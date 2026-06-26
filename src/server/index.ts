#!/usr/bin/env bun
import { captureSnapshot, getRestorePlan, getResumeContext, getSnapshotEnvelope, listRestorePlans, listSnapshots, planSnapshotRestore } from "../runtime.js";
import { PACKAGE_NAME, PACKAGE_VERSION, withContract } from "../contracts.js";
import { parseInclude, parseLimit, parsePositiveInteger, parseSnapshotId } from "../validation.js";

const port = Number(process.env.SNAPSHOTS_PORT ?? process.env.PORT ?? 7337);
const hostname = process.env.SNAPSHOTS_HOST ?? process.env.HOST ?? "127.0.0.1";
const authToken = process.env.SNAPSHOTS_TOKEN;
const allowUnauthenticated = process.env.SNAPSHOTS_ALLOW_UNAUTHENTICATED === "1";
const maxBodyBytes = 64 * 1024;

if (!isLoopbackHost(hostname) && process.env.SNAPSHOTS_ALLOW_NON_LOOPBACK !== "1") {
  throw new Error("Non-loopback HTTP binding requires SNAPSHOTS_ALLOW_NON_LOOPBACK=1.");
}

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
  hostname,
  async fetch(request) {
    const url = new URL(request.url);
    const parts = pathParts(url);
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return json(withContract({ ok: true, service: PACKAGE_NAME, package_version: PACKAGE_VERSION }));
      }
      const authError = authorize(request);
      if (authError) return authError;
      if (request.method === "GET" && url.pathname === "/snapshots") {
        return json(withContract({ snapshots: listSnapshots({ limit: parseLimit(url.searchParams.get("limit"), 50, 500) }) }));
      }
      if (request.method === "POST" && url.pathname === "/snapshots") {
        const body = await readBody(request);
        return json(await captureSnapshot({
          name: typeof body.name === "string" ? body.name : undefined,
          include: parseInclude(body.include),
          includePaneTail: body.includePaneTail === true,
          maxPaneTailChars: body.maxPaneTailChars == null
            ? undefined
            : parsePositiveInteger(body.maxPaneTailChars, "maxPaneTailChars", { maxValue: 16_000 })
        }));
      }
      if (request.method === "GET" && parts[0] === "snapshots" && parts[1]) {
        return json(getSnapshotEnvelope({ id: parseSnapshotId(parts[1]) }));
      }
      if (request.method === "GET" && parts[0] === "resume") {
        return json(getResumeContext({
          id: parseSnapshotId(parts[1] ?? "latest", "snapshot id", { allowLatest: true }),
          maxPaneTailChars: parsePositiveInteger(url.searchParams.get("paneTailChars"), "paneTailChars", {
            defaultValue: 1_200,
            maxValue: 16_000
          })
        }));
      }
      if (request.method === "GET" && url.pathname === "/plans") {
        return json(listRestorePlans({ limit: parseLimit(url.searchParams.get("limit"), 50, 500) }));
      }
      if (request.method === "GET" && parts[0] === "plans" && parts[1]) {
        return json(getRestorePlan({ id: parseSnapshotId(parts[1], "restore plan id") }));
      }
      if (request.method === "POST" && parts[0] === "restore" && parts[1] === "plan" && parts[2]) {
        return json(planSnapshotRestore({ id: parseSnapshotId(parts[2]) }));
      }
      return json(withContract({ ok: false, error: "not found" }), 404);
    } catch (error) {
      return json(withContract({ ok: false, error: error instanceof Error ? error.message : String(error) }), 500);
    }
  }
});

console.log(JSON.stringify({ event: "listening", hostname, port }));

async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    throw new Error("POST requests require content-type: application/json.");
  }
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    throw new Error(`Request body exceeds ${maxBodyBytes} bytes.`);
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > maxBodyBytes) {
    throw new Error(`Request body exceeds ${maxBodyBytes} bytes.`);
  }
  if (!text.trim()) return {};
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function authorize(request: Request): Response | undefined {
  if (allowUnauthenticated) return undefined;
  if (!authToken) {
    return json(withContract({ ok: false, error: "SNAPSHOTS_TOKEN is required for non-health HTTP endpoints." }), 403);
  }
  if (request.headers.get("authorization") !== `Bearer ${authToken}`) {
    return json(withContract({ ok: false, error: "unauthorized" }), 401);
  }
  return undefined;
}

function isLoopbackHost(value: string): boolean {
  return value === "127.0.0.1" || value === "::1" || value === "localhost";
}
