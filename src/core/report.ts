import { candidatesOf, isAutoMergeEligible, type Verdict } from "./interpret.js";
import type { ApiDiffReport, CompatVersionResult } from "./packdevTypes.js";
import type { Bump } from "./extractBump.js";

const MAX_OUTPUT_CHARS = 4000;

const VERDICT_LABEL: Record<Verdict["kind"], string> = {
  NO_CONTROL: "⚠️ No control — infrastructure failure",
  HARNESS_BROKEN: "⚠️ Test harness broken",
  INSTALL_FAILED: "⚠️ Install failed",
  NOTHING_TESTED: "⚠️ Nothing tested",
  INCOMPATIBLE: "❌ Incompatible",
  PASSED_WEAK: "🟡 Passed (weak evidence)",
  PASSED: "✅ Passed",
};

function truncate(output: string | undefined): string | null {
  if (!output) return null;
  if (output.length <= MAX_OUTPUT_CHARS) return output;
  const omitted = output.length - MAX_OUTPUT_CHARS;
  return `${output.slice(0, MAX_OUTPUT_CHARS)}\n… (truncated, ${omitted} more characters)`;
}

function outputBlock(title: string, output: string | undefined): string {
  const truncated = truncate(output);
  if (!truncated) return "";
  return `\n<details>\n<summary>${title}</summary>\n\n\`\`\`\n${truncated}\n\`\`\`\n</details>\n`;
}

function versionsList(versions: CompatVersionResult[]): string {
  return versions.map((v) => `\`${v.version}\``).join(", ");
}

function bumpSummary(verdict: Verdict): string {
  const control = verdict.report.control;
  const candidates = candidatesOf(verdict.report);
  const from = control ? `\`${control.version}\`` : "*(unresolved)*";
  const to = candidates.length > 0 ? versionsList(candidates) : "*(none tested)*";
  const group = verdict.report.group;
  const groupNote =
    group && group.length > 0
      ? ` (grouped with ${group.map((name) => `\`${name}\``).join(", ")}, pinned to the same version)`
      : "";
  return `**${verdict.report.package}**${groupNote}: ${from} → ${to}`;
}

/**
 * Warnings that must always be surfaced verbatim, regardless of verdict —
 * suppressing any of these would hide exactly the information a reviewer
 * needs to sanity-check an automated decision. See docs/architecture.md
 * "core / report".
 */
function alwaysSurfacedWarnings(verdict: Verdict): string[] {
  const warnings: string[] = [];
  const { report } = verdict;

  for (const caveat of report.testCommandCaveats) {
    warnings.push(`⚠️ **Test command caveat** (\`${caveat.code}\`): ${caveat.message}`);
  }

  for (const version of report.versions) {
    if (version.esmMismatch) {
      warnings.push(`⚠️ **ESM mismatch** on \`${version.version}\`: ${version.esmMismatch}`);
    }
    if (version.dupesRegression) {
      for (const r of version.dupesRegression) {
        warnings.push(
          `⚠️ **Duplicate copies increased** on \`${version.version}\`: \`${r.package}\` ${r.controlCopies} → ${r.candidateCopies}`,
        );
      }
    }
  }

  return warnings;
}

function provenanceLine(verdict: Verdict): string {
  const { report } = verdict;
  return `_Sandbox: \`${report.sandboxMode}\` · Package manager: \`${report.packageManager}\`_`;
}

