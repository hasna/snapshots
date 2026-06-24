import { CONTRACT_VERSION } from "./contracts.js";
import type { ResumeContext } from "./resume.js";
import type { ServicePlan } from "./service.js";
import type {
  JsonObject,
  JsonValue,
  RestorePlan,
  RestorePolicy,
  SnapshotRecord,
  StoredSnapshotResource
} from "./types.js";

export type DisplayKind =
  | "capture"
  | "snapshots-list"
  | "snapshot-show"
  | "resources-list"
  | "resume"
  | "restore-plan"
  | "restore-plans-list"
  | "policy-list"
  | "policy-set"
  | "service"
  | "doctor"
  | "help"
  | "error";

export interface DisplayOptions {
  json?: boolean;
  verbose?: boolean;
  limit?: number;
}

interface SnapshotSummary {
  id: string;
  created_at: string;
  name: string | null;
  resource_count: number;
  kinds: string;
  diagnostics: number;
}

interface ResourceSummary {
  id: string;
  kind: string;
  name: string;
  source: string;
  details: string;
}

export function renderCliOutput(kind: DisplayKind, value: unknown, options: DisplayOptions = {}): string {
  if (options.json) return JSON.stringify(value, null, 2);

  switch (kind) {
    case "capture":
      return renderCapture(value);
    case "snapshots-list":
      return renderSnapshotsList(value, options);
    case "snapshot-show":
      return renderSnapshotShow(value, options);
    case "resources-list":
      return renderResourcesList(value, options);
    case "resume":
      return renderResume(value, options);
    case "restore-plan":
      return renderRestorePlan(value, options);
    case "restore-plans-list":
      return renderRestorePlansList(value, options);
    case "policy-list":
      return renderPolicyList(value, options);
    case "policy-set":
      return renderPolicySet(value);
    case "service":
      return renderService(value, options);
    case "doctor":
      return renderDoctor(value);
    case "help":
      return renderHelp(value);
    case "error":
      return renderError(value);
  }
}

export function formatMcpToolResult(kind: DisplayKind, value: unknown, options: DisplayOptions = {}): string {
  const output = options.json || options.verbose ? value : compactMcpResult(kind, value, options);
  return JSON.stringify(output, null, 2);
}

export function compactMcpResult(kind: DisplayKind, value: unknown, options: DisplayOptions = {}): unknown {
  switch (kind) {
    case "capture":
      return compactCapture(value);
    case "snapshots-list":
      return compactSnapshotList(value, options);
    case "snapshot-show":
      return compactSnapshotShow(value, options);
    case "resume":
      return compactResume(value);
    case "restore-plan":
      return compactRestorePlan(value, options);
    case "restore-plans-list":
      return compactRestorePlansList(value, options);
    default:
      return value;
  }
}

function renderCapture(value: unknown): string {
  const snapshot = objectValue(value).snapshot as SnapshotRecord | undefined;
  if (!snapshot) return renderGeneric(value);

  return [
    "Snapshot captured",
    keyValueTable([
      ["ID", snapshot.id],
      ["Name", snapshot.name ?? "-"],
      ["Created", snapshot.createdAt],
      ["Resources", String(snapshot.resourceCount)],
      ["Diagnostics", String(diagnosticCount(snapshot.summary))],
      ["Kinds", kindsSummary(snapshot.summary)]
    ]),
    `Hint: use snapshots show ${snapshot.id} for details, or add --json for the full contract.`
  ].join("\n");
}

function renderSnapshotsList(value: unknown, options: DisplayOptions): string {
  const snapshots = snapshotsFrom(value);
  const limit = metaLimit(value, options.limit ?? snapshots.length);
  const visibleSnapshots = snapshots.slice(0, limit);
  const total = metaTotal(value, snapshots.length);
  const truncated = total > visibleSnapshots.length;
  if (!visibleSnapshots.length) {
    return [
      "No snapshots found.",
      "Hint: run snapshots capture --name <name> to create one."
    ].join("\n");
  }

  const rows = visibleSnapshots.map((snapshot) => snapshotSummary(snapshot));
  const headers = options.verbose
    ? ["ID", "CREATED", "NAME", "RES", "KINDS", "DIAG"]
    : ["ID", "CREATED", "NAME", "RES", "KINDS"];
  const tableRows = rows.map((row) => options.verbose
    ? [row.id, row.created_at, row.name ?? "-", String(row.resource_count), row.kinds, String(row.diagnostics)]
    : [row.id, row.created_at, row.name ?? "-", String(row.resource_count), row.kinds]);

  return [
    `Snapshots (${visibleSnapshots.length} of ${total} shown)`,
    table(headers, tableRows),
    truncated
      ? `Hint: use --limit ${Math.min(total, limit * 2)} to show more, snapshots show <id> for details, or --json for full records.`
      : "Hint: use snapshots show <id> for details; add --verbose for more columns or --json for full records."
  ].join("\n");
}

