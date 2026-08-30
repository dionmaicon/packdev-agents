/**
 * Env for every child process this repo spawns that installs or runs
 * content influenced by a PR's package.json (npm/yarn/pnpm installs, the
 * packdev CLI itself, and the app's own test command/script). Two
 * defenses in one place, both load-bearing, not optional hardening:
 *
 * 1. npm_config_ignore_scripts=true — npm/yarn/pnpm all read config via
 *    npm_config_<key> env vars (confirmed empirically: suppresses a real
 *    postinstall side effect for both npm and pnpm). This is REQUIRED
 *    reinforcement, not redundant with prepareWorkspace.ts's own
 *    `--ignore-scripts` flag: packdev's own CLI (a separate dependency
 *    this repo shells out to) does its OWN internal sandbox install of
 *    the candidate version with no `--ignore-scripts` flag exposed on its
 *    `compat`/`api-diff` commands, so setting it here is the only lever
 *    this repo has over that install. (Known residual gap: yarn v1
 *    classic doesn't reliably honor this env var the way npm/pnpm do,
 *    and packdev exposes no flag either — a malicious postinstall in a
 *    yarn-v1-managed sandboxed candidate install is not fully closed by
 *    anything this repo can control.)
 * 2. Secret scrubbing — every execFile call here previously inherited the
 *    full process.env verbatim, so a malicious postinstall script (or
 *    the app's own test command, which also runs PR-influenced code)
 *    could read and exfiltrate GITHUB_TOKEN / brain API keys. Strips
 *    anything token/key/secret/password-shaped EXCEPT registry auth vars
 *    (NPM_TOKEN, NODE_AUTH_TOKEN) that installs may legitimately need for
 *    a private registry.
 */

const SECRET_ALLOWLIST = new Set(["NPM_TOKEN", "NODE_AUTH_TOKEN"]);
const SECRET_PATTERN = /token|api[_-]?key|secret|password/i;

export function buildSandboxEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (!SECRET_ALLOWLIST.has(key) && SECRET_PATTERN.test(key)) continue;
    env[key] = value;
  }
  env["npm_config_ignore_scripts"] = "true";
  return env;
}
