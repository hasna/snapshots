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
import type { CaptureIncludeValue } from "./validation.js";
