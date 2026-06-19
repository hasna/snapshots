import { existsSync, mkdirSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import type {
  RestoreExecutionOptions,
  RestoreOperation,
  RestorePlan,
  RestorePolicy,
  SnapshotRecord,
  StoredSnapshotResource
} from "./types.js";
import { commandExists, nowIso, runTmux, sha256, stableJson, tmuxCommand } from "./util.js";
import { resolvePolicy } from "./policy.js";

export function createRestorePlan(
  snapshot: SnapshotRecord,
  resources: StoredSnapshotResource[],
  policies: RestorePolicy[] = [],
  options: RestoreExecutionOptions = {}
): RestorePlan {
  const operations: RestoreOperation[] = [];

  for (const resource of resources) {
    const policy = resolvePolicy(resource, policies);
    if (policy.mode === "ignore") {
      operations.push(operation(resource, "ignored", "Ignored by restore policy.", "skipped", policy.reason));
      continue;
    }
    if (policy.mode !== "restore") {
      operations.push(operation(resource, "observed", "Observed only; no restore action.", "skipped", policy.reason));
      continue;
    }

    if (resource.kind === "project") {
      operations.push(planProject(resource));
    } else if (resource.kind === "tmux-session") {
      operations.push(planTmuxSession(resource, resources));
    } else if (resource.kind === "tmux-window") {
      operations.push(planTmuxWindow(resource));
      operations.push(...planTmuxWindowState(resource));
    } else if (resource.kind === "tmux-pane") {
      operations.push(planTmuxPane(resource, resources));
      operations.push(...planTmuxPaneState(resource));
    } else if (resource.kind === "process") {
      operations.push(planProcess(resource));
    } else if (resource.kind === "app") {
      operations.push(planApp(resource, policy));
    } else {
      operations.push(operation(resource, "unsupported", "No restore adapter for this resource kind.", "skipped"));
    }
  }

  const plan: RestorePlan = {
    id: `plan_${snapshot.id}_${sha256(stableJson(operations.map((op) => ({ id: op.id, status: op.status })))).slice(0, 12)}`,
    snapshotId: snapshot.id,
    createdAt: nowIso(),
    apply: Boolean(options.apply),
    operations: sortOperations(operations),
    summary: summarizeOperations(operations)
  };

  if (options.apply) {
    return executeRestorePlan(plan, options);
  }

  return plan;
}

export function executeRestorePlan(plan: RestorePlan, options: RestoreExecutionOptions = {}): RestorePlan {
  if (!options.apply) return plan;
  if (!options.yes) {
    const operations = plan.operations.map((op) =>
      op.status === "planned"
        ? { ...op, status: "blocked" as const, reason: "Restore execution requires --apply --yes." }
        : op
    );
    return {
      ...plan,
      apply: true,
      operations: sortOperations(operations),
      summary: summarizeOperations(operations)
    };
  }

  const operations = sortOperations(plan.operations).map((op) => executeOperation(op));
  return {
    ...plan,
    apply: true,
    operations,
    summary: summarizeOperations(operations)
  };
}

function planProject(resource: StoredSnapshotResource): RestoreOperation {
  const path = typeof resource.attributes.path === "string" ? resource.attributes.path : undefined;
  if (!path) {
    return operation(resource, "project.mkdir", "Project has no path attribute.", "blocked");
  }
  if (existsSync(path)) {
    return operation(resource, "project.exists", `Project path already exists: ${path}`, "noop");
  }
  return operation(resource, "project.mkdir", `Create missing project directory: ${path}`, "planned", undefined, [
    "mkdir",
    "-p",
    path
  ]);
}

function planTmuxSession(resource: StoredSnapshotResource, resources: StoredSnapshotResource[]): RestoreOperation {
  const name = resource.name;
  if (!/^[A-Za-z0-9_.:-]+$/.test(name)) {
    return operation(resource, "tmux.create-session", `Unsafe tmux session name: ${name}`, "blocked");
  }
  if (!commandExists("tmux")) {
    return operation(resource, "tmux.create-session", "tmux is not installed or not on PATH.", "blocked");
  }
  const hasSession = runTmux(["has-session", "-t", name], 2_000).status === 0;
  if (hasSession) {
    return operation(resource, "tmux.exists", `tmux session already exists: ${name}`, "noop");
  }
  const firstWindow = resources
    .filter((candidate) => candidate.kind === "tmux-window" && candidate.parentId === resource.id)
    .sort((a, b) => Number(a.attributes.index ?? 0) - Number(b.attributes.index ?? 0))[0];
  const cwd =
    typeof firstWindow?.attributes.current_path === "string"
      ? firstWindow.attributes.current_path
      : typeof resource.attributes.cwd === "string"
        ? resource.attributes.cwd
        : process.cwd();
  const command = tmuxCommand(["new-session", "-d", "-s", name, "-c", cwd]);
  if (firstWindow && typeof firstWindow.attributes.name === "string") {
    command.push("-n", firstWindow.attributes.name);
  }
  const startCommand = typeof firstWindow?.attributes.start_command === "string" ? firstWindow.attributes.start_command : "";
  if (firstWindow?.attributes.restartable === true && startCommand) {
    command.push(startCommand);
  }
  return operation(resource, "tmux.create-session", `Create detached tmux session: ${name}`, "planned", undefined, [
    ...command
  ]);
}

function planTmuxWindow(resource: StoredSnapshotResource): RestoreOperation {
  const session = typeof resource.attributes.session === "string" ? resource.attributes.session : undefined;
  const name = typeof resource.attributes.name === "string" ? resource.attributes.name : resource.name.split(":").slice(2).join(":");
  if (!session || !name) return operation(resource, "tmux.create-window", "Window is missing session/name metadata.", "blocked");
  if (!commandExists("tmux")) return operation(resource, "tmux.create-window", "tmux is not installed or not on PATH.", "blocked");
  if (tmuxWindowExists(session, name)) {
    return operation(resource, "tmux.window-exists", `tmux window already exists: ${session}:${name}`, "noop");
  }
  const cwd = typeof resource.attributes.current_path === "string" ? resource.attributes.current_path : process.cwd();
  const command = tmuxCommand(["new-window", "-d", "-t", session, "-n", name, "-c", cwd]);
  const startCommand = typeof resource.attributes.start_command === "string" ? resource.attributes.start_command : "";
  if (resource.attributes.restartable === true && startCommand) {
    command.push(startCommand);
  }
  return operation(resource, "tmux.create-window", `Create tmux window: ${session}:${name}`, "planned", undefined, command);
}

function planTmuxPane(resource: StoredSnapshotResource, resources: StoredSnapshotResource[]): RestoreOperation {
  const session = typeof resource.attributes.session === "string" ? resource.attributes.session : undefined;
  const windowIndex = Number(resource.attributes.window_index);
  const paneIndex = Number(resource.attributes.pane_index);
  if (!session || !Number.isFinite(windowIndex) || !Number.isFinite(paneIndex)) {
    return operation(resource, "tmux.create-pane", "Pane is missing session/window/pane metadata.", "blocked");
  }
  if (paneIndex === firstPaneIndexForWindow(resource, resources)) {
    return operation(resource, "tmux.initial-pane", "Initial pane is created with the tmux window.", "noop");
  }
  if (!commandExists("tmux")) return operation(resource, "tmux.create-pane", "tmux is not installed or not on PATH.", "blocked");
  if (tmuxPaneExists(session, windowIndex, paneIndex)) {
    return operation(resource, "tmux.pane-exists", `tmux pane index already exists: ${session}:${windowIndex}.${paneIndex}`, "noop");
  }
  const cwd = typeof resource.attributes.current_path === "string" ? resource.attributes.current_path : process.cwd();
  const command = tmuxCommand(["split-window", "-d", "-t", `${session}:${windowIndex}`, "-c", cwd]);
  const startCommand = typeof resource.attributes.start_command === "string" ? resource.attributes.start_command : "";
  if (resource.attributes.restartable === true && startCommand) {
    command.push(startCommand);
  }
  return operation(resource, "tmux.create-pane", `Create tmux pane: ${session}:${windowIndex}.${paneIndex}`, "planned", undefined, command);
}

function planTmuxWindowState(resource: StoredSnapshotResource): RestoreOperation[] {
  const session = typeof resource.attributes.session === "string" ? resource.attributes.session : undefined;
  const windowIndex = Number(resource.attributes.index);
  if (!session || !Number.isFinite(windowIndex) || !commandExists("tmux")) return [];
  const operations: RestoreOperation[] = [];
  const layout = typeof resource.attributes.layout === "string" ? resource.attributes.layout : undefined;
  if (layout && Number(resource.attributes.pane_count ?? 0) > 1) {
    operations.push(operation(
      resource,
      "tmux.select-layout",
      `Restore tmux layout: ${session}:${windowIndex}`,
      "planned",
      undefined,
      tmuxCommand(["select-layout", "-t", `${session}:${windowIndex}`, layout])
    ));
  }
  if (resource.attributes.active === true) {
    operations.push(operation(
      resource,
      "tmux.select-window",
      `Restore active tmux window: ${session}:${windowIndex}`,
      "planned",
      undefined,
      tmuxCommand(["select-window", "-t", `${session}:${windowIndex}`])
    ));
  }
  return operations;
}

function planTmuxPaneState(resource: StoredSnapshotResource): RestoreOperation[] {
  const session = typeof resource.attributes.session === "string" ? resource.attributes.session : undefined;
  const windowIndex = Number(resource.attributes.window_index);
  const paneIndex = Number(resource.attributes.pane_index);
  if (!session || !Number.isFinite(windowIndex) || !Number.isFinite(paneIndex) || !commandExists("tmux")) return [];
  if (resource.attributes.active !== true) return [];
  return [
    operation(
      resource,
      "tmux.select-pane",
      `Restore active tmux pane: ${session}:${windowIndex}.${paneIndex}`,
      "planned",
      undefined,
      tmuxCommand(["select-pane", "-t", `${session}:${windowIndex}.${paneIndex}`])
    )
  ];
}

function planProcess(resource: StoredSnapshotResource): RestoreOperation {
  if (resource.attributes.restartable !== true) {
    return operation(resource, "process.observe", "Process lacks explicit restartable marker.", "skipped");
  }
  const processId = typeof resource.attributes.process_id === "string" ? resource.attributes.process_id : undefined;
  const restartCommand = typeof resource.attributes.restart_command === "string" ? resource.attributes.restart_command : undefined;
  if (!restartCommand) {
    return operation(
      resource,
      "process.restart",
      "Restartable process is missing restart_command.",
      "blocked",
      "Captured processes require HASNA_SNAPSHOTS_RESTART_COMMAND_B64 or HASNA_SNAPSHOTS_RESTART_COMMAND_FILE for replay."
    );
  }
  if (processId && processMarkerRunning(processId)) {
    return operation(resource, "process.exists", `Restartable process already running: ${processId}`, "noop");
  }
  return operation(resource, "process.restart", `Restart marked process: ${processId ?? resource.name}`, "planned", undefined, [
    "sh",
    "-lc",
    restartCommand
  ]);
}

function planApp(resource: StoredSnapshotResource, policy: RestorePolicy): RestoreOperation {
  const name = typeof resource.attributes.name === "string" ? resource.attributes.name : resource.name;
  if (!name) return operation(resource, "app.open", "App resource has no name.", "blocked");
  if (policy.selector !== resource.id) {
    return operation(resource, "app.observe", "App restore requires a per-app restore policy.", "skipped", policy.reason);
  }
  const restoreCommand = Array.isArray(resource.attributes.restore_command)
    ? resource.attributes.restore_command.filter((part): part is string => typeof part === "string")
    : undefined;
  if (macAppRunning(name)) return operation(resource, "app.exists", `App already running: ${name}`, "noop");
  if (restoreCommand?.length) {
    return operation(resource, "app.open", `Open app: ${name}`, "planned", undefined, restoreCommand);
  }
  if (process.platform === "darwin") {
    return operation(resource, "app.open", `Open macOS app: ${name}`, "planned", undefined, ["open", "-a", name]);
  }
  return operation(resource, "app.open", "App restore requires an explicit restore_command on this platform.", "skipped");
}

function executeOperation(op: RestoreOperation): RestoreOperation {
  if (op.status !== "planned") return op;
  if (op.kind === "project.mkdir") {
    const path = op.command?.at(-1);
    if (!path) return { ...op, status: "failed", reason: "Missing project path." };
    try {
      mkdirSync(path, { recursive: true });
      return { ...op, status: "applied" };
    } catch (error) {
      return { ...op, status: "failed", reason: error instanceof Error ? error.message : String(error) };
    }
  }
  if (op.kind === "tmux.create-session" && op.command) {
    const [command, ...args] = op.command;
    const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5_000 });
    if (result.status === 0) return { ...op, status: "applied" };
    return {
      ...op,
      status: "failed",
      reason: result.stderr?.trim() || result.error?.message || `Command exited with ${result.status}`
    };
  }
  if (op.kind === "tmux.create-window" && op.command) {
    const session = String(op.resource?.attributes.session ?? "");
    const name = String(op.resource?.attributes.name ?? "");
    if (session && name && tmuxWindowExists(session, name)) return { ...op, status: "noop", reason: "Window already exists at execution time." };
    const [command, ...args] = op.command;
    const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5_000 });
    if (result.status === 0) return { ...op, status: "applied" };
    return { ...op, status: "failed", reason: result.stderr?.trim() || result.error?.message || `Command exited with ${result.status}` };
  }
  if (op.kind === "tmux.create-pane" && op.command) {
    const session = String(op.resource?.attributes.session ?? "");
    const windowIndex = Number(op.resource?.attributes.window_index);
    const paneIndex = Number(op.resource?.attributes.pane_index);
    if (session && Number.isFinite(windowIndex) && Number.isFinite(paneIndex) && tmuxPaneExists(session, windowIndex, paneIndex)) {
      return { ...op, status: "noop", reason: "Pane already exists at execution time." };
    }
    const [command, ...args] = op.command;
    const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5_000 });
    if (result.status === 0) return { ...op, status: "applied" };
    return { ...op, status: "failed", reason: result.stderr?.trim() || result.error?.message || `Command exited with ${result.status}` };
  }
  if ((op.kind === "tmux.select-layout" || op.kind === "tmux.select-pane" || op.kind === "tmux.select-window") && op.command) {
    const [command, ...args] = op.command;
    const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5_000 });
    if (result.status === 0) return { ...op, status: "applied" };
    return { ...op, status: "failed", reason: result.stderr?.trim() || result.error?.message || `Command exited with ${result.status}` };
  }
  if (op.kind === "process.restart" && op.command) {
    const [command, ...args] = op.command;
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.unref();
    return { ...op, status: "applied" };
  }
  if (op.kind === "app.open" && op.command) {
    const [command, ...args] = op.command;
    const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 });
    if (result.status === 0) return { ...op, status: "applied" };
    return { ...op, status: "failed", reason: result.stderr?.trim() || result.error?.message || `Command exited with ${result.status}` };
  }
  return { ...op, status: "blocked", reason: "No executor for operation kind." };
}

