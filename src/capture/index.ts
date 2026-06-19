import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { hostname, platform, release, userInfo } from "node:os";
import type { CaptureDiagnostic, CaptureOptions, CaptureResult, JsonObject, JsonValue, SnapshotResource } from "../types.js";
import { commandExists, defaultDataDir, nowIso, redactJson, redactText, runCommand, runJsonCommand, sha256, slugPart } from "../util.js";

export async function captureAll(options: CaptureOptions = {}): Promise<CaptureResult> {
  const include = new Set(options.include ?? ["machine", "tmux", "projects", "processes", "sessions", "browser", "desktop"]);
  const now = options.now ?? nowIso();
  const result: CaptureResult = { resources: [], diagnostics: [] };

  const append = (capture: CaptureResult) => {
    result.resources.push(...capture.resources);
    result.diagnostics.push(...capture.diagnostics);
  };

  if (include.has("machine")) append(captureMachine(now, options.cwd));
  if (include.has("tmux")) append(captureTmux(now));
  if (include.has("projects")) append(captureProjects(now));
  if (include.has("processes")) append(captureProcesses(now));
  if (include.has("sessions")) append(captureSessions(now));
  if (include.has("browser")) append(captureBrowser(now));
  if (include.has("desktop")) append(captureDesktop(now));

  for (const diagnostic of result.diagnostics) {
    result.resources.push(diagnosticResource(diagnostic, now));
  }

  return result;
}

function captureMachine(now: string, cwd = process.cwd()): CaptureResult {
  return {
    resources: [
      {
        id: `machine:${process.env.HASNA_MACHINE_ID ?? sha256(hostname()).slice(0, 12)}`,
        kind: "machine",
        name: hostname(),
        source: "machine",
        attributes: {
          hostname: hostname(),
          platform: platform(),
          release: release(),
          user: userInfo().username,
          cwd,
          hasna_machine_id: process.env.HASNA_MACHINE_ID ?? null
        },
        observedAt: now
      }
    ],
    diagnostics: []
  };
}

function captureTmux(now: string): CaptureResult {
  if (!commandExists("tmux")) {
    return diagnostic("tmux", "info", "tmux command not found; tmux resources were not captured.");
  }
  const sessions = runCommand("tmux", ["list-sessions", "-F", "#{session_id}\t#{session_name}\t#{session_created}\t#{session_windows}\t#{session_attached}"]);
  if (!sessions.ok) {
    return diagnostic("tmux", "info", "tmux server is not running or cannot be queried.", sessions.stderr.trim());
  }

  const resources: SnapshotResource[] = [];
  for (const line of sessions.stdout.trim().split("\n").filter(Boolean)) {
    const [sessionId, name, created, windows, attached] = line.split("\t");
    const id = `tmux-session:${slugPart(name)}`;
    resources.push({
      id,
      kind: "tmux-session",
      name,
      source: "tmux",
      attributes: {
        tmux_id: sessionId,
        created: Number(created),
        windows: Number(windows),
        attached: attached === "1",
        cwd: process.cwd()
      },
      observedAt: now
    });
  }

  const panes = runCommand("tmux", [
    "list-panes",
    "-a",
    "-F",
    "#{session_name}\t#{window_index}\t#{window_name}\t#{pane_id}\t#{pane_current_path}\t#{pane_current_command}\t#{pane_active}"
  ]);
  if (panes.ok) {
    for (const line of panes.stdout.trim().split("\n").filter(Boolean)) {
      const [sessionName, windowIndex, windowName, paneId, panePath, paneCommand, paneActive] = line.split("\t");
      const sessionResourceId = `tmux-session:${slugPart(sessionName)}`;
      const windowResourceId = `tmux-window:${slugPart(sessionName)}:${windowIndex}`;
      if (!resources.some((resource) => resource.id === windowResourceId)) {
        resources.push({
          id: windowResourceId,
          kind: "tmux-window",
          name: `${sessionName}:${windowIndex}:${windowName}`,
          source: "tmux",
          parentId: sessionResourceId,
          attributes: { session: sessionName, index: Number(windowIndex), name: windowName },
          observedAt: now
        });
      }
      resources.push({
        id: `tmux-pane:${slugPart(sessionName)}:${paneId.replace("%", "")}`,
        kind: "tmux-pane",
        name: `${sessionName}:${paneId}`,
        source: "tmux",
        parentId: windowResourceId,
        attributes: {
          session: sessionName,
          window_index: Number(windowIndex),
          current_path: panePath,
          current_command: paneCommand,
          active: paneActive === "1"
        },
        observedAt: now
      });
    }
  }

  return { resources, diagnostics: [] };
}

