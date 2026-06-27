import { existsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
  const command = options.command ?? defaultAgentCommand();
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
  const startResult = startService(plan);
  return {
    applied: true,
    path: plan.path,
    started: startResult.status === 0,
    start_status: startResult.status,
    start_error: startResult.stderr || startResult.error || null,
    next_command: startResult.status === 0 ? null : plan.applyCommand
  };
}

export function serviceStatus(plan: ServicePlan): JsonObject {
  if (plan.kind === "systemd") {
    const result = runServiceCommand(["systemctl", "--user", "is-active", "hasna-snapshots.service"]);
    return {
      kind: plan.kind,
      path: plan.path,
      installed: existsSync(plan.path),
      active: result.stdout.trim() === "active",
      status: result.stdout.trim() || result.stderr.trim() || result.error || "unknown"
    };
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const result = runServiceCommand(["launchctl", "print", `gui/${uid}/com.hasna.snapshots`]);
  return {
    kind: plan.kind,
    path: plan.path,
    installed: existsSync(plan.path),
    active: result.status === 0,
    status: result.status === 0 ? "active" : result.stderr.trim() || result.error || "unknown"
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

function defaultAgentCommand(): string {
  const resolved = spawnSync("sh", ["-lc", "command -v snapshots-agent"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 2_000
  });
  const command = resolved.status === 0 ? resolved.stdout.trim() : "snapshots-agent";
  return `${command || "snapshots-agent"} run --interval 300 --tmux-tail-lines 0`;
}

function runServiceCommand(command: string[]): { status: number | null; stdout: string; stderr: string; error?: string } {
  const [program, ...args] = command;
  const result = spawnSync(program, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error?.message
  };
}

function startService(plan: ServicePlan): { status: number | null; stdout: string; stderr: string; error?: string } {
  if (plan.kind === "systemd") {
    const reload = runServiceCommand(["systemctl", "--user", "daemon-reload"]);
    if (reload.status !== 0) return reload;
  }
  return runServiceCommand(plan.applyCommand);
}

function launchdPlist(command: string, intervalSeconds: number): string {
  const [program, ...args] = splitCommand(command);
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
  <key>KeepAlive</key>
  <dict>
    <key>Crashed</key>
    <true/>
  </dict>
</dict>
</plist>
`;
}

function splitCommand(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  let escaped = false;

  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if ((char === "'" || char === "\"") && !quote) {
      quote = char;
      continue;
    }
    if (quote === char) {
      quote = undefined;
      continue;
    }
    if (!quote && /\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaped) current += "\\";
  if (quote) throw new Error(`Unclosed quote in service command: ${command}`);
  if (current) parts.push(current);
  if (!parts.length) throw new Error("Service command cannot be empty.");
  return parts;
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