function operation(
  resource: StoredSnapshotResource,
  kind: string,
  summary: string,
  status: RestoreOperation["status"],
  reason?: string,
  command?: string[]
): RestoreOperation {
  return {
    id: `${kind}:${resource.id}`,
    kind,
    resourceId: resource.id,
    resourceKind: resource.kind,
    summary,
    status,
    reason,
    command,
    resource
  };
}

function summarizeOperations(operations: RestoreOperation[]): RestorePlan["summary"] {
  const summary: RestorePlan["summary"] = {
    planned: 0,
    noop: 0,
    blocked: 0,
    skipped: 0,
    applied: 0,
    failed: 0
  };
  for (const op of operations) {
    summary[op.status] += 1;
  }
  return summary;
}

function sortOperations(operations: RestoreOperation[]): RestoreOperation[] {
  const priority: Record<string, number> = {
    "project.mkdir": 10,
    "tmux.create-session": 20,
    "tmux.create-window": 30,
    "tmux.create-pane": 35,
    "tmux.select-layout": 36,
    "tmux.select-pane": 37,
    "tmux.select-window": 38,
    "process.restart": 40,
    "app.open": 50
  };
  return [...operations].sort((a, b) => (priority[a.kind] ?? 100) - (priority[b.kind] ?? 100) || a.id.localeCompare(b.id));
}

