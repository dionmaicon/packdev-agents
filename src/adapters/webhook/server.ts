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
}

export interface WebhookServer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

const RELEVANT_ACTIONS = new Set(["opened", "reopened", "synchronize"]);

function readRawBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Per-repo run coalescing: two overlapping triggers for the same repo must
 * not run concurrently (they'd race writing the same state file/clone
 * dir). "running" means a run is in flight; "running+pending" means a
 * second trigger arrived while it was running, so exactly one more run
 * happens right after, instead of a second overlapping one starting
 * immediately or the trigger being silently dropped.
 */
function createCoalescer(repos: Map<string, RepoEntry>): (repo: string) => void {
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
    try {
      await entry.run();
    } catch (error) {
      console.error(`[webhook] [${repo}] run failed: ${String(error)}`);
    }
    const next = state.get(repo);
    state.delete(repo);
    if (next === "running+pending") {
      trigger(repo);
    }
  }

  return trigger;
}

/**
 * Plain node:http webhook listener — no new dependency, matching this
 * repo's existing thin-wiring style. Verifies the payload's signature via
 * the matched repo's own Provider before doing anything else, so an
 * unsigned/forged request never reaches repo-matching logic that could
 * otherwise be used to fingerprint configured repos via timing/response
 * differences beyond the deliberately generic 200/401/404 responses below.
 */
export function createWebhookServer(options: WebhookServerOptions): WebhookServer {
  const trigger = createCoalescer(options.repos);
  const server = http.createServer((req, res) => {
    void handleRequest(req, res);
  });

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "POST" || req.url !== options.path) {
      res.writeHead(404);
      res.end();
      return;
    }

    const rawBody = await readRawBody(req);

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
      // No match (or malformed payload) -> 200 no-op. Never distinguish
      // this from any other no-op case (wrong action, etc.) via status
      // code — that would leak which repos are configured to anyone who
      // can send requests to this endpoint.
      res.writeHead(200);
      res.end();
      return;
    }

    const verified = entry.provider.verifyWebhookSignature?.(rawBody, req.headers) ?? false;
    if (!verified) {
      res.writeHead(401);
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
  }

  return {
    start(): Promise<void> {
      return new Promise((resolve) => {
        server.listen(options.port, resolve);
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
