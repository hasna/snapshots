import type { JsonObject, JsonValue, RestorePlan, SnapshotRecord, StoredSnapshotResource } from "./types.js";
import { CONTRACT_VERSION } from "./contracts.js";

export interface ResumeContext {
  contract_version: typeof CONTRACT_VERSION;
  snapshot_id: string;
  created_at: string;
  resource_count: number;
  summary: JsonObject;
  projects: JsonObject[];
  tmux: JsonObject[];
  agent_sessions: JsonObject[];
  restartable_processes: JsonObject[];
  diagnostics: JsonObject[];
  restore_plan_summary?: RestorePlan["summary"];
  truncated: boolean;
}

interface ResumeContextOptions {
  maxProjects?: number;
  maxTmuxSessions?: number;
  maxWindowsPerSession?: number;
  maxPanesPerWindow?: number;
  maxAgentSessions?: number;
  maxProcesses?: number;
  maxDiagnostics?: number;
  maxPaneTailChars?: number;
}

const DEFAULT_OPTIONS: Required<ResumeContextOptions> = {
  maxProjects: 12,
  maxTmuxSessions: 8,
  maxWindowsPerSession: 8,
  maxPanesPerWindow: 6,
  maxAgentSessions: 24,
  maxProcesses: 20,
  maxDiagnostics: 24,
  maxPaneTailChars: 1_200
};

export function buildResumeContext(
  snapshot: SnapshotRecord,
  resources: StoredSnapshotResource[],
  plan?: RestorePlan,
  options: ResumeContextOptions = {}
): ResumeContext {
  const limits = { ...DEFAULT_OPTIONS, ...options };
  const sorted = [...resources].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const projects = sorted
    .filter((resource) => resource.kind === "project")
    .slice(0, limits.maxProjects)
    .map((resource) => compactProject(resource));
  const tmux = sorted
    .filter((resource) => resource.kind === "tmux-session")
    .slice(0, limits.maxTmuxSessions)
    .map((session) => compactTmuxSession(session, sorted, limits));
  const agentSessions = sorted
    .filter((resource) => resource.kind === "agent-session")
    .slice(0, limits.maxAgentSessions)
    .map(compactAgentSession);
  const restartableProcesses = sorted
    .filter((resource) => resource.kind === "process" && resource.attributes.restartable === true)
    .slice(0, limits.maxProcesses)
    .map(compactProcess);
  const diagnostics = sorted
    .filter((resource) => resource.kind === "diagnostic")
    .slice(0, limits.maxDiagnostics)
    .map(compactDiagnostic);

  return {
    contract_version: CONTRACT_VERSION,
    snapshot_id: snapshot.id,
    created_at: snapshot.createdAt,
    resource_count: snapshot.resourceCount,
    summary: snapshot.summary,
    projects,
    tmux,
    agent_sessions: agentSessions,
    restartable_processes: restartableProcesses,
    diagnostics,
    restore_plan_summary: plan?.summary,
	    truncated:
	      projects.length < sorted.filter((resource) => resource.kind === "project").length
	      || tmux.length < sorted.filter((resource) => resource.kind === "tmux-session").length
	      || hasNestedTmuxTruncation(sorted, limits)
	      || agentSessions.length < sorted.filter((resource) => resource.kind === "agent-session").length
      || restartableProcesses.length < sorted.filter((resource) => resource.kind === "process" && resource.attributes.restartable === true).length
      || diagnostics.length < sorted.filter((resource) => resource.kind === "diagnostic").length
  };
}

function hasNestedTmuxTruncation(resources: StoredSnapshotResource[], limits: Required<ResumeContextOptions>): boolean {
  const sessions = resources
    .filter((resource) => resource.kind === "tmux-session")
    .slice(0, limits.maxTmuxSessions);
  for (const session of sessions) {
    const windows = resources
      .filter((candidate) =>
        candidate.kind === "tmux-window"
        && (candidate.parentId === session.id || candidate.attributes.session === session.name)
      )
      .sort((a, b) => numberValue(a.attributes.index) - numberValue(b.attributes.index));
    if (windows.length > limits.maxWindowsPerSession) return true;
    for (const window of windows.slice(0, limits.maxWindowsPerSession)) {
      const sessionName = stringValue(window.attributes.session);
      const windowIndex = numberValue(window.attributes.index);
      const panes = resources.filter((candidate) =>
        candidate.kind === "tmux-pane"
        && (
          candidate.parentId === window.id
          || (
            candidate.attributes.session === sessionName
            && numberValue(candidate.attributes.window_index) === windowIndex
          )
        )
      );
      if (panes.length > limits.maxPanesPerWindow) return true;
    }
  }
  return false;
}

