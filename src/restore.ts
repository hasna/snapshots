import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type {
  RestoreExecutionOptions,
  RestoreOperation,
  RestoreOperationSafety,
  RestorePlan,
  RestorePolicy,
  SnapshotRecord,
  StoredSnapshotResource
} from "./types.js";
import { commandExists, nowIso, runTmux, sha256, stableJson, tmuxCommand, slugPart } from "./util.js";
import { resolvePolicy } from "./policy.js";
import { CONTRACT_VERSION } from "./contracts.js";

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
      operations.push(planProject(resource, policy));
    } else if (resource.kind === "tmux-session") {
      operations.push(planTmuxSession(resource, resources));
    } else if (resource.kind === "tmux-window") {
      const windowOperation = planTmuxWindow(resource);
      operations.push(windowOperation);
      if (windowOperation.status !== "blocked") operations.push(...planTmuxWindowState(resource));
    } else if (resource.kind === "tmux-pane") {
      const paneOperation = planTmuxPane(resource, resources);
      operations.push(paneOperation);
      if (paneOperation.status !== "blocked") operations.push(...planTmuxPaneState(resource));
    } else if (resource.kind === "process") {
      operations.push(planProcess(resource, policy));
    } else if (resource.kind === "agent-session") {
      operations.push(planAgentSession(resource, policy));
    } else if (resource.kind === "app") {
      operations.push(planApp(resource, policy));
    } else {
      operations.push(operation(resource, "unsupported", "No restore adapter for this resource kind.", "skipped"));
    }
  }

  const plan: RestorePlan = {
    contract_version: CONTRACT_VERSION,
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
    const reason = "Restore execution requires --apply --yes.";
    const operations = plan.operations.map((op) =>
      op.status === "planned"
        ? { ...op, status: "blocked" as const, reason, safety: operationSafety(op.kind, "blocked", reason, op.command) }
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

function planProject(resource: StoredSnapshotResource, policy: RestorePolicy): RestoreOperation {
  const path = typeof resource.attributes.path === "string" ? resource.attributes.path : undefined;
  if (!path) {
    return operation(resource, "project.mkdir", "Project has no path attribute.", "blocked");
  }
  const pathError = validateProjectPath(path, policy.selector === resource.id);
  if (pathError) {
    return operation(resource, "project.mkdir", pathError, "blocked", pathError);
  }
  const resolvedPath = resolve(path);
  if (existsSync(resolvedPath)) {
    return operation(resource, "project.exists", `Project path already exists: ${resolvedPath}`, "noop");
  }
  return operation(resource, "project.mkdir", `Create missing project directory: ${resolvedPath}`, "planned", undefined, [
    "mkdir",
    "-p",
    resolvedPath
  ]);
}

function planTmuxSession(resource: StoredSnapshotResource, resources: StoredSnapshotResource[]): RestoreOperation {
  const name = resource.name;
  if (!/^[A-Za-z0-9_.:-]+$/.test(name)) {
    return operation(resource, "tmux.create-session", `Unsafe tmux session name: ${name}`, "blocked");
  }
  if (!tmuxAvailable()) {
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
  return operation(resource, "tmux.create-session", `Create detached tmux session: ${name}`, "planned", undefined, [
    ...command
  ]);
}

function planTmuxWindow(resource: StoredSnapshotResource): RestoreOperation {
  const session = typeof resource.attributes.session === "string" ? resource.attributes.session : undefined;
  const name = typeof resource.attributes.name === "string" ? resource.attributes.name : resource.name.split(":").slice(2).join(":");
  const windowIndex = Number(resource.attributes.index);
  if (!session || !name || !Number.isFinite(windowIndex)) return operation(resource, "tmux.create-window", "Window is missing session/name/index metadata.", "blocked");
  if (!tmuxAvailable()) return operation(resource, "tmux.create-window", "tmux is not installed or not on PATH.", "blocked");
  const existingTarget = tmuxWindowNameAtIndex(session, windowIndex);
  if (existingTarget === name) {
    return operation(resource, "tmux.window-exists", `tmux window already exists: ${session}:${windowIndex}:${name}`, "noop");
  }
  if (existingTarget) {
    return operation(resource, "tmux.create-window", `tmux window index ${session}:${windowIndex} is occupied by ${existingTarget}.`, "blocked");
  }
  if (tmuxWindowExists(session, name)) {
    return operation(resource, "tmux.create-window", `tmux window name exists at a different index: ${session}:${name}`, "blocked");
  }
  const cwd = typeof resource.attributes.current_path === "string" ? resource.attributes.current_path : process.cwd();
  const command = tmuxCommand(["new-window", "-d", "-t", `${session}:${windowIndex}`, "-n", name, "-c", cwd]);
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
  if (!tmuxAvailable()) return operation(resource, "tmux.create-pane", "tmux is not installed or not on PATH.", "blocked");
  if (tmuxPaneExists(session, windowIndex, paneIndex)) {
    return operation(resource, "tmux.pane-exists", `tmux pane index already exists: ${session}:${windowIndex}.${paneIndex}`, "noop");
  }
  const cwd = typeof resource.attributes.current_path === "string" ? resource.attributes.current_path : process.cwd();
  const command = tmuxCommand(["split-window", "-d", "-t", `${session}:${windowIndex}`, "-c", cwd]);
  return operation(resource, "tmux.create-pane", `Create tmux pane: ${session}:${windowIndex}.${paneIndex}`, "planned", undefined, command);
}

function planTmuxWindowState(resource: StoredSnapshotResource): RestoreOperation[] {
  const session = typeof resource.attributes.session === "string" ? resource.attributes.session : undefined;
  const windowIndex = Number(resource.attributes.index);
  if (!session || !Number.isFinite(windowIndex) || !tmuxAvailable()) return [];
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
  if (!session || !Number.isFinite(windowIndex) || !Number.isFinite(paneIndex) || !tmuxAvailable()) return [];
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

function planProcess(resource: StoredSnapshotResource, policy: RestorePolicy): RestoreOperation {
  if (policy.selector !== resource.id) {
    return operation(resource, "process.observe", "Process restore requires a per-process restore policy.", "skipped", policy.reason);
  }
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
  const validationError = validateRestartCommand(processId, restartCommand);
  if (validationError) {
    return operation(resource, "process.restart", validationError, "blocked", validationError);
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

function planAgentSession(resource: StoredSnapshotResource, policy: RestorePolicy): RestoreOperation {
  if (policy.selector !== resource.id) {
    return operation(resource, "agent-session.observe", "Agent session resume requires a per-session restore policy.", "skipped", policy.reason);
  }
  const tool = typeof resource.attributes.tool === "string" ? resource.attributes.tool : undefined;
  const sessionId = typeof resource.attributes.session_id === "string" ? resource.attributes.session_id : undefined;
  const resumeCommand = stringArray(resource.attributes.resume_command);
  if (!tool || !sessionId) {
    return operation(resource, "agent-session.resume", "Agent session is missing tool/session_id metadata.", "blocked");
  }
  if (!resumeCommand) {
    return operation(resource, "agent-session.resume", "Agent session is missing a native resume_command.", "blocked");
  }
  const validationError = validateAgentResumeCommand(tool, sessionId, resumeCommand);
  if (validationError) {
    return operation(resource, "agent-session.resume", validationError, "blocked", validationError);
  }
  return operation(resource, "agent-session.resume", `Resume ${tool} session: ${sessionId}`, "planned", undefined, resumeCommand);
}

function planApp(resource: StoredSnapshotResource, policy: RestorePolicy): RestoreOperation {
  const name = typeof resource.attributes.name === "string" ? resource.attributes.name : resource.name;
  if (!name) return operation(resource, "app.open", "App resource has no name.", "blocked");
  if (policy.selector !== resource.id) {
    return operation(resource, "app.observe", "App restore requires a per-app restore policy.", "skipped", policy.reason);
  }
  const restoreCommand = stringArray(resource.attributes.restore_command);
  if (macAppRunning(name)) return operation(resource, "app.exists", `App already running: ${name}`, "noop");
  if (restoreCommand?.length) {
    const validationError = validateAppRestoreCommand(name, restoreCommand);
    if (validationError) return operation(resource, "app.open", validationError, "blocked", validationError);
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
    const pathError = validateProjectPath(path, true);
    if (pathError) {
      return { ...op, status: "blocked", reason: pathError, safety: operationSafety(op.kind, "blocked", pathError, op.command) };
    }
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
    const windowIndex = Number(op.resource?.attributes.index);
    if (session && name && Number.isFinite(windowIndex)) {
      const existingTarget = tmuxWindowNameAtIndex(session, windowIndex);
      if (existingTarget === name) return { ...op, status: "noop", reason: "Window already exists at execution time." };
      if (existingTarget) return { ...op, status: "blocked", reason: `Window index occupied at execution time: ${existingTarget}` };
      if (tmuxWindowExists(session, name)) return { ...op, status: "blocked", reason: "Window name exists at a different index at execution time." };
    }
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
    if (op.resource?.attributes.restartable !== true) {
      return { ...op, status: "blocked", reason: "Restartable marker missing at execution time.", safety: operationSafety(op.kind, "blocked", "Restartable marker missing at execution time.", op.command) };
    }
    const processId = typeof op.resource.attributes.process_id === "string" ? op.resource.attributes.process_id : undefined;
    const restartCommand = op.command[2];
    if (typeof restartCommand !== "string") {
      return { ...op, status: "blocked", reason: "Restart command missing at execution time.", safety: operationSafety(op.kind, "blocked", "Restart command missing at execution time.", op.command) };
    }
    const validationError = validateRestartCommand(processId, restartCommand);
    if (validationError) {
      return { ...op, status: "blocked", reason: validationError, safety: operationSafety(op.kind, "blocked", validationError, op.command) };
    }
    const [command, ...args] = op.command;
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.unref();
    return { ...op, status: "applied" };
  }
  if (op.kind === "agent-session.resume" && op.command) {
    const tool = typeof op.resource?.attributes.tool === "string" ? op.resource.attributes.tool : undefined;
    const sessionId = typeof op.resource?.attributes.session_id === "string" ? op.resource.attributes.session_id : undefined;
    if (!tool || !sessionId) {
      return { ...op, status: "blocked", reason: "Agent session metadata missing at execution time.", safety: operationSafety(op.kind, "blocked", "Agent session metadata missing at execution time.", op.command) };
    }
    const validationError = validateAgentResumeCommand(tool, sessionId, op.command);
    if (validationError) {
      return { ...op, status: "blocked", reason: validationError, safety: operationSafety(op.kind, "blocked", validationError, op.command) };
    }
    if (!commandExists("tmux")) {
      return { ...op, status: "failed", reason: "Agent session resume requires tmux on PATH for a detached interactive session." };
    }
    const sessionName = `snapshots-${slugPart(op.resourceId).slice(0, 48)}`;
    const hasSession = runTmux(["has-session", "-t", sessionName], 2_000).status === 0;
    if (hasSession) return { ...op, status: "noop", reason: `Agent resume tmux session already exists: ${sessionName}` };
    const cwd = typeof op.resource?.attributes.cwd === "string" && existsSync(op.resource.attributes.cwd)
      ? op.resource.attributes.cwd
      : undefined;
    const command = tmuxCommand(["new-session", "-d", "-s", sessionName]);
    if (cwd) command.push("-c", cwd);
    command.push(joinShellCommand(op.command));
    const [binary, ...args] = command;
    const result = spawnSync(binary, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5_000 });
    if (result.status === 0) return { ...op, status: "applied" };
    return { ...op, status: "failed", reason: result.stderr?.trim() || result.error?.message || `Command exited with ${result.status}` };
  }
  if (op.kind === "app.open" && op.command) {
    const name = typeof op.resource?.attributes.name === "string" ? op.resource.attributes.name : op.resource?.name;
    const validationError = validateAppRestoreCommand(name, op.command);
    if (validationError) {
      return { ...op, status: "blocked", reason: validationError, safety: operationSafety(op.kind, "blocked", validationError, op.command) };
    }
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
    safety: operationSafety(kind, status, reason, command),
    resource
  };
}

function operationSafety(kind: string, status: RestoreOperation["status"], reason?: string, command?: string[]): RestoreOperationSafety {
  const safety: RestoreOperationSafety = {
    effect: operationEffect(kind),
    requires: operationRequirements(kind)
  };
  if (command?.length) safety.command_hash = sha256(stableJson(command));
  if (status === "blocked" && reason) safety.blocked_reason = reason;
  return safety;
}

function operationEffect(kind: string): RestoreOperationSafety["effect"] {
  if (kind === "project.mkdir") return "filesystem-write";
  if (kind.startsWith("tmux.")) return "tmux";
  if (kind === "process.restart") return "process-spawn";
  if (kind === "app.open") return "app-open";
  if (kind === "agent-session.resume") return "agent-resume";
  return "none";
}

function operationRequirements(kind: string): string[] {
  if (kind === "project.mkdir") return ["restore-policy"];
  if (kind.startsWith("tmux.")) return ["restore-policy", "tmux"];
  if (kind === "process.restart") return ["restartable-marker", "matching-process-id", "per-resource-policy"];
  if (kind === "app.open") return ["per-resource-policy"];
  if (kind === "agent-session.resume") return ["per-resource-policy", "native-resume-command", "tmux-on-apply"];
  return [];
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
    "agent-session.resume": 45,
    "app.open": 50
  };
  return [...operations].sort((a, b) => (priority[a.kind] ?? 100) - (priority[b.kind] ?? 100) || a.id.localeCompare(b.id));
}

function validateProjectPath(path: string, perResourcePolicy: boolean): string | undefined {
  if (/[\0\r\n]/.test(path)) return "Project path contains unsafe control characters.";
  if (!isAbsolute(path)) return "Project path must be absolute.";
  if (path.split(/[\\/]+/).includes("..")) return "Project path must not contain traversal segments.";
  const resolvedPath = resolve(path);
  if (resolvedPath === parse(resolvedPath).root) return "Project path cannot be the filesystem root.";
  if (isSystemPath(resolvedPath)) return `Project path targets a protected system location: ${resolvedPath}`;
  const hiddenHomePath = hiddenHomeSegment(resolvedPath);
  if (hiddenHomePath) return `Project path targets a hidden home directory: ${hiddenHomePath}`;
  if (hasSymlinkParent(resolvedPath)) return `Project path has a symlinked parent: ${resolvedPath}`;
  if (!perResourcePolicy && !safeProjectRoots().some((root) => pathInside(resolvedPath, root))) {
    return "Project path outside safe project roots requires a per-project restore policy.";
  }
  return undefined;
}

function safeProjectRoots(): string[] {
  const configured = process.env.HASNA_SNAPSHOTS_PROJECT_ROOTS
    ?.split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => resolve(entry));
  if (configured?.length) return configured;
  const home = homedir();
  return [
    process.cwd(),
    join(home, "Workspace"),
    join(home, "workspace"),
    join(home, "Projects"),
    join(home, "Developer"),
    tmpdir()
  ].map((entry) => resolve(entry));
}

function isSystemPath(path: string): boolean {
  if (process.platform === "win32") {
    const lower = path.toLowerCase();
    return lower.startsWith("c:\\windows") || lower.startsWith("c:\\program files");
  }
  const blocked = ["/bin", "/boot", "/dev", "/etc", "/lib", "/lib64", "/proc", "/root", "/run", "/sbin", "/sys", "/usr", "/var", "/Library", "/System", "/private/etc"];
  return blocked.some((prefix) => pathInside(path, resolve(prefix)));
}

function hiddenHomeSegment(path: string): string | undefined {
  const home = resolve(homedir());
  if (!pathInside(path, home)) return undefined;
  const first = relative(home, path).split(/[\\/]+/).filter(Boolean)[0];
  return first?.startsWith(".") ? first : undefined;
}

function hasSymlinkParent(path: string): boolean {
  const parsed = parse(path);
  let current = parsed.root;
  const parts = relative(parsed.root, path).split(sep).filter(Boolean);
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    if (!existsSync(current)) break;
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch {
      break;
    }
  }
  return false;
}

function pathInside(path: string, root: string): boolean {
  const offset = relative(root, path);
  return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
}

function validateRestartCommand(processId: string | undefined, restartCommand: string): string | undefined {
  if (!processId) return "Restartable process is missing process_id.";
  if (!/^[A-Za-z0-9_.:-]+$/.test(processId)) return `Unsafe process_id: ${processId}`;
  if (/[\0\r\n]/.test(restartCommand)) return "Restart command contains unsafe control characters.";
  if (!restartCommand.includes("HASNA_SNAPSHOTS_RESTARTABLE=1")) {
    return "Restart command is missing HASNA_SNAPSHOTS_RESTARTABLE=1.";
  }
  if (!restartCommand.includes(`HASNA_SNAPSHOTS_PROCESS_ID=${processId}`)) {
    return `Restart command is missing matching HASNA_SNAPSHOTS_PROCESS_ID=${processId}.`;
  }
  return undefined;
}

function validateAppRestoreCommand(name: string | undefined, command: string[]): string | undefined {
  if (!name) return "App restore requires an app name.";
  if (!command.length || command.some((part) => !part || /[\0\r\n]/.test(part))) {
    return "App restore_command contains unsafe values.";
  }
  if (command.length === 3 && command[0] === "open" && command[1] === "-a" && command[2] === name) {
    return undefined;
  }
  return "App restore_command must use the supported open -a adapter.";
}

function tmuxAvailable(): boolean {
  return process.env.HASNA_SNAPSHOTS_TEST_ASSUME_TMUX === "1" || commandExists("tmux");
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.length || value.some((part) => typeof part !== "string" || !part)) return undefined;
  return value;
}

function validateAgentResumeCommand(tool: string, sessionId: string, command: string[]): string | undefined {
  if (command.some((part) => /[\n\r\0]/.test(part))) return "Agent resume_command contains unsafe control characters.";
  if (tool === "codewith" && command.length === 3 && command[0] === "codewith" && command[1] === "resume" && command[2] === sessionId) {
    return undefined;
  }
  if (tool === "codex" && command.length === 3 && command[0] === "codex" && command[1] === "resume" && command[2] === sessionId) {
    return undefined;
  }
  if (tool === "claude" && command.length === 3 && command[0] === "claude" && (command[1] === "--resume" || command[1] === "-r") && command[2] === sessionId) {
    return undefined;
  }
  if (tool === "aicopilot" && command[0] === "aicopilot") {
    const sessionFlagIndex = command.findIndex((part) => part === "--session" || part === "-s");
    if (sessionFlagIndex >= 0 && command[sessionFlagIndex + 1] === sessionId) return undefined;
  }
  return `Unsupported ${tool} resume_command for session ${sessionId}.`;
}

function joinShellCommand(command: string[]): string {
  return command.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function tmuxWindowExists(session: string, name: string): boolean {
  const result = runTmux(["list-windows", "-t", session, "-F", "#{window_name}"], 2_000);
  return result.status === 0 && result.stdout.split("\n").map((line) => line.trim()).includes(name);
}

function tmuxWindowNameAtIndex(session: string, index: number): string | undefined {
  const result = runTmux(["list-windows", "-t", session, "-F", "#{window_index}\t#{window_name}"], 2_000);
  if (result.status !== 0) return undefined;
  for (const line of result.stdout.split("\n")) {
    const [rawIndex, name] = line.split("\t");
    if (Number(rawIndex) === index) return name;
  }
  return undefined;
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
