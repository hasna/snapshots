import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import type {
  CaptureDiagnostic,
  DbArtifactRef,
  DbIntegrityReport,
  DbStats,
  JsonObject,
  OpsStateReport,
  RetentionOptions,
  RetentionPlan,
  RestorePolicy,
  RestorePlan,
  SnapshotRecord,
  SnapshotResource,
  SnapshotSaveOptions,
  StoredSnapshotResource,
  StorageOptions
} from "./types.js";
import { defaultDbPath, ensureParentDir, nowIso, redactPath, sha256, stableJson } from "./util.js";
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

  dbStats(): DbStats {
    const dbFile = fileArtifact(this.path);
    const walFile = fileArtifact(`${this.path}-wal`);
    const shmFile = fileArtifact(`${this.path}-shm`);
    return {
      path: dbFile.path,
      exists: dbFile.exists,
      size_bytes: dbFile.size_bytes,
      wal_size_bytes: walFile.size_bytes,
      shm_size_bytes: shmFile.size_bytes,
      page_size: pragmaNumber(this.db, "page_size"),
      page_count: pragmaNumber(this.db, "page_count"),
      freelist_count: pragmaNumber(this.db, "freelist_count"),
      journal_mode: pragmaString(this.db, "journal_mode")
    };
  }

  checkIntegrity(options: { full?: boolean; now?: string } = {}): DbIntegrityReport {
    const mode = options.full ? "full" : "quick";
    const pragma = options.full ? "integrity_check" : "quick_check";
    const integrityMessages = (this.db.query(`PRAGMA ${pragma}(20)`).all() as Row[])
      .map((row) => String(firstValue(row) ?? ""))
      .filter(Boolean);
    const integrityOk = integrityMessages.length === 0 || integrityMessages.every((message) => message === "ok");
    const allForeignKeyRows = this.db.query("SELECT * FROM pragma_foreign_key_check LIMIT 21").all() as Row[];
    const foreignKeyRows = allForeignKeyRows
      .slice(0, 20)
      .map(rowToJsonObject);
    const foreignKeyViolationCount = allForeignKeyRows.length > 20 ? "20+" : String(allForeignKeyRows.length);
    const checks = [
      {
        name: pragma,
        ok: integrityOk,
        messages: integrityMessages.length ? integrityMessages : ["ok"]
      },
      {
        name: "foreign_key_check",
        ok: allForeignKeyRows.length === 0,
        messages: allForeignKeyRows.length ? [`${foreignKeyViolationCount} foreign key violation(s)`] : ["ok"]
      }
    ];

    return {
      contract_version: CONTRACT_VERSION,
      checked_at: options.now ?? nowIso(),
      ok: checks.every((check) => check.ok),
      mode,
      db: this.dbStats(),
      checks,
      foreign_key_violations: foreignKeyRows,
      raw_artifacts: dbArtifacts(this.path)
    };
  }

  getOpsState(options: { includeIntegrity?: boolean; now?: string } = {}): OpsStateReport {
    const db = this.dbStats();
    const counts = {
      snapshots: countQuery(this.db, "SELECT COUNT(*) AS count FROM snapshots"),
      snapshot_resources: countQuery(this.db, "SELECT COUNT(*) AS count FROM snapshot_resources"),
      resources: countQuery(this.db, "SELECT COUNT(*) AS count FROM resources"),
      orphan_resources: countQuery(this.db, "SELECT COUNT(*) AS count FROM resources r WHERE NOT EXISTS (SELECT 1 FROM snapshot_resources sr WHERE sr.resource_id = r.id)"),
      restore_plans: countQuery(this.db, "SELECT COUNT(*) AS count FROM restore_plans"),
      policies: countQuery(this.db, "SELECT COUNT(*) AS count FROM policies")
    };
    const latestSnapshot = this.listSnapshots(1)[0];
    const oldestSnapshotRow = this.db.query("SELECT id, created_at FROM snapshots ORDER BY created_at ASC LIMIT 1").get() as Row | null;
    const latestRestorePlan = this.listRestorePlans(1)[0];
    const resourceKinds = (this.db.query("SELECT kind, COUNT(*) AS count FROM resources GROUP BY kind ORDER BY kind").all() as Row[])
      .map((row) => ({ kind: String(row.kind), count: Number(row.count ?? 0) }));
    const pressure = pressureSummary(db, counts);
    const integrity = options.includeIntegrity === false ? undefined : this.checkIntegrity({ now: options.now });

    return {
      contract_version: CONTRACT_VERSION,
      captured_at: options.now ?? nowIso(),
      ok: (integrity?.ok ?? true) && pressure.level !== "critical",
      db,
      counts,
      latest_snapshot: latestSnapshot
        ? {
            id: latestSnapshot.id,
            name: latestSnapshot.name,
            created_at: latestSnapshot.createdAt,
            resource_count: latestSnapshot.resourceCount
          }
        : undefined,
      oldest_snapshot: oldestSnapshotRow
        ? {
            id: String(oldestSnapshotRow.id),
            created_at: String(oldestSnapshotRow.created_at)
          }
        : undefined,
      latest_restore_plan: latestRestorePlan
        ? {
            id: latestRestorePlan.id,
            snapshot_id: latestRestorePlan.snapshotId,
            created_at: latestRestorePlan.createdAt,
            summary: latestRestorePlan.summary
          }
        : undefined,
      resource_kinds: resourceKinds,
      pressure,
      integrity: integrity
        ? {
            ok: integrity.ok,
            mode: integrity.mode,
            checks: integrity.checks,
            foreign_key_violations: integrity.foreign_key_violations
          }
        : undefined,
      raw_artifacts: dbArtifacts(this.path)
    };
  }

  planRetention(options: RetentionOptions = {}): RetentionPlan {
    return stripRetentionPlan(this.buildRetentionPlan(options));
  }

  applyRetention(options: RetentionOptions = {}): RetentionPlan {
    const plan = this.buildRetentionPlan({ ...options, apply: true });
    if (plan.summary.blocked > 0) return stripRetentionPlan(plan);

    const deleteRestorePlan = this.db.query("DELETE FROM restore_plans WHERE id = ?");
    const deleteSnapshot = this.db.query("DELETE FROM snapshots WHERE id = ?");
    const deleteResource = this.db.query("DELETE FROM resources WHERE id = ? AND NOT EXISTS (SELECT 1 FROM snapshot_resources WHERE resource_id = ?)");
    const restorePlanExists = this.db.query("SELECT 1 AS found FROM restore_plans WHERE id = ?");
    const snapshotExists = this.db.query("SELECT 1 AS found FROM snapshots WHERE id = ?");

    let restorePlansDeleted = 0;
    let snapshotsDeleted = 0;
    let resourcesDeleted = 0;
    const transaction = this.db.transaction(() => {
      for (const id of plan.restore_plan_ids_full) {
        if (restorePlanExists.get(id)) {
          deleteRestorePlan.run(id);
          restorePlansDeleted += 1;
        }
      }
      for (const id of plan.snapshot_ids_full) {
        if (snapshotExists.get(id)) {
          deleteSnapshot.run(id);
          snapshotsDeleted += 1;
        }
      }
      for (const id of plan.resource_ids_full) {
        if (Number(deleteResource.run(id, id).changes ?? 0) > 0) resourcesDeleted += 1;
      }
    });
    transaction();
    if (options.vacuum) this.db.exec("VACUUM");

    return stripRetentionPlan({
      ...plan,
      applied: true,
      safety: {
        dry_run: false,
        requires: ["retention-plan", "explicit-yes"]
      },
      summary: {
        ...plan.summary,
        snapshots_deleted: snapshotsDeleted,
        restore_plans_deleted: restorePlansDeleted,
        resources_deleted: resourcesDeleted,
        blocked: 0
      }
    });
  }

  private buildRetentionPlan(options: RetentionOptions = {}): RetentionPlan & {
    snapshot_ids_full: string[];
    restore_plan_ids_full: string[];
    resource_ids_full: string[];
  } {
    const keepSnapshots = options.keepSnapshots ?? 100;
    const keepPlans = options.keepPlans ?? 100;
    const limit = options.limit ?? 20;
    const createdAt = options.now ?? nowIso();
    const snapshotRows = (this.db.query("SELECT id, created_at FROM snapshots ORDER BY created_at DESC, id DESC").all() as Row[])
      .map((row) => ({ id: String(row.id), createdAt: String(row.created_at) }));
    const snapshotIds = new Set(snapshotRows.map((row) => row.id));
    const keepSnapshotIds = new Set<string>();
    snapshotRows.slice(0, keepSnapshots).forEach((row) => keepSnapshotIds.add(row.id));
    if (options.keepDays !== undefined) {
      const cutoff = Date.parse(createdAt) - options.keepDays * 86_400_000;
      for (const row of snapshotRows) {
        const created = Date.parse(row.createdAt);
        if (Number.isFinite(created) && created >= cutoff) keepSnapshotIds.add(row.id);
      }
    }
    const snapshotIdsToDelete = snapshotRows
      .filter((row) => !keepSnapshotIds.has(row.id))
      .map((row) => row.id);
    const snapshotDeleteSet = new Set(snapshotIdsToDelete);

    const restorePlanRows = (this.db.query("SELECT id, snapshot_id, created_at FROM restore_plans ORDER BY created_at DESC, id DESC").all() as Row[])
      .map((row) => ({ id: String(row.id), snapshotId: String(row.snapshot_id), createdAt: String(row.created_at) }));
    const restorePlanIdsToDelete = restorePlanRows
      .filter((row, index) => index >= keepPlans || snapshotDeleteSet.has(row.snapshotId) || !snapshotIds.has(row.snapshotId))
      .map((row) => row.id);
    const resourceIdsToDelete = retentionResourceIds(this.db, snapshotDeleteSet);
    const id = `ret_${sha256(stableJson({
      keep_days: options.keepDays ?? null,
      keep_plans: keepPlans,
      keep_snapshots: keepSnapshots,
      resource_ids: resourceIdsToDelete,
      restore_plan_ids: restorePlanIdsToDelete,
      snapshot_ids: snapshotIdsToDelete,
      vacuum: Boolean(options.vacuum)
    })).slice(0, 16)}`;
    const blockedReason = retentionBlockedReason(options, id);
    const blocked = blockedReason ? 1 : 0;

    const dbStats = this.dbStats();
    return {
      contract_version: CONTRACT_VERSION,
      id,
      created_at: createdAt,
      apply: Boolean(options.apply),
      applied: false,
      db: {
        path: dbStats.path,
        size_bytes: dbStats.size_bytes,
        wal_size_bytes: dbStats.wal_size_bytes,
        freelist_count: dbStats.freelist_count
      },
      policy: {
        keep_snapshots: keepSnapshots,
        keep_days: options.keepDays,
        keep_plans: keepPlans,
        vacuum: Boolean(options.vacuum)
      },
      summary: {
        snapshots_to_delete: snapshotIdsToDelete.length,
        restore_plans_to_delete: restorePlanIdsToDelete.length,
        resources_to_delete: resourceIdsToDelete.length,
        snapshots_deleted: 0,
        restore_plans_deleted: 0,
        resources_deleted: 0,
        blocked
      },
      snapshot_ids: snapshotIdsToDelete.slice(0, limit),
      restore_plan_ids: restorePlanIdsToDelete.slice(0, limit),
      resource_ids: resourceIdsToDelete.slice(0, limit),
      snapshot_ids_full: snapshotIdsToDelete,
      restore_plan_ids_full: restorePlanIdsToDelete,
      resource_ids_full: resourceIdsToDelete,
      truncated: snapshotIdsToDelete.length > limit || restorePlanIdsToDelete.length > limit || resourceIdsToDelete.length > limit,
      safety: {
        dry_run: !options.apply || blocked > 0,
        requires: options.apply ? ["retention-plan", "explicit-yes", "reviewed-plan-id"] : ["dry-run-review"],
        blocked_reason: blockedReason
      }
    };
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

function fileArtifact(path: string): DbArtifactRef {
  try {
    if (!existsSync(path)) return { path: redactPath(path), exists: false, size_bytes: 0 };
    return { path: redactPath(path), exists: true, size_bytes: statSync(path).size };
  } catch {
    return { path: redactPath(path), exists: false, size_bytes: 0 };
  }
}

function dbArtifacts(path: string): DbArtifactRef[] {
  return [
    fileArtifact(path),
    fileArtifact(`${path}-wal`),
    fileArtifact(`${path}-shm`)
  ];
}

function pragmaNumber(db: Database, name: "page_size" | "page_count" | "freelist_count"): number {
  const value = firstValue(db.query(`PRAGMA ${name}`).get() as Row | null);
  return Number(value ?? 0);
}

function pragmaString(db: Database, name: "journal_mode"): string {
  const value = firstValue(db.query(`PRAGMA ${name}`).get() as Row | null);
  return value == null ? "" : String(value);
}

function countQuery(db: Database, sql: string): number {
  const row = db.query(sql).get() as Row | null;
  return Number(row?.count ?? 0);
}

function firstValue(row: Row | null): unknown {
  if (!row) return undefined;
  return Object.values(row)[0];
}

function rowToJsonObject(row: Row): JsonObject {
  const object: JsonObject = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
      object[key] = value;
    } else if (value !== undefined) {
      object[key] = String(value);
    }
  }
  return object;
}

