#!/usr/bin/env bun
import { captureSnapshot, countRestorePlans, countSnapshots, getRestorePlan, getResumeContext, getSnapshotEnvelope, listRestorePlans, listSnapshots, planSnapshotRestore } from "../runtime.js";
import { CONTRACT_VERSION, PACKAGE_VERSION, withContract } from "../contracts.js";
import { parseInclude, parseLimit, parsePositiveInteger, parseSnapshotId } from "../validation.js";
import { formatMcpToolResult, type DisplayKind, type DisplayOptions } from "../display.js";

interface JsonRpcRequest {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const tools = [
  {
    name: "capture_snapshot",
    description: "Capture a local runtime snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        include: { type: "array", items: { type: "string" } },
        includePaneTail: { type: "boolean" },
        maxPaneTailChars: { type: "number" },
        verbose: { type: "boolean" },
        format: { type: "string", enum: ["compact", "json"] }
      }
    }
  },
  {
    name: "list_snapshots",
    description: "List stored snapshots.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number" },
        verbose: { type: "boolean" },
        format: { type: "string", enum: ["compact", "json"] }
      }
    }
  },
  {
    name: "get_snapshot",
    description: "Get a snapshot and its resources.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        limit: { type: "number", description: "Maximum resources to include in compact output." },
        verbose: { type: "boolean" },
        format: { type: "string", enum: ["compact", "json"] }
      }
    }
  },
  {
    name: "get_resume_context",
    description: "Get a compact, bounded context for resuming work from a snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Snapshot id or latest." },
        maxPaneTailChars: { type: "number" },
        verbose: { type: "boolean" },
        format: { type: "string", enum: ["compact", "json"] }
      }
    }
  },
  {
    name: "plan_restore",
    description: "Build a dry-run restore plan for a snapshot.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        limit: { type: "number", description: "Maximum operations to include in compact output." },
        verbose: { type: "boolean" },
        format: { type: "string", enum: ["compact", "json"] }
      }
    }
  },
  {
    name: "list_restore_plans",
    description: "List stored restore plans.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number" },
        verbose: { type: "boolean" },
        format: { type: "string", enum: ["compact", "json"] }
      }
    }
  },
  {
    name: "get_restore_plan",
    description: "Get a stored restore plan by id.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        limit: { type: "number", description: "Maximum operations to include in compact output." },
        verbose: { type: "boolean" },
        format: { type: "string", enum: ["compact", "json"] }
      }
    }
  }
];

export async function handle(request: JsonRpcRequest) {
  if (request.method === "initialize") {
    return withContract({
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "@hasna/snapshots", version: PACKAGE_VERSION }
    });
  }
  if (request.method === "tools/list") {
    return withContract({ tools });
  }
  if (request.method === "tools/call") {
    const name = String(request.params?.name ?? "");
    const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
    const result = await callTool(name, args);
    return {
      content: [{ type: "text", text: formatMcpToolResult(displayKindForTool(name), result, mcpDisplayOptions(args)) }]
    };
  }
  return {};
}

async function callTool(name: string, args: Record<string, unknown>) {
  rejectDbPath(args);
  if (name === "capture_snapshot") {
    return captureSnapshot({
      name: typeof args.name === "string" ? args.name : undefined,
      include: parseInclude(args.include),
      includePaneTail: args.includePaneTail === true,
      maxPaneTailChars: args.maxPaneTailChars == null
        ? undefined
        : parsePositiveInteger(args.maxPaneTailChars, "maxPaneTailChars", { maxValue: 16_000 })
    });
  }
  if (name === "list_snapshots") {
    const limit = mcpLimit(args, 20, 50, 500);
    const snapshots = listSnapshots({ limit });
    if (isFullMcpOutput(args)) return withContract({ snapshots });
    return withContract({ snapshots, total: countSnapshots(), limit });
  }
  if (name === "get_snapshot") {
    return getSnapshotEnvelope({ id: parseSnapshotId(args.id) });
  }
  if (name === "get_resume_context") {
    return getResumeContext({
      id: parseSnapshotId(args.id ?? "latest", "snapshot id", { allowLatest: true }),
      maxPaneTailChars: args.maxPaneTailChars == null
        ? undefined
        : parsePositiveInteger(args.maxPaneTailChars, "maxPaneTailChars", { maxValue: 16_000 })
    });
  }
  if (name === "plan_restore") {
    return planSnapshotRestore({ id: parseSnapshotId(args.id) });
  }
  if (name === "list_restore_plans") {
    const limit = mcpLimit(args, 20, 50, 500);
    const plans = listRestorePlans({ limit });
    if (isFullMcpOutput(args)) return plans;
    return { ...plans, total: countRestorePlans(), limit };
  }
  if (name === "get_restore_plan") {
    return getRestorePlan({ id: parseSnapshotId(args.id, "restore plan id") });
  }
  throw new Error(`Unknown tool: ${name}`);
}

function rejectDbPath(args: Record<string, unknown>): void {
  if (args.dbPath !== undefined) {
    throw new Error("MCP tools do not accept dbPath; configure HASNA_SNAPSHOTS_DB_PATH for the server process instead.");
  }
}

function displayKindForTool(name: string): DisplayKind {
  if (name === "capture_snapshot") return "capture";
  if (name === "list_snapshots") return "snapshots-list";
  if (name === "get_snapshot") return "snapshot-show";
  if (name === "get_resume_context") return "resume";
  if (name === "plan_restore") return "restore-plan";
  if (name === "list_restore_plans") return "restore-plans-list";
  if (name === "get_restore_plan") return "restore-plan";
  return "doctor";
}

function mcpDisplayOptions(args: Record<string, unknown>): DisplayOptions {
  return {
    json: args.format === "json" || args.json === true,
    verbose: args.verbose === true,
    limit: parseLimit(args.limit, 20, 1_000)
  };
}

function mcpLimit(args: Record<string, unknown>, compactDefault: number, jsonDefault: number, maxValue: number): number {
  return parseLimit(args.limit, isFullMcpOutput(args) ? jsonDefault : compactDefault, maxValue);
}

function isFullMcpOutput(args: Record<string, unknown>): boolean {
  return args.format === "json" || args.json === true || args.verbose === true;
}

async function main(): Promise<void> {
  process.stdin.setEncoding("utf8");
  let buffer = "";
  for await (const chunk of process.stdin) {
    buffer += String(chunk);
    let newlineIndex = buffer.search(/\r?\n/);
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(buffer[newlineIndex] === "\r" ? newlineIndex + 2 : newlineIndex + 1);
      if (line) await handleLine(line);
      newlineIndex = buffer.search(/\r?\n/);
    }
  }
  if (buffer.trim()) await handleLine(buffer.trim());
}

async function handleLine(line: string): Promise<void> {
  let id: JsonRpcRequest["id"] = null;
  try {
    const request = JSON.parse(line) as JsonRpcRequest;
    id = request.id ?? null;
    const result = await handle(request);
    console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
  } catch (error) {
    console.log(JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
        data: { contract_version: CONTRACT_VERSION }
      }
    }));
  }
}

if (import.meta.main) {
  await main();
}
