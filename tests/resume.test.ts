import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTRACT_VERSION } from "../src/contracts.js";
import { buildResumeContext } from "../src/resume.js";
import { getResumeContext } from "../src/runtime.js";
import { SnapshotStore } from "../src/storage.js";
import type { SnapshotRecord, SnapshotResource, StoredSnapshotResource } from "../src/types.js";

function tmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), "snapshots-resume-")), "snapshots.sqlite");
}

describe("resume context", () => {
  test("builds compact agent-facing context from latest snapshot", () => {
    const dbPath = tmpDb();
    const store = new SnapshotStore({ path: dbPath });
    const resources: SnapshotResource[] = [
      {
        id: "project:fixture",
        kind: "project",
        name: "fixture",
        source: "projects",
        attributes: { path: "/tmp/fixture" },
        observedAt: "2026-06-19T00:00:00.000Z"
      },
      {
        id: "tmux-session:fixture",
        kind: "tmux-session",
        name: "fixture",
        source: "tmux",
        attributes: { attached: true, cwd: "/tmp/fixture" },
        observedAt: "2026-06-19T00:00:00.000Z"
      },
      {
        id: "tmux-window:fixture:0",
        kind: "tmux-window",
        name: "fixture:0:agent",
        source: "tmux",
        parentId: "tmux-session:fixture",
        attributes: {
          session: "fixture",
          index: 0,
          name: "agent",
          current_path: "/tmp/fixture",
          active: true,
          restartable: true,
          start_command: "codewith resume 019ee3"
        },
        observedAt: "2026-06-19T00:00:00.000Z"
      },
      {
        id: "tmux-pane:fixture:1",
        kind: "tmux-pane",
        name: "fixture:%1",
        source: "tmux",
        parentId: "tmux-window:fixture:0",
        attributes: {
          session: "fixture",
          window_index: 0,
          pane_index: 0,
          current_path: "/tmp/fixture",
          current_command: "codewith",
          active: true,
          content_tail: "0123456789abcdef"
        },
        observedAt: "2026-06-19T00:00:00.000Z"
      },
      {
        id: "agent-session:codewith:019ee3",
        kind: "agent-session",
        name: "codewith:resume",
        source: "agent-sessions:codewith",
        attributes: {
          tool: "codewith",
          session_id: "019ee3",
          title: "resume fixture",
          cwd: "/tmp/fixture",
          model: "gpt-5",
          resume_command: ["codewith", "resume", "019ee3"]
        },
        observedAt: "2026-06-19T00:00:00.000Z"
      },
      {
        id: "process:agent",
        kind: "process",
        name: "codewith",
        source: "processes",
        attributes: {
          pid: 123,
          command: "codewith",
          restartable: true,
          process_id: "agent"
        },
        observedAt: "2026-06-19T00:00:00.000Z"
      },
      {
        id: "diagnostic:fixture",
        kind: "diagnostic",
        name: "fixture diagnostic",
        source: "fixture",
        attributes: {
          level: "info",
          message: "diagnostic fixture"
        },
        observedAt: "2026-06-19T00:00:00.000Z"
      }
    ];
    try {
      store.saveSnapshot(resources, {
        id: "snap_resume",
        createdAt: "2026-06-19T00:00:00.000Z",
        diagnostics: [{ source: "fixture", level: "info", message: "diagnostic fixture" }]
      });
    } finally {
      store.close();
    }

    const context = getResumeContext({ dbPath, id: "latest", maxPaneTailChars: 8 });

    expect(context.contract_version).toBe(CONTRACT_VERSION);
    expect(context.snapshot_id).toBe("snap_resume");
    expect(context.projects[0].path).toBe("/tmp/fixture");
    expect(context.tmux[0].windows).toHaveLength(1);
    expect(((context.tmux[0].windows as object[])[0] as { panes: { content_tail: string }[] }).panes[0].content_tail).toBe("89abcdef");
    expect(context.agent_sessions[0].resume_command).toEqual(["codewith", "resume", "019ee3"]);
    expect(context.restartable_processes[0].process_id).toBe("agent");
    expect(context.diagnostics[0].message).toBe("diagnostic fixture");
    expect(context.restore_plan_summary).toBeTruthy();
  });

  test("marks context truncated when nested tmux panes are over limit", () => {
    const snapshot: SnapshotRecord = {
      id: "snap_nested",
      hash: "hash",
      createdAt: "2026-06-19T00:00:00.000Z",
      resourceCount: 3,
      summary: {}
    };
    const resources: StoredSnapshotResource[] = [
      {
        id: "tmux-session:fixture",
        kind: "tmux-session",
        name: "fixture",
        source: "tmux",
        attributes: {},
        observedAt: snapshot.createdAt,
        hash: "session"
      },
      {
        id: "tmux-window:fixture:0",
        kind: "tmux-window",
        name: "fixture:0:agent",
        source: "tmux",
        parentId: "tmux-session:fixture",
        attributes: { session: "fixture", index: 0, name: "agent" },
        observedAt: snapshot.createdAt,
        hash: "window"
      },
      ...[0, 1].map((index) => ({
        id: `tmux-pane:fixture:${index}`,
        kind: "tmux-pane" as const,
        name: `fixture:%${index}`,
        source: "tmux",
        parentId: "tmux-window:fixture:0",
        attributes: { session: "fixture", window_index: 0, pane_index: index },
        observedAt: snapshot.createdAt,
        hash: `pane-${index}`
      }))
    ];

    const context = buildResumeContext(snapshot, resources, undefined, { maxPanesPerWindow: 1 });

    expect(context.truncated).toBe(true);
    expect(((context.tmux[0].windows as object[])[0] as { panes: object[] }).panes).toHaveLength(1);
  });
});
