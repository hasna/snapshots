import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applySavedRestorePlan, planSnapshotRestore } from "../src/runtime.js";
import { SnapshotStore } from "../src/storage.js";
import type { SnapshotResource } from "../src/types.js";

function dbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "snapshots-runtime-")), "snapshots.sqlite");
}

describe("runtime restore plans", () => {
  test("saves immutable granular plans and applies them by id/hash", () => {
    const path = dbPath();
    const projectPath = join(mkdtempSync(join(tmpdir(), "snapshots-runtime-project-")), "project");
    const resource: SnapshotResource = {
      id: "project:saved-plan",
      kind: "project",
      name: "saved-plan",
      source: "projects",
      attributes: { path: projectPath },
      observedAt: "2026-06-19T00:00:00.000Z"
    };
    const store = new SnapshotStore({ path });
    try {
      store.saveSnapshot([resource], {
        id: "snap_saved_plan",
        createdAt: "2026-06-19T00:00:00.000Z"
      });
    } finally {
      store.close();
    }

    const plan = planSnapshotRestore({ dbPath: path, id: "snap_saved_plan", include: ["kind:project"] });
    const blocked = applySavedRestorePlan({ dbPath: path, planId: plan.id, planHash: plan.planHash, apply: true });
    const applied = applySavedRestorePlan({ dbPath: path, planId: plan.id, planHash: plan.planHash, apply: true, yes: true });
    const auditStore = new SnapshotStore({ path });
    const runCount = auditStore.db.query("SELECT count(*) AS count FROM restore_runs WHERE plan_id = ?").get(plan.id) as { count: number };
    const savedPlan = auditStore.getRestorePlan(plan.id);
    auditStore.close();

    expect(plan.planHash).toBeTruthy();
    expect(plan.operations).toHaveLength(1);
    expect(blocked.summary.blocked).toBe(1);
    expect(applied.summary.applied).toBe(1);
    expect(savedPlan?.summary.planned).toBe(1);
    expect(Number(runCount.count)).toBe(2);
    expect(() => applySavedRestorePlan({ dbPath: path, planId: plan.id, planHash: "bad" })).toThrow("hash mismatch");
    expect(() => applySavedRestorePlan({ dbPath: path, planId: plan.id, apply: true })).toThrow("--plan-hash");
  });

  test("uses distinct plan ids for distinct restore requests", () => {
    const path = dbPath();
    const projectPath = join(mkdtempSync(join(tmpdir(), "snapshots-plan-id-project-")), "project");
    const resource: SnapshotResource = {
      id: "project:plan-id",
      kind: "project",
      name: "plan-id",
      source: "projects",
      attributes: { path: projectPath },
      observedAt: "2026-06-19T00:00:00.000Z"
    };
    const store = new SnapshotStore({ path });
    try {
      store.saveSnapshot([resource], {
        id: "snap_plan_id",
        createdAt: "2026-06-19T00:00:00.000Z"
      });
    } finally {
      store.close();
    }

    const byKind = planSnapshotRestore({ dbPath: path, id: "snap_plan_id", include: ["kind:project"] });
    const byId = planSnapshotRestore({ dbPath: path, id: "snap_plan_id", include: ["project:plan-id"] });

    expect(byKind.id).not.toBe(byId.id);
    expect(byKind.planHash).not.toBe(byId.planHash);
  });
});
