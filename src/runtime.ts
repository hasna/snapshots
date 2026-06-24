import type { CaptureOptions, JsonObject, RestoreExecutionOptions, RestorePlan, SnapshotRecord } from "./types.js";
import { captureAll } from "./capture/index.js";
import { SnapshotStore } from "./storage.js";
import { createRestorePlan } from "./restore.js";
import { withContract, type ContractEnvelope } from "./contracts.js";
import { buildResumeContext, type ResumeContext } from "./resume.js";

export interface RuntimeOptions {
  dbPath?: string;
}

export interface CaptureSnapshotOptions extends RuntimeOptions, CaptureOptions {
  name?: string;
}

export interface SnapshotEnvelope extends ContractEnvelope {
  snapshot: SnapshotRecord;
  resource_count: number;
  diagnostic_count: number;
  duplicate: boolean;
}

export async function captureSnapshot(options: CaptureSnapshotOptions = {}): Promise<SnapshotEnvelope> {
  const store = new SnapshotStore({ path: options.dbPath });
  try {
    const capture = await captureAll(options);
    const snapshot = store.saveSnapshot(capture.resources, {
      name: options.name,
      diagnostics: capture.diagnostics
    });
    return withContract({
      snapshot,
      resource_count: capture.resources.length,
      diagnostic_count: capture.diagnostics.length,
      duplicate: Boolean(snapshot.duplicateOf)
    });
  } finally {
    store.close();
  }
}

export function listSnapshots(options: RuntimeOptions & { limit?: number } = {}): SnapshotRecord[] {
  const store = new SnapshotStore({ path: options.dbPath });
  try {
    return store.listSnapshots(options.limit ?? 50);
  } finally {
    store.close();
  }
}

export function countSnapshots(options: RuntimeOptions = {}): number {
  const store = new SnapshotStore({ path: options.dbPath });
  try {
    return store.countSnapshots();
  } finally {
    store.close();
  }
}

export function getSnapshotEnvelope(options: RuntimeOptions & { id: string }) {
  const store = new SnapshotStore({ path: options.dbPath });
  try {
    const snapshot = store.getSnapshot(options.id);
    if (!snapshot) throw new Error(`Snapshot not found: ${options.id}`);
    return withContract({
      snapshot,
      resources: store.getSnapshotResources(options.id)
    });
  } finally {
    store.close();
  }
}

export function listResources(options: RuntimeOptions & { limit?: number } = {}) {
  const store = new SnapshotStore({ path: options.dbPath });
  try {
    return withContract({
      resources: store.listResources(options.limit ?? 200)
    });
  } finally {
    store.close();
  }
}

export function countResources(options: RuntimeOptions = {}): number {
  const store = new SnapshotStore({ path: options.dbPath });
  try {
    return store.countResources();
  } finally {
    store.close();
  }
}

export function planSnapshotRestore(options: RuntimeOptions & RestoreExecutionOptions & { id: string }): RestorePlan {
  const store = new SnapshotStore({ path: options.dbPath });
  try {
    const snapshot = store.getSnapshot(options.id);
    if (!snapshot) throw new Error(`Snapshot not found: ${options.id}`);
    const resources = store.getSnapshotResources(options.id);
    const plan = createRestorePlan(snapshot, resources, store.listPolicies(), options);
    store.saveRestorePlan(plan as unknown as JsonObject & { id: string; snapshotId: string; createdAt: string });
    return plan;
  } finally {
    store.close();
  }
}

export function listRestorePlans(options: RuntimeOptions & { limit?: number } = {}) {
  const store = new SnapshotStore({ path: options.dbPath });
  try {
    return withContract({
      plans: store.listRestorePlans(options.limit ?? 50)
    });
  } finally {
    store.close();
  }
}

export function countRestorePlans(options: RuntimeOptions = {}): number {
  const store = new SnapshotStore({ path: options.dbPath });
  try {
    return store.countRestorePlans();
  } finally {
    store.close();
  }
}

export function getRestorePlan(options: RuntimeOptions & { id: string }): RestorePlan {
  const store = new SnapshotStore({ path: options.dbPath });
  try {
    const plan = store.getRestorePlan(options.id);
    if (!plan) throw new Error(`Restore plan not found: ${options.id}`);
    return plan;
  } finally {
    store.close();
  }
}

export function getResumeContext(options: RuntimeOptions & { id?: string; maxPaneTailChars?: number } = {}): ResumeContext {
  const store = new SnapshotStore({ path: options.dbPath });
  try {
    const snapshotId = resolveSnapshotId(store, options.id ?? "latest");
    const snapshot = store.getSnapshot(snapshotId);
    if (!snapshot) throw new Error(`Snapshot not found: ${snapshotId}`);
    const resources = store.getSnapshotResources(snapshot.id);
    const plan = createRestorePlan(snapshot, resources, store.listPolicies());
    return buildResumeContext(snapshot, resources, plan, { maxPaneTailChars: options.maxPaneTailChars });
  } finally {
    store.close();
  }
}

export function upsertPolicy(options: RuntimeOptions & { selector: string; mode: "observe" | "restore" | "ignore"; reason?: string }) {
  const store = new SnapshotStore({ path: options.dbPath });
  try {
    return store.upsertPolicy(options.selector, options.mode, options.reason);
  } finally {
    store.close();
  }
}

export function listPolicies(options: RuntimeOptions = {}) {
  const store = new SnapshotStore({ path: options.dbPath });
  try {
    return store.listPolicies();
  } finally {
    store.close();
  }
}

function resolveSnapshotId(store: SnapshotStore, id: string): string {
  if (id !== "latest") return id;
  const [snapshot] = store.listSnapshots(1);
  if (!snapshot) throw new Error("No snapshots found.");
  return snapshot.id;
}
