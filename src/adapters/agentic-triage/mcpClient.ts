import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { resolvePackdevBinPath } from "../../core/packdevBin.js";

/**
 * The SDK's own package.json "exports" map only declares a "./client"
 * subpath (mapped to dist/esm/client/index.d.ts) — "./client/index.js" and
 * "./client/stdio.js" both only resolve via its "./*" wildcard fallback,
 * whose "types" mapping ("./dist/esm/*.d.ts") doesn't correctly strip the
 * ".js" before appending ".d.ts" for these deep imports. That leaves
 * listTools()/callTool()'s return types unresolvable (TS reports
 * `unknown`) even though the runtime import works fine. Rather than fight
 * the library's packaging bug, these are OUR minimal local types for the
 * exact response shapes this module actually consumes — same "our mirrored
 * type is the contract" approach already used for packdev's own CLI JSON
 * in packdevTypes.ts.
 */
interface RawListToolsResult {
  tools: Array<{
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
  }>;
}

interface RawCallToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
}

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolCallResult {
  /** The tool's own JSON report, as text — same shape packdev's --json CLI output would produce. */
  text: string;
  isError: boolean;
}

/**
 * A live connection to `packdev mcp` (packdev's own MCP server, run over
 * stdio — see packdev's --help: "exposes api-diff/compat/dupes as tools for
 * a coding agent. Reads node_modules/lockfiles and runs sandboxed installs
 * on this machine — never a hosted server, never uploads your dependency
 * tree"). Everything this session's tools see and do stays local.
 */
export interface PackdevMcpSession {
  listTools(): Promise<McpToolDescriptor[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult>;
  close(): Promise<void>;
}

export interface ConnectPackdevMcpOptions {
  /** The tool calls' own `app`/`root` arguments are resolved relative to this. */
  cwd: string;
  /** Overrides CLI entry-point resolution. Test-only escape hatch, mirrors runCompat/runApiDiff. */
  binPathOverride?: string | undefined;
}

/**
 * Spawns `packdev mcp` as a child process and connects to it over stdio.
 * Real subprocess, real JSON-RPC — never a hand-rolled protocol shim. The
 * caller owns the returned session's lifecycle and must call close().
 */
export async function connectPackdevMcp(
  options: ConnectPackdevMcpOptions,
): Promise<PackdevMcpSession> {
  const binPath = options.binPathOverride ?? (await resolvePackdevBinPath());

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [binPath, "mcp"],
    cwd: options.cwd,
  });

  const client = new Client(
    { name: "packdev-agents-agentic-triage", version: "0.1.0" },
    { capabilities: {} },
  );
  await client.connect(transport);

  return {
    async listTools() {
      const result = (await client.listTools()) as unknown as RawListToolsResult;
      return result.tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema,
      }));
    },

    async callTool(name, args) {
      const result = (await client.callTool({ name, arguments: args })) as unknown as RawCallToolResult;
      const textBlock = result.content.find(
        (block): block is { type: "text"; text: string } =>
          block.type === "text" && typeof block.text === "string",
      );
      if (!textBlock) {
        throw new Error(`packdev mcp tool "${name}" returned no text content block`);
      }
      return { text: textBlock.text, isError: result.isError === true };
    },

    async close() {
      await client.close();
    },
  };
}
