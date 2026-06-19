import { existsSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { JsonObject } from "./types.js";
import { ensureDir } from "./util.js";

export interface ServicePlanOptions {
  command?: string;
  intervalSeconds?: number;
  platform?: NodeJS.Platform;
}

export interface ServicePlan {
  kind: "systemd" | "launchd";
  path: string;
  content: string;
  applyCommand: string[];
  note: string;
}

export function planService(options: ServicePlanOptions = {}): ServicePlan {
  const targetPlatform = options.platform ?? platform();
  const command = options.command ?? "snapshots-agent run --interval 300";
  if (targetPlatform === "darwin") {
    const path = join(homedir(), "Library", "LaunchAgents", "com.hasna.snapshots.plist");
    return {
      kind: "launchd",
      path,
      content: launchdPlist(command, options.intervalSeconds ?? 300),
      applyCommand: ["launchctl", "load", path],
      note: "launchd plan is dry-run until service install --apply --yes is used."
    };
  }
  const path = join(homedir(), ".config", "systemd", "user", "hasna-snapshots.service");
  return {
    kind: "systemd",
    path,
    content: systemdUnit(command),
    applyCommand: ["systemctl", "--user", "enable", "--now", "hasna-snapshots.service"],
    note: "systemd plan is dry-run until service install --apply --yes is used."
  };
}

export function applyServicePlan(plan: ServicePlan, yes: boolean): JsonObject {
  if (!yes) {
    return {
      applied: false,
      reason: "Writing service files requires --apply --yes.",
      plan: plan as unknown as JsonObject
    };
  }
  ensureDir(plan.path.split("/").slice(0, -1).join("/"));
  if (existsSync(plan.path)) {
    return { applied: false, reason: `Service file already exists: ${plan.path}`, plan: plan as unknown as JsonObject };
  }
  writeFileSync(plan.path, plan.content, "utf8");
  return {
    applied: true,
    path: plan.path,
    next_command: plan.applyCommand
  };
}

function systemdUnit(command: string): string {
  return `[Unit]
Description=Hasna snapshots agent

[Service]
Type=simple
ExecStart=${command}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
}

function launchdPlist(command: string, intervalSeconds: number): string {
  const [program, ...args] = command.split(/\s+/);
  const array = [program, ...args].map((arg) => `    <string>${escapeXml(arg)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.hasna.snapshots</string>
  <key>ProgramArguments</key>
  <array>
${array}
  </array>
  <key>StartInterval</key>
  <integer>${intervalSeconds}</integer>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`;
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
