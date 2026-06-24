import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import type { JsonObject, JsonValue } from "./types.js";

export function nowIso(): string {
  return new Date().toISOString();
}

export function defaultDataDir(): string {
  return process.env.HASNA_SNAPSHOTS_DIR ?? join(homedir(), ".hasna", "snapshots");
}

export function defaultDbPath(): string {
  return process.env.HASNA_SNAPSHOTS_DB_PATH ?? join(defaultDataDir(), "snapshots.sqlite");
}

export function ensureParentDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function stableJson(value: JsonValue): string {
  return JSON.stringify(sortJson(value));
}

export function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === "object") {
    const sorted: JsonObject = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortJson(value[key]);
    }
    return sorted;
  }
  return value;
}

export function safeParseJson(text: string): JsonValue | undefined {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}

export function commandExists(command: string): boolean {
  const result = spawnSync("sh", ["-lc", `command -v ${shellQuote(command)}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 2_000
  });
  return result.status === 0;
}

export interface CommandResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export function runCommand(command: string, args: string[] = [], timeoutMs = 5_000): CommandResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error?.message
  };
}

export function tmuxCommand(args: string[] = []): string[] {
  return ["tmux", ...tmuxArgs(args)];
}

export function tmuxArgs(args: string[] = []): string[] {
  const socketPath = process.env.HASNA_SNAPSHOTS_TMUX_SOCKET_PATH;
  if (socketPath) return ["-S", socketPath, ...args];
  const socketName = process.env.HASNA_SNAPSHOTS_TMUX_SOCKET;
  if (socketName) return ["-L", socketName, ...args];
  return args;
}

export function runTmux(args: string[] = [], timeoutMs = 5_000): CommandResult {
  return runCommand("tmux", tmuxArgs(args), timeoutMs);
}

export function runJsonCommand(command: string, args: string[] = [], timeoutMs = 5_000): JsonValue | undefined {
  const result = runCommand(command, args, timeoutMs);
  if (!result.ok) return undefined;
  return safeParseJson(result.stdout);
}

export function redactText(input: string): string {
  return input
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted-private-key]")
    .replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, "[redacted-aws-access-key]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[redacted-api-key]")
    .replace(/\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, "[redacted-api-key]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[redacted-github-token]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, "[redacted-slack-token]")
    .replace(/([A-Za-z_]*(?:TOKEN|SECRET|KEY|PASSWORD|PASS|COOKIE)[A-Za-z_]*=)[^\s]+/gi, "$1[redacted]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/(https?:\/\/[^:\s/]+:)[^@\s/]+(@)/gi, "$1[redacted]$2");
}

export function redactJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(redactJson);
  }
  if (value && typeof value === "object") {
    const redacted: JsonObject = {};
    for (const [key, child] of Object.entries(value)) {
      if (/token|secret|key|password|pass|cookie/i.test(key)) {
        redacted[key] = "[redacted]";
      } else {
        redacted[key] = redactJson(child);
      }
    }
    return redacted;
  }
  if (typeof value === "string") {
    return redactText(value);
  }
  return value;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function slugPart(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || sha256(value).slice(0, 12);
}

export function stableIdPart(value: string): string {
  return `${slugPart(value)}-${sha256(value).slice(0, 8)}`;
}

export function fileExists(path: string | undefined): path is string {
  return Boolean(path && existsSync(path));
}
