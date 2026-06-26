export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export type ResourceKind =
  | "machine"
  | "project"
  | "tmux-session"
  | "tmux-window"
  | "tmux-pane"
  | "process"
  | "app"
  | "service"
  | "session"
  | "agent-session"
  | "browser-state"
  | "desktop-window"
  | "diagnostic";

export interface SnapshotResource {
  id: string;
  kind: ResourceKind;
  name: string;
  source: string;
  parentId?: string;
  attributes: JsonObject;
  observedAt: string;
}

export interface StoredSnapshotResource extends SnapshotResource {
  hash: string;
}

export interface SnapshotRecord {
  id: string;
  name?: string;
  hash: string;
  createdAt: string;
  resourceCount: number;
  summary: JsonObject;
  duplicateOf?: string;
}

export interface CaptureDiagnostic {
  source: string;
  level: "info" | "warning" | "error";
  message: string;
  detail?: JsonValue;
}

export interface CaptureResult {
  resources: SnapshotResource[];
  diagnostics: CaptureDiagnostic[];
}

export type PolicyMode = "observe" | "restore" | "ignore";

export interface RestorePolicy {
  selector: string;
  mode: PolicyMode;
  reason?: string;
  updatedAt: string;
}

export type RestoreOperationStatus =
  | "planned"
  | "noop"
  | "blocked"
  | "skipped"
  | "applied"
  | "failed";

export interface RestoreOperationSafety {
  effect: "none" | "filesystem-write" | "tmux" | "process-spawn" | "app-open" | "agent-resume";
  requires: string[];
  command_hash?: string;
  blocked_reason?: string;
}

export interface RestoreOperation {
  id: string;
  kind: string;
  resourceId: string;
  resourceKind: ResourceKind;
  summary: string;
  status: RestoreOperationStatus;
  command?: string[];
  reason?: string;
  safety: RestoreOperationSafety;
  resource?: StoredSnapshotResource;
}

export interface RestorePlan {
  contract_version: number;
  id: string;
  snapshotId: string;
  createdAt: string;
  apply: boolean;
  operations: RestoreOperation[];
  summary: {
    planned: number;
    noop: number;
    blocked: number;
    skipped: number;
    applied: number;
    failed: number;
  };
}

export interface StorageOptions {
  path?: string;
}

export interface CaptureOptions {
  include?: CaptureIncludeValue[];
  cwd?: string;
  now?: string;
  includePaneTail?: boolean;
  maxPaneTailChars?: number;
}

export interface SnapshotSaveOptions {
  id?: string;
  name?: string;
  createdAt?: string;
  diagnostics?: CaptureDiagnostic[];
}

export interface RestoreExecutionOptions {
  apply?: boolean;
  yes?: boolean;
}

export interface DbArtifactRef {
  path: string;
  exists: boolean;
  size_bytes: number;
}

export interface DbStats {
  path: string;
  exists: boolean;
  size_bytes: number;
  wal_size_bytes: number;
  shm_size_bytes: number;
  page_size: number;
  page_count: number;
  freelist_count: number;
  journal_mode: string;
}

export interface DbIntegrityCheck {
  name: string;
  ok: boolean;
  messages: string[];
}

export interface DbIntegrityReport {
  contract_version: number;
  checked_at: string;
  ok: boolean;
  mode: "quick" | "full";
  db: DbStats;
  checks: DbIntegrityCheck[];
  foreign_key_violations: JsonObject[];
  raw_artifacts: DbArtifactRef[];
}

export interface OpsStateReport {
  contract_version: number;
  captured_at: string;
  ok: boolean;
  db: DbStats;
  counts: {
    snapshots: number;
    snapshot_resources: number;
    resources: number;
    orphan_resources: number;
    restore_plans: number;
    policies: number;
  };
  latest_snapshot?: {
    id: string;
    name?: string;
    created_at: string;
    resource_count: number;
  };
  oldest_snapshot?: {
    id: string;
    created_at: string;
  };
  latest_restore_plan?: {
    id: string;
    snapshot_id: string;
    created_at: string;
    summary: RestorePlan["summary"];
  };
  resource_kinds: Array<{ kind: string; count: number }>;
  pressure: {
    level: "ok" | "warning" | "critical";
    reasons: string[];
    retention_hint: string;
  };
  integrity?: Pick<DbIntegrityReport, "ok" | "mode" | "checks" | "foreign_key_violations">;
  raw_artifacts: DbArtifactRef[];
}

export interface RetentionOptions {
  keepSnapshots?: number;
  keepDays?: number;
  keepPlans?: number;
  expectedPlanId?: string;
  apply?: boolean;
  yes?: boolean;
  vacuum?: boolean;
  limit?: number;
  now?: string;
}

export interface RetentionPlan {
  contract_version: number;
  id: string;
  created_at: string;
  apply: boolean;
  applied: boolean;
  db: Pick<DbStats, "path" | "size_bytes" | "wal_size_bytes" | "freelist_count">;
  policy: {
    keep_snapshots: number;
    keep_days?: number;
    keep_plans: number;
    vacuum: boolean;
  };
  summary: {
    snapshots_to_delete: number;
    restore_plans_to_delete: number;
    resources_to_delete: number;
    snapshots_deleted: number;
    restore_plans_deleted: number;
    resources_deleted: number;
    blocked: number;
  };
  snapshot_ids: string[];
  restore_plan_ids: string[];
  resource_ids: string[];
  truncated: boolean;
  safety: {
    dry_run: boolean;
    requires: string[];
    blocked_reason?: string;
  };
}

export interface RestoreSmokeReport {
  contract_version: number;
  checked_at: string;
  ok: boolean;
  snapshot_id: string;
  plan_ref: string;
  dry_run: true;
  summary: RestorePlan["summary"];
  safe_to_apply: boolean;
  blocked: Array<{
    id: string;
    kind: string;
    resource_id: string;
    reason: string;
  }>;
  planned: Array<{
    id: string;
    kind: string;
    resource_id: string;
    summary: string;
  }>;
  truncated: boolean;
  hint: string;
}
import type { CaptureIncludeValue } from "./validation.js";
