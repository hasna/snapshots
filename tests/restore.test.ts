import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRestorePlan } from "../src/restore.js";
import type { SnapshotRecord, StoredSnapshotResource } from "../src/types.js";

const snapshot: SnapshotRecord = {
  id: "snap_test",
  hash: "abc",
  createdAt: "2026-06-19T00:00:00.000Z",
  resourceCount: 1,
  summary: {}
};

describe("restore planning", () => {
  test("plans a guarded project directory restore", () => {
    const path = join(mkdtempSync(join(tmpdir(), "snapshots-restore-")), "project");
    const resource: StoredSnapshotResource = {
      id: "project:test",
      kind: "project",
      name: "test-project",
      source: "projects",
      attributes: { path },
      observedAt: "2026-06-19T00:00:00.000Z",
      hash: "resource-hash"
    };

    const plan = createRestorePlan(snapshot, [resource]);

    expect(plan.summary.planned).toBe(1);
    expect(plan.operations[0].kind).toBe("project.mkdir");
    expect(plan.operations[0].command).toEqual(["mkdir", "-p", path]);
  });

  test("apply without yes blocks planned operations", () => {
    const path = join(mkdtempSync(join(tmpdir(), "snapshots-restore-")), "project");
    const resource: StoredSnapshotResource = {
      id: "project:test",
      kind: "project",
      name: "test-project",
      source: "projects",
      attributes: { path },
      observedAt: "2026-06-19T00:00:00.000Z",
      hash: "resource-hash"
    };

    const plan = createRestorePlan(snapshot, [resource], [], { apply: true });

    expect(plan.summary.blocked).toBe(1);
    expect(plan.operations[0].reason).toContain("--apply --yes");
  });

  test("process resources are skipped by the default observe policy", () => {
    const resource: StoredSnapshotResource = {
      id: "process:1",
      kind: "process",
      name: "bash",
      source: "processes",
      attributes: { pid: 1 },
      observedAt: "2026-06-19T00:00:00.000Z",
      hash: "resource-hash"
    };

    const plan = createRestorePlan(snapshot, [resource]);

    expect(plan.summary.skipped).toBe(1);
    expect(plan.operations[0].status).toBe("skipped");
  });
});