function renderSnapshotShow(value: unknown, options: DisplayOptions): string {
  const object = objectValue(value);
  const snapshot = object.snapshot as SnapshotRecord | undefined;
  const resources = resourcesFrom(object);
  if (!snapshot) return renderGeneric(value);

  const limit = options.limit ?? (options.verbose ? 50 : 20);
  const visibleResources = resources.slice(0, limit);
  const resourceRows = visibleResources.map((resource) => resourceSummary(resource, options.verbose));

  return [
    `Snapshot ${snapshot.id}`,
    keyValueTable([
      ["Name", snapshot.name ?? "-"],
      ["Created", snapshot.createdAt],
      ["Resources", String(snapshot.resourceCount)],
      ["Kinds", kindsSummary(snapshot.summary)],
      ["Diagnostics", String(diagnosticCount(snapshot.summary))]
    ]),
    "",
    `Resources (${visibleResources.length} of ${resources.length} shown)`,
    resourceRows.length
      ? table(["ID", "KIND", "NAME", "SOURCE", "DETAILS"], resourceRows.map(resourceSummaryRow))
      : "No resources stored for this snapshot.",
    resources.length > visibleResources.length
      ? `Hint: add --limit ${Math.min(resources.length, limit * 2)} to show more, or --json for the full snapshot.`
      : "Hint: add --json for the full snapshot payload."
  ].join("\n");
}

function renderResourcesList(value: unknown, options: DisplayOptions): string {
  const resources = resourcesFrom(value);
  const limit = metaLimit(value, options.limit ?? resources.length);
  const visibleResources = resources.slice(0, limit);
  const total = metaTotal(value, resources.length);
  const truncated = total > visibleResources.length;
  if (!visibleResources.length) {
    return [
      "No resources found.",
      "Hint: run snapshots capture first."
    ].join("\n");
  }

  const rows = visibleResources.map((resource) => resourceSummary(resource, options.verbose));
  const headers = options.verbose
    ? ["ID", "KIND", "NAME", "SOURCE", "DETAILS", "HASH"]
    : ["ID", "KIND", "NAME", "SOURCE", "DETAILS"];
  const tableRows = rows.map((row, index) => options.verbose
    ? [...resourceSummaryRow(row), truncateText(visibleResources[index]?.hash ?? "-", 16)]
    : resourceSummaryRow(row));

  return [
    `Resources (${visibleResources.length} of ${total} shown)`,
    table(headers, tableRows),
    truncated
      ? `Hint: use --limit ${Math.min(total, limit * 2)} to show more, --verbose for hashes, or --json for full attributes.`
      : "Hint: use --limit n to adjust rows, --verbose for hashes, or --json for full attributes."
  ].join("\n");
}

function renderResume(value: unknown, options: DisplayOptions): string {
  const context = value as ResumeContext;
  const plan = context.restore_plan_summary;
  const rows: [string, string][] = [
    ["Snapshot", context.snapshot_id ?? "-"],
    ["Created", context.created_at ?? "-"],
    ["Resources", String(context.resource_count ?? 0)],
    ["Projects", String(context.projects?.length ?? 0)],
    ["Tmux sessions", String(context.tmux?.length ?? 0)],
    ["Agent sessions", String(context.agent_sessions?.length ?? 0)],
    ["Restartable processes", String(context.restartable_processes?.length ?? 0)],
    ["Diagnostics", String(context.diagnostics?.length ?? 0)],
    ["Truncated", String(Boolean(context.truncated))]
  ];
  if (plan) rows.push(["Restore plan", restoreSummaryText(plan)]);

  const lines = [
    "Resume context",
    keyValueTable(rows)
  ];

  if (options.verbose) {
    const limit = options.limit ?? 12;
    lines.push("", "Projects");
    lines.push(compactJsonRows(context.projects ?? [], limit));
    lines.push("", "Agent sessions");
    lines.push(compactJsonRows(context.agent_sessions ?? [], limit));
  }

  lines.push("Hint: add --json for bounded resume JSON; use --pane-tail-chars n to tune pane tails.");
  return lines.join("\n");
}

