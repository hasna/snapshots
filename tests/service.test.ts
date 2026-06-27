import { describe, expect, test } from "bun:test";
import { planService } from "../src/service.js";

describe("service planning", () => {
  test("launchd preserves quoted shell commands and restarts on crash", () => {
    const plan = planService({
      platform: "darwin",
      command: "/bin/sh -c 'echo ok >> /tmp/hasna-snapshots-service.log'",
      intervalSeconds: 5
    });

    expect(plan.kind).toBe("launchd");
    expect(plan.content).toContain("<key>KeepAlive</key>");
    expect(plan.content).toContain("<string>/bin/sh</string>");
    expect(plan.content).toContain("<string>-c</string>");
    expect(plan.content).toContain("<string>echo ok &gt;&gt; /tmp/hasna-snapshots-service.log</string>");
  });

  test("systemd uses restart-on-failure semantics", () => {
    const plan = planService({ platform: "linux", command: "snapshots-agent run --interval 60" });

    expect(plan.kind).toBe("systemd");
    expect(plan.content).toContain("Restart=on-failure");
    expect(plan.content).toContain("ExecStart=snapshots-agent run --interval 60");
  });

  test("default service command skips tmux pane tails for unattended daemon captures", () => {
    const plan = planService({ platform: "linux" });

    expect(plan.content).toContain("--tmux-tail-lines 0");
  });
});
