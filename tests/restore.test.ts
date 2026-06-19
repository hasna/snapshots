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

  test("explicit restartable processes are restorable without broad process policy", () => {
    const resource: StoredSnapshotResource = {
      id: "process:agent-1",
      kind: "process",
      name: "mock-agent",
      source: "processes",
      attributes: {
        restartable: true,
        process_id: "agent-1",
        restart_command: "env HASNA_SNAPSHOTS_RESTARTABLE=1 HASNA_SNAPSHOTS_PROCESS_ID=agent-1 sleep 60"
      },
      observedAt: "2026-06-19T00:00:00.000Z",
      hash: "resource-hash"
    };

    const plan = createRestorePlan(snapshot, [resource]);

    expect(plan.summary.planned).toBe(1);
    expect(plan.operations[0].kind).toBe("process.restart");
    expect(plan.operations[0].command).toEqual([
      "sh",
      "-lc",
      "env HASNA_SNAPSHOTS_RESTARTABLE=1 HASNA_SNAPSHOTS_PROCESS_ID=agent-1 sleep 60"
    ]);
  });

  test("tmux windows are planned after their session", () => {
    const session: StoredSnapshotResource = {
      id: "tmux-session:restore-test",
      kind: "tmux-session",
      name: "restore-test",
      source: "tmux",
      attributes: { cwd: "/tmp" },
      observedAt: "2026-06-19T00:00:00.000Z",
      hash: "session-hash"
    };
    const window: StoredSnapshotResource = {
      id: "tmux-window:restore-test:0",
      kind: "tmux-window",
      name: "restore-test:0:agent",
      source: "tmux",
      parentId: session.id,
      attributes: {
        session: "restore-test",
        index: 0,
        name: "agent",
        current_path: "/tmp",
        restartable: true,
        start_command: "env HASNA_SNAPSHOTS_RESTARTABLE=1 HASNA_SNAPSHOTS_PROCESS_ID=agent-window sleep 60",
        active: true,
        layout: "tiled",
        pane_count: 2
      },
      observedAt: "2026-06-19T00:00:00.000Z",
      hash: "window-hash"
    };

    const plan = createRestorePlan(snapshot, [window, session]);

    expect(plan.operations.map((op) => op.kind).slice(0, 2)).toEqual(["tmux.create-session", "tmux.create-window"]);
    expect(plan.operations.map((op) => op.kind)).toContain("tmux.select-window");
    expect(plan.operations.map((op) => op.kind)).toContain("tmux.select-layout");
    expect(plan.operations[0].command).toContain("-n");
    expect(plan.operations[0].command?.at(-1)).toContain("HASNA_SNAPSHOTS_RESTARTABLE=1");
    expect(plan.operations[1].command?.at(-1)).toContain("HASNA_SNAPSHOTS_RESTARTABLE=1");
  });

  test("tmux restore commands can target an isolated socket", () => {
    process.env.HASNA_SNAPSHOTS_TMUX_SOCKET = "snapshots-unit";
    try {
      const session: StoredSnapshotResource = {
        id: "tmux-session:socket-test",
        kind: "tmux-session",
        name: "socket-test",
        source: "tmux",
        attributes: { cwd: "/tmp" },
        observedAt: "2026-06-19T00:00:00.000Z",
        hash: "session-hash"
      };

      const plan = createRestorePlan(snapshot, [session]);

      expect(plan.operations[0].command?.slice(0, 3)).toEqual(["tmux", "-L", "snapshots-unit"]);
    } finally {
      delete process.env.HASNA_SNAPSHOTS_TMUX_SOCKET;
    }
  });

  test("additional tmux panes are restored after windows", () => {
    const initialPane: StoredSnapshotResource = {
      id: "tmux-pane:restore-test:1",
      kind: "tmux-pane",
      name: "restore-test:%1",
      source: "tmux",
      parentId: "tmux-window:restore-test:0",
      attributes: {
        session: "restore-test",
        window_index: 0,
        pane_index: 1,
        current_path: "/tmp"
      },
      observedAt: "2026-06-19T00:00:00.000Z",
      hash: "initial-pane-hash"
    };
    const pane: StoredSnapshotResource = {
      id: "tmux-pane:restore-test:2",
      kind: "tmux-pane",
      name: "restore-test:%2",
      source: "tmux",
      parentId: "tmux-window:restore-test:0",
      attributes: {
        session: "restore-test",
        window_index: 0,
        pane_index: 2,
        current_path: "/tmp",
        restartable: true,
        start_command: "env HASNA_SNAPSHOTS_RESTARTABLE=1 HASNA_SNAPSHOTS_PROCESS_ID=agent-pane sleep 60"
      },
      observedAt: "2026-06-19T00:00:00.000Z",
      hash: "pane-hash"
    };

    const plan = createRestorePlan(snapshot, [initialPane, pane]);

    expect(plan.operations.map((op) => op.kind)).toContain("tmux.initial-pane");
    expect(plan.operations.map((op) => op.kind)).toContain("tmux.create-pane");
    expect(plan.operations.find((op) => op.kind === "tmux.create-pane")?.command?.at(-1)).toContain("HASNA_SNAPSHOTS_RESTARTABLE=1");
  });

  test("broad app policies do not reopen every visible app", () => {
    const resource: StoredSnapshotResource = {
      id: "app:fixture",
      kind: "app",
      name: "fixture-app",
      source: "test",
      attributes: {
        name: "fixture-app",
        platform: "linux",
        restore_command: ["sh", "-lc", "true"]
      },
      observedAt: "2026-06-19T00:00:00.000Z",
      hash: "app-hash"
    };

    const plan = createRestorePlan(snapshot, [resource], [{ selector: "kind:app", mode: "restore", updatedAt: "2026-06-19T00:00:00.000Z" }]);

    expect(plan.summary.skipped).toBe(1);
    expect(plan.operations[0].kind).toBe("app.observe");
  });

  test("per-app policies can restore explicit app commands", () => {
    const resource: StoredSnapshotResource = {
      id: "app:fixture",
      kind: "app",
      name: "fixture-app",
      source: "test",
      attributes: {
        name: "fixture-app",
        platform: "linux",
        restore_command: ["sh", "-lc", "true"]
      },
      observedAt: "2026-06-19T00:00:00.000Z",
      hash: "app-hash"
    };

    const plan = createRestorePlan(snapshot, [resource], [{ selector: "app:fixture", mode: "restore", updatedAt: "2026-06-19T00:00:00.000Z" }]);

    expect(plan.summary.planned).toBe(1);
    expect(plan.operations[0].command).toEqual(["sh", "-lc", "true"]);
  });

  test("restartable processes without explicit restart commands are blocked", () => {
    const resource: StoredSnapshotResource = {
      id: "process:agent-2",
      kind: "process",
      name: "mock-agent",
      source: "processes",
      attributes: {
        restartable: true,
        process_id: "agent-2",
        restart_command: null
      },
      observedAt: "2026-06-19T00:00:00.000Z",
      hash: "resource-hash"
    };

    const plan = createRestorePlan(snapshot, [resource]);

    expect(plan.summary.blocked).toBe(1);
    expect(plan.operations[0].kind).toBe("process.restart");
    expect(plan.operations[0].reason).toContain("HASNA_SNAPSHOTS_RESTART_COMMAND_B64");
    expect(plan.operations[0].reason).toContain("HASNA_SNAPSHOTS_RESTART_COMMAND_FILE");
  });
});
