import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SnapshotStore } from "../src/storage.js";
import type { SnapshotResource } from "../src/types.js";

function dbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "snapshots-storage-")), "snapshots.sqlite");
}

function machineResource(now = "2026-06-19T00:00:00.000Z"): SnapshotResource {
  return {
    id: "machine:test",
    kind: "machine",
    name: "test-machine",
    source: "machine",
    attributes: {
      hostname: "test-machine",
      platform: "linux"
    },
    observedAt: now
  };
}

function indexedMachineResource(index: number): SnapshotResource {
  return {
    id: `machine:test-${index}`,
    kind: "machine",
    name: `test-machine-${index}`,
    source: "machine",
    attributes: {
      hostname: `test-machine-${index}`,
      platform: "linux"
    },
    observedAt: `2026-06-19T00:00:0${index}.000Z`
  };
}

function emptyPlan(id: string, snapshotId: string, createdAt: string) {
  return {
    contract_version: 1,
    id,
    snapshotId,
    createdAt,
    apply: false,
    operations: [],
    summary: {
      planned: 0,
      noop: 0,
      blocked: 0,
      skipped: 0,
      applied: 0,
      failed: 0
    }
  };
}

describe("SnapshotStore", () => {
  test("stores snapshots and dedupes equivalent resource state", () => {
    const store = new SnapshotStore({ path: dbPath() });
    try {
      const first = store.saveSnapshot([machineResource()], { name: "first", createdAt: "2026-06-19T00:00:00.000Z" });
      const second = store.saveSnapshot([machineResource("2026-06-19T01:00:00.000Z")], {
        name: "second",
        createdAt: "2026-06-19T01:00:00.000Z"
      });

      expect(first.id).toBe(second.id);
      expect(second.duplicateOf).toBe(first.id);
      expect(store.listSnapshots()).toHaveLength(1);
      expect(store.getSnapshotResources(first.id)[0].hash).toBeTruthy();
    } finally {
      store.close();
    }
  });

  test("persists and lists restore policies", () => {
    const store = new SnapshotStore({ path: dbPath() });
    try {
      store.upsertPolicy("kind:process", "ignore", "processes are observe-only");
      expect(store.listPolicies()).toMatchObject([
        {
          selector: "kind:process",
          mode: "ignore",
          reason: "processes are observe-only"
        }
      ]);
    } finally {
      store.close();
    }
  });

  test("reports ops state and database integrity", () => {
    const store = new SnapshotStore({ path: dbPath() });
    try {
      store.saveSnapshot([machineResource()], {
        id: "snap_ops_state",
        createdAt: "2026-06-19T00:00:00.000Z"
      });

      const integrity = store.checkIntegrity({ now: "2026-06-19T01:00:00.000Z" });
      expect(integrity.ok).toBe(true);
      expect(integrity.mode).toBe("quick");
      expect(integrity.checks.map((check) => check.name)).toContain("quick_check");
      expect(integrity.raw_artifacts[0]?.path).toContain("snapshots.sqlite");

      const state = store.getOpsState({ now: "2026-06-19T01:00:00.000Z" });
      expect(state.ok).toBe(true);
      expect(state.counts.snapshots).toBe(1);
      expect(state.latest_snapshot?.id).toBe("snap_ops_state");
      expect(state.resource_kinds).toEqual([{ kind: "machine", count: 1 }]);
      expect(state.integrity?.ok).toBe(true);
    } finally {
      store.close();
    }
  });

  test("retention plans are bounded and apply only with explicit yes", () => {
    const store = new SnapshotStore({ path: dbPath() });
    try {
      for (let index = 0; index < 4; index += 1) {
        const snapshotId = `snap_retention_${index}`;
        store.saveSnapshot([indexedMachineResource(index)], {
          id: snapshotId,
          createdAt: `2026-06-19T00:00:0${index}.000Z`
        });
        store.saveRestorePlan(emptyPlan(`plan_retention_${index}`, snapshotId, `2026-06-19T00:01:0${index}.000Z`));
      }

      const dryRun = store.planRetention({ keepSnapshots: 2, keepPlans: 1, limit: 1 });
      expect(dryRun.summary.snapshots_to_delete).toBe(2);
      expect(dryRun.summary.restore_plans_to_delete).toBe(3);
      expect(dryRun.summary.resources_to_delete).toBe(2);
      expect(dryRun.snapshot_ids).toHaveLength(1);
      expect(dryRun.truncated).toBe(true);
      expect((dryRun as unknown as Record<string, unknown>).snapshot_ids_full).toBeUndefined();
      expect(store.countSnapshots()).toBe(4);

      const blocked = store.applyRetention({ keepSnapshots: 2, keepPlans: 1 });
      expect(blocked.summary.blocked).toBe(1);
      expect(blocked.applied).toBe(false);
      expect((blocked as unknown as Record<string, unknown>).snapshot_ids_full).toBeUndefined();
      expect(store.countSnapshots()).toBe(4);

      const mismatch = store.applyRetention({ keepSnapshots: 2, keepPlans: 1, yes: true, expectedPlanId: "ret_old_reviewed_plan" });
      expect(mismatch.summary.blocked).toBe(1);
      expect(mismatch.safety.blocked_reason).toContain("mismatch");
      expect(store.countSnapshots()).toBe(4);

      const applied = store.applyRetention({ keepSnapshots: 2, keepPlans: 1, yes: true, expectedPlanId: dryRun.id });
      expect(applied.applied).toBe(true);
      expect(applied.summary.snapshots_deleted).toBe(2);
      expect(applied.summary.restore_plans_deleted).toBe(3);
      expect(applied.summary.resources_deleted).toBe(2);
      expect(store.countSnapshots()).toBe(2);
      expect(store.countResources()).toBe(2);
      expect(store.countRestorePlans()).toBe(1);
    } finally {
      store.close();
    }
  });
});
