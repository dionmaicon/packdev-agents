/**
 * Env for every child process this repo spawns that installs or runs
 * content influenced by a PR's package.json (npm/yarn/pnpm installs, the
 * packdev CLI itself, and the app's own test command/script).
 *
 * SECRET SCRUBBING is unconditional and load-bearing, not optional
 * hardening: every execFile call here once inherited the full process.env
 * verbatim, so a malicious postinstall script (or the app's own test
 * command, which also runs PR-influenced code) could read and exfiltrate
 * GITHUB_TOKEN / brain API keys. Strips anything token/key/secret/
 * password-shaped EXCEPT registry auth vars (NPM_TOKEN, NODE_AUTH_TOKEN)
 * that installs may legitimately need for a private registry.
 *
 * IGNORE-SCRIPTS is opt-in per call site, and deliberately NOT the blanket
 * default it used to be. npm applies npm_config_ignore_scripts to EVERY
 * lifecycle hook in the process tree, which cannot distinguish the two
 * things that matter here:
 *
 *   - a bumped dependency's `postinstall` (untrusted registry code — must
 *     be blocked), versus
 *   - the app's OWN `pretest`/`prebuild` hooks (the same repo code whose
 *     test suite we are about to run anyway — must NOT be blocked).
 *
 * Setting it process-wide for the packdev CLI conflated them and produced
 * a silent false PASSED, found live: a NestJS app's `pretest: "npm run
 * build"` never ran, so `node --test` found zero compiled test files and
 * npm exited 0 — reported as a clean pass, auto-merge eligible, for a
 * genuinely broken bump (dionmaicon/packdev#6). packdev 0.4.3 fixes this
 * properly with `--ignore-install-scripts`, which scopes the blocking to
 * its own sandbox install so the --test phase keeps normal npm lifecycle
 * behavior — see runCompat.ts. That flag is now the mechanism for
 * packdev's install, and this env var is reserved for installs THIS repo
 * performs directly (prepareWorkspace), where no app test command runs and
 * so there is no hook to wrongly suppress.
 */

const SECRET_ALLOWLIST = new Set(["NPM_TOKEN", "NODE_AUTH_TOKEN"]);
const SECRET_PATTERN = /token|api[_-]?key|secret|password/i;

/**
 * Parent-process runner state that must never reach the sandboxed app's
 * own test run, because it silently changes how that run BEHAVES rather
 * than just what it can see.
 *
 * NODE_TEST_CONTEXT is set by Node's own test runner in the process it
 * spawns. Inherited by a nested `node --test`, it switches that child from
 * TAP to the v8-serialized reporter — so packdev's summary scraping finds
 * no counts, `testCounts` comes back undefined, and the
 * PASS_WITH_NO_TESTS caveat that should have downgraded the verdict never
 * fires. Caught by this repo's own test suite: an app running zero tests
 * was reported a clean auto-mergeable PASSED under `node --test`, and
 * PASSED_WEAK everywhere else. A safety caveat that disappears based on
 * who launched the parent process is worse than no caveat at all.
 */
const RUNNER_STATE_DENYLIST = new Set(["NODE_TEST_CONTEXT"]);

export interface SandboxEnvOptions {
  /**
   * Sets npm_config_ignore_scripts. Only correct for a child that performs
   * an install and runs NO app-authored test command — see the module doc
   * comment. Defaults to false: the conflation this caused was a real bug,
   * so it must be a deliberate choice at each call site rather than
   * something inherited silently.
   */
  ignoreScripts?: boolean;
}

export function buildSandboxEnv(
  base: NodeJS.ProcessEnv = process.env,
  options: SandboxEnvOptions = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (RUNNER_STATE_DENYLIST.has(key)) continue;
    if (!SECRET_ALLOWLIST.has(key) && SECRET_PATTERN.test(key)) continue;
    env[key] = value;
  }
  if (options.ignoreScripts) {
    env["npm_config_ignore_scripts"] = "true";
  }
  return env;
}
