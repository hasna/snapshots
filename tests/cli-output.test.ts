import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli/index.js";
import { handle } from "../src/mcp/index.js";
import { SnapshotStore } from "../src/storage.js";
import type { SnapshotResource } from "../src/types.js";

function tmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), "snapshots-cli-output-")), "snapshots.sqlite");
}

function seedSnapshot(dbPath: string): string {
  const store = new SnapshotStore({ path: dbPath });
  const resources: SnapshotResource[] = [
    {
      id: "machine:compact-output",
      kind: "machine",
      name: "compact-output",
      source: "machine",
      attributes: { hostname: "compact-output" },
      observedAt: "2026-06-24T00:00:00.000Z"
    },
    {
      id: "tmux-pane:compact-output:0",
      kind: "tmux-pane",
      name: "pane-0",
      source: "tmux",
      attributes: {
        session: "work",
        window_index: 0,
        pane_index: 0,
        current_path: "/workspace/open-snapshots",
        current_command: "bun test",
        content_tail: "VERY_LONG_PANE_TAIL_SHOULD_ONLY_APPEAR_IN_JSON ".repeat(20)
      },
      observedAt: "2026-06-24T00:00:00.000Z"
    }
  ];

  try {
    const snapshot = store.saveSnapshot(resources, {
      id: "snap_compact_output",
      name: "compact-output",
      createdAt: "2026-06-24T00:00:00.000Z"
    });
    return snapshot.id;
  } finally {
    store.close();
  }
}

function seedManySnapshots(dbPath: string, count: number): void {
  const store = new SnapshotStore({ path: dbPath });
  try {
    for (let index = 0; index < count; index += 1) {
      store.saveSnapshot([
        {
          id: `machine:compact-output-${index}`,
          kind: "machine",
          name: `compact-output-${index}`,
          source: "machine",
          attributes: { hostname: `compact-output-${index}` },
          observedAt: "2026-06-24T00:00:00.000Z"
        }
      ], {
        id: `snap_compact_output_${index}`,
        name: `compact-output-${index}`,
        createdAt: `2026-06-24T00:00:${String(index).padStart(2, "0")}.000Z`
      });
    }
  } finally {
    store.close();
  }
}

function seedBlockedProjectSnapshot(dbPath: string): string {
  const store = new SnapshotStore({ path: dbPath });
  try {
    const snapshot = store.saveSnapshot([
      {
        id: "project:blocked-root",
        kind: "project",
        name: "blocked-root",
        source: "projects",
        attributes: { path: "/" },
        observedAt: "2026-06-24T00:00:00.000Z"
      }
    ], {
      id: "snap_blocked_restore_smoke",
      name: "blocked-restore-smoke",
      createdAt: "2026-06-24T00:00:00.000Z"
    });
    return snapshot.id;
  } finally {
    store.close();
  }
}

async function captureStdout(run: () => Promise<void>): Promise<string> {
  const originalLog = console.log;
  const originalExitCode = process.exitCode;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await run();
    return lines.join("\n");
  } finally {
    console.log = originalLog;
    process.exitCode = originalExitCode;
  }
}

