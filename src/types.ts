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
}

export interface RestorePlan {
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
  include?: string[];
  cwd?: string;
  now?: string;
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
