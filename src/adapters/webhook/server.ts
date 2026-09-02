import http from "node:http";

import type { Provider } from "../../providers/types.js";

interface RepoEntry {
  provider: Provider;
  run: () => Promise<void>;
}

export interface WebhookServerOptions {
  port: number;
  path: string;
  repos: Map<string, RepoEntry>;
  /**
   * Bounded retry backoff (ms) for a run that throws — a transient
   * clone/forge failure gets a few automatic retries instead of the event
   * being silently dropped, without building a durable queue. After the
   * last retry is exhausted, the failure is only logged; recovery then
   * needs either the next real webhook delivery for that repo, or pairing
   * --webhook with an occasional --once cron run as a durability net.
   * Exposed mainly so tests can use short delays. Default: 5s, 30s, 120s.
   */
  retryDelaysMs?: number[];
}

export interface WebhookServer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export const DEFAULT_RETRY_DELAYS_MS = [5_000, 30_000, 120_000];

// "synchronize" is GitHub's spelling for "new commits pushed to the PR
// branch"; Gitea's own webhook payload spells the same event
// "synchronized" — both must be treated as the same trigger.
const RELEVANT_ACTIONS = new Set(["opened", "reopened", "synchronize", "synchronized"]);

// Only the provider-specific event-TYPE header (not the payload's "action"
// field alone) reliably distinguishes a pull-request delivery from some
// other signed event that happens to share the "action"/"repository" shape
// (e.g. GitHub's "issues" event also has action:"opened" and a repository).
// Checked when present; providers/deliveries that don't send a known one
// fall back to action-only filtering, same as before.
const EVENT_TYPE_HEADERS = ["x-github-event", "x-gitea-event", "x-gogs-event"];

const MAX_BODY_BYTES = 1 * 1024 * 1024; // generous for a PR webhook payload, small enough to bound memory

class PayloadTooLargeError extends Error {}

function readRawBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const contentLength = Number(req.headers["content-length"]);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      reject(new PayloadTooLargeError());
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new PayloadTooLargeError());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Per-repo run coalescing + bounded retry: two overlapping triggers for the
 * same repo must not run concurrently (they'd race writing the same state
 * file/clone dir). "running" means a run (including any retry backoff) is
 * in flight; "running+pending" means a real trigger arrived while it was
 * in flight, so exactly one more run happens right after — instead of a
 * second overlapping one starting immediately, or the trigger being
 * silently dropped.
 */
function createCoalescer(repos: Map<string, RepoEntry>, retryDelaysMs: number[]): (repo: string) => void {
  const state = new Map<string, "running" | "running+pending">();

  function trigger(repo: string): void {
    const entry = repos.get(repo);
    if (!entry) return;

    const current = state.get(repo);
    if (current === "running") {
      state.set(repo, "running+pending");
      return;
    }
    if (current === "running+pending") return;

    state.set(repo, "running");
    void runAndDrain(repo, entry);
  }

  async function runAndDrain(repo: string, entry: RepoEntry): Promise<void> {
    const maxAttempts = retryDelaysMs.length + 1;
    let ok = false;
    for (let attempt = 0; attempt < maxAttempts && !ok; attempt++) {
      try {
        await entry.run();
        ok = true;
      } catch (error) {
        console.error(`[webhook] [${repo}] run failed (attempt ${attempt + 1}/${maxAttempts}): ${String(error)}`);
        const delay = retryDelaysMs[attempt];
        if (delay !== undefined) await sleep(delay);
      }
    }
    if (!ok) {
      console.error(`[webhook] [${repo}] giving up after ${maxAttempts} attempts — will retry on the next webhook delivery for this repo.`);
    }

    const next = state.get(repo);
    state.delete(repo);
    if (next === "running+pending") {
      trigger(repo);
    }
  }

  return trigger;
}

function firstHeaderValue(headers: NodeJS.Dict<string | string[]>, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function extractEventType(headers: NodeJS.Dict<string | string[]>): string | undefined {
  for (const name of EVENT_TYPE_HEADERS) {
    const value = firstHeaderValue(headers, name);
    if (value) return value;
  }
  return undefined;
}

/**
 * Plain node:http webhook listener — no new dependency, matching this
 * repo's existing thin-wiring style. An unmatched repo and a bad signature
 * both get the SAME response (401) — never distinguished via status code,
 * which would otherwise let an unauthenticated caller enumerate the
 * configured repo list by comparing responses for guessed repo names.
 */
export function createWebhookServer(options: WebhookServerOptions): WebhookServer {
  const trigger = createCoalescer(options.repos, options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS);
  const server = http.createServer((req, res) => {
    void handleRequest(req, res);
  });

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      if (req.method !== "POST" || req.url !== options.path) {
        res.writeHead(404);
        res.end();
        return;
      }

      let rawBody: Buffer;
      try {
        rawBody = await readRawBody(req, MAX_BODY_BYTES);
      } catch (error) {
        res.writeHead(error instanceof PayloadTooLargeError ? 413 : 400);
        res.end();
        return;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(rawBody.toString("utf8"));
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }

      const repoFullName = extractRepoFullName(payload);
      const entry = repoFullName ? options.repos.get(repoFullName) : undefined;
      if (!entry) {
        // No match (or malformed payload) -> same response as a bad
        // signature below — see this function's doc comment.
        res.writeHead(401);
        res.end();
        return;
      }

      let verified: boolean;
      try {
        verified = entry.provider.verifyWebhookSignature?.(rawBody, req.headers) ?? false;
      } catch (error) {
        // The Provider contract says verifyWebhookSignature must never
        // throw, but a third-party PROVIDER_MODULE could violate that —
        // treat it the same as "false" rather than letting it become an
        // unhandled rejection that could take down the whole listener.
        console.error(`[webhook] verifyWebhookSignature threw, treating as unverified: ${String(error)}`);
        verified = false;
      }
      if (!verified) {
        res.writeHead(401);
        res.end();
        return;
      }

      const eventType = extractEventType(req.headers);
      if (eventType !== undefined && eventType !== "pull_request") {
        res.writeHead(200);
        res.end();
        return;
      }

      const action = extractAction(payload);
      if (!action || !RELEVANT_ACTIONS.has(action)) {
        res.writeHead(200);
        res.end();
        return;
      }

      res.writeHead(200);
      res.end();
      trigger(repoFullName!);
    } catch (error) {
      console.error(`[webhook] unexpected error handling request: ${String(error)}`);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    }
  }

  return {
    start(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
    },
    stop(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function extractRepoFullName(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const repository = (payload as Record<string, unknown>)["repository"];
  if (typeof repository !== "object" || repository === null) return undefined;
  const fullName = (repository as Record<string, unknown>)["full_name"];
  return typeof fullName === "string" ? fullName : undefined;
}

function extractAction(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const action = (payload as Record<string, unknown>)["action"];
  return typeof action === "string" ? action : undefined;
}