describe("compact CLI and MCP output", () => {
  test("CLI list is compact by default and full with --json", async () => {
    const dbPath = tmpDb();
    seedSnapshot(dbPath);

    const compact = await captureStdout(() => main(["list", "--db", dbPath]));
    expect(compact).toContain("Snapshots (1 of 1 shown)");
    expect(compact).toContain("Hint: use snapshots show <id>");
    expect(compact).not.toContain("\"snapshots\"");
    expect(compact).not.toContain("\"hash\"");

    const json = await captureStdout(() => main(["list", "--db", dbPath, "--json"]));
    const parsed = JSON.parse(json) as { snapshots: Array<{ id: string; hash: string }> };
    expect(parsed.snapshots[0]?.id).toBe("snap_compact_output");
    expect(parsed.snapshots[0]?.hash).toHaveLength(64);
  });

  test("CLI and MCP list outputs report truncation when compact defaults cap rows", async () => {
    const dbPath = tmpDb();
    seedManySnapshots(dbPath, 25);

    const compact = await captureStdout(() => main(["list", "--db", dbPath]));
    expect(compact).toContain("Snapshots (20 of 25 shown)");
    expect(compact).toContain("use --limit 25");

    const originalDbPath = process.env.HASNA_SNAPSHOTS_DB_PATH;
    process.env.HASNA_SNAPSHOTS_DB_PATH = dbPath;
    try {
      const compactResponse = await handle({
        method: "tools/call",
        params: {
          name: "list_snapshots",
          arguments: {}
        }
      }) as { content: Array<{ text: string }> };
      const parsed = JSON.parse(compactResponse.content[0]?.text ?? "{}") as {
        snapshots: unknown[];
        shown: number;
        limit: number;
        total: number;
        truncated: boolean;
        has_more: boolean;
      };
      expect(parsed.snapshots).toHaveLength(20);
      expect(parsed.shown).toBe(20);
      expect(parsed.limit).toBe(20);
      expect(parsed.total).toBe(25);
      expect(parsed.truncated).toBe(true);
      expect(parsed.has_more).toBe(true);
    } finally {
      if (originalDbPath === undefined) {
        delete process.env.HASNA_SNAPSHOTS_DB_PATH;
      } else {
        process.env.HASNA_SNAPSHOTS_DB_PATH = originalDbPath;
      }
    }
  });

  test("CLI show truncates resource detail unless --json is requested", async () => {
    const dbPath = tmpDb();
    const id = seedSnapshot(dbPath);

    const compact = await captureStdout(() => main(["show", id, "--db", dbPath, "--limit", "1"]));
    expect(compact).toContain("Snapshot snap_compact_output");
    expect(compact).toContain("Resources (1 of 2 shown)");
    expect(compact).not.toContain("VERY_LONG_PANE_TAIL_SHOULD_ONLY_APPEAR_IN_JSON");
    expect(compact).not.toContain("content_tail");

    const verbose = await captureStdout(() => main(["resources", "--db", dbPath, "--verbose"]));
    expect(verbose).toContain("HASH");
    expect(verbose).toContain("observed=2026-06-24T00:00:00.000Z");
    expect(verbose).not.toContain("VERY_LONG_PANE_TAIL_SHOULD_ONLY_APPEAR_IN_JSON");
    expect(verbose).not.toContain("content_tail");

    const json = await captureStdout(() => main(["show", id, "--db", dbPath, "--json"]));
    const parsed = JSON.parse(json) as { resources: Array<{ attributes: Record<string, string> }> };
    expect(JSON.stringify(parsed.resources)).toContain("VERY_LONG_PANE_TAIL_SHOULD_ONLY_APPEAR_IN_JSON");
  });

  test("MCP get_snapshot is compact by default and full with format=json", async () => {
    const dbPath = tmpDb();
    const id = seedSnapshot(dbPath);
    const originalDbPath = process.env.HASNA_SNAPSHOTS_DB_PATH;
    process.env.HASNA_SNAPSHOTS_DB_PATH = dbPath;

    try {
      const compactResponse = await handle({
        method: "tools/call",
        params: {
          name: "get_snapshot",
          arguments: { id, limit: 1 }
        }
      }) as { content: Array<{ text: string }> };
      const compact = JSON.parse(compactResponse.content[0]?.text ?? "{}") as {
        resources: unknown[];
        resource_count: number;
        truncated: boolean;
      };
      expect(compact.resources).toHaveLength(1);
      expect(compact.resource_count).toBe(2);
      expect(compact.truncated).toBe(true);
      expect(JSON.stringify(compact)).not.toContain("VERY_LONG_PANE_TAIL_SHOULD_ONLY_APPEAR_IN_JSON");

      const fullResponse = await handle({
        method: "tools/call",
        params: {
          name: "get_snapshot",
          arguments: { id, format: "json" }
        }
      }) as { content: Array<{ text: string }> };
      const full = JSON.parse(fullResponse.content[0]?.text ?? "{}") as { resources: Array<{ attributes: Record<string, string> }> };
      expect(JSON.stringify(full.resources)).toContain("VERY_LONG_PANE_TAIL_SHOULD_ONLY_APPEAR_IN_JSON");

      const verboseResponse = await handle({
        method: "tools/call",
        params: {
          name: "get_snapshot",
          arguments: { id, verbose: true }
        }
      }) as { content: Array<{ text: string }> };
      const verbose = JSON.parse(verboseResponse.content[0]?.text ?? "{}") as { resources: Array<{ attributes: Record<string, string> }> };
      expect(JSON.stringify(verbose.resources)).toContain("VERY_LONG_PANE_TAIL_SHOULD_ONLY_APPEAR_IN_JSON");
    } finally {
      if (originalDbPath === undefined) {
        delete process.env.HASNA_SNAPSHOTS_DB_PATH;
      } else {
        process.env.HASNA_SNAPSHOTS_DB_PATH = originalDbPath;
      }
    }
  });

  test("CLI ops-state and db integrity default to compact JSON evidence", async () => {
    const dbPath = tmpDb();
    seedSnapshot(dbPath);

    const stateOutput = await captureStdout(() => main(["ops-state", "--db", dbPath]));
    expect(stateOutput).not.toContain("\n");
    const state = JSON.parse(stateOutput) as {
      counts: { snapshots: number };
      integrity: { ok: boolean };
      raw_artifacts: Array<{ path: string }>;
    };
    expect(state.counts.snapshots).toBe(1);
    expect(state.integrity.ok).toBe(true);
    expect(state.raw_artifacts[0]?.path).toContain("snapshots.sqlite");

    const integrityOutput = await captureStdout(() => main(["db", "integrity", "--full", "--db", dbPath]));
    expect(integrityOutput).not.toContain("\n");
    const integrity = JSON.parse(integrityOutput) as { ok: boolean; mode: string };
    expect(integrity.ok).toBe(true);
    expect(integrity.mode).toBe("full");
  });

  test("CLI retention is dry-run by default and applies only with yes", async () => {
    const dbPath = tmpDb();
    seedManySnapshots(dbPath, 3);

    const planOutput = await captureStdout(() => main([
      "retention",
      "plan",
      "--db",
      dbPath,
      "--keep-snapshots",
      "1",
      "--limit",
      "1"
    ]));
    const plan = JSON.parse(planOutput) as {
      id: string;
      applied: boolean;
      summary: { snapshots_to_delete: number };
      snapshot_ids: string[];
      truncated: boolean;
    };
    expect(plan.applied).toBe(false);
    expect(plan.summary.snapshots_to_delete).toBe(2);
    expect(plan.snapshot_ids).toHaveLength(1);
    expect(plan.truncated).toBe(true);

    const blockedOutput = await captureStdout(() => main([
      "retention",
      "apply",
      "--db",
      dbPath,
      "--keep-snapshots",
      "1"
    ]));
    const blocked = JSON.parse(blockedOutput) as { applied: boolean; summary: { blocked: number } };
    expect(blocked.applied).toBe(false);
    expect(blocked.summary.blocked).toBe(1);
    expect(blockedOutput).not.toContain("snapshot_ids_full");

    const mismatchOutput = await captureStdout(() => main([
      "retention",
      "apply",
      "--db",
      dbPath,
      "--keep-snapshots",
      "1",
      "--plan-id",
      "ret_stale",
      "--yes"
    ]));
    const mismatch = JSON.parse(mismatchOutput) as { applied: boolean; summary: { blocked: number } };
    expect(mismatch.applied).toBe(false);
    expect(mismatch.summary.blocked).toBe(1);

    const applyOutput = await captureStdout(() => main([
      "retention",
      "apply",
      "--db",
      dbPath,
      "--keep-snapshots",
      "1",
      "--plan-id",
      plan.id,
      "--yes"
    ]));
    const applied = JSON.parse(applyOutput) as {
      applied: boolean;
      summary: { snapshots_deleted: number };
    };
    expect(applied.applied).toBe(true);
    expect(applied.summary.snapshots_deleted).toBe(2);
  });

  test("MCP exposes ops-state, retention, and restore smoke as bounded JSON", async () => {
    const dbPath = tmpDb();
    const id = seedSnapshot(dbPath);
    const originalDbPath = process.env.HASNA_SNAPSHOTS_DB_PATH;
    process.env.HASNA_SNAPSHOTS_DB_PATH = dbPath;

    try {
      const stateResponse = await handle({
        method: "tools/call",
        params: {
          name: "get_ops_state",
          arguments: {}
        }
      }) as { content: Array<{ text: string }> };
      const state = JSON.parse(stateResponse.content[0]?.text ?? "{}") as { counts: { snapshots: number } };
      expect(state.counts.snapshots).toBe(1);

      const retentionResponse = await handle({
        method: "tools/call",
        params: {
          name: "run_retention",
          arguments: { keepSnapshots: 1, apply: true }
        }
      }) as { content: Array<{ text: string }> };
      const retention = JSON.parse(retentionResponse.content[0]?.text ?? "{}") as {
        applied: boolean;
        summary: { blocked: number };
      };
      expect(retention.applied).toBe(false);
      expect(retention.summary.blocked).toBe(1);
      expect(retentionResponse.content[0]?.text ?? "").not.toContain("snapshot_ids_full");

      const smokeResponse = await handle({
        method: "tools/call",
        params: {
          name: "restore_smoke",
          arguments: { id, limit: 1 }
        }
      }) as { content: Array<{ text: string }> };
      const smoke = JSON.parse(smokeResponse.content[0]?.text ?? "{}") as {
        ok: boolean;
        snapshot_id: string;
        dry_run: boolean;
        plan_ref: string;
      };
      expect(smoke.ok).toBe(true);
      expect(smoke.snapshot_id).toBe(id);
      expect(smoke.dry_run).toBe(true);
      expect(smoke.plan_ref).toContain("plan_");
    } finally {
      if (originalDbPath === undefined) {
        delete process.env.HASNA_SNAPSHOTS_DB_PATH;
      } else {
        process.env.HASNA_SNAPSHOTS_DB_PATH = originalDbPath;
      }
    }
  });

  test("restore-smoke marks blocked dry-run plans as not ok", async () => {
    const dbPath = tmpDb();
    const id = seedBlockedProjectSnapshot(dbPath);

    const output = await captureStdout(() => main(["restore-smoke", id, "--db", dbPath]));
    const smoke = JSON.parse(output) as {
      ok: boolean;
      safe_to_apply: boolean;
      summary: { blocked: number };
      blocked: Array<{ reason: string }>;
    };
    expect(smoke.ok).toBe(false);
    expect(smoke.safe_to_apply).toBe(false);
    expect(smoke.summary.blocked).toBe(1);
    expect(smoke.blocked[0]?.reason).toContain("filesystem root");
  });
});
