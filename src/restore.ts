import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type {
  RestoreExecutionOptions,
  RestoreOperation,
  RestorePlan,
  RestorePolicy,
  SnapshotRecord,
  StoredSnapshotResource
} from "./types.js";
import { commandExists, nowIso, sha256, stableJson } from "./util.js";
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
      operations.push(planTmuxSession(resource));
    } else {
      operations.push(operation(resource, "unsupported", "No restore adapter for this resource kind.", "skipped"));
    }
  }

  const plan: RestorePlan = {
    id: `plan_${snapshot.id}_${sha256(stableJson(operations.map((op) => ({ id: op.id, status: op.status })))).slice(0, 12)}`,
    snapshotId: snapshot.id,
    createdAt: nowIso(),
    apply: Boolean(options.apply),
    operations,
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
      operations,
      summary: summarizeOperations(operations)
    };
  }

  const operations = plan.operations.map((op) => executeOperation(op));
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

function planTmuxSession(resource: StoredSnapshotResource): RestoreOperation {
  const name = resource.name;
  if (!/^[A-Za-z0-9_.:-]+$/.test(name)) {
    return operation(resource, "tmux.create-session", `Unsafe tmux session name: ${name}`, "blocked");
  }
  if (!commandExists("tmux")) {
    return operation(resource, "tmux.create-session", "tmux is not installed or not on PATH.", "blocked");
  }
  const hasSession = spawnSync("tmux", ["has-session", "-t", name], {
    stdio: "ignore",
    timeout: 2_000
  }).status === 0;
  if (hasSession) {
    return operation(resource, "tmux.exists", `tmux session already exists: ${name}`, "noop");
  }
  const cwd = typeof resource.attributes.cwd === "string" ? resource.attributes.cwd : process.cwd();
  return operation(resource, "tmux.create-session", `Create detached tmux session: ${name}`, "planned", undefined, [
    "tmux",
    "new-session",
    "-d",
    "-s",
    name,
    "-c",
    cwd
  ]);
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