function pressureSummary(
  db: DbStats,
  counts: OpsStateReport["counts"]
): OpsStateReport["pressure"] {
  const reasons: string[] = [];
  const totalBytes = db.size_bytes + db.wal_size_bytes + db.shm_size_bytes;
  const freelistRatio = db.page_count > 0 ? db.freelist_count / db.page_count : 0;
  let level: OpsStateReport["pressure"]["level"] = "ok";

  if (totalBytes >= 1024 * 1024 * 1024) {
    level = "critical";
    reasons.push("db-files >= 1GiB");
  } else if (totalBytes >= 256 * 1024 * 1024) {
    level = "warning";
    reasons.push("db-files >= 256MiB");
  }
  if (freelistRatio >= 0.5) {
    level = "critical";
    reasons.push("freelist >= 50% of pages");
  } else if (freelistRatio >= 0.25) {
    if (level === "ok") level = "warning";
    reasons.push("freelist >= 25% of pages");
  }
  if (counts.orphan_resources > 0) {
    if (level === "ok") level = "warning";
    reasons.push("orphan resources are reclaimable");
  }
  if (counts.snapshots > 1_000) {
    if (level === "ok") level = "warning";
    reasons.push("snapshot count > 1000");
  }

  return {
    level,
    reasons,
    retention_hint: "snapshots retention plan --keep-snapshots 100 --keep-plans 100"
  };
}