function renderRestorePlan(value: unknown, options: DisplayOptions): string {
  const plan = value as RestorePlan;
  if (!Array.isArray(plan.operations)) return renderGeneric(value);

  const limit = options.limit ?? (options.verbose ? 50 : 20);
  const operations = plan.operations.slice(0, limit);
  const headers = options.verbose
    ? ["ID", "STATUS", "KIND", "RESOURCE", "SUMMARY", "REASON", "COMMAND"]
    : ["ID", "STATUS", "KIND", "RESOURCE", "SUMMARY"];
  const rows = operations.map((operation) => {
    const base = [
      truncateText(operation.id, 28),
      operation.status,
      truncateText(operation.kind, 24),
      truncateText(operation.resourceId, 36),
      truncateText(operation.summary, 80)
    ];
    if (!options.verbose) return base;
    return [
      ...base,
      truncateText(operation.reason ?? operation.safety?.blocked_reason ?? "-", 80),
      truncateText(operation.command?.join(" ") ?? "-", 100)
    ];
  });

  return [
    `Restore plan ${plan.id}`,
    keyValueTable([
      ["Snapshot", plan.snapshotId],
      ["Created", plan.createdAt],
      ["Apply", String(plan.apply)],
      ["Summary", restoreSummaryText(plan.summary)]
    ]),
    "",
    `Operations (${operations.length} of ${plan.operations.length} shown)`,
    rows.length ? table(headers, rows) : "No operations.",
    plan.operations.length > operations.length
      ? `Hint: add --limit ${Math.min(plan.operations.length, limit * 2)} or --verbose for more operations; add --json for full commands/resources.`
      : "Hint: add --verbose for reasons/commands or --json for full commands/resources."
  ].join("\n");
}

function renderRestorePlansList(value: unknown, options: DisplayOptions): string {
  const plans = plansFrom(value);
  const limit = metaLimit(value, options.limit ?? plans.length);
  const visiblePlans = plans.slice(0, limit);
  const total = metaTotal(value, plans.length);
  const truncated = total > visiblePlans.length;
  if (!visiblePlans.length) {
    return [
      "No restore plans found.",
      "Hint: run snapshots plan <snapshot-id> to create one."
    ].join("\n");
  }

  const rows = visiblePlans.map((plan) => [
    plan.id,
    plan.snapshotId,
    plan.createdAt,
    restoreSummaryText(plan.summary)
  ]);

  return [
    `Restore plans (${visiblePlans.length} of ${total} shown)`,
    table(["ID", "SNAPSHOT", "CREATED", "SUMMARY"], rows),
    truncated
      ? `Hint: use --limit ${Math.min(total, limit * 2)} to show more, snapshots plans show <plan-id> for details, or --json for full records.`
      : "Hint: use snapshots plans show <plan-id> for details, or --json for full records."
  ].join("\n");
}

function renderPolicyList(value: unknown, options: DisplayOptions): string {
  const policies = policiesFrom(value);
  if (!policies.length) {
    return [
      "No restore policies configured.",
      "Hint: use snapshots policy set <selector> <observe|restore|ignore> to add one."
    ].join("\n");
  }

  const limit = options.limit ?? 50;
  const visiblePolicies = policies.slice(0, limit);
  const rows = visiblePolicies.map((policy) => [
    truncateText(policy.selector, 48),
    policy.mode,
    truncateText(policy.reason ?? "-", 72),
    policy.updatedAt
  ]);

  return [
    `Policies (${visiblePolicies.length} of ${policies.length} shown)`,
    table(["SELECTOR", "MODE", "REASON", "UPDATED"], rows),
    policies.length > visiblePolicies.length
      ? "Hint: use --limit n to show more, or --json for full policy records."
      : "Hint: add --json for full policy records."
  ].join("\n");
}

