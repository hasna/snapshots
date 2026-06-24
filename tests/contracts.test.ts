import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTRACT_VERSION, PACKAGE_VERSION } from "../src/contracts.js";
import * as rootExports from "../src/index.js";
import { captureSnapshot, listResources, planSnapshotRestore } from "../src/runtime.js";
import { handle } from "../src/mcp/index.js";

function tmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), "snapshots-contracts-")), "snapshots.sqlite");
}

describe("JSON contract metadata", () => {
  test("package version constant stays in sync with package.json", () => {
    const packageJson = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { version: string };

    expect(PACKAGE_VERSION).toBe(packageJson.version);
  });

  test("root SDK exports runtime helpers", () => {
    expect(rootExports.captureSnapshot).toBe(captureSnapshot);
    expect(typeof rootExports.planSnapshotRestore).toBe("function");
  });

  test("runtime envelopes and restore plans include contract_version", async () => {
    const dbPath = tmpDb();
    const captured = await captureSnapshot({
      dbPath,
      include: ["machine"],
      now: "2026-06-19T00:00:00.000Z",
      name: "contract-fixture"
    });
    const resources = listResources({ dbPath });
    const plan = planSnapshotRestore({ dbPath, id: captured.snapshot.id });

    expect(captured.contract_version).toBe(CONTRACT_VERSION);
    expect(resources.contract_version).toBe(CONTRACT_VERSION);
    expect(plan.contract_version).toBe(CONTRACT_VERSION);
  });

  test("MCP initialize and tools/list include current contract metadata", async () => {
    const initialized = await handle({ method: "initialize" }) as {
      contract_version: number;
      serverInfo: { version: string };
    };
    const tools = await handle({ method: "tools/list" }) as { contract_version: number; tools: unknown[] };

    expect(initialized.contract_version).toBe(CONTRACT_VERSION);
    expect(initialized.serverInfo.version).toBe(PACKAGE_VERSION);
    expect(tools.contract_version).toBe(CONTRACT_VERSION);
    expect(tools.tools.length).toBeGreaterThan(0);
  });
});
