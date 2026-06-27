#!/usr/bin/env bun
import { captureSnapshot, getSnapshotEnvelope, listSnapshots, planSnapshotRestore } from "../runtime.js";

const port = Number(process.env.SNAPSHOTS_PORT ?? process.env.PORT ?? 7337);

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function pathParts(url: URL): string[] {
  return url.pathname.split("/").filter(Boolean);
}

Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    const parts = pathParts(url);
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true, service: "@hasna/snapshots" });
      }
      if (request.method === "GET" && url.pathname === "/snapshots") {
        return json({ snapshots: listSnapshots({ limit: Number(url.searchParams.get("limit") ?? 50) }) });
      }
      if (request.method === "POST" && url.pathname === "/snapshots") {
        const body = await readBody(request);
        return json(await captureSnapshot({
          name: typeof body.name === "string" ? body.name : undefined,
          include: Array.isArray(body.include) ? body.include.map(String) : undefined
        }));
      }
      if (request.method === "GET" && parts[0] === "snapshots" && parts[1]) {
        return json(getSnapshotEnvelope({ id: parts[1] }));
      }
      if (request.method === "POST" && parts[0] === "restore" && parts[1] === "plan" && parts[2]) {
        const body = await readBody(request);
        return json(planSnapshotRestore({
          id: parts[2],
          include: Array.isArray(body.include) ? body.include.map(String) : undefined,
          exclude: Array.isArray(body.exclude) ? body.exclude.map(String) : undefined,
          dependencyMode: body.dependencyMode === "parents" || body.dependencyMode === "full" ? body.dependencyMode : "none",
          targetMode: body.targetMode === "merge-existing" ? "merge-existing" : "strict",
          tmuxMode: body.tmuxMode === "resume-marked" ? "resume-marked" : "layout-only"
        }));
      }
      return json({ ok: false, error: "not found" }, 404);
    } catch (error) {
      return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
    }
  }
});

console.log(JSON.stringify({ event: "listening", port }));

async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.includes("application/json")) return {};
  return (await request.json()) as Record<string, unknown>;
}