function renderPolicySet(value: unknown): string {
  const policy = objectValue(value).policy as RestorePolicy | undefined;
  if (!policy) return renderGeneric(value);
  return [
    "Policy saved",
    keyValueTable([
      ["Selector", policy.selector],
      ["Mode", policy.mode],
      ["Reason", policy.reason ?? "-"],
      ["Updated", policy.updatedAt]
    ]),
    "Hint: use snapshots policy list --json for machine-readable policy records."
  ].join("\n");
}

function renderService(value: unknown, options: DisplayOptions): string {
  const object = objectValue(value);
  const service = object.service as ServicePlan | undefined;
  const plan = (object.plan ?? service) as ServicePlan | undefined;
  const applied = typeof object.applied === "boolean" ? object.applied : undefined;

  if (!plan) return renderGeneric(value);

  const rows: [string, string][] = [
    ["Kind", plan.kind],
    ["Path", plan.path],
    ["Apply command", plan.applyCommand.join(" ")],
    ["Note", plan.note]
  ];
  if (applied !== undefined) rows.unshift(["Applied", String(applied)]);
  if (typeof object.reason === "string") rows.push(["Reason", object.reason]);
  if (options.verbose) rows.push(["Content preview", truncateText(plan.content, 240)]);

  return [
    "Service plan",
    keyValueTable(rows),
    "Hint: add --verbose for a content preview or --json for the complete service file."
  ].join("\n");
}

function renderDoctor(value: unknown): string {
  const object = objectValue(value);
  const commands = Array.isArray(object.commands) ? object.commands.map(String) : [];
  return [
    object.ok === false ? "Snapshots CLI is not healthy" : "Snapshots CLI is healthy",
    keyValueTable([
      ["DB path", typeof object.db_path === "string" ? object.db_path : "-"],
      ["Commands", commands.join(", ") || "-"]
    ]),
    "Hint: add --json for the full diagnostic contract."
  ].join("\n");
}

function renderHelp(value: unknown): string {
  const object = objectValue(value);
  const usage = Array.isArray(object.usage) ? object.usage.map(String) : [];
  return [
    object.error ? `Error: ${object.error}` : "Usage",
    ...usage.map((line) => `  ${line}`),
    "",
    "Global detail flags:",
    "  --json       emit the full machine-readable contract",
    "  --verbose    show richer human output without dumping full payloads",
    "  --limit n    adjust compact row counts where supported"
  ].join("\n");
}

function renderError(value: unknown): string {
  const message = objectValue(value).error;
  return [
    `Error: ${typeof message === "string" ? message : "unknown error"}`,
    "Hint: rerun with --json for the error contract."
  ].join("\n");
}

function renderGeneric(value: unknown): string {
  return [
    truncateText(JSON.stringify(value, null, 2), 2_000),
    "Hint: add --json for the full output."
  ].join("\n");
}

function compactCapture(value: unknown): unknown {
  const snapshot = objectValue(value).snapshot as SnapshotRecord | undefined;
  if (!snapshot) return value;
  return {
    contract_version: contractVersion(value),
    snapshot: snapshotSummary(snapshot),
    duplicate: Boolean(objectValue(value).duplicate),
    hint: `use get_snapshot with verbose=true or format=json for details`
  };
}

function compactSnapshotList(value: unknown, options: DisplayOptions): unknown {
  const snapshots = snapshotsFrom(value);
  const limit = metaLimit(value, options.limit ?? snapshots.length);
  const visibleSnapshots = snapshots.slice(0, limit);
  const total = metaTotal(value, snapshots.length);
  return {
    contract_version: contractVersion(value),
    snapshots: visibleSnapshots.map(snapshotSummary),
    shown: visibleSnapshots.length,
    limit,
    total,
    truncated: total > visibleSnapshots.length,
    has_more: total > visibleSnapshots.length,
    hint: "use get_snapshot with an id for details; pass verbose=true or format=json for full records"
  };
}

function compactSnapshotShow(value: unknown, options: DisplayOptions): unknown {
  const object = objectValue(value);
  const snapshot = object.snapshot as SnapshotRecord | undefined;
  const resources = resourcesFrom(object);
  if (!snapshot) return value;
  const limit = options.limit ?? 20;
  return {
    contract_version: contractVersion(value),
    snapshot: snapshotSummary(snapshot),
    resources: resources.slice(0, limit).map((resource) => resourceSummary(resource)),
    resource_count: resources.length,
    truncated: resources.length > limit,
    hint: "pass verbose=true or format=json for full resources and attributes"
  };
}

