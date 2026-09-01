/**
 * Library entrypoint for @packdev/agents — the typed surface a third party
 * needs to write their own PROVIDER_MODULE (see src/providers/registry.ts)
 * or embed the compat pipeline programmatically, without depending on this
 * package's internal file layout.
 */
export type {
  Provider,
  ProviderFactory,
  PullRequestSource,
  OpenBotPR,
} from "./providers/types.js";

export {
  runCompatPipeline,
  type RunCompatPipelineOptions,
  type RunCompatPipelineResult,
  type ForgeOps,
  type CommentInput,
  type CheckRunInput,
  DEFAULT_ALLOWED_ACTORS,
} from "./core/pipeline.js";
