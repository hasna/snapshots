import { describe, expect, test } from "bun:test";
import { captureAll } from "../src/capture/index.js";
import { commandExists, runCommand } from "../src/util.js";

describe("captureAll", () => {
  test("always captures the local machine resource", async () => {
    const result = await captureAll({ include: ["machine"], now: "2026-06-19T00:00:00.000Z" });

    expect(result.resources).toHaveLength(1);
    expect(result.resources[0].kind).toBe("machine");
    expect(result.resources[0].attributes.hostname).toBeTruthy();
    expect(result.sourceStatuses?.[0]).toMatchObject({ source: "machine", ok: true, resourceCount: 1 });
  });

  test("turns missing optional integrations into diagnostics", async () => {
    const result = await captureAll({ include: ["browser"], now: "2026-06-19T00:00:00.000Z" });

    expect(result.resources.every((resource) => resource.kind === "browser-state" || resource.kind === "diagnostic")).toBe(true);
  });

  test("captures restartable metadata for tmux panes", async () => {
    if (!commandExists("tmux")) return;
    const socket = `snapshots-capture-${Date.now()}`;
    process.env.HASNA_SNAPSHOTS_TMUX_SOCKET = socket;
    try {
      const command = "env HASNA_SNAPSHOTS_RESTARTABLE=1 HASNA_SNAPSHOTS_PROCESS_ID=capture-pane sleep 60";
      const created = runCommand("tmux", ["-L", socket, "new-session", "-d", "-s", "capture-pane", command], 5_000);
      if (!created.ok) return;
      const result = await captureAll({ include: ["tmux"], now: "2026-06-19T00:00:00.000Z" });
      const pane = result.resources.find((resource) => resource.kind === "tmux-pane" && resource.name.startsWith("capture-pane:"));

      expect(pane?.attributes.restartable).toBe(true);
    } finally {
      runCommand("tmux", ["-L", socket, "kill-server"], 5_000);
      delete process.env.HASNA_SNAPSHOTS_TMUX_SOCKET;
    }
  });

  test("can skip tmux pane tails for faster daemon captures", async () => {
    if (!commandExists("tmux")) return;
    const socket = `snapshots-capture-fast-${Date.now()}`;
    process.env.HASNA_SNAPSHOTS_TMUX_SOCKET = socket;
    try {
      const created = runCommand("tmux", ["-L", socket, "new-session", "-d", "-s", "capture-fast", "sleep 60"], 5_000);
      if (!created.ok) return;
      const result = await captureAll({ include: ["tmux"], now: "2026-06-19T00:00:00.000Z", tmuxPaneTailLines: 0 });
      const pane = result.resources.find((resource) => resource.kind === "tmux-pane" && resource.name.startsWith("capture-fast:"));

      expect(pane?.attributes.content_tail_skipped).toBe(true);
      expect(pane?.attributes.content_tail).toBe("");
    } finally {
      runCommand("tmux", ["-L", socket, "kill-server"], 5_000);
      delete process.env.HASNA_SNAPSHOTS_TMUX_SOCKET;
    }
  });
});