function retentionResourceIds(db: Database, deletedSnapshotIds: Set<string>): string[] {
  const resourceIds = (db.query("SELECT id FROM resources ORDER BY id").all() as Row[])
    .map((row) => String(row.id));
  const refs = (db.query("SELECT resource_id, snapshot_id FROM snapshot_resources").all() as Row[])
    .map((row) => ({ resourceId: String(row.resource_id), snapshotId: String(row.snapshot_id) }));
  const survivingRefs = new Map<string, number>();
  for (const ref of refs) {
    if (deletedSnapshotIds.has(ref.snapshotId)) continue;
    survivingRefs.set(ref.resourceId, (survivingRefs.get(ref.resourceId) ?? 0) + 1);
  }
  return resourceIds.filter((id) => (survivingRefs.get(id) ?? 0) === 0);
}

function retentionBlockedReason(options: RetentionOptions, planId: string): string | undefined {
  if (!options.apply) return undefined;
  if (!options.yes) return "Retention apply requires --yes.";
  if (!options.expectedPlanId) return "Retention apply requires --plan-id from a reviewed retention dry-run.";
  if (options.expectedPlanId !== planId) {
    return `Retention plan mismatch: reviewed ${options.expectedPlanId}, current ${planId}. Re-run retention plan before applying.`;
  }
  return undefined;
}

function stripRetentionPlan(plan: RetentionPlan & {
  snapshot_ids_full?: string[];
  restore_plan_ids_full?: string[];
  resource_ids_full?: string[];
}): RetentionPlan {
  const {
    snapshot_ids_full: _snapshotIdsFull,
    restore_plan_ids_full: _restorePlanIdsFull,
    resource_ids_full: _resourceIdsFull,
    ...publicPlan
  } = plan;
  return publicPlan;
}
