import type { CaptureOptions, JsonObject, RestoreExecutionOptions, RestorePlan, SnapshotRecord } from "./types.js";
import { captureAll } from "./capture/index.js";
import { SnapshotStore } from "./storage.js";
import { createRestorePlan } from "./restore.js";

export interface RuntimeOptions {
  dbPath?: string;
}

export interface CaptureSnapshotOptions extends RuntimeOptions, CaptureOptions {
  name?: string;
}

export interface SnapshotEnvelope {
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
    return {
      snapshot,
      resource_count: capture.resources.length,
      diagnostic_count: capture.diagnostics.length,
      duplicate: Boolean(snapshot.duplicateOf)
    };
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

export function getSnapshotEnvelope(options: RuntimeOptions & { id: string }) {
  const store = new SnapshotStore({ path: options.dbPath });
  try {
    const snapshot = store.getSnapshot(options.id);
    if (!snapshot) throw new Error(`Snapshot not found: ${options.id}`);
    return {
      snapshot,
      resources: store.getSnapshotResources(options.id)
    };
  } finally {
    store.close();
  }
}

export function listResources(options: RuntimeOptions & { limit?: number } = {}) {
  const store = new SnapshotStore({ path: options.dbPath });
  try {
    return {
      resources: store.listResources(options.limit ?? 200)
    };
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