function compactResume(value: unknown): unknown {
  const context = value as ResumeContext;
  return {
    contract_version: context.contract_version ?? CONTRACT_VERSION,
    snapshot_id: context.snapshot_id,
    created_at: context.created_at,
    resource_count: context.resource_count,
    sections: {
      projects: context.projects?.length ?? 0,
      tmux_sessions: context.tmux?.length ?? 0,
      agent_sessions: context.agent_sessions?.length ?? 0,
      restartable_processes: context.restartable_processes?.length ?? 0,
      diagnostics: context.diagnostics?.length ?? 0
    },
    restore_plan_summary: context.restore_plan_summary,
    truncated: Boolean(context.truncated),
    hint: "pass verbose=true or format=json for the bounded resume context"
  };
}

function compactRestorePlan(value: unknown, options: DisplayOptions): unknown {
  const plan = value as RestorePlan;
  if (!Array.isArray(plan.operations)) return value;
  const limit = options.limit ?? 20;
  return {
    contract_version: plan.contract_version ?? CONTRACT_VERSION,
    id: plan.id,
    snapshot_id: plan.snapshotId,
    created_at: plan.createdAt,
    apply: plan.apply,
    summary: plan.summary,
    operations: plan.operations.slice(0, limit).map((operation) => ({
      id: operation.id,
      status: operation.status,
      kind: operation.kind,
      resource_id: operation.resourceId,
      resource_kind: operation.resourceKind,
      summary: truncateText(operation.summary, 160),
      reason: operation.reason ? truncateText(operation.reason, 160) : undefined
    })),
    operation_count: plan.operations.length,
    truncated: plan.operations.length > limit,
    hint: "pass verbose=true or format=json for full operations, commands, safety metadata, and resources"
  };
}

function compactRestorePlansList(value: unknown, options: DisplayOptions): unknown {
  const plans = plansFrom(value);
  const limit = metaLimit(value, options.limit ?? plans.length);
  const visiblePlans = plans.slice(0, limit);
  const total = metaTotal(value, plans.length);
  return {
    contract_version: contractVersion(value),
    plans: visiblePlans.map((plan) => ({
      id: plan.id,
      snapshot_id: plan.snapshotId,
      created_at: plan.createdAt,
      summary: plan.summary,
      operation_count: plan.operations.length
    })),
    shown: visiblePlans.length,
    limit,
    total,
    truncated: total > visiblePlans.length,
    has_more: total > visiblePlans.length,
    hint: "use get_restore_plan with an id for details; pass verbose=true or format=json for full records"
  };
}

function snapshotSummary(snapshot: SnapshotRecord): SnapshotSummary {
  return {
    id: snapshot.id,
    created_at: snapshot.createdAt,
    name: snapshot.name ?? null,
    resource_count: snapshot.resourceCount,
    kinds: kindsSummary(snapshot.summary),
    diagnostics: diagnosticCount(snapshot.summary)
  };
}

function resourceSummary(resource: StoredSnapshotResource, verbose = false): ResourceSummary {
  return {
    id: resource.id,
    kind: resource.kind,
    name: resource.name,
    source: resource.source,
    details: resourceDetails(resource, verbose)
  };
}

function resourceSummaryRow(summary: ResourceSummary): string[] {
  return [
    truncateText(summary.id, 36),
    summary.kind,
    truncateText(summary.name, 32),
    truncateText(summary.source, 24),
    truncateText(summary.details, 80)
  ];
}

function resourceDetails(resource: StoredSnapshotResource, verbose: boolean): string {
  const attributes = resource.attributes;
  const preferredKeys = [
    "path",
    "primary_path",
    "cwd",
    "current_path",
    "tool",
    "session_id",
    "model",
    "pid",
    "process_id",
    "session",
    "window_index",
    "pane_index",
    "level",
    "message",
    "command",
    "current_command",
    "start_command"
  ];
  const parts: string[] = [];
  for (const key of preferredKeys) {
    const value = attributes[key];
    if (value == null || key === "content_tail") continue;
    parts.push(`${key}=${shortJsonValue(value)}`);
  }
  if (resource.parentId) parts.push(`parent=${resource.parentId}`);
  if (verbose && resource.observedAt) parts.push(`observed=${resource.observedAt}`);
  return parts.length ? parts.join(" ") : `${Object.keys(attributes).length} attributes`;
}

