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
- `tmux-session` resources can plan detached tmux session creation.
- other resource kinds are observed and skipped unless future adapters explicitly support them.

Execution requires both `--apply` and `--yes`. Restore never kills existing sessions or overwrites existing service files. Existing project directories and tmux sessions become `noop` operations.

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

## CLI

```sh
snapshots capture --name before-upgrade
snapshots list
snapshots show <snapshot-id>
snapshots resources --limit 50
snapshots plan <snapshot-id>
snapshots restore <snapshot-id> --apply --yes
snapshots policy list
snapshots policy set kind:process ignore --reason "processes are observe-only"
snapshots daemon once
snapshots daemon run --interval 300
snapshots service plan
snapshots service install --apply --yes
```

All commands emit JSON so agents can consume stable contracts.

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