function captureProjects(now: string): CaptureResult {
  const json = commandExists("projects") ? runJsonCommand("projects", ["list", "--json"]) : undefined;
  if (!json) {
    return diagnostic("projects", "info", "projects CLI not found or did not return JSON.");
  }
  const rows = Array.isArray(json) ? json : Array.isArray((json as JsonObject).projects) ? ((json as JsonObject).projects as JsonValue[]) : [];
  const resources = rows
    .filter((row): row is JsonObject => Boolean(row && typeof row === "object" && !Array.isArray(row)))
    .map((row) => {
      const path = typeof row.path === "string" ? row.path : typeof row.primary_path === "string" ? row.primary_path : undefined;
      const name = String(row.name ?? row.slug ?? path ?? "project");
      const attributes = redactJson({ ...row, path: path ?? null }) as JsonObject;
      return {
        id: `project:${slugPart(String(row.id ?? row.slug ?? path ?? name))}`,
        kind: "project" as const,
        name,
        source: "projects",
        attributes,
        observedAt: now
      };
    });
  return { resources, diagnostics: [] };
}

function captureProcesses(now: string): CaptureResult {
  const ps = runCommand("ps", ["-axo", "pid=,ppid=,comm=,args="], 5_000);
  if (!ps.ok) return diagnostic("processes", "warning", "ps command failed.", ps.stderr.trim());
  const resources: SnapshotResource[] = [];
  for (const line of ps.stdout.split("\n").map((entry) => entry.trim()).filter(Boolean).slice(0, 250)) {
    const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    if (!match) continue;
    const [, pid, ppid, command, args] = match;
    resources.push({
        id: `process:${pid}`,
        kind: "process" as const,
        name: command,
        source: "processes",
        attributes: {
          pid: Number(pid),
          ppid: Number(ppid),
          command,
          args: redactText(args ?? "")
        },
        observedAt: now
      });
  }
  return { resources, diagnostics: [] };
}

function captureSessions(now: string): CaptureResult {
  const json = commandExists("sessions") ? runJsonCommand("sessions", ["list", "--json"]) : undefined;
  if (!json) return diagnostic("sessions", "info", "sessions CLI not found or did not return JSON.");
  const rows = Array.isArray(json) ? json : Array.isArray((json as JsonObject).sessions) ? ((json as JsonObject).sessions as JsonValue[]) : [];
  const resources = rows
    .filter((row): row is JsonObject => Boolean(row && typeof row === "object" && !Array.isArray(row)))
    .map((row) => ({
      id: `session:${slugPart(String(row.id ?? row.session_id ?? row.path ?? JSON.stringify(row).slice(0, 80)))}`,
      kind: "session" as const,
      name: String(row.name ?? row.title ?? row.id ?? "session"),
      source: "sessions",
      attributes: redactJson(row) as JsonObject,
      observedAt: now
    }));
  return { resources, diagnostics: [] };
}

function captureBrowser(now: string): CaptureResult {
  const browserRoot = process.env.HASNA_BROWSER_DIR ?? join(defaultDataDir(), "..", "browser");
  const dirs = ["states", "profiles", "persistent"].map((name) => join(browserRoot, name));
  const resources: SnapshotResource[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of safeReaddir(dir).slice(0, 100)) {
      const path = join(dir, entry);
      const stat = safeStat(path);
      if (!stat) continue;
      resources.push({
        id: `browser-state:${slugPart(path)}`,
        kind: "browser-state",
        name: entry,
        source: "browser",
        attributes: {
          path,
          bytes: stat.size,
          directory: stat.isDirectory(),
          modified_at: stat.mtime.toISOString()
        },
        observedAt: now
      });
    }
  }
  return { resources, diagnostics: resources.length ? [] : diagnostic("browser", "info", "No local browser state directory found.").diagnostics };
}

function captureDesktop(now: string): CaptureResult {
  const json = commandExists("computer") ? runJsonCommand("computer", ["sessions", "--json"]) : undefined;
  if (!json) return diagnostic("desktop", "info", "computer CLI not found or did not return desktop session JSON.");
  const rows = Array.isArray(json) ? json : Array.isArray((json as JsonObject).sessions) ? ((json as JsonObject).sessions as JsonValue[]) : [];
  const resources = rows
    .filter((row): row is JsonObject => Boolean(row && typeof row === "object" && !Array.isArray(row)))
    .map((row) => ({
      id: `desktop-window:${slugPart(String(row.id ?? row.window_id ?? JSON.stringify(row).slice(0, 80)))}`,
      kind: "desktop-window" as const,
      name: String(row.title ?? row.app ?? row.id ?? "desktop-window"),
      source: "desktop",
      attributes: redactJson(row) as JsonObject,
      observedAt: now
    }));
  return { resources, diagnostics: [] };
}

function diagnostic(source: string, level: CaptureDiagnostic["level"], message: string, detail?: JsonValue): CaptureResult {
  return { resources: [], diagnostics: [{ source, level, message, detail }] };
}

function diagnosticResource(diagnostic: CaptureDiagnostic, now: string): SnapshotResource {
  return {
    id: `diagnostic:${slugPart(`${diagnostic.source}:${diagnostic.message}`)}`,
    kind: "diagnostic",
    name: `${diagnostic.source}: ${diagnostic.message}`,
    source: diagnostic.source,
    attributes: {
      level: diagnostic.level,
      message: diagnostic.message,
      detail: diagnostic.detail ?? null
    },
    observedAt: now
  };
}

function safeReaddir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function safeStat(path: string) {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}
