import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRestorePlan, executeRestorePlan } from "../src/restore.js";
import type { SnapshotRecord, StoredSnapshotResource } from "../src/types.js";

const snapshot: SnapshotRecord = {
  id: "snap_test",
  hash: "abc",
  createdAt: "2026-06-19T00:00:00.000Z",
  resourceCount: 1,
  summary: {}
};

function withTmuxPlanning<T>(run: () => T, socket = `snapshots-unit-${Date.now()}-${Math.random().toString(16).slice(2)}`): T {
  const previousSocket = process.env.HASNA_SNAPSHOTS_TMUX_SOCKET;
  const previousAssume = process.env.HASNA_SNAPSHOTS_TEST_ASSUME_TMUX;
  process.env.HASNA_SNAPSHOTS_TMUX_SOCKET = socket;
  process.env.HASNA_SNAPSHOTS_TEST_ASSUME_TMUX = "1";
  try {
    return run();
  } finally {
    if (previousSocket === undefined) {
      delete process.env.HASNA_SNAPSHOTS_TMUX_SOCKET;
    } else {
      process.env.HASNA_SNAPSHOTS_TMUX_SOCKET = previousSocket;
    }
    if (previousAssume === undefined) {
      delete process.env.HASNA_SNAPSHOTS_TEST_ASSUME_TMUX;
    } else {
      process.env.HASNA_SNAPSHOTS_TEST_ASSUME_TMUX = previousAssume;
    }
  }
}

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
    expect(plan.operations[0].safety.blocked_reason).toContain("--apply --yes");
  });

  test("apply with yes creates a guarded project directory", () => {
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

    const plan = createRestorePlan(snapshot, [resource], [], { apply: true, yes: true });

    expect(plan.summary.applied).toBe(1);
    expect(existsSync(path)).toBe(true);
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

  test("agent sessions are observed by default", () => {
    const resource: StoredSnapshotResource = {
      id: "agent-session:codewith:test",
      kind: "agent-session",
      name: "codewith:test",
      source: "agent-sessions:codewith",
      attributes: {
        tool: "codewith",
        session_id: "session-1",
        resume_command: ["codewith", "resume", "session-1"]
      },
      observedAt: "2026-06-19T00:00:00.000Z",
      hash: "agent-session-hash"
    };

    const plan = createRestorePlan(snapshot, [resource]);

    expect(plan.summary.skipped).toBe(1);
    expect(plan.operations[0].kind).toBe("observed");
  });

  test("per-agent-session policies can plan native resume commands", () => {
    const resource: StoredSnapshotResource = {
      id: "agent-session:codewith:test",
      kind: "agent-session",
      name: "codewith:test",
      source: "agent-sessions:codewith",
      attributes: {
        tool: "codewith",
        session_id: "session-1",
        cwd: "/tmp/project",
        resume_command: ["codewith", "resume", "session-1"]
      },
      observedAt: "2026-06-19T00:00:00.000Z",
      hash: "agent-session-hash"
    };

    const plan = createRestorePlan(snapshot, [resource], [{
      selector: resource.id,
      mode: "restore",
      updatedAt: "2026-06-19T00:00:00.000Z"
    }]);

    expect(plan.summary.planned).toBe(1);
    expect(plan.operations[0].kind).toBe("agent-session.resume");
    expect(plan.operations[0].command).toEqual(["codewith", "resume", "session-1"]);
    expect(plan.operations[0].safety.effect).toBe("agent-resume");
    expect(plan.operations[0].safety.requires).toContain("native-resume-command");
    expect(plan.operations[0].safety.command_hash).toHaveLength(64);
  });

  test("agent session resume rejects shell-shaped commands", () => {
    const resource: StoredSnapshotResource = {
      id: "agent-session:codewith:test",
      kind: "agent-session",
      name: "codewith:test",
      source: "agent-sessions:codewith",
      attributes: {
        tool: "codewith",
        session_id: "session-1",
        resume_command: ["sh", "-lc", "codewith resume session-1"]
      },
      observedAt: "2026-06-19T00:00:00.000Z",
      hash: "agent-session-hash"
    };

    const plan = createRestorePlan(snapshot, [resource], [{
      selector: resource.id,
      mode: "restore",
      updatedAt: "2026-06-19T00:00:00.000Z"
    }]);

    expect(plan.summary.blocked).toBe(1);
    expect(plan.operations[0].kind).toBe("agent-session.resume");
    expect(plan.operations[0].summary).toContain("Unsupported codewith resume_command");
  });

  test("broad agent-session policies do not resume every session", () => {
    const resource: StoredSnapshotResource = {
      id: "agent-session:codewith:test",
      kind: "agent-session",
      name: "codewith:test",
      source: "agent-sessions:codewith",
      attributes: {
        tool: "codewith",
        session_id: "session-1",
        resume_command: ["codewith", "resume", "session-1"]
      },
      observedAt: "2026-06-19T00:00:00.000Z",
      hash: "agent-session-hash"
    };

    const plan = createRestorePlan(snapshot, [resource], [{ selector: "kind:agent-session", mode: "restore", updatedAt: "2026-06-19T00:00:00.000Z" }]);

    expect(plan.summary.skipped).toBe(1);
    expect(plan.operations[0].kind).toBe("agent-session.observe");
  });

  test("restartable processes require per-process restore policy", () => {
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

    expect(plan.summary.skipped).toBe(1);
    expect(plan.operations[0].kind).toBe("observed");
  });

  test("per-process policies can plan explicit restartable processes", () => {
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

    const plan = createRestorePlan(snapshot, [resource], [{ selector: resource.id, mode: "restore", updatedAt: "2026-06-19T00:00:00.000Z" }]);

    expect(plan.summary.planned).toBe(1);
    expect(plan.operations[0].kind).toBe("process.restart");
    expect(plan.operations[0].command).toEqual([
      "sh",
      "-lc",
      "env HASNA_SNAPSHOTS_RESTARTABLE=1 HASNA_SNAPSHOTS_PROCESS_ID=agent-1 sleep 60"
    ]);
    expect(plan.operations[0].safety.effect).toBe("process-spawn");
    expect(plan.operations[0].safety.requires).toContain("restartable-marker");
    expect(plan.operations[0].safety.command_hash).toHaveLength(64);
  });

  test("process restart rechecks restartable marker before apply", () => {
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
    const plan = createRestorePlan(snapshot, [resource], [{ selector: resource.id, mode: "restore", updatedAt: "2026-06-19T00:00:00.000Z" }]);
    if (plan.operations[0].resource) {
      plan.operations[0].resource.attributes.restartable = false;
    }

    const applied = executeRestorePlan(plan, { apply: true, yes: true });

    expect(applied.summary.blocked).toBe(1);
    expect(applied.operations[0].reason).toContain("Restartable marker missing");
    expect(applied.operations[0].safety.blocked_reason).toContain("Restartable marker missing");
  });

  test("process restart commands without matching markers are blocked", () => {
    const resource: StoredSnapshotResource = {
      id: "process:agent-1",
      kind: "process",
      name: "mock-agent",
      source: "processes",
      attributes: {
        restartable: true,
        process_id: "agent-1",
        restart_command: "sleep 60"
      },
      observedAt: "2026-06-19T00:00:00.000Z",
      hash: "resource-hash"
    };

    const plan = createRestorePlan(snapshot, [resource], [{ selector: resource.id, mode: "restore", updatedAt: "2026-06-19T00:00:00.000Z" }]);

    expect(plan.summary.blocked).toBe(1);
    expect(plan.operations[0].reason).toContain("HASNA_SNAPSHOTS_RESTARTABLE=1");
  });

  test("tmux windows are planned after their session", () => {
    withTmuxPlanning(() => {
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
      expect(plan.operations.flatMap((op) => op.command ?? []).join(" ")).not.toContain("HASNA_SNAPSHOTS_RESTARTABLE=1");
    });
  });

  test("tmux restore commands can target an isolated socket", () => {
    withTmuxPlanning(() => {
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
    }, "snapshots-unit");
  });

  test("additional tmux panes are restored after windows", () => {
    withTmuxPlanning(() => {
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
      expect(plan.operations.find((op) => op.kind === "tmux.create-pane")?.command?.join(" ")).not.toContain("HASNA_SNAPSHOTS_RESTARTABLE=1");
    });
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

  test("per-app policies reject shell-shaped app commands", () => {
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

    expect(plan.summary.blocked).toBe(1);
    expect(plan.operations[0].reason).toContain("open -a");
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

    const plan = createRestorePlan(snapshot, [resource], [{ selector: resource.id, mode: "restore", updatedAt: "2026-06-19T00:00:00.000Z" }]);

    expect(plan.summary.blocked).toBe(1);
    expect(plan.operations[0].kind).toBe("process.restart");
    expect(plan.operations[0].reason).toContain("HASNA_SNAPSHOTS_RESTART_COMMAND_B64");
    expect(plan.operations[0].reason).toContain("HASNA_SNAPSHOTS_RESTART_COMMAND_FILE");
  });
});