function bodyFor(verdict: Verdict): string {
  switch (verdict.kind) {
    case "NO_CONTROL":
      return (
        "No control version could be resolved from `node_modules` — the sandbox this ran " +
        "against was never installed, or the package wasn't found there. This is an " +
        "infrastructure problem, not evidence about the bump. **No verdict on the bump itself " +
        "can be trusted from this run.**"
      );

    case "HARNESS_BROKEN": {
      const control = verdict.report.control!;
      return (
        `The control (\`${control.version}\`, the version already in use) did not pass the app's ` +
        "own test command. The app's test harness itself is broken for this run — a missing " +
        "devDependency satisfied only by hoisting, a flaky suite, or similar. **This says " +
        "nothing about whether the bump is safe.** Fix the harness before trusting any compat " +
        "verdict for this app." +
        outputBlock(`Control (${control.version}) output`, control.output)
      );
    }

    case "INSTALL_FAILED": {
      const names = versionsList(verdict.failedVersions);
      const blocks = verdict.failedVersions
        .map((v) => outputBlock(`Install output — ${v.version}`, v.output))
        .join("");
      return (
        `The sandboxed install itself failed for ${names}, before any test ran. This is a ` +
        "registry, auth, or package-manager problem — **not evidence the candidate version is " +
        "incompatible.** Check registry reachability/auth and that the resolved package manager " +
        "is available." +
        blocks
      );
    }

    case "NOTHING_TESTED":
      return (
        "Every candidate version was skipped. **Nothing was determined by this run** — this is " +
        "not a pass, and it is not evidence of a problem either."
      );

    case "INCOMPATIBLE": {
      const names = versionsList(verdict.failedVersions);
      const blocks = verdict.failedVersions
        .map((v) => outputBlock(`Failure output — ${v.version}`, v.output))
        .join("");
      return `${names} failed the app's real test command. **The bump is incompatible with this app.**${blocks}`;
    }

    case "PASSED_WEAK": {
      const names = versionsList(verdict.candidates);
      return (
        `${names} passed, but the app's own test command has a structural caveat attached — ` +
        "it may not be able to see the kind of break this bump could introduce (see caveats " +
        "below). **Treat this as weak evidence, not a clean pass.**"
      );
    }

    case "PASSED": {
      const names = versionsList(verdict.candidates);
      return `${names} passed the app's real test command against a working control. Clean pass.`;
    }
  }
}

/**
 * Renders a Verdict into PR-comment markdown. The renderer is shared across
 * both deployment modes (GitHub Action, self-hosted) — only the sink that
 * posts this text differs. Always surfaces testCommandCaveats, esmMismatch,
 * and dupesRegression verbatim: a caveat present in the report must be
 * present in the rendered output for every verdict kind that can carry one.
 */
export function render(verdict: Verdict): string {
  const lines: string[] = [];

  lines.push(`### packdev compat — ${VERDICT_LABEL[verdict.kind]}`);
  lines.push("");
  lines.push(bumpSummary(verdict));
  lines.push("");
  lines.push(bodyFor(verdict));

  const warnings = alwaysSurfacedWarnings(verdict);
  if (warnings.length > 0) {
    lines.push("");
    lines.push(...warnings);
  }

  lines.push("");
  lines.push(provenanceLine(verdict));
  lines.push(
    isAutoMergeEligible(verdict)
      ? "_Auto-merge eligible._"
      : "_Not auto-merge eligible — requires human review._",
  );

  return lines.join("\n");
}

/**
 * Renders the static-analysis short-circuit path: `packdev api-diff` found
 * a CONFIDENT negative (a symbol the app statically imports is missing from
 * the candidate version's exports, with no dynamic/namespace usage that
 * could hide the real export list) — see pipeline.ts's static-incompatible
 * branch. This never ran a sandboxed install or the app's real test
 * command, so it is never auto-merge eligible, and is always its own thing,
 * not a Verdict — interpret()'s Verdict union only ever describes an
 * outcome that came from a real compat run.
 */
export function renderStaticIncompatible(bump: Bump, apiDiff: ApiDiffReport): string {
  const entry = apiDiff.versions.find((v) => v.version === bump.toVersion);
  const missing = entry?.missingSymbols ?? [];
  const missingList = missing.map((s) => `\`${s}\``).join(", ");

  const lines: string[] = [];
  lines.push("### packdev compat — ⛔ Incompatible (static)");
  lines.push("");
  lines.push(`**${bump.name}**: \`${bump.fromVersion}\` → \`${bump.toVersion}\``);
  lines.push("");
  lines.push(
    `Static analysis (\`packdev api-diff\`) found this app imports ${missingList} from ` +
      `**${bump.name}**, which \`${bump.toVersion}\` does not export. **The bump is incompatible ` +
      "with this app.** Skipped the full sandboxed test run — this is a confident result, not an " +
      "approximation: no dynamic or namespace usage was found that could have hidden the real " +
      "export list.",
  );
  lines.push("");
  lines.push("_Static pre-check — no sandboxed install or test ran for this verdict._");
  lines.push("_Not auto-merge eligible — requires human review._");

  return lines.join("\n");
}
