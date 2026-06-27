import { existsSync, mkdirSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import type {
  RestoreAutoAddedDependency,
  RestoreExecutionOptions,
  RestoreOperation,
  RestorePlan,
  RestorePolicy,
  RestoreRequest,
  RestoreSelectorMatch,
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
  const request = normalizeRestoreRequest(options);
  const selection = selectResources(resources, request);
  const selectedResourceIds = new Set(selection.resources.map((resource) => resource.id));
  const strictExistingTmuxSessions = strictExistingTmuxSessionNames(selection.resources, request);
  const operations: RestoreOperation[] = [];
  const planWarnings = [...selection.warnings, ...tmuxPlanWarnings(selection.resources, request)];

  for (const resource of selection.resources) {
    const missingParent = missingSelectedParent(resource, resources, selectedResourceIds);
    if (missingParent) {
      operations.push(operation(
        resource,
        "dependency.missing",
        `Resource requires parent ${missingParent}. Re-run with --with-dependencies to include it.`,
        "blocked",
        "Partial restore cannot safely apply a child resource without its captured parent.",
        undefined,
        {
          dependsOn: [missingParent],
          warnings: ["Dependency closure is incomplete."],
          confidence: "impossible",
          risk: "medium"
        }
      ));
      continue;
    }

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
      operations.push(planTmuxSession(resource, resources, request));
      operations.push(...planTmuxSessionState(resource, resources));
    } else if (resource.kind === "tmux-window") {
      const blockedSession = tmuxSessionForResource(resource);
      if (blockedSession && strictExistingTmuxSessions.has(blockedSession)) {
        operations.push(blockedExistingTmuxSubtree(resource, blockedSession));
        continue;
      }
      operations.push(planTmuxWindow(resource, request));
      operations.push(...planTmuxWindowState(resource));
    } else if (resource.kind === "tmux-pane") {
      const blockedSession = tmuxSessionForResource(resource);
      if (blockedSession && strictExistingTmuxSessions.has(blockedSession)) {
        operations.push(blockedExistingTmuxSubtree(resource, blockedSession));
        continue;
      }
      operations.push(planTmuxPane(resource, resources, request));
      operations.push(...planTmuxPaneState(resource));
    } else if (resource.kind === "process") {
      operations.push(planProcess(resource));
    } else if (resource.kind === "app") {
      operations.push(planApp(resource, policy));
    } else {
      operations.push(operation(resource, "unsupported", "No restore adapter for this resource kind.", "skipped"));
    }
  }

  const basePlan: RestorePlan = {
    id: `plan_${snapshot.id}_pending`,
    snapshotId: snapshot.id,
    createdAt: nowIso(),
    apply: Boolean(options.apply),
    request,
    matchedSelectors: selection.matchedSelectors,
    unmatchedSelectors: selection.unmatchedSelectors,
    autoAddedDependencies: selection.autoAddedDependencies,
    warnings: planWarnings,
    autopilot: assessAutopilot(operations),
    operations: sortOperations(operations),
    summary: summarizeOperations(operations)
  };
  basePlan.planHash = hashRestorePlan(basePlan);
  const plan: RestorePlan = {
    ...basePlan,
    id: `plan_${snapshot.id}_${basePlan.planHash.slice(0, 12)}`
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

function planTmuxSession(resource: StoredSnapshotResource, resources: StoredSnapshotResource[], request: RestoreRequest): RestoreOperation {
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
  if (shouldReplayTmuxCommand(firstWindow, request, startCommand)) {
    command.push(startCommand);
  }
  return operation(resource, "tmux.create-session", `Create detached tmux session: ${name}`, "planned", undefined, [
    ...command
  ], tmuxCreateExtras(firstWindow ?? resource, request, startCommand));
}

function planTmuxSessionState(resource: StoredSnapshotResource, resources: StoredSnapshotResource[]): RestoreOperation[] {
  const name = resource.name;
  if (!commandExists("tmux")) return [];
  if (tmuxSessionExists(name)) return [];
  const firstWindow = resources
    .filter((candidate) => candidate.kind === "tmux-window" && candidate.parentId === resource.id)
    .sort((a, b) => Number(a.attributes.index ?? 0) - Number(b.attributes.index ?? 0))[0];
  const windowIndex = Number(firstWindow?.attributes.index);
  if (!Number.isFinite(windowIndex)) return [];
  return [
    operation(
      firstWindow ?? resource,
      "tmux.move-window",
      `Restore first tmux window index: ${name}:${windowIndex}`,
      "planned",
      undefined,
      tmuxCommand(["move-window", "-s", `${name}:`, "-t", `${name}:${windowIndex}`]),
      {
        confidence: "best-effort",
        warnings: ["Moves the implicit first tmux window created by new-session to the captured index when tmux base-index differs."],
        risk: "low",
        effects: ["restore tmux first-window index"]
      }
    )
  ];
}

function planTmuxWindow(resource: StoredSnapshotResource, request: RestoreRequest): RestoreOperation {
  const session = typeof resource.attributes.session === "string" ? resource.attributes.session : undefined;
  const name = typeof resource.attributes.name === "string" ? resource.attributes.name : resource.name.split(":").slice(2).join(":");
  const windowIndex = Number(resource.attributes.index);
  if (!session || !name) return operation(resource, "tmux.create-window", "Window is missing session/name metadata.", "blocked");
  if (!commandExists("tmux")) return operation(resource, "tmux.create-window", "tmux is not installed or not on PATH.", "blocked");
  if (tmuxWindowExists(session, name, Number.isFinite(windowIndex) ? windowIndex : undefined)) {
    return operation(resource, "tmux.window-exists", `tmux window already exists: ${session}:${Number.isFinite(windowIndex) ? windowIndex : name}`, "noop");
  }
  const cwd = typeof resource.attributes.current_path === "string" ? resource.attributes.current_path : process.cwd();
  const target = Number.isFinite(windowIndex) ? `${session}:${windowIndex}` : session;
  const command = tmuxCommand(["new-window", "-d", "-t", target, "-n", name, "-c", cwd]);
  const startCommand = typeof resource.attributes.start_command === "string" ? resource.attributes.start_command : "";
  if (shouldReplayTmuxCommand(resource, request, startCommand)) {
    command.push(startCommand);
  }
  return operation(resource, "tmux.create-window", `Create tmux window: ${session}:${name}`, "planned", undefined, command, tmuxCreateExtras(resource, request, startCommand));
}

function planTmuxPane(resource: StoredSnapshotResource, resources: StoredSnapshotResource[], request: RestoreRequest): RestoreOperation {
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
  if (shouldReplayTmuxCommand(resource, request, startCommand)) {
    command.push(startCommand);
  }
  return operation(resource, "tmux.create-pane", `Create tmux pane: ${session}:${windowIndex}.${paneIndex}`, "planned", undefined, command, tmuxCreateExtras(resource, request, startCommand));
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
      tmuxCommand(["select-layout", "-t", `${session}:${windowIndex}`, layout]),
      {
        confidence: "best-effort",
        warnings: ["tmux layout restore is best-effort and does not restore shell/process state, scrollback, marks, or client size."]
      }
    ));
  }
  if (resource.attributes.active === true) {
    operations.push(operation(
      resource,
      "tmux.select-window",
      `Restore active tmux window: ${session}:${windowIndex}`,
      "planned",
      undefined,
      tmuxCommand(["select-window", "-t", `${session}:${windowIndex}`]),
      {
        confidence: "best-effort",
        warnings: ["tmux active-window selection may affect the current live client when merging into an existing session."]
      }
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
      tmuxCommand(["select-pane", "-t", `${session}:${windowIndex}.${paneIndex}`]),
      {
        confidence: "best-effort",
        warnings: ["tmux active-pane selection may affect the current live client when merging into an existing session."]
      }
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
  if (op.kind === "tmux.move-window" && op.command) {
    const session = String(op.resource?.attributes.session ?? "");
    const windowIndex = Number(op.resource?.attributes.index);
    if (session && Number.isFinite(windowIndex)) {
      const current = runTmux(["display-message", "-p", "-t", `${session}:`, "#{window_index}"], 2_000);
      if (current.status === 0 && Number(current.stdout.trim()) === windowIndex) {
        return { ...op, status: "noop", reason: "First window already has the captured index." };
      }
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
  command?: string[],
  extra: Partial<RestoreOperation> = {}
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
    resource,
    ...extra
  };
}

interface ResourceSelection {
  resources: StoredSnapshotResource[];
  matchedSelectors: RestoreSelectorMatch[];
  unmatchedSelectors: string[];
  autoAddedDependencies: RestoreAutoAddedDependency[];
  warnings: string[];
}

function normalizeRestoreRequest(options: RestoreExecutionOptions): RestoreRequest {
  const request: RestoreRequest = {
    dependencyMode: options.dependencyMode ?? "none",
    targetMode: options.targetMode ?? "strict",
    tmuxMode: options.tmuxMode ?? "layout-only"
  };
  if (options.include?.length) request.include = uniqueStrings(options.include);
  if (options.exclude?.length) request.exclude = uniqueStrings(options.exclude);
  if (options.applyPlanId) request.applyPlanId = options.applyPlanId;
  if (options.planHash) request.planHash = options.planHash;
  return request;
}

function selectResources(resources: StoredSnapshotResource[], request: RestoreRequest): ResourceSelection {
  const include = request.include ?? [];
  const exclude = request.exclude ?? [];
  const matchedSelectors: RestoreSelectorMatch[] = [];
  const unmatchedSelectors: string[] = [];
  const warnings: string[] = [];
  const autoAddedDependencies: RestoreAutoAddedDependency[] = [];
  const byId = new Map(resources.map((resource) => [resource.id, resource]));
  const childrenByParent = new Map<string, StoredSnapshotResource[]>();
  for (const resource of resources) {
    if (!resource.parentId) continue;
    const children = childrenByParent.get(resource.parentId) ?? [];
    children.push(resource);
    childrenByParent.set(resource.parentId, children);
  }

  const selectedIds = new Set<string>();
  const includeSelectors = include.length ? include : ["*"];
  for (const selector of includeSelectors) {
    const matches = matchResources(resources, selector).map((resource) => resource.id);
    matchedSelectors.push({ selector, matchedResourceIds: matches });
    if (!matches.length && selector !== "*") unmatchedSelectors.push(selector);
    for (const id of matches) selectedIds.add(id);
  }

  if ((request.dependencyMode === "parents" || request.dependencyMode === "full") && include.length) {
    for (const id of [...selectedIds]) addParentDependencies(id, id, byId, selectedIds, autoAddedDependencies);
  }
  if (request.dependencyMode === "full" && include.length) {
    for (const id of [...selectedIds]) addChildDependencies(id, id, childrenByParent, selectedIds, autoAddedDependencies);
  }

  for (const selector of exclude) {
    const matches = matchResources(resources, selector).map((resource) => resource.id);
    matchedSelectors.push({ selector: `!${selector}`, matchedResourceIds: matches });
    if (!matches.length) unmatchedSelectors.push(`!${selector}`);
    for (const id of matches) selectedIds.delete(id);
  }

  if (include.length && request.dependencyMode === "none") {
    warnings.push("Partial restore requested without dependency closure; child resources with omitted parents will be blocked.");
  }

  return {
    resources: resources.filter((resource) => selectedIds.has(resource.id)),
    matchedSelectors,
    unmatchedSelectors,
    autoAddedDependencies: autoAddedDependencies.filter((entry) => selectedIds.has(entry.resourceId)),
    warnings
  };
}

function matchResources(resources: StoredSnapshotResource[], selector: string): StoredSnapshotResource[] {
  const trimmed = selector.trim();
  if (!trimmed || trimmed === "*") return resources;
  const [prefix, ...rest] = trimmed.split(":");
  const value = rest.join(":");
  if (!value) return resources.filter((resource) => resource.id === trimmed);
  if (prefix === "id") return resources.filter((resource) => resource.id === value);
  if (prefix === "kind") return resources.filter((resource) => resource.kind === value);
  if (prefix === "source") return resources.filter((resource) => resource.source === value);
  if (prefix === "parent") return resources.filter((resource) => resource.parentId === value);
  if (prefix === "name") {
    const normalized = value.toLowerCase();
    return resources.filter((resource) => resource.name.toLowerCase().includes(normalized));
  }
  if (prefix === "path") {
    return resources.filter((resource) => resourcePaths(resource).some((path) => path === value || path.startsWith(`${value}/`)));
  }
  return resources.filter((resource) => resource.id === trimmed);
}

function resourcePaths(resource: StoredSnapshotResource): string[] {
  return ["path", "current_path", "app_path"]
    .map((key) => resource.attributes[key])
    .filter((value): value is string => typeof value === "string");
}

function addParentDependencies(
  resourceId: string,
  requiredBy: string,
  byId: Map<string, StoredSnapshotResource>,
  selectedIds: Set<string>,
  added: RestoreAutoAddedDependency[]
): void {
  const resource = byId.get(resourceId);
  if (!resource?.parentId) return;
  if (!selectedIds.has(resource.parentId)) {
    selectedIds.add(resource.parentId);
    added.push({ resourceId: resource.parentId, requiredBy, reason: "parent dependency" });
  }
  addParentDependencies(resource.parentId, requiredBy, byId, selectedIds, added);
}

function addChildDependencies(
  resourceId: string,
  requiredBy: string,
  childrenByParent: Map<string, StoredSnapshotResource[]>,
  selectedIds: Set<string>,
  added: RestoreAutoAddedDependency[]
): void {
  for (const child of childrenByParent.get(resourceId) ?? []) {
    if (!selectedIds.has(child.id)) {
      selectedIds.add(child.id);
      added.push({ resourceId: child.id, requiredBy, reason: "child dependency" });
    }
    addChildDependencies(child.id, requiredBy, childrenByParent, selectedIds, added);
  }
}

function missingSelectedParent(
  resource: StoredSnapshotResource,
  allResources: StoredSnapshotResource[],
  selectedResourceIds: Set<string>
): string | undefined {
  if (!resource.parentId) return undefined;
  if (selectedResourceIds.has(resource.parentId)) return undefined;
  return allResources.some((candidate) => candidate.id === resource.parentId) ? resource.parentId : undefined;
}

function strictExistingTmuxSessionNames(resources: StoredSnapshotResource[], request: RestoreRequest): Set<string> {
  if (request.targetMode === "merge-existing") return new Set();
  if (!commandExists("tmux")) return new Set();
  const names = new Set<string>();
  for (const resource of resources) {
    if (resource.kind !== "tmux-session") continue;
    if (tmuxSessionExists(resource.name)) names.add(resource.name);
  }
  return names;
}

function shouldReplayTmuxCommand(resource: StoredSnapshotResource | undefined, request: RestoreRequest, startCommand: string): boolean {
  return request.tmuxMode === "resume-marked" && resource?.attributes.restartable === true && Boolean(startCommand);
}

function tmuxCreateExtras(
  resource: StoredSnapshotResource,
  request: RestoreRequest,
  startCommand: string
): Partial<RestoreOperation> {
  const warnings = [
    "tmux restore recreates layout/cwd best-effort; it cannot restore shell internals, scrollback, process memory, or client attachment."
  ];
  if (startCommand && resource.attributes.restartable === true && request.tmuxMode !== "resume-marked") {
    warnings.push("Captured restartable command was not replayed because tmux mode is layout-only.");
  }
  if (startCommand && resource.attributes.restartable !== true) {
    warnings.push("Captured command is forensic-only because it lacks a restartable marker.");
  }
  return {
    warnings,
    confidence: "best-effort",
    risk: shouldReplayTmuxCommand(resource, request, startCommand) ? "high" : "low",
    effects: shouldReplayTmuxCommand(resource, request, startCommand)
      ? ["create tmux structure", "replay restartable command"]
      : ["create tmux structure"]
  };
}

function tmuxPlanWarnings(resources: StoredSnapshotResource[], request: RestoreRequest): string[] {
  const warnings: string[] = [];
  if (resources.some((resource) => resource.kind === "tmux-session" && resource.attributes.attached === true)) {
    warnings.push("tmux client attachment is captured for context but restore creates detached sessions.");
  }
  if (request.tmuxMode === "layout-only" && resources.some((resource) => resource.source === "tmux" && typeof resource.attributes.start_command === "string" && resource.attributes.start_command)) {
    warnings.push("tmux restore mode is layout-only; captured start commands are preserved as forensic data but not replayed.");
  }
  return warnings;
}

function tmuxSessionExists(name: string): boolean {
  return runTmux(["has-session", "-t", name], 2_000).status === 0;
}

function tmuxSessionForResource(resource: StoredSnapshotResource): string | undefined {
  if (resource.kind === "tmux-session") return resource.name;
  return typeof resource.attributes.session === "string" ? resource.attributes.session : undefined;
}

function blockedExistingTmuxSubtree(resource: StoredSnapshotResource, session: string): RestoreOperation {
  return operation(
    resource,
    "tmux.blocked-existing-session",
    `Blocked restore into existing tmux session: ${session}`,
    "blocked",
    "Existing tmux sessions are not merged by default. Re-run with --merge-existing to opt into live-session mutation.",
    undefined,
    {
      preconditions: [`tmux session must be absent or --merge-existing must be set: ${session}`],
      warnings: ["Default strict restore avoids mutating live tmux sessions."],
      risk: "high",
      confidence: "impossible"
    }
  );
}

function assessAutopilot(operations: RestoreOperation[]): RestorePlan["autopilot"] {
  const allowedOperationIds: string[] = [];
  const approvalRequiredOperationIds: string[] = [];
  const forbiddenOperationIds: string[] = [];
  const reasons: string[] = [];
  for (const op of operations) {
    if (op.status === "blocked" || op.status === "failed") {
      forbiddenOperationIds.push(op.id);
      reasons.push(`${op.id}: ${op.status} operation prevents autopilot apply.`);
      continue;
    }
    if (op.status !== "planned") continue;
    if (op.kind === "project.mkdir") {
      allowedOperationIds.push(op.id);
      continue;
    }
    if (op.command?.[0] === "sh" && op.command?.[1] === "-lc") {
      forbiddenOperationIds.push(op.id);
      reasons.push(`${op.id}: shell command replay is forbidden for autopilot.`);
      continue;
    }
    if (op.kind.startsWith("tmux.") || op.kind === "app.open" || op.kind === "process.restart") {
      approvalRequiredOperationIds.push(op.id);
      reasons.push(`${op.id}: ${op.kind} requires human approval.`);
      continue;
    }
    approvalRequiredOperationIds.push(op.id);
    reasons.push(`${op.id}: operation kind is not autopilot-allowlisted.`);
  }
  return {
    safeToApply: approvalRequiredOperationIds.length === 0 && forbiddenOperationIds.length === 0,
    allowedOperationIds,
    approvalRequiredOperationIds,
    forbiddenOperationIds,
    reasons
  };
}

function hashRestorePlan(plan: RestorePlan): string {
  return sha256(stableJson({
    snapshotId: plan.snapshotId,
    request: {
      include: plan.request?.include ?? [],
      exclude: plan.request?.exclude ?? [],
      dependencyMode: plan.request?.dependencyMode ?? "none",
      targetMode: plan.request?.targetMode ?? "strict",
      tmuxMode: plan.request?.tmuxMode ?? "layout-only",
      applyPlanId: plan.request?.applyPlanId ?? null,
      planHash: plan.request?.planHash ?? null
    },
    operations: plan.operations.map((op) => ({
      id: op.id,
      kind: op.kind,
      resourceId: op.resourceId,
      resourceKind: op.resourceKind,
      status: op.status,
      command: op.command ?? [],
      reason: op.reason ?? null,
      resourceHash: op.resource?.hash ?? null
    }))
  }));
}

export function prepareRestorePlanForExecution(plan: RestorePlan): RestorePlan {
  const operations = plan.operations.map((op) =>
    op.status === "blocked" && op.reason === "Restore execution requires --apply --yes."
      ? { ...op, status: "planned" as const, reason: undefined }
      : op
  );
  return {
    ...plan,
    apply: false,
    operations,
    summary: summarizeOperations(operations),
    autopilot: assessAutopilot(operations)
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
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
    "tmux.move-window": 25,
    "tmux.create-window": 30,
    "tmux.create-pane": 35,
    "tmux.select-layout": 36,
    "tmux.select-pane": 37,
    "tmux.select-window": 38,
    "process.restart": 40,
    "app.open": 50
  };
  return [...operations].sort((a, b) =>
    (priority[a.kind] ?? 100) - (priority[b.kind] ?? 100)
    || operationOrderKey(a).localeCompare(operationOrderKey(b), undefined, { numeric: true })
  );
}

function operationOrderKey(op: RestoreOperation): string {
  const resource = op.resource;
  const session = typeof resource?.attributes.session === "string" ? resource.attributes.session : resource?.name ?? "";
  const windowIndex = Number(resource?.attributes.index ?? resource?.attributes.window_index ?? 0);
  const paneIndex = Number(resource?.attributes.pane_index ?? 0);
  return `${session}:${Number.isFinite(windowIndex) ? windowIndex : 0}:${Number.isFinite(paneIndex) ? paneIndex : 0}:${op.id}`;
}

function tmuxWindowExists(session: string, name: string, index?: number): boolean {
  const result = runTmux(["list-windows", "-t", session, "-F", "#{window_index}\t#{window_name}"], 2_000);
  if (result.status !== 0) return false;
  return result.stdout.split("\n").some((line) => {
    const [windowIndex, windowName] = line.trim().split("\t");
    if (typeof index === "number") return Number(windowIndex) === index;
    return windowName === name;
  });
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
