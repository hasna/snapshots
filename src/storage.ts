import { Database } from "bun:sqlite";
import { basename } from "node:path";
import type {
  CaptureDiagnostic,
  JsonObject,
  RestorePolicy,
  RestorePlan,
  SnapshotRecord,
  SnapshotResource,
  SnapshotSaveOptions,
  StoredSnapshotResource,
  StorageOptions
} from "./types.js";
import { defaultDbPath, ensureParentDir, nowIso, sha256, stableJson } from "./util.js";
import { CONTRACT_VERSION } from "./contracts.js";

type Row = Record<string, unknown>;

export class SnapshotStore {
  readonly path: string;
  readonly db: Database;

  constructor(options: StorageOptions = {}) {
    this.path = options.path ?? defaultDbPath();
    ensureParentDir(this.path);
    this.db = new Database(this.path);
    this.db.exec("PRAGMA journal_mode = WAL");
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
    const summary = summarizeResources(storedResources, options.diagnostics ?? []);

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

  countSnapshots(): number {
    const row = this.db.query("SELECT COUNT(*) AS count FROM snapshots").get() as Row | null;
    return Number(row?.count ?? 0);
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

  countResources(): number {
    const row = this.db.query("SELECT COUNT(*) AS count FROM resources").get() as Row | null;
    return Number(row?.count ?? 0);
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

  listRestorePlans(limit = 50): RestorePlan[] {
    return (this.db.query("SELECT payload FROM restore_plans ORDER BY created_at DESC LIMIT ?").all(limit) as Row[])
      .map((row) => restorePlanFromPayload(String(row.payload)));
  }

  countRestorePlans(): number {
    const row = this.db.query("SELECT COUNT(*) AS count FROM restore_plans").get() as Row | null;
    return Number(row?.count ?? 0);
  }

  getRestorePlan(id: string): RestorePlan | undefined {
    const row = this.db.query("SELECT payload FROM restore_plans WHERE id = ?").get(id) as Row | null;
    return row ? restorePlanFromPayload(String(row.payload)) : undefined;
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

function summarizeResources(resources: StoredSnapshotResource[], diagnostics: CaptureDiagnostic[]): JsonObject {
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
    }))
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

function restorePlanFromPayload(payload: string): RestorePlan {
  const plan = JSON.parse(payload) as RestorePlan;
  return {
    ...plan,
    contract_version: plan.contract_version ?? CONTRACT_VERSION
  };
}

export function defaultSnapshotName(): string {
  return `${basename(process.cwd())}-${nowIso()}`;
}
