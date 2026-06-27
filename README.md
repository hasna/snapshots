# @hasna/snapshots

Runtime snapshot and restore layer for the local Hasna open-source developer environment.

`@hasna/snapshots` captures a point-in-time view of local runtime resources, stores it in SQLite, and can build guarded restore plans for the parts that are safe to recreate automatically.

## What It Captures

- machine identity and runtime context
- tmux sessions, windows, panes, and pane working directories
- Hasna project registry output when `projects list --json` is available
- local process summaries with secret-like arguments redacted
- session, browser, and desktop state when companion Hasna CLIs or state folders exist
- diagnostics for optional integrations that are absent or unavailable

Missing optional tools do not fail a snapshot. They become diagnostic resources so the snapshot still explains what was visible at capture time.

## Safety Model

Restore is dry-run by default.

The built-in restore allowlist is intentionally narrow:

- `project` resources can plan creation of missing project directories.
- `tmux-session`, `tmux-window`, and `tmux-pane` resources can plan detached tmux layout recreation.
- other resource kinds are observed and skipped unless future adapters explicitly support them.

Execution requires both `--apply` and `--yes`. Restore never kills existing sessions or overwrites existing service files. Existing project directories and tmux sessions become `noop` operations, and child tmux resources are blocked by default when the target session already exists. Use `--merge-existing` only when you explicitly want to mutate a live tmux session.

tmux restore is best effort. The default mode is `layout-only`: it recreates sessions, windows, panes, working directories, layouts, and active selection where safe, but it does not replay captured commands. Use `--tmux-mode resume-marked` to replay only commands that were explicitly marked restartable.

## Install

```sh
bun install
bun run build
```

The package stores data in `$HOME/.hasna/snapshots/snapshots.sqlite` by default. Override with:

```sh
HASNA_SNAPSHOTS_DIR=/path/to/data
HASNA_SNAPSHOTS_DB_PATH=/path/to/snapshots.sqlite
```

## SDK

The package exposes typed SDK exports from the root package and focused subpaths:

```ts
import { SnapshotStore, captureAll, createRestorePlan } from "@hasna/snapshots";
import { planService } from "@hasna/snapshots/service";
```

Capture and store a snapshot:

```ts
import { SnapshotStore, captureAll } from "@hasna/snapshots";

const store = new SnapshotStore({ path: "/tmp/snapshots.sqlite" });
try {
  const capture = await captureAll({
    include: ["machine", "projects", "tmux"],
    tmuxPaneTailLines: 0,
  });

  const snapshot = store.saveSnapshot(capture.resources, {
    name: "before-upgrade",
    diagnostics: capture.diagnostics,
    sourceStatuses: capture.sourceStatuses,
  });

  console.log(snapshot.id, snapshot.resourceCount);
} finally {
  store.close();
}
```

Build a guarded restore plan without applying it:

```ts
import { SnapshotStore, createRestorePlan } from "@hasna/snapshots";

const store = new SnapshotStore();
try {
  const [snapshot] = store.listSnapshots(1);
  if (!snapshot) throw new Error("No snapshots found");

  const resources = store.getSnapshotResources(snapshot.id);
  const policies = store.listPolicies();
  const plan = createRestorePlan(snapshot, resources, policies, {
    include: ["tmux-session:work"],
    dependencyMode: "parents",
    targetMode: "strict",
  });

  store.saveRestorePlan(plan);
  console.log(plan.id, plan.summary, plan.autopilot);
} finally {
  store.close();
}
```

Service planning is SDK-only until callers explicitly write/apply the generated plan:

```ts
import { planService } from "@hasna/snapshots/service";

const plan = planService({ intervalSeconds: 300 });
console.log(plan.kind, plan.path, plan.note);
```

### Interface Parity

| Workflow | CLI | SDK | MCP | HTTP server |
| --- | --- | --- | --- | --- |
| Capture snapshot | `snapshots capture`, `snapshots daemon once` | `captureAll`, `SnapshotStore.saveSnapshot` | `capture_snapshot` | `POST /snapshots` |
| List snapshots | `snapshots list` | `SnapshotStore.listSnapshots` | `list_snapshots` | `GET /snapshots` |
| Read snapshot/resources | `snapshots show`, `snapshots resources` | `SnapshotStore.getSnapshot`, `SnapshotStore.getSnapshotResources`, `SnapshotStore.listResources` | `get_snapshot` | `GET /snapshots/:id` |
| Plan restore | `snapshots plan`, `snapshots restore` without `--apply` | `createRestorePlan`, `SnapshotStore.saveRestorePlan` | `plan_restore` | not exposed |
| Apply restore | `snapshots restore --apply --yes` | `createRestorePlan(..., { apply: true, yes: true })` | intentionally not exposed | not exposed |
| Policy management | `snapshots policy list/set` | `SnapshotStore.listPolicies`, `SnapshotStore.upsertPolicy` | intentionally not exposed | not exposed |
| Service planning | `snapshots service plan/status/install` | `planService`, `serviceStatus`, `applyServicePlan` | intentionally not exposed | not exposed |

MCP intentionally exposes only capture, list, read, and plan tools. Restore
execution and service installation mutate local machine state, so they stay in
the CLI/SDK surfaces where callers must opt in explicitly.

## CLI

```sh
snapshots capture --name before-upgrade
snapshots list
snapshots show <snapshot-id>
snapshots resources --limit 50
snapshots resources <snapshot-id> --tree
snapshots plan <snapshot-id> --resource kind:tmux-session --with-dependencies
snapshots restore <snapshot-id> --resource tmux-session:work --with-dependencies --apply --yes
snapshots restore --plan <plan-id> --plan-hash <hash> --apply --yes
snapshots policy list
snapshots policy set kind:process ignore --reason "processes are observe-only"
snapshots daemon once --tmux-tail-lines 0
snapshots daemon run --interval 300 --tmux-tail-lines 20
snapshots service plan
snapshots service install --apply --yes
snapshots service status
```

All commands emit JSON so agents can consume stable contracts.

Snapshot summaries include per-source status, duration, resource count, diagnostic count, and a `degraded` flag when a source returns warnings or errors. Daemon captures can use `--tmux-tail-lines 0` to skip pane scrollback tails for faster topology snapshots.

Restore plans include an `autopilot` assessment. By default, only low-risk project directory creation can be marked safe for autopilot. tmux mutations require approval, and shell command replay is forbidden for autopilot.

## MCP

`snapshots-mcp` provides a minimal stdio JSON-RPC bridge with these tools:

- `capture_snapshot`
- `list_snapshots`
- `get_snapshot`
- `plan_restore`

## Local HTTP Server

```sh
snapshots-serve
curl http://localhost:7337/health
curl http://localhost:7337/snapshots
curl -X POST http://localhost:7337/snapshots -H 'content-type: application/json' -d '{"name":"manual"}'
```

## Release Verification

```sh
bun run typecheck
bun test
bun run build
bun run verify:release
```

Publishing still depends on normal external credentials for npm and GitHub.
