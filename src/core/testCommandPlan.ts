import { readFile } from "node:fs/promises";
import path from "node:path";

import type { PackageManagerName } from "./prepareWorkspace.js";

/**
 * Guards against a pathological/cyclic script graph. Three levels covers
 * every real chain observed (test -> pretest -> build -> prebuild); beyond
 * that the remaining hook is still run directly, just not expanded further.
 */
const MAX_EXPANSION_DEPTH = 3;

/** A hook body that is EXACTLY a package-manager script invocation, e.g. "npm run build" — the only shape safe to expand further (see expandHook). */
const BARE_SCRIPT_INVOCATION = /^(?:npm|yarn|pnpm)\s+(?:run\s+)?([\w:-]+)\s*$/;

export interface TestPlan {
  /** The command to actually hand to packdev. Mutually exclusive with testScript, mirroring RunCompatOptions. */
  testCommand?: string | undefined;
  testScript?: string | undefined;
  /**
   * Non-null only when the caller's configured command was rewritten.
   * Surfaced verbatim in the PR comment: an automated verdict produced by
   * a command the user did not literally write must say so, or the report
   * isn't auditable (same principle as report.ts's alwaysSurfacedWarnings).
   */
  note: string | null;
}

type Scripts = Record<string, string>;

/**
 * The lifecycle-hook problem this solves, found live against
 * packdev-demo-nestjs:
 *
 * npm_config_ignore_scripts=true is REQUIRED (see childEnv.ts) — it is the
 * only lever this repo has over the install packdev performs internally of
 * the bumped dependency, where a malicious postinstall would run. But npm
 * applies that setting to ALL lifecycle hooks, including the app's OWN
 * trusted "pretest" build step, which is not part of the threat model at
 * all: it lives in the repo, it is the same code whose test suite we are
 * about to run anyway, and the bumped dependency has no influence over it.
 *
 * The consequence was a silent false PASSED: notifier's
 * `pretest: "npm run build"` never ran, so `node --test` found zero
 * compiled test files and npm exited 0 — reported as a clean pass,
 * auto-merge eligible, for a genuinely broken bump.
 *
 * The fix is that an EXPLICITLY named `npm run <script>` is not blocked by
 * ignore-scripts (confirmed empirically) — only npm's automatic invocation
 * of pre/post hooks is. So the hook chain is reconstructed by name and run
 * explicitly, restoring real lifecycle behavior for the app's own scripts
 * while the dependency install stays blocked. The user changes nothing.
 */
export async function planTestCommand(
  appDir: string,
  test: { testCommand?: string | undefined; testScript?: string | undefined },
  packageManager: PackageManagerName,
): Promise<TestPlan> {
  const passthrough: TestPlan = {
    ...(test.testScript ? { testScript: test.testScript } : { testCommand: test.testCommand }),
    note: null,
  };

  // A testCommand that isn't a plain single-script invocation ("npm run
  // build && npm test", a bespoke multi-step command) is deliberately left
  // exactly as written: the user already controls the whole sequence, and
  // rewriting arbitrary shell is both unnecessary and unsafe to attempt.
  const scriptName = test.testScript ?? test.testCommand?.trim().match(BARE_SCRIPT_INVOCATION)?.[1];
  if (!scriptName) return passthrough;

  let scripts: Scripts;
  try {
    const raw = await readFile(path.join(appDir, "package.json"), "utf8");
    scripts = (JSON.parse(raw) as { scripts?: Scripts }).scripts ?? {};
  } catch {
    return passthrough;
  }

  const sequence = expandScript(scriptName, scripts, new Set(), 0);
  // No pre/post hooks anywhere in the chain — npm's automatic behavior and
  // ours would be identical, so leave the caller's config untouched
  // (notably keeping testScript AS testScript; see the note below for what
  // converting it costs).
  if (sequence.length === 1) return passthrough;

  const command = sequence.map((name) => `${packageManager} run ${name}`).join(" && ");
  const hooks = sequence.filter((name) => name !== scriptName);
  const configured = test.testScript ? `testScript: "${test.testScript}"` : `testCommand: "${test.testCommand}"`;

  return {
    testCommand: command,
    note:
      `ℹ️ Ran \`${command}\` instead of the configured ${configured}. This app defines ` +
      `${hooks.map((h) => `\`${h}\``).join(", ")}, which npm would normally run automatically — but the ` +
      "compat sandbox sets `--ignore-scripts` (required, so a malicious `postinstall` in the bumped " +
      "dependency can't execute), and that also suppresses the app's own lifecycle hooks. Naming them " +
      "explicitly restores them without re-enabling dependency install scripts, so this verdict reflects " +
      "a real build + test run rather than a silently unbuilt tree." +
      (test.testScript
        ? " Note that running as a command rather than a named script means packdev's own test-harness " +
          "caveat detection (`TYPE_CHECK_ONLY`/`TRANSPILE_ONLY`) can't inspect the script body here."
        : ""),
  };
}

/**
 * Flattens `script` into the explicit sequence to run: its pre-hook chain,
 * then itself, then its post-hook chain. Running each by name is what makes
 * them execute at all under --ignore-scripts; running the target itself by
 * name is safe precisely BECAUSE its own hooks stay suppressed, so nothing
 * here can double-run.
 */
function expandScript(script: string, scripts: Scripts, visited: Set<string>, depth: number): string[] {
  if (visited.has(script) || depth > MAX_EXPANSION_DEPTH) return [script];
  visited.add(script);

  return [
    ...expandHook(`pre${script}`, scripts, visited, depth),
    script,
    ...expandHook(`post${script}`, scripts, visited, depth),
  ];
}

/**
 * A hook whose body is exactly "npm run build" is replaced by the full
 * expansion of `build` — otherwise that inner invocation would itself
 * silently skip `prebuild`, reintroducing the same bug one level down.
 * Any other body (real shell, multiple steps) is run as-is by name: still
 * strictly better than not running at all, and not worth parsing shell for.
 */
function expandHook(hook: string, scripts: Scripts, visited: Set<string>, depth: number): string[] {
  const body = scripts[hook];
  if (!body) return [];

  const inner = body.trim().match(BARE_SCRIPT_INVOCATION)?.[1];
  if (inner && scripts[inner] && !visited.has(inner)) {
    return expandScript(inner, scripts, visited, depth + 1);
  }
  return [hook];
}
