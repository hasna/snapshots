import { Database } from "bun:sqlite";
import { basename } from "node:path";
import type {
  CaptureDiagnostic,
  CaptureSourceStatus,
  JsonObject,
  RestorePlan,
  RestorePolicy,
  SnapshotRecord,
  SnapshotResource,
  SnapshotSaveOptions,
  StoredSnapshotResource,
  StorageOptions
} from "./types.js";
import { defaultDbPath, ensureParentDir, nowIso, sha256, stableJson } from "./util.js";

type Row = Record<string, unknown>;

export class SnapshotStore {
  readonly path: string;
  readonly db: Database;

  constructor(options: StorageOptions = {}) {
    this.path = options.path ?? defaultDbPath();
    ensureParentDir(this.path);
    this.db = new Database(this.path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS resources (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        source TEXT NOT NULL,
        parent_id TEXT,
        hash TEXT NOT NULL,
        payload TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY,
        name TEXT,
        hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        resource_count INTEGER NOT NULL,
        summary TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS snapshot_resources (
        snapshot_id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        source TEXT NOT NULL,
        parent_id TEXT,
        hash TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (snapshot_id, resource_id),
        FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS policies (
        selector TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        reason TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS restore_plans (
        id TEXT PRIMARY KEY,
        snapshot_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS restore_runs (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        plan_hash TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        subject_id TEXT,
        created_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS snapshots_created_at_idx ON snapshots(created_at DESC);
      CREATE INDEX IF NOT EXISTS resources_last_seen_at_idx ON resources(last_seen_at DESC);
      CREATE INDEX IF NOT EXISTS snapshot_resources_lookup_idx ON snapshot_resources(snapshot_id, kind, name, resource_id);
      CREATE INDEX IF NOT EXISTS restore_plans_snapshot_idx ON restore_plans(snapshot_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS restore_runs_plan_idx ON restore_runs(plan_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS audit_events_type_idx ON audit_events(event_type, created_at DESC);
    `);
  }

  saveSnapshot(resources: SnapshotResource[], options: SnapshotSaveOptions = {}): SnapshotRecord {
    const createdAt = options.createdAt ?? nowIso();
    const storedResources = resources.map(toStoredResource).sort((a, b) => a.id.localeCompare(b.id));
    const snapshotHash = sha256(stableJson(storedResources.map((resource) => ({
      id: resource.id,
      hash: resource.hash
    }))));

    const existing = this.getSnapshotByHash(snapshotHash);
    if (existing) {
      return { ...existing, duplicateOf: existing.id };
    }

    const id = options.id ?? `snap_${createdAt.replace(/[-:.TZ]/g, "").slice(0, 14)}_${snapshotHash.slice(0, 12)}`;
    const summary = summarizeResources(storedResources, options.diagnostics ?? [], options.sourceStatuses ?? []);

    const insertResource = this.db.query(`
      INSERT INTO resources (id, kind, name, source, parent_id, hash, payload, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        name = excluded.name,
        source = excluded.source,
        parent_id = excluded.parent_id,
        hash = excluded.hash,
        payload = excluded.payload,
        last_seen_at = excluded.last_seen_at
    `);
    const insertSnapshot = this.db.query(`
      INSERT INTO snapshots (id, name, hash, created_at, resource_count, summary)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertSnapshotResource = this.db.query(`
      INSERT INTO snapshot_resources (snapshot_id, resource_id, kind, name, source, parent_id, hash, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const transaction = this.db.transaction(() => {
      for (const resource of storedResources) {
        insertResource.run(
          resource.id,
          resource.kind,
          resource.name,
          resource.source,
          resource.parentId ?? null,
          resource.hash,
          JSON.stringify(resource),
          createdAt,
          createdAt
        );
      }
      insertSnapshot.run(id, options.name ?? null, snapshotHash, createdAt, storedResources.length, JSON.stringify(summary));
      for (const resource of storedResources) {
        insertSnapshotResource.run(
          id,
          resource.id,
          resource.kind,
          resource.name,
          resource.source,
          resource.parentId ?? null,
          resource.hash,
          JSON.stringify(resource)
        );
      }
    });
    transaction();

    return {
      id,
      name: options.name,
      hash: snapshotHash,
      createdAt,
      resourceCount: storedResources.length,
      summary
    };
  }

  listSnapshots(limit = 50): SnapshotRecord[] {
    return (this.db.query("SELECT * FROM snapshots ORDER BY created_at DESC LIMIT ?").all(limit) as Row[]).map(snapshotFromRow);
  }

  getSnapshot(id: string): SnapshotRecord | undefined {
    const row = this.db.query("SELECT * FROM snapshots WHERE id = ?").get(id) as Row | null;
    return row ? snapshotFromRow(row) : undefined;
  }

  getSnapshotByHash(hash: string): SnapshotRecord | undefined {
    const row = this.db.query("SELECT * FROM snapshots WHERE hash = ?").get(hash) as Row | null;
    return row ? snapshotFromRow(row) : undefined;
  }

  getSnapshotResources(snapshotId: string): StoredSnapshotResource[] {
    return this.db
      .query("SELECT payload FROM snapshot_resources WHERE snapshot_id = ? ORDER BY kind, name, resource_id")
      .all(snapshotId)
      .map((row) => JSON.parse(String((row as Row).payload)) as StoredSnapshotResource);
  }

  listResources(limit = 200): StoredSnapshotResource[] {
    return this.db
      .query("SELECT payload FROM resources ORDER BY last_seen_at DESC LIMIT ?")
      .all(limit)
      .map((row) => JSON.parse(String((row as Row).payload)) as StoredSnapshotResource);
  }

  upsertPolicy(selector: string, mode: RestorePolicy["mode"], reason?: string): RestorePolicy {
    const updatedAt = nowIso();
    this.db
      .query(
        `INSERT INTO policies (selector, mode, reason, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(selector) DO UPDATE SET mode = excluded.mode, reason = excluded.reason, updated_at = excluded.updated_at`
      )
      .run(selector, mode, reason ?? null, updatedAt);
    return { selector, mode, reason, updatedAt };
  }

  listPolicies(): RestorePolicy[] {
    return (this.db.query("SELECT * FROM policies ORDER BY selector").all() as Row[]).map(policyFromRow);
  }

  saveRestorePlan(plan: JsonObject & { id: string; snapshotId: string; createdAt: string }): void {
    this.db
      .query("INSERT OR REPLACE INTO restore_plans (id, snapshot_id, created_at, payload) VALUES (?, ?, ?, ?)")
      .run(plan.id, plan.snapshotId, plan.createdAt, JSON.stringify(plan));
  }

  getRestorePlan(id: string): RestorePlan | undefined {
    const row = this.db.query("SELECT payload FROM restore_plans WHERE id = ?").get(id) as Row | null;
    return row ? JSON.parse(String(row.payload)) as RestorePlan : undefined;
  }

  saveRestoreRun(plan: RestorePlan): JsonObject {
    const createdAt = nowIso();
    const status = plan.summary.failed > 0 ? "failed" : plan.summary.blocked > 0 ? "blocked" : "complete";
    const run = {
      id: `run_${plan.id}_${createdAt.replace(/[-:.TZ]/g, "").slice(0, 17)}_${sha256(stableJson({ createdAt, summary: plan.summary, random: Math.random() })).slice(0, 8)}`,
      plan_id: plan.id,
      snapshot_id: plan.snapshotId,
      plan_hash: plan.planHash ?? null,
      status,
      created_at: createdAt,
      summary: plan.summary
    };
    this.db
      .query("INSERT INTO restore_runs (id, plan_id, snapshot_id, plan_hash, status, created_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(run.id, run.plan_id, run.snapshot_id, run.plan_hash, run.status, run.created_at, JSON.stringify({ ...run, plan }));
    this.db
      .query("INSERT INTO audit_events (id, event_type, subject_id, created_at, payload) VALUES (?, ?, ?, ?, ?)")
      .run(`audit_${run.id}`, "restore.run", run.id, createdAt, JSON.stringify(run));
    return run as unknown as JsonObject;
  }
}

export function toStoredResource(resource: SnapshotResource): StoredSnapshotResource {
  const payload: JsonObject = {
    id: resource.id,
    kind: resource.kind,
    name: resource.name,
    source: resource.source,
    attributes: resource.attributes
  };
  if (resource.parentId) payload.parentId = resource.parentId;
  return {
    ...resource,
    hash: sha256(stableJson(payload))
  };
}

function summarizeResources(resources: StoredSnapshotResource[], diagnostics: CaptureDiagnostic[], sourceStatuses: CaptureSourceStatus[]): JsonObject {
  const byKind: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  for (const resource of resources) {
    byKind[resource.kind] = (byKind[resource.kind] ?? 0) + 1;
    bySource[resource.source] = (bySource[resource.source] ?? 0) + 1;
  }
  return {
    by_kind: byKind,
    by_source: bySource,
    diagnostics: diagnostics.map((diagnostic) => ({
      source: diagnostic.source,
      level: diagnostic.level,
      message: diagnostic.message
    })),
    sources: sourceStatuses.map((status) => ({
      source: status.source,
      ok: status.ok,
      duration_ms: status.durationMs,
      resource_count: status.resourceCount,
      diagnostic_count: status.diagnosticCount
    })),
    degraded: sourceStatuses.some((status) => !status.ok)
  };
}

function snapshotFromRow(row: Row): SnapshotRecord {
  return {
    id: String(row.id),
    name: row.name == null ? undefined : String(row.name),
    hash: String(row.hash),
    createdAt: String(row.created_at),
    resourceCount: Number(row.resource_count),
    summary: JSON.parse(String(row.summary)) as JsonObject
  };
}

function policyFromRow(row: Row): RestorePolicy {
  return {
    selector: String(row.selector),
    mode: row.mode as RestorePolicy["mode"],
    reason: row.reason == null ? undefined : String(row.reason),
    updatedAt: String(row.updated_at)
  };
}

export function defaultSnapshotName(): string {
  return `${basename(process.cwd())}-${nowIso()}`;
}
