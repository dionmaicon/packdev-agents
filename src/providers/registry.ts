import path from "node:path";
import { pathToFileURL } from "node:url";

import type { Provider, ProviderFactory } from "./types.js";
import { createGithubProvider } from "./github/index.js";
import { createGiteaProvider } from "./gitea/index.js";

const BUILTIN_PROVIDERS: Record<string, ProviderFactory> = {
  github: createGithubProvider,
  gitea: createGiteaProvider,
};

/**
 * A relative ("./foo.js", "../foo.js") or absolute filesystem path in
 * PROVIDER_MODULE must resolve against the CALLER's working directory
 * (process.cwd() — wherever the user ran `packdev-agents` from), not
 * against this file's own location. A bare `import("./foo.js")` resolves
 * relative to dist/providers/registry.js instead, which silently breaks
 * the documented local-file escape hatch for every installed copy of this
 * package. A bare/package specifier (no leading "." or "/", e.g.
 * "@my-org/my-provider") is left untouched so Node's normal node_modules
 * resolution handles it.
 */
function resolveModuleSpecifier(specifier: string): string {
  const isFilesystemPath = specifier.startsWith("./") || specifier.startsWith("../") || path.isAbsolute(specifier);
  if (!isFilesystemPath) return specifier;
  return pathToFileURL(path.resolve(process.cwd(), specifier)).href;
}

/**
 * Resolves which forge this run talks to. PROVIDER_MODULE, if set, always
 * wins regardless of PROVIDER — it's the third-party extensibility path:
 * a module (local file, or an installed package) whose default export is
 * a ProviderFactory (see types.ts), letting anyone add GitLab/Bitbucket/
 * anything else without a PR to this repo or waiting on a built-in.
 * Otherwise PROVIDER selects a built-in ("github" by default, "gitea"
 * also available today).
 */
export async function resolveProvider(env: NodeJS.ProcessEnv): Promise<Provider> {
  const moduleSpecifier = env["PROVIDER_MODULE"];
  if (moduleSpecifier) {
    const imported: unknown = await import(resolveModuleSpecifier(moduleSpecifier));
    const factory = (imported as { default?: unknown }).default;
    if (typeof factory !== "function") {
      throw new Error(
        `PROVIDER_MODULE "${moduleSpecifier}" must have a default export that is a function (env) => Provider — see src/providers/types.ts's ProviderFactory.`,
      );
    }
    return (factory as ProviderFactory)(env);
  }

  const providerName = env["PROVIDER"] ?? "github";
  const factory = BUILTIN_PROVIDERS[providerName];
  if (!factory) {
    const known = Object.keys(BUILTIN_PROVIDERS).join(", ");
    throw new Error(
      `Unknown PROVIDER "${providerName}" — expected one of: ${known} (or set PROVIDER_MODULE to a custom provider).`,
    );
  }
  return factory(env);
}
