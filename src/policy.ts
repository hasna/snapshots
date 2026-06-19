import type { PolicyMode, RestorePolicy, StoredSnapshotResource } from "./types.js";
import { nowIso } from "./util.js";

const SAFE_DEFAULT_RESTORE_KINDS = new Set(["project", "tmux-session"]);

export function selectorCandidates(resource: StoredSnapshotResource): string[] {
  return [
    resource.id,
    `kind:${resource.kind}`,
    `source:${resource.source}`,
    "*"
  ];
}

export function resolvePolicy(resource: StoredSnapshotResource, policies: RestorePolicy[] = []): RestorePolicy {
  const bySelector = new Map(policies.map((policy) => [policy.selector, policy]));
  for (const selector of selectorCandidates(resource)) {
    const policy = bySelector.get(selector);
    if (policy) return policy;
  }
  if (SAFE_DEFAULT_RESTORE_KINDS.has(resource.kind)) {
    return {
      selector: `kind:${resource.kind}`,
      mode: "restore",
      reason: "Built-in allowlist for guarded local project/tmux restore.",
      updatedAt: nowIso()
    };
  }
  return {
    selector: "*",
    mode: "observe",
    reason: "Default policy observes resources without restoring them.",
    updatedAt: nowIso()
  };
}

export function normalizePolicyMode(mode: string): PolicyMode {
  if (mode === "observe" || mode === "restore" || mode === "ignore") return mode;
  throw new Error(`Invalid policy mode: ${mode}. Expected observe, restore, or ignore.`);
}
