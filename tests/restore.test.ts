import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRestorePlan } from "../src/restore.js";
import { commandExists, runCommand } from "../src/util.js";
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

    const plan = createRestorePlan(snapshot, [window, session], [], { tmuxMode: "resume-marked" });

    expect(plan.operations.map((op) => op.kind).slice(0, 3)).toEqual(["tmux.create-session", "tmux.move-window", "tmux.create-window"]);
    expect(plan.operations.map((op) => op.kind)).toContain("tmux.select-window");
    expect(plan.operations.map((op) => op.kind)).toContain("tmux.select-layout");
    expect(plan.operations[0].command).toContain("-n");
    expect(plan.operations[0].command?.at(-1)).toContain("HASNA_SNAPSHOTS_RESTARTABLE=1");
    expect(plan.operations[2].command?.at(-1)).toContain("HASNA_SNAPSHOTS_RESTARTABLE=1");
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

    const plan = createRestorePlan(snapshot, [initialPane, pane], [], { tmuxMode: "resume-marked" });

    expect(plan.operations.map((op) => op.kind)).toContain("tmux.initial-pane");
    expect(plan.operations.map((op) => op.kind)).toContain("tmux.create-pane");
    expect(plan.operations.find((op) => op.kind === "tmux.create-pane")?.command?.at(-1)).toContain("HASNA_SNAPSHOTS_RESTARTABLE=1");
  });

  test("tmux layout-only mode does not replay captured restart commands by default", () => {
    const window: StoredSnapshotResource = {
      id: "tmux-window:layout-only:0",
      kind: "tmux-window",
      name: "layout-only:0:agent",
      source: "tmux",
      parentId: "tmux-session:layout-only",
      attributes: {
        session: "layout-only",
        index: 0,
        name: "agent",
        current_path: "/tmp",
        restartable: true,
        start_command: "env HASNA_SNAPSHOTS_RESTARTABLE=1 HASNA_SNAPSHOTS_PROCESS_ID=layout-only sleep 60"
      },
      observedAt: "2026-06-19T00:00:00.000Z",
      hash: "window-hash"
    };

    const plan = createRestorePlan(snapshot, [window]);
    const createWindow = plan.operations.find((op) => op.kind === "tmux.create-window");

    expect(createWindow?.command?.join(" ")).not.toContain("HASNA_SNAPSHOTS_RESTARTABLE=1");
    expect(createWindow?.warnings).toContain("Captured restartable command was not replayed because tmux mode is layout-only.");
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

  test("filters restore plans with one-shot resource selectors", () => {
    const project: StoredSnapshotResource = {
      id: "project:selected",
      kind: "project",
      name: "selected-project",
      source: "projects",
      attributes: { path: join(mkdtempSync(join(tmpdir(), "snapshots-selector-")), "selected") },
      observedAt: "2026-06-19T00:00:00.000Z",
      hash: "project-hash"
    };
    const processResource: StoredSnapshotResource = {
      id: "process:unselected",
      kind: "process",
      name: "bash",
      source: "processes",
      attributes: { pid: 123 },
      observedAt: "2026-06-19T00:00:00.000Z",
      hash: "process-hash"
    };

    const plan = createRestorePlan(snapshot, [project, processResource], [], { include: ["kind:project"] });

    expect(plan.operations).toHaveLength(1);
    expect(plan.operations[0].resourceId).toBe(project.id);
    expect(plan.matchedSelectors?.[0]).toMatchObject({ selector: "kind:project", matchedResourceIds: [project.id] });
    expect(plan.planHash).toBeTruthy();
    expect(plan.autopilot?.safeToApply).toBe(true);
    expect(plan.autopilot?.allowedOperationIds).toEqual([plan.operations[0].id]);
  });

  test("blocks selected child resources when dependency closure is omitted", () => {
    const session: StoredSnapshotResource = {
      id: "tmux-session:partial",
      kind: "tmux-session",
      name: "partial",
      source: "tmux",
      attributes: { cwd: "/tmp" },
      observedAt: "2026-06-19T00:00:00.000Z",
      hash: "session-hash"
    };
    const window: StoredSnapshotResource = {
      id: "tmux-window:partial:0",
      kind: "tmux-window",
      name: "partial:0:agent",
      source: "tmux",
      parentId: session.id,
      attributes: { session: "partial", index: 0, name: "agent", current_path: "/tmp" },
      observedAt: "2026-06-19T00:00:00.000Z",
      hash: "window-hash"
    };

    const plan = createRestorePlan(snapshot, [session, window], [], { include: [window.id] });

    expect(plan.summary.blocked).toBe(1);
    expect(plan.operations[0].kind).toBe("dependency.missing");
    expect(plan.operations[0].dependsOn).toEqual([session.id]);
    expect(plan.autopilot?.safeToApply).toBe(false);
  });

  test("auto-adds parent resources with dependency closure enabled", () => {
    const session: StoredSnapshotResource = {
      id: "tmux-session:closure",
      kind: "tmux-session",
      name: "closure",
      source: "tmux",
      attributes: { cwd: "/tmp" },
      observedAt: "2026-06-19T00:00:00.000Z",
      hash: "session-hash"
    };
    const window: StoredSnapshotResource = {
      id: "tmux-window:closure:0",
      kind: "tmux-window",
      name: "closure:0:agent",
      source: "tmux",
      parentId: session.id,
      attributes: { session: "closure", index: 0, name: "agent", current_path: "/tmp" },
      observedAt: "2026-06-19T00:00:00.000Z",
      hash: "window-hash"
    };

    const plan = createRestorePlan(snapshot, [session, window], [], {
      include: [window.id],
      dependencyMode: "parents"
    });

    expect(plan.autoAddedDependencies).toEqual([{ resourceId: session.id, requiredBy: window.id, reason: "parent dependency" }]);
    expect(plan.operations.map((op) => op.resourceId)).toContain(session.id);
    expect(plan.operations.map((op) => op.resourceId)).toContain(window.id);
  });

  test("full dependency closure expands selected tmux sessions to child resources", () => {
    const session: StoredSnapshotResource = {
      id: "tmux-session:full-closure",
      kind: "tmux-session",
      name: "full-closure",
      source: "tmux",
      attributes: { cwd: "/tmp" },
      observedAt: "2026-06-19T00:00:00.000Z",
      hash: "session-hash"
    };
    const window: StoredSnapshotResource = {
      id: "tmux-window:full-closure:0",
      kind: "tmux-window",
      name: "full-closure:0:agent",
      source: "tmux",
      parentId: session.id,
      attributes: { session: "full-closure", index: 0, name: "agent", current_path: "/tmp" },
      observedAt: "2026-06-19T00:00:00.000Z",
      hash: "window-hash"
    };
    const pane: StoredSnapshotResource = {
      id: "tmux-pane:full-closure:1",
      kind: "tmux-pane",
      name: "full-closure:%1",
      source: "tmux",
      parentId: window.id,
      attributes: { session: "full-closure", window_index: 0, pane_index: 1, current_path: "/tmp" },
      observedAt: "2026-06-19T00:00:00.000Z",
      hash: "pane-hash"
    };

    const plan = createRestorePlan(snapshot, [session, window, pane], [], {
      include: [session.id],
      dependencyMode: "full"
    });

    expect(plan.operations.map((op) => op.resourceId)).toContain(session.id);
    expect(plan.operations.map((op) => op.resourceId)).toContain(window.id);
    expect(plan.operations.map((op) => op.resourceId)).toContain(pane.id);
  });

  test("blocks tmux child restore into existing sessions unless merge is explicit", () => {
    if (!commandExists("tmux")) return;
    const socket = `snapshots-collision-${Date.now()}`;
    process.env.HASNA_SNAPSHOTS_TMUX_SOCKET = socket;
    try {
      const created = runCommand("tmux", ["-L", socket, "new-session", "-d", "-s", "collision", "-n", "existing"], 5_000);
      if (!created.ok) return;
      const session: StoredSnapshotResource = {
        id: "tmux-session:collision",
        kind: "tmux-session",
        name: "collision",
        source: "tmux",
        attributes: { cwd: "/tmp" },
        observedAt: "2026-06-19T00:00:00.000Z",
        hash: "session-hash"
      };
      const window: StoredSnapshotResource = {
        id: "tmux-window:collision:1",
        kind: "tmux-window",
        name: "collision:1:agent",
        source: "tmux",
        parentId: session.id,
        attributes: { session: "collision", index: 1, name: "agent", current_path: "/tmp" },
        observedAt: "2026-06-19T00:00:00.000Z",
        hash: "window-hash"
      };

      const strictPlan = createRestorePlan(snapshot, [session, window]);
      const mergePlan = createRestorePlan(snapshot, [session, window], [], { targetMode: "merge-existing" });

      expect(strictPlan.operations.some((op) => op.kind === "tmux.blocked-existing-session")).toBe(true);
      expect(mergePlan.operations.some((op) => op.kind === "tmux.blocked-existing-session")).toBe(false);
    } finally {
      runCommand("tmux", ["-L", socket, "kill-server"], 5_000);
      delete process.env.HASNA_SNAPSHOTS_TMUX_SOCKET;
    }
  });

  test("moves implicit first tmux window to captured index before pane restore", () => {
    if (!commandExists("tmux")) return;
    const socket = `snapshots-base-index-${Date.now()}`;
    process.env.HASNA_SNAPSHOTS_TMUX_SOCKET = socket;
    try {
      runCommand("tmux", ["-L", socket, "start-server"], 5_000);
      runCommand("tmux", ["-L", socket, "set-option", "-g", "base-index", "1"], 5_000);
      runCommand("tmux", ["-L", socket, "set-option", "-g", "pane-base-index", "0"], 5_000);
      const session: StoredSnapshotResource = {
        id: "tmux-session:base-index",
        kind: "tmux-session",
        name: "base-index",
        source: "tmux",
        attributes: { cwd: "/tmp" },
        observedAt: "2026-06-19T00:00:00.000Z",
        hash: "session-hash"
      };
      const window: StoredSnapshotResource = {
        id: "tmux-window:base-index:0",
        kind: "tmux-window",
        name: "base-index:0:main",
        source: "tmux",
        parentId: session.id,
        attributes: { session: "base-index", index: 0, name: "main", current_path: "/tmp", pane_count: 2 },
        observedAt: "2026-06-19T00:00:00.000Z",
        hash: "window-hash"
      };
      const initialPane: StoredSnapshotResource = {
        id: "tmux-pane:base-index:0",
        kind: "tmux-pane",
        name: "base-index:%0",
        source: "tmux",
        parentId: window.id,
        attributes: { session: "base-index", window_index: 0, pane_index: 1, current_path: "/tmp" },
        observedAt: "2026-06-19T00:00:00.000Z",
        hash: "initial-pane-hash"
      };
      const pane: StoredSnapshotResource = {
        id: "tmux-pane:base-index:1",
        kind: "tmux-pane",
        name: "base-index:%1",
        source: "tmux",
        parentId: window.id,
        attributes: { session: "base-index", window_index: 0, pane_index: 2, current_path: "/tmp" },
        observedAt: "2026-06-19T00:00:00.000Z",
        hash: "pane-hash"
      };

      const plan = createRestorePlan(snapshot, [session, window, initialPane, pane], [], { apply: true, yes: true });
      const windows = runCommand("tmux", ["-L", socket, "list-windows", "-t", "base-index", "-F", "#{window_index}:#{window_name}"], 5_000);

      expect(plan.operations.find((op) => op.kind === "tmux.move-window")?.status).toBe("applied");
      expect(plan.operations.find((op) => op.kind === "tmux.create-pane")?.status).toBe("applied");
      expect(windows.stdout).toContain("0:main");
    } finally {
      runCommand("tmux", ["-L", socket, "kill-server"], 5_000);
      delete process.env.HASNA_SNAPSHOTS_TMUX_SOCKET;
    }
  });

  test("marks shell replay as forbidden for autopilot", () => {
    const resource: StoredSnapshotResource = {
      id: "process:agent-forbidden",
      kind: "process",
      name: "mock-agent",
      source: "processes",
      attributes: {
        restartable: true,
        process_id: "agent-forbidden",
        restart_command: "env HASNA_SNAPSHOTS_RESTARTABLE=1 HASNA_SNAPSHOTS_PROCESS_ID=agent-forbidden sleep 60"
      },
      observedAt: "2026-06-19T00:00:00.000Z",
      hash: "resource-hash"
    };

    const plan = createRestorePlan(snapshot, [resource]);

    expect(plan.autopilot?.safeToApply).toBe(false);
    expect(plan.autopilot?.forbiddenOperationIds).toEqual([plan.operations[0].id]);
  });
});
