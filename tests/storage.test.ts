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
});
