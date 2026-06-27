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

export interface CaptureSourceStatus {
  source: string;
  ok: boolean;
  durationMs: number;
  resourceCount: number;
  diagnosticCount: number;
}

export interface CaptureResult {
  resources: SnapshotResource[];
  diagnostics: CaptureDiagnostic[];
  sourceStatuses?: CaptureSourceStatus[];
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

export interface RestoreOperation {
  id: string;
  kind: string;
  resourceId: string;
  resourceKind: ResourceKind;
  summary: string;
  status: RestoreOperationStatus;
  command?: string[];
  reason?: string;
  resource?: StoredSnapshotResource;
  dependsOn?: string[];
  preconditions?: string[];
  effects?: string[];
  warnings?: string[];
  risk?: "low" | "medium" | "high";
  confidence?: "exact" | "best-effort" | "forensic-only" | "impossible";
}

export type RestoreDependencyMode = "none" | "parents" | "full";
export type RestoreTargetMode = "strict" | "merge-existing";
export type TmuxRestoreMode = "layout-only" | "resume-marked";

export interface RestoreSelectorMatch {
  selector: string;
  matchedResourceIds: string[];
}

export interface RestoreAutoAddedDependency {
  resourceId: string;
  requiredBy: string;
  reason: string;
}

export interface RestoreRequest {
  include?: string[];
  exclude?: string[];
  dependencyMode?: RestoreDependencyMode;
  targetMode?: RestoreTargetMode;
  tmuxMode?: TmuxRestoreMode;
  applyPlanId?: string;
  planHash?: string;
}

export interface RestoreAutopilotAssessment {
  safeToApply: boolean;
  allowedOperationIds: string[];
  approvalRequiredOperationIds: string[];
  forbiddenOperationIds: string[];
  reasons: string[];
}

export interface RestorePlan {
  id: string;
  snapshotId: string;
  createdAt: string;
  apply: boolean;
  planHash?: string;
  request?: RestoreRequest;
  matchedSelectors?: RestoreSelectorMatch[];
  unmatchedSelectors?: string[];
  autoAddedDependencies?: RestoreAutoAddedDependency[];
  warnings?: string[];
  autopilot?: RestoreAutopilotAssessment;
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
  include?: string[];
  cwd?: string;
  now?: string;
  tmuxPaneTailLines?: number;
}

export interface SnapshotSaveOptions {
  id?: string;
  name?: string;
  createdAt?: string;
  diagnostics?: CaptureDiagnostic[];
  sourceStatuses?: CaptureSourceStatus[];
}

export interface RestoreExecutionOptions {
  apply?: boolean;
  yes?: boolean;
  include?: string[];
  exclude?: string[];
  dependencyMode?: RestoreDependencyMode;
  targetMode?: RestoreTargetMode;
  tmuxMode?: TmuxRestoreMode;
  applyPlanId?: string;
  planHash?: string;
}
