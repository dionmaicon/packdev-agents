import { createRequire } from "node:module";
import path from "node:path";
import { readFile } from "node:fs/promises";

/**
 * Resolves packdev's CLI entry script on disk. NEVER `require("packdev")`
 * or `import` its named exports for this purpose: packdev's package.json
 * has "main": "dist/index.js" with no "exports" map, and that file IS the
 * CLI entry — it calls program.parse() as a side effect at module load, so
 * importing it would execute the CLI in-process instead of letting us spawn
 * and capture it. See docs/architecture.md "Shell out, do not import".
 * Shared by every runXxx module that spawns the CLI (runCompat, runApiDiff).
 */
export async function resolvePackdevBinPath(): Promise<string> {
  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve("packdev/package.json");
  const packageDir = path.dirname(packageJsonPath);
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
    bin?: Record<string, string> | string;
  };

  const binField = packageJson.bin;
  const relativeBin =
    typeof binField === "string" ? binField : binField?.packdev;
  if (!relativeBin) {
    throw new Error(
      `packdev's package.json at ${packageJsonPath} has no "bin.packdev" entry`,
    );
  }
  return path.join(packageDir, relativeBin);
}