function tmuxWindowExists(session: string, name: string): boolean {
  const result = runTmux(["list-windows", "-t", session, "-F", "#{window_name}"], 2_000);
  return result.status === 0 && result.stdout.split("\n").map((line) => line.trim()).includes(name);
}

function firstPaneIndexForWindow(resource: StoredSnapshotResource, resources: StoredSnapshotResource[]): number {
  const session = resource.attributes.session;
  const windowIndex = resource.attributes.window_index;
  const indexes = resources
    .filter((candidate) =>
      candidate.kind === "tmux-pane"
      && candidate.attributes.session === session
      && candidate.attributes.window_index === windowIndex
    )
    .map((candidate) => Number(candidate.attributes.pane_index))
    .filter(Number.isFinite);
  return indexes.length ? Math.min(...indexes) : 0;
}

function tmuxPaneExists(session: string, windowIndex: number, paneIndex: number): boolean {
  const result = runTmux(["list-panes", "-t", `${session}:${windowIndex}`, "-F", "#{pane_index}"], 2_000);
  if (result.status !== 0) return false;
  return result.stdout.split("\n").map((line) => Number(line.trim())).includes(paneIndex);
}

function processMarkerRunning(processId: string): boolean {
  const result = spawnSync("ps", ["-axo", "pid=,args="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 2_000
  });
  if (result.status !== 0) return false;
  return result.stdout.split("\n").some((line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    const match = trimmed.match(/^(\d+)\s+(.*)$/);
    if (!match) return false;
    const [, pid, args] = match;
    return Number(pid) !== process.pid
      && args.includes("HASNA_SNAPSHOTS_RESTARTABLE=1")
      && args.includes(`HASNA_SNAPSHOTS_PROCESS_ID=${processId}`);
  });
}

function macAppRunning(name: string): boolean {
  if (process.platform !== "darwin") return false;
  const result = spawnSync("osascript", ["-e", `tell application "System Events" to exists application process "${escapeAppleScript(name)}"`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000
  });
  if (result.status === 0) return result.stdout.trim() === "true";
  const ps = spawnSync("ps", ["-axo", "args="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 2_000
  });
  if (ps.status !== 0) return false;
  return ps.stdout.split("\n").some((line) => line.includes(`/${name}.app/Contents/MacOS/`));
}

function escapeAppleScript(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
