import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * ignore-scripts (required — see childEnv.ts's doc comment) silently skips
 * ANY automatic pre/post lifecycle hook, not just a dependency's
 * postinstall. If the app's own test script has a "pre<script>" hook that
 * builds/compiles it, that hook silently never runs under our sandboxing —
 * the actual test command then runs against stale or missing build output
 * and can trivially report a clean pass (0 tests found, exit 0) with NO
 * caveat surfaced anywhere. Confirmed live: packdev-demo-nestjs's
 * `pretest: "npm run build"` (NestJS needs a real tsc compile for
 * emitDecoratorMetadata) — a genuinely broken bump reported a clean PASSED,
 * auto-merge eligible, because `node --test` silently found zero compiled
 * test files. packdev's own `--test` docs already say to chain explicitly
 * ("npm run build && npm test") for exactly this reason; this only exists
 * to catch the case where a plain "npm test" / testScript "test" was
 * configured instead of following that.
 */
const BARE_SCRIPT_INVOCATION = /^(?:npm|yarn|pnpm)\s+(?:run\s+)?([\w:-]+)\s*$/;

/**
 * Returns a human-readable explanation if the configured test.testCommand/
 * testScript looks like it would silently skip a real "pre<script>" build
 * hook the target app depends on, or null if no such risk is detected.
 *
 * Only flags a BARE single-script invocation ("npm test", "yarn run
 * build" — nothing else chained). A testCommand that already chains
 * multiple steps ("npm run build && npm test") is assumed to have been
 * written deliberately and is not second-guessed further: false negatives
 * here are far safer than false positives blocking a correctly-configured
 * repo on every single PR.
 */
export async function detectSilentPretestSkip(
  appDir: string,
  test: { testCommand?: string | undefined; testScript?: string | undefined },
): Promise<string | null> {
  const scriptName = test.testScript ?? test.testCommand?.trim().match(BARE_SCRIPT_INVOCATION)?.[1];
  if (!scriptName) return null;

  let scripts: Record<string, string>;
  try {
    const raw = await readFile(path.join(appDir, "package.json"), "utf8");
    scripts = (JSON.parse(raw) as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    return null;
  }

  const hookName = `pre${scriptName}`;
  const hook = scripts[hookName];
  if (!hook) return null;

  const configured = test.testScript
    ? `testScript: "${test.testScript}"`
    : `testCommand: "${test.testCommand}"`;

  return (
    `This app's package.json defines a "${hookName}" script ("${hook}") that npm would normally run ` +
    `automatically before "${scriptName}" — but packdev-agents always sandboxes the test run with ` +
    "--ignore-scripts (required to block a malicious postinstall from the bumped dependency itself), " +
    `which silently disables that automatic hook too. As configured (${configured}), "${hookName}" never ` +
    "runs, so the test command may be running against stale or missing build output and could report a " +
    'false clean pass. Fix: set testCommand to explicitly run the build first, e.g. testCommand: "npm run ' +
    'build && npm test" — an explicitly-named "npm run <script>" is NOT blocked by --ignore-scripts, only ' +
    "automatic pre/post hooks are."
  );
}
