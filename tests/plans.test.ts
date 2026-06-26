import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTRACT_VERSION } from "../src/contracts.js";
import { getRestorePlan, listRestorePlans, planSnapshotRestore } from "../src/runtime.js";
import { SnapshotStore } from "../src/storage.js";
import type { SnapshotResource } from "../src/types.js";

function tmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), "snapshots-plans-")), "snapshots.sqlite");
}

describe("restore plan history", () => {
  test("lists and retrieves stored restore plans", () => {
    const dbPath = tmpDb();
    const store = new SnapshotStore({ path: dbPath });
    const resource: SnapshotResource = {
      id: "machine:plan-test",
      kind: "machine",
      name: "plan-test",
      source: "machine",
      attributes: { hostname: "plan-test" },
      observedAt: "2026-06-19T00:00:00.000Z"
    };
    try {
      store.saveSnapshot([resource], {
        id: "snap_plan_history",
        createdAt: "2026-06-19T00:00:00.000Z"
      });
    } finally {
      store.close();
    }

    const plan = planSnapshotRestore({ dbPath, id: "snap_plan_history" });
    const listed = listRestorePlans({ dbPath });
    const fetched = getRestorePlan({ dbPath, id: plan.id });

    expect(listed.contract_version).toBe(CONTRACT_VERSION);
    expect(listed.plans[0].id).toBe(plan.id);
    expect(fetched.contract_version).toBe(CONTRACT_VERSION);
    expect(fetched.id).toBe(plan.id);
  });
});
