#!/usr/bin/env bun
import { captureSnapshot, getSnapshotEnvelope, listSnapshots, planSnapshotRestore } from "../runtime.js";

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
        dbPath: { type: "string" }
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
        dbPath: { type: "string" }
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
        include: { type: "array", items: { type: "string" } },
        exclude: { type: "array", items: { type: "string" } },
        dependencyMode: { type: "string", enum: ["none", "parents", "full"] },
        targetMode: { type: "string", enum: ["strict", "merge-existing"] },
        tmuxMode: { type: "string", enum: ["layout-only", "resume-marked"] },
        dbPath: { type: "string" }
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
        dbPath: { type: "string" }
      }
    }
  }
];

async function handle(request: JsonRpcRequest) {
  if (request.method === "initialize") {
    return {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "@hasna/snapshots", version: "0.1.2" }
    };
  }
  if (request.method === "tools/list") {
    return { tools };
  }
  if (request.method === "tools/call") {
    const name = String(request.params?.name ?? "");
    const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
    const result = await callTool(name, args);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
    };
  }
  return {};
}

async function callTool(name: string, args: Record<string, unknown>) {
  const dbPath = typeof args.dbPath === "string" ? args.dbPath : undefined;
  if (name === "capture_snapshot") {
    return captureSnapshot({
      dbPath,
      name: typeof args.name === "string" ? args.name : undefined,
      include: Array.isArray(args.include) ? args.include.map(String) : undefined
    });
  }
  if (name === "list_snapshots") {
    return { snapshots: listSnapshots({ dbPath, limit: typeof args.limit === "number" ? args.limit : undefined }) };
  }
  if (name === "get_snapshot") {
    return getSnapshotEnvelope({ dbPath, id: String(args.id) });
  }
  if (name === "plan_restore") {
    return planSnapshotRestore({
      dbPath,
      id: String(args.id),
      include: Array.isArray(args.include) ? args.include.map(String) : undefined,
      exclude: Array.isArray(args.exclude) ? args.exclude.map(String) : undefined,
      dependencyMode: args.dependencyMode === "parents" || args.dependencyMode === "full" ? args.dependencyMode : "none",
      targetMode: args.targetMode === "merge-existing" ? "merge-existing" : "strict",
      tmuxMode: args.tmuxMode === "resume-marked" ? "resume-marked" : "layout-only"
    });
  }
  throw new Error(`Unknown tool: ${name}`);
}

async function main(): Promise<void> {
  const input = await new Response(Bun.stdin.stream()).text();
  for (const line of input.split(/\r?\n/).filter((candidate) => candidate.trim())) {
    const request = JSON.parse(line) as JsonRpcRequest;
    try {
      const result = await handle(request);
      console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id ?? null, result }));
    } catch (error) {
      console.log(JSON.stringify({
        jsonrpc: "2.0",
        id: request.id ?? null,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : String(error)
        }
      }));
    }
  }
}

if (import.meta.main) {
  await main();
}