function compactProject(resource: StoredSnapshotResource): JsonObject {
  return {
    id: resource.id,
    name: resource.name,
    path: stringValue(resource.attributes.path) ?? stringValue(resource.attributes.primary_path) ?? null,
    source: resource.source
  };
}

function compactTmuxSession(resource: StoredSnapshotResource, resources: StoredSnapshotResource[], limits: Required<ResumeContextOptions>): JsonObject {
  const windows = resources
    .filter((candidate) =>
      candidate.kind === "tmux-window"
      && (candidate.parentId === resource.id || candidate.attributes.session === resource.name)
    )
    .sort((a, b) => numberValue(a.attributes.index) - numberValue(b.attributes.index))
    .slice(0, limits.maxWindowsPerSession)
    .map((window) => compactTmuxWindow(window, resources, limits));
  return {
    id: resource.id,
    name: resource.name,
    attached: booleanValue(resource.attributes.attached),
    cwd: stringValue(resource.attributes.cwd) ?? null,
    windows
  };
}

function compactTmuxWindow(resource: StoredSnapshotResource, resources: StoredSnapshotResource[], limits: Required<ResumeContextOptions>): JsonObject {
  const session = stringValue(resource.attributes.session);
  const windowIndex = numberValue(resource.attributes.index);
  const panes = resources
    .filter((candidate) =>
      candidate.kind === "tmux-pane"
      && (
        candidate.parentId === resource.id
        || (
          candidate.attributes.session === session
          && numberValue(candidate.attributes.window_index) === windowIndex
        )
      )
    )
    .sort((a, b) => numberValue(a.attributes.pane_index) - numberValue(b.attributes.pane_index))
    .slice(0, limits.maxPanesPerWindow)
    .map((pane) => compactTmuxPane(pane, limits.maxPaneTailChars));
  return {
    id: resource.id,
    index: windowIndex,
    name: stringValue(resource.attributes.name) ?? resource.name,
    active: booleanValue(resource.attributes.active),
    cwd: stringValue(resource.attributes.current_path) ?? null,
    restartable: booleanValue(resource.attributes.restartable),
    start_command: booleanValue(resource.attributes.restartable) ? stringValue(resource.attributes.start_command) ?? null : null,
    panes
  };
}

function compactTmuxPane(resource: StoredSnapshotResource, maxPaneTailChars: number): JsonObject {
  const tail = stringValue(resource.attributes.content_tail);
  return {
    id: resource.id,
    index: numberValue(resource.attributes.pane_index),
    active: booleanValue(resource.attributes.active),
    cwd: stringValue(resource.attributes.current_path) ?? null,
    command: stringValue(resource.attributes.current_command) ?? null,
    content_tail: tail ? tail.slice(-maxPaneTailChars) : null
  };
}

function compactAgentSession(resource: StoredSnapshotResource): JsonObject {
  return {
    id: resource.id,
    tool: stringValue(resource.attributes.tool) ?? null,
    session_id: stringValue(resource.attributes.session_id) ?? null,
    title: stringValue(resource.attributes.title) ?? resource.name,
    cwd: stringValue(resource.attributes.cwd) ?? null,
    updated_at: stringValue(resource.attributes.updated_at) ?? null,
    model: stringValue(resource.attributes.model) ?? null,
    resume_command: stringArray(resource.attributes.resume_command) ?? []
  };
}

function compactProcess(resource: StoredSnapshotResource): JsonObject {
  return {
    id: resource.id,
    name: resource.name,
    pid: numberValue(resource.attributes.pid),
    process_id: stringValue(resource.attributes.process_id) ?? null,
    command: stringValue(resource.attributes.command) ?? null
  };
}

function compactDiagnostic(resource: StoredSnapshotResource): JsonObject {
  return {
    source: resource.source,
    level: stringValue(resource.attributes.level) ?? "info",
    message: stringValue(resource.attributes.message) ?? resource.name
  };
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function stringArray(value: JsonValue | undefined): string[] | undefined {
  return Array.isArray(value) && value.every((part) => typeof part === "string") ? value : undefined;
}

function numberValue(value: JsonValue | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function booleanValue(value: JsonValue | undefined): boolean {
  return value === true;
}
