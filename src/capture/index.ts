import { Database } from "bun:sqlite";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { homedir, hostname, platform, release, userInfo } from "node:os";
import type { CaptureDiagnostic, CaptureOptions, CaptureResult, JsonObject, JsonValue, SnapshotResource } from "../types.js";
import { commandExists, defaultDataDir, nowIso, redactJson, redactText, runCommand, runJsonCommand, runTmux, sha256, stableIdPart } from "../util.js";
import { CAPTURE_INCLUDE_VALUES, parseInclude } from "../validation.js";

const MAX_PANE_TAIL_CHARS = 16_000;
const MAX_TRANSCRIPT_READ_BYTES = 1_048_576;
const MAX_RESTART_COMMAND_FILE_BYTES = 16_000;

export async function captureAll(options: CaptureOptions = {}): Promise<CaptureResult> {
  const include = new Set(parseInclude(options.include) ?? CAPTURE_INCLUDE_VALUES);
  const now = options.now ?? nowIso();
  const result: CaptureResult = { resources: [], diagnostics: [] };

  const append = (capture: CaptureResult) => {
    result.resources.push(...capture.resources);
    result.diagnostics.push(...capture.diagnostics);
  };

  if (include.has("machine")) append(captureMachine(now, options.cwd));
  if (include.has("tmux")) append(captureTmux(now, options));
  if (include.has("projects")) append(captureProjects(now));
  if (include.has("processes")) append(captureProcesses(now));
  if (include.has("sessions")) append(captureSessions(now));
  if (include.has("agent-sessions")) append(captureAgentSessions(now));
  if (include.has("browser")) append(captureBrowser(now));
  if (include.has("desktop")) append(captureDesktop(now));
  if (include.has("apps")) append(captureApps(now));

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

function captureTmux(now: string, options: CaptureOptions): CaptureResult {
  if (!commandExists("tmux")) {
    return diagnostic("tmux", "info", "tmux command not found; tmux resources were not captured.");
  }
  const sessions = runTmux(["list-sessions", "-F", "#{session_id}\t#{session_name}\t#{session_created}\t#{session_windows}\t#{session_attached}"]);
  if (!sessions.ok) {
    return diagnostic("tmux", "info", "tmux server is not running or cannot be queried.", sessions.stderr.trim());
  }

  const resources: SnapshotResource[] = [];
  const includePaneTail = options.includePaneTail === true;
  const maxPaneTailChars = positiveIntegerOption(options.maxPaneTailChars, MAX_PANE_TAIL_CHARS, MAX_PANE_TAIL_CHARS);
  for (const line of sessions.stdout.trim().split("\n").filter(Boolean)) {
    const [sessionId, name, created, windows, attached] = line.split("\t");
    const id = `tmux-session:${stableIdPart(name)}`;
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

  const windows = runTmux([
    "list-windows",
    "-a",
    "-F",
    "#{session_name}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_layout}\t#{window_panes}"
  ]);
  if (windows.ok) {
    for (const line of windows.stdout.trim().split("\n").filter(Boolean)) {
      const [sessionName, windowIndex, windowName, windowActive, windowLayout, windowPanes] = line.split("\t");
      const sessionIdPart = stableIdPart(sessionName);
      resources.push({
        id: `tmux-window:${sessionIdPart}:${windowIndex}`,
        kind: "tmux-window",
        name: `${sessionName}:${windowIndex}:${windowName}`,
        source: "tmux",
        parentId: `tmux-session:${sessionIdPart}`,
        attributes: {
          session: sessionName,
          index: Number(windowIndex),
          name: windowName,
          active: windowActive === "1",
          layout: windowLayout,
          pane_count: Number(windowPanes)
        },
        observedAt: now
      });
    }
  }

  const panes = runTmux([
    "list-panes",
    "-a",
    "-F",
    "#{session_name}\t#{window_index}\t#{window_name}\t#{pane_index}\t#{pane_id}\t#{pane_current_path}\t#{pane_current_command}\t#{pane_active}\t#{pane_start_command}"
  ]);
  if (panes.ok) {
    for (const line of panes.stdout.trim().split("\n").filter(Boolean)) {
      const [sessionName, windowIndex, windowName, paneIndex, paneId, panePath, paneCommand, paneActive, paneStartCommand = ""] = line.split("\t");
      const sessionIdPart = stableIdPart(sessionName);
      const sessionResourceId = `tmux-session:${sessionIdPart}`;
      const windowResourceId = `tmux-window:${sessionIdPart}:${windowIndex}`;
      const startCommand = redactText(paneStartCommand);
      const windowResource = resources.find((resource) => resource.id === windowResourceId);
      if (windowResource) {
        if (paneActive === "1" || typeof windowResource.attributes.current_path !== "string") {
          windowResource.attributes.current_path = panePath;
          windowResource.attributes.start_command = startCommand;
          windowResource.attributes.restartable = isRestartableCommand(startCommand);
        }
      } else {
        resources.push({
          id: windowResourceId,
          kind: "tmux-window",
          name: `${sessionName}:${windowIndex}:${windowName}`,
          source: "tmux",
          parentId: sessionResourceId,
          attributes: {
            session: sessionName,
            index: Number(windowIndex),
            name: windowName,
            current_path: panePath,
            start_command: startCommand,
            restartable: isRestartableCommand(startCommand),
            active: false,
            layout: null,
            pane_count: null
          },
          observedAt: now
        });
      }
      const paneTail = includePaneTail ? runTmux(["capture-pane", "-p", "-t", paneId, "-S", "-100"], 2_000) : undefined;
      resources.push({
        id: `tmux-pane:${sessionIdPart}:${stableIdPart(paneId)}`,
        kind: "tmux-pane",
        name: `${sessionName}:${paneId}`,
        source: "tmux",
        parentId: windowResourceId,
        attributes: {
          session: sessionName,
          window_index: Number(windowIndex),
          pane_index: Number(paneIndex),
          current_path: panePath,
          current_command: paneCommand,
          start_command: redactText(paneStartCommand),
          content_tail: paneTail?.ok ? redactText(paneTail.stdout).slice(-maxPaneTailChars) : "",
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
        id: `project:${stableIdPart(String(row.id ?? row.slug ?? path ?? name))}`,
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
  let observedProcessCount = 0;
  for (const line of ps.stdout.split("\n").map((entry) => entry.trim()).filter(Boolean)) {
    const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    if (!match) continue;
    const [, pid, ppid, command, args] = match;
    const argsText = redactText(args ?? "");
    const restartInfo = parseRestartableCommand(args ?? "");
    const hasSnapshotMarker = (args ?? "").includes("HASNA_SNAPSHOTS_");
    if (!restartInfo && !hasSnapshotMarker && observedProcessCount >= 250) continue;
    observedProcessCount += 1;
    resources.push({
        id: `process:${pid}`,
        kind: "process" as const,
        name: command,
        source: "processes",
        attributes: {
          pid: Number(pid),
          ppid: Number(ppid),
          command,
          args: argsText,
          restartable: Boolean(restartInfo),
          process_id: restartInfo?.id ?? null,
          restart_command: restartInfo?.command ?? null
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
      id: `session:${stableIdPart(String(row.id ?? row.session_id ?? row.path ?? JSON.stringify(row).slice(0, 80)))}`,
      kind: "session" as const,
      name: String(row.name ?? row.title ?? row.id ?? "session"),
      source: "sessions",
      attributes: redactJson(row) as JsonObject,
      observedAt: now
    }));
  return { resources, diagnostics: [] };
}

function captureAgentSessions(now: string): CaptureResult {
  const resources: SnapshotResource[] = [];
  const diagnostics: CaptureDiagnostic[] = [];
  for (const capture of [
    captureCodewithSessions(now),
    captureCodexSessions(now),
    captureClaudeSessions(now),
    captureAicopilotSessions(now)
  ]) {
    resources.push(...capture.resources);
    diagnostics.push(...capture.diagnostics);
  }
  if (!resources.length && !diagnostics.length) {
    diagnostics.push({
      source: "agent-sessions",
      level: "info",
      message: "No local coding-agent session stores were found."
    });
  }
  return { resources, diagnostics };
}

function captureCodewithSessions(now: string): CaptureResult {
  const home = process.env.CODEWITH_HOME ?? join(homedir(), ".codewith");
  const indexPath = join(home, "session_index.jsonl");
  if (!existsSync(indexPath)) return diagnostic("agent-sessions:codewith", "info", "Codewith session index not found.");
  const transcripts = indexTranscripts(join(home, "projects"));
  const resources = readJsonl(indexPath, 200).map((row) => {
    const sessionId = stringValue(row.id) ?? stringValue(row.session_id) ?? stringValue(row.sessionId) ?? "";
    const transcriptPath = transcripts.get(sessionId);
    const metadata = transcriptPath ? readTranscriptMetadata(transcriptPath, sessionId) : {};
    return agentSessionResource({
      now,
      tool: "codewith",
      sessionId,
      title: stringValue(row.thread_name) ?? stringValue(row.title) ?? metadata.title ?? sessionId,
      updatedAt: stringValue(row.updated_at) ?? stringValue(row.updatedAt) ?? metadata.updatedAt,
      cwd: metadata.cwd,
      transcriptPath,
      model: metadata.model,
      resumeCommand: ["codewith", "resume", sessionId]
    });
  }).filter((resource): resource is SnapshotResource => Boolean(resource));
  return { resources, diagnostics: [] };
}

function captureCodexSessions(now: string): CaptureResult {
  const home = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const indexPath = join(home, "session_index.jsonl");
  if (!existsSync(indexPath)) return diagnostic("agent-sessions:codex", "info", "Codex session index not found.");
  const transcripts = indexTranscripts(join(home, "sessions"));
  const resources = readJsonl(indexPath, 200).map((row) => {
    const sessionId = stringValue(row.id) ?? stringValue(row.session_id) ?? stringValue(row.sessionId) ?? "";
    const transcriptPath = transcripts.get(sessionId);
    const metadata = transcriptPath ? readTranscriptMetadata(transcriptPath, sessionId) : {};
    return agentSessionResource({
      now,
      tool: "codex",
      sessionId,
      title: stringValue(row.thread_name) ?? stringValue(row.title) ?? metadata.title ?? sessionId,
      updatedAt: stringValue(row.updated_at) ?? stringValue(row.updatedAt) ?? metadata.updatedAt,
      cwd: metadata.cwd,
      transcriptPath,
      model: metadata.model,
      resumeCommand: ["codex", "resume", sessionId]
    });
  }).filter((resource): resource is SnapshotResource => Boolean(resource));
  return { resources, diagnostics: [] };
}

function captureClaudeSessions(now: string): CaptureResult {
  const home = process.env.HASNA_SNAPSHOTS_CLAUDE_HOME ?? join(homedir(), ".claude");
  const projectRoot = join(home, "projects");
  if (!existsSync(projectRoot)) return diagnostic("agent-sessions:claude", "info", "Claude Code project session directory not found.");
  const resources = listJsonlFiles(projectRoot, 200).map((transcriptPath) => {
    const sessionId = basename(transcriptPath, ".jsonl");
    const metadata = readTranscriptMetadata(transcriptPath, sessionId);
    return agentSessionResource({
      now,
      tool: "claude",
      sessionId,
      title: metadata.title ?? sessionId,
      updatedAt: metadata.updatedAt,
      cwd: metadata.cwd,
      transcriptPath,
      model: metadata.model,
      resumeCommand: ["claude", "--resume", sessionId]
    });
  }).filter((resource): resource is SnapshotResource => Boolean(resource));
  return { resources, diagnostics: [] };
}

function captureAicopilotSessions(now: string): CaptureResult {
  const dbPath = process.env.HASNA_SNAPSHOTS_AICOPILOT_DB ?? join(homedir(), ".local", "share", "aicopilot", "aicopilot.db");
  if (!existsSync(dbPath)) return diagnostic("agent-sessions:aicopilot", "info", "aicopilot session database not found.");
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db.query(`
        SELECT id, directory, path, title, agent, model, time_updated
        FROM session
        ORDER BY time_updated DESC
        LIMIT 200
      `).all() as Record<string, unknown>[];
      const resources = rows.map((row) => {
        const sessionId = String(row.id ?? "");
        const cwd = stringValue(row.directory);
        const model = parseModelName(stringValue(row.model));
        return agentSessionResource({
          now,
          tool: "aicopilot",
          sessionId,
          title: stringValue(row.title) ?? sessionId,
          updatedAt: millisToIso(row.time_updated),
          cwd,
          agent: stringValue(row.agent),
          model,
          resumeCommand: cwd ? ["aicopilot", cwd, "--session", sessionId] : ["aicopilot", "--session", sessionId]
        });
      }).filter((resource): resource is SnapshotResource => Boolean(resource));
      return { resources, diagnostics: [] };
    } finally {
      db.close();
    }
  } catch (error) {
    return diagnostic("agent-sessions:aicopilot", "warning", "Unable to read aicopilot session database.", error instanceof Error ? error.message : String(error));
  }
}

interface AgentSessionInput {
  now: string;
  tool: "codewith" | "codex" | "claude" | "aicopilot";
  sessionId: string;
  title?: string;
  updatedAt?: string;
  cwd?: string;
  transcriptPath?: string;
  agent?: string;
  model?: string;
  resumeCommand: string[];
}

function agentSessionResource(input: AgentSessionInput): SnapshotResource | undefined {
  if (!input.sessionId) return undefined;
  return {
    id: `agent-session:${input.tool}:${stableIdPart(input.sessionId)}`,
    kind: "agent-session",
    name: `${input.tool}:${input.title ?? input.sessionId}`,
    source: `agent-sessions:${input.tool}`,
    attributes: redactJson({
      tool: input.tool,
      session_id: input.sessionId,
      title: input.title ?? null,
      cwd: input.cwd ?? null,
      updated_at: input.updatedAt ?? null,
      transcript_path: input.transcriptPath ?? null,
      agent: input.agent ?? null,
      model: input.model ?? null,
      resume_supported: true,
      resume_capability: "native-cli",
      resume_command: input.resumeCommand
    }) as JsonObject,
    observedAt: input.now
  };
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
        id: `browser-state:${stableIdPart(path)}`,
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
      id: `desktop-window:${stableIdPart(String(row.id ?? row.window_id ?? JSON.stringify(row).slice(0, 80)))}`,
      kind: "desktop-window" as const,
      name: String(row.title ?? row.app ?? row.id ?? "desktop-window"),
      source: "desktop",
      attributes: redactJson(row) as JsonObject,
      observedAt: now
    }));
  return { resources, diagnostics: [] };
}

function captureApps(now: string): CaptureResult {
  if (platform() === "darwin") return captureMacApps(now);
  if (platform() === "linux") return captureLinuxApps(now);
  return diagnostic("apps", "info", `Native app capture is not implemented for ${platform()}.`);
}

function captureMacApps(now: string): CaptureResult {
  const script = 'tell application "System Events" to get name of every application process whose background only is false';
  const result = runCommand("osascript", ["-e", script], 5_000);
  if (!result.ok) {
    const fallback = captureMacAppsFromProcesses(now);
    if (fallback.resources.length) {
      return {
        resources: fallback.resources,
        diagnostics: [{
          source: "apps",
          level: "warning",
          message: "System Events unavailable; captured macOS apps from process paths.",
          detail: result.stderr.trim()
        }]
      };
    }
    return diagnostic("apps", "warning", "Unable to query macOS application processes.", result.stderr.trim());
  }
  const names = result.stdout.split(",").map((name) => name.trim()).filter(Boolean);
  const resources = names.map((name) => ({
    id: `app:${stableIdPart(name)}`,
    kind: "app" as const,
    name,
    source: "macos-apps",
    attributes: {
      name,
      platform: "darwin",
      restore_supported: true,
      restore_command: ["open", "-a", name]
    },
    observedAt: now
  }));
  return { resources, diagnostics: [] };
}

function captureMacAppsFromProcesses(now: string): CaptureResult {
  const ps = runCommand("ps", ["-axo", "pid=,args="], 5_000);
  if (!ps.ok) return { resources: [], diagnostics: [] };
  const seen = new Set<string>();
  const resources: SnapshotResource[] = [];
  for (const line of ps.stdout.split("\n").map((entry) => entry.trim()).filter(Boolean)) {
    const match = line.match(/(\/(?:Applications|System\/Applications|System\/Library|Library\/Apple\/System\/Library)[^\n]*?\.app)\/Contents\/MacOS\//);
    if (!match) continue;
    const appPath = match[1];
    if (seen.has(appPath)) continue;
    seen.add(appPath);
    const name = basename(appPath, ".app");
    resources.push({
      id: `app:${stableIdPart(name)}`,
      kind: "app",
      name,
      source: "macos-processes",
      attributes: {
        name,
        app_path: appPath,
        platform: "darwin",
        restore_supported: true,
        restore_command: ["open", "-a", name]
      },
      observedAt: now
    });
  }
  return { resources, diagnostics: [] };
}

function captureLinuxApps(now: string): CaptureResult {
  if (!commandExists("wmctrl")) {
    return diagnostic("apps", "info", "Linux app capture requires wmctrl; no visible app resources captured.");
  }
  const result = runCommand("wmctrl", ["-lx"], 5_000);
  if (!result.ok) return diagnostic("apps", "warning", "Unable to query Linux desktop windows with wmctrl.", result.stderr.trim());
  const seen = new Set<string>();
  const resources: SnapshotResource[] = [];
  for (const line of result.stdout.split("\n").map((entry) => entry.trim()).filter(Boolean)) {
    const parts = line.split(/\s+/);
    const windowClass = parts[2];
    if (!windowClass || seen.has(windowClass)) continue;
    seen.add(windowClass);
    const name = windowClass.split(".").at(-1) ?? windowClass;
    resources.push({
      id: `app:${stableIdPart(windowClass)}`,
      kind: "app",
      name,
      source: "linux-wmctrl",
      attributes: {
        name,
        window_class: windowClass,
        platform: "linux",
        restore_supported: false,
        restore_command: null
      },
      observedAt: now
    });
  }
  return { resources, diagnostics: [] };
}

function diagnostic(source: string, level: CaptureDiagnostic["level"], message: string, detail?: JsonValue): CaptureResult {
  return { resources: [], diagnostics: [{ source, level, message, detail }] };
}

function diagnosticResource(diagnostic: CaptureDiagnostic, now: string): SnapshotResource {
  return {
    id: `diagnostic:${stableIdPart(`${diagnostic.source}:${diagnostic.message}`)}`,
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

interface TranscriptMetadata {
  sessionId?: string;
  cwd?: string;
  model?: string;
  updatedAt?: string;
  title?: string;
}

function indexTranscripts(root: string): Map<string, string> {
  const transcripts = new Map<string, string>();
  for (const path of listJsonlFiles(root, 1_000)) {
    const fileStem = basename(path, ".jsonl");
    const candidates = new Set<string>([fileStem]);
    const uuidMatch = fileStem.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    if (uuidMatch) candidates.add(uuidMatch[0]);
    const metadata = readTranscriptMetadata(path);
    if (metadata.sessionId) candidates.add(metadata.sessionId);
    for (const candidate of candidates) {
      if (candidate && !transcripts.has(candidate)) transcripts.set(candidate, path);
    }
  }
  return transcripts;
}

function listJsonlFiles(root: string, maxFiles: number): string[] {
  const rootStat = safeLstat(root);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) return [];
  const files: string[] = [];
  const directories = [root];
  const seenDirectories = new Set<string>();
  while (directories.length && files.length < maxFiles) {
    const directory = directories.shift();
    if (!directory) break;
    const realDirectory = safeRealpath(directory);
    if (!realDirectory || seenDirectories.has(realDirectory)) continue;
    seenDirectories.add(realDirectory);
    for (const entry of safeReaddir(directory).sort()) {
      const path = join(directory, entry);
      const stat = safeLstat(path);
      if (!stat || stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        directories.push(path);
      } else if (stat.isFile() && entry.endsWith(".jsonl")) {
        files.push(path);
        if (files.length >= maxFiles) break;
      }
    }
  }
  return files;
}

function readJsonl(path: string, maxLines: number): JsonObject[] {
  const stat = safeLstat(path);
  if (!stat?.isFile() || stat.isSymbolicLink()) return [];
  const content = readFilePrefix(path, Math.min(stat.size, MAX_TRANSCRIPT_READ_BYTES));
  const rows: JsonObject[] = [];
  for (const line of content.split("\n")) {
    if (rows.length >= maxLines) break;
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = parseJson(trimmed);
    if (isJsonObject(parsed)) rows.push(parsed);
  }
  return rows;
}

function readTranscriptMetadata(path: string, expectedSessionId?: string): TranscriptMetadata {
  const metadata: TranscriptMetadata = {};
  for (const row of readJsonl(path, 60)) {
    const payload = isJsonObject(row.payload) ? row.payload : undefined;
    const message = isJsonObject(row.message) ? row.message : undefined;
    const sessionId =
      stringValue(row.sessionId)
      ?? stringValue(row.session_id)
      ?? stringValue(row.id)
      ?? stringValue(payload?.sessionId)
      ?? stringValue(payload?.session_id)
      ?? stringValue(payload?.id);
    if (sessionId && (!expectedSessionId || sessionId === expectedSessionId)) {
      metadata.sessionId ??= sessionId;
    }
    metadata.cwd ??=
      stringValue(row.cwd)
      ?? stringValue(row.directory)
      ?? stringValue(payload?.cwd)
      ?? stringValue(payload?.directory);
    metadata.model ??= modelName(row.model) ?? modelName(payload?.model) ?? modelName(payload?.model_provider) ?? modelName(message?.model);
    metadata.updatedAt ??=
      isoTimestamp(row.updated_at)
      ?? isoTimestamp(row.updatedAt)
      ?? isoTimestamp(row.timestamp)
      ?? isoTimestamp(payload?.updated_at)
      ?? isoTimestamp(payload?.timestamp);
    metadata.title ??=
      stringValue(row.summary)
      ?? stringValue(row.title)
      ?? stringValue(payload?.summary)
      ?? stringValue(payload?.title);
  }
  return metadata;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return undefined;
}

function modelName(value: unknown): string | undefined {
  if (typeof value === "string") return parseModelName(value);
  if (!isJsonObject(value)) return undefined;
  const provider = stringValue(value.providerID) ?? stringValue(value.providerId) ?? stringValue(value.provider);
  const id = stringValue(value.id) ?? stringValue(value.model) ?? stringValue(value.name);
  const variant = stringValue(value.variant);
  const base = [provider, id].filter(Boolean).join("/");
  return base ? `${base}${variant ? `:${variant}` : ""}` : undefined;
}

function parseModelName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = parseJson(trimmed);
  const parsedModel = modelName(parsed);
  if (parsedModel) return parsedModel;
  if (typeof parsed === "string") return parsed;
  return trimmed.slice(0, 120);
}

function isoTimestamp(value: unknown): string | undefined {
  const text = stringValue(value);
  if (!text) return undefined;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? text : date.toISOString();
}

function millisToIso(value: unknown): string | undefined {
  const raw = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(raw)) return undefined;
  const millis = raw > 10_000_000_000 ? raw : raw * 1_000;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
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

function safeLstat(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

function safeRealpath(path: string): string | undefined {
  try {
    return resolve(realpathSync(path));
  } catch {
    return undefined;
  }
}

function readFilePrefix(path: string, maxBytes: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(Math.max(0, maxBytes));
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function isRestartableCommand(command: string): boolean {
  if (command.includes("HASNA_SNAPSHOTS_RESTARTABLE=1")) return true;
  return /\b(codex|claude|codewith|coders)\b/.test(command) && /\b(--resume|resume)\b/.test(command);
}

function parseRestartableCommand(args: string): { id: string; command?: string } | undefined {
  if (!args.includes("HASNA_SNAPSHOTS_RESTARTABLE=1")) return undefined;
  const idMatch = args.match(/HASNA_SNAPSHOTS_PROCESS_ID=([A-Za-z0-9_.:-]+)/);
  const commandB64Match = args.match(/HASNA_SNAPSHOTS_RESTART_COMMAND_B64=([A-Za-z0-9+/=_-]+)/);
  const commandFileMatch = args.match(/HASNA_SNAPSHOTS_RESTART_COMMAND_FILE=([^\s;]+)/);
  return {
    id: idMatch?.[1] ?? sha256(args).slice(0, 12),
    command: commandB64Match
      ? redactText(decodeRestartCommand(commandB64Match[1]))
      : commandFileMatch
        ? readRestartCommandFile(commandFileMatch[1])
        : undefined
  };
}

function decodeRestartCommand(encoded: string): string {
  try {
    const normalized = encoded.replaceAll("-", "+").replaceAll("_", "/");
    return Buffer.from(normalized, "base64").toString("utf8");
  } catch {
    return encoded;
  }
}

function readRestartCommandFile(path: string): string | undefined {
  const allowedRoot = resolve(process.env.HASNA_SNAPSHOTS_RESTART_COMMAND_DIR ?? join(defaultDataDir(), "restart-commands"));
  const resolvedPath = resolve(path);
  const rootStat = safeLstat(allowedRoot);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) return undefined;
  const realRoot = safeRealpath(allowedRoot);
  const realPath = safeRealpath(resolvedPath);
  if (!realRoot || !realPath || !pathInside(realPath, realRoot)) return undefined;
  const stat = safeLstat(resolvedPath);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > MAX_RESTART_COMMAND_FILE_BYTES) return undefined;
  try {
    const content = readFileSync(resolvedPath, "utf8");
    return redactText(content.trim()).slice(0, 16_000);
  } catch {
    return undefined;
  }
}

function pathInside(path: string, root: string): boolean {
  const offset = relative(root, path);
  return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
}

function positiveIntegerOption(value: number | undefined, defaultValue: number, maxValue: number): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return Math.min(value, maxValue);
  return defaultValue;
}