function kindsSummary(summary: JsonObject | undefined, maxKinds = 5): string {
  const byKind = objectValue(summary).by_kind;
  if (!isPlainObject(byKind)) return "-";
  const entries = Object.entries(byKind)
    .filter(([, count]) => typeof count === "number")
    .sort((a, b) => Number(b[1]) - Number(a[1]) || a[0].localeCompare(b[0]));
  if (!entries.length) return "-";
  const visible = entries.slice(0, maxKinds).map(([kind, count]) => `${kind}:${count}`);
  const hidden = entries.length - visible.length;
  return hidden > 0 ? `${visible.join(", ")} +${hidden}` : visible.join(", ");
}

function diagnosticCount(summary: JsonObject | undefined): number {
  const diagnostics = objectValue(summary).diagnostics;
  return Array.isArray(diagnostics) ? diagnostics.length : 0;
}

function restoreSummaryText(summary: RestorePlan["summary"] | undefined): string {
  if (!summary) return "-";
  return [
    ["planned", summary.planned],
    ["blocked", summary.blocked],
    ["skipped", summary.skipped],
    ["noop", summary.noop],
    ["applied", summary.applied],
    ["failed", summary.failed]
  ]
    .filter(([, count]) => Number(count) > 0)
    .map(([name, count]) => `${name}:${count}`)
    .join(", ") || "no operations";
}

function compactJsonRows(rows: JsonObject[], limit: number): string {
  const visible = rows.slice(0, limit);
  if (!visible.length) return "  -";
  return visible
    .map((row) => `  ${truncateText(JSON.stringify(row), 180)}`)
    .join("\n");
}

function keyValueTable(rows: [string, string][]): string {
  const width = rows.reduce((max, [key]) => Math.max(max, key.length), 0);
  return rows.map(([key, value]) => `${key.padEnd(width)}  ${truncateText(value, 220)}`).join("\n");
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) => {
    const rowWidth = rows.reduce((max, row) => Math.max(max, (row[index] ?? "").length), 0);
    return Math.max(header.length, rowWidth);
  });
  const formatRow = (row: string[]) => row.map((cell, index) => (cell ?? "").padEnd(widths[index] ?? 0)).join("  ");
  return [
    formatRow(headers),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...rows.map(formatRow)
  ].join("\n");
}

function snapshotsFrom(value: unknown): SnapshotRecord[] {
  const snapshots = objectValue(value).snapshots;
  return Array.isArray(snapshots) ? snapshots as SnapshotRecord[] : [];
}

function resourcesFrom(value: unknown): StoredSnapshotResource[] {
  const resources = objectValue(value).resources;
  return Array.isArray(resources) ? resources as StoredSnapshotResource[] : [];
}

function plansFrom(value: unknown): RestorePlan[] {
  const plans = objectValue(value).plans;
  return Array.isArray(plans) ? plans as RestorePlan[] : [];
}

function policiesFrom(value: unknown): RestorePolicy[] {
  const policies = objectValue(value).policies;
  return Array.isArray(policies) ? policies as RestorePolicy[] : [];
}

function contractVersion(value: unknown): number {
  const version = objectValue(value).contract_version;
  return typeof version === "number" ? version : CONTRACT_VERSION;
}

function metaTotal(value: unknown, fallback: number): number {
  const total = objectValue(value).total;
  return typeof total === "number" && Number.isFinite(total) ? total : fallback;
}

function metaLimit(value: unknown, fallback: number): number {
  const limit = objectValue(value).limit;
  return typeof limit === "number" && Number.isFinite(limit) ? limit : fallback;
}

function shortJsonValue(value: JsonValue): string {
  if (typeof value === "string") return truncateText(value, 72);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value == null) return "null";
  if (Array.isArray(value)) return `[${value.length} items]`;
  return `{${Object.keys(value).length} keys}`;
}

export function truncateText(value: string, maxLength = 120): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  if (maxLength <= 3) return ".".repeat(maxLength);
  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function objectValue(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
