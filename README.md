# @hasna/snapshots

Runtime snapshot and restore layer for the local Hasna open-source developer environment.

`@hasna/snapshots` captures a point-in-time view of local runtime resources, stores it in SQLite, and can build guarded restore plans for the parts that are safe to recreate automatically.

## What It Captures

- machine identity and runtime context
- tmux sessions, windows, panes, and pane working directories
- Hasna project registry output when `projects list --json` is available
- local process summaries with secret-like arguments redacted
- generic session, browser, and desktop state when companion Hasna CLIs or state folders exist
- first-class coding-agent sessions for Codewith, aicopilot, Codex, and Claude Code when local session stores exist
- diagnostics for optional integrations that are absent or unavailable

Tmux pane content is not captured by default. Use `--include-pane-tail` only when the terminal scrollback is safe to persist.

Missing optional tools do not fail a snapshot. They become diagnostic resources so the snapshot still explains what was visible at capture time.

## Safety Model

Restore is dry-run by default.

The built-in restore allowlist is intentionally narrow:

- `project` resources can plan creation of missing project directories.
- `tmux-session`, `tmux-window`, and `tmux-pane` resources can plan detached tmux structure restore, but captured shell start commands are not replayed.
- `process` resources can restart only with a per-resource restore policy, explicit `HASNA_SNAPSHOTS_RESTARTABLE=1` marker, matching `HASNA_SNAPSHOTS_PROCESS_ID`, and restart command.
- `agent-session` resources can resume only with a per-resource restore policy and a native resume command captured from Codewith, aicopilot, Codex, or Claude Code.
- `app` resources require a per-app restore policy and a supported non-shell restore adapter.
- other resource kinds are observed and skipped.

Execution requires both `--apply` and `--yes`. Restore never kills existing sessions or overwrites existing service files. Existing project directories and tmux sessions become `noop` operations. Restore operations include machine-readable `safety` metadata with effect type, prerequisites, blocked reason, and command hash.

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
snapshots capture --name with-safe-pane-tail --include-pane-tail --pane-tail-chars 1200
snapshots list --limit 20
snapshots show <snapshot-id> --limit 20
snapshots resources --limit 50 --verbose
snapshots resume [snapshot-id|latest]
snapshots plan <snapshot-id>
snapshots plans list
snapshots plans show <plan-id>
snapshots restore <snapshot-id> --apply --yes
snapshots policy list
snapshots policy set kind:process ignore --reason "processes are observe-only"
snapshots daemon once
snapshots daemon run --interval 300
snapshots service plan
snapshots service install --apply --yes
```

CLI commands use compact human output by default so agent terminals do not fill
with full snapshot records. Defaults cap list/detail rows, truncate long text,
and print hints for the next detail command.

Use these flags for gradual disclosure:

- `--json` emits the full machine-readable contract with `contract_version`.
- `--verbose` adds richer human detail without dumping complete resource
  attributes, commands, or service files.
- `--limit n` adjusts compact row counts on list/detail commands.
- `show`, `plans show`, `resume`, and `--json` are the intended detail paths.

## MCP

`snapshots-mcp` provides a minimal stdio JSON-RPC bridge with these tools:

- `capture_snapshot`
- `list_snapshots`
- `get_snapshot`
- `get_resume_context`
- `plan_restore`
- `list_restore_plans`
- `get_restore_plan`

MCP tool calls return compact JSON summaries by default. Pass
`{"format":"json"}` or `{"verbose":true}` to request the full payload for tools
such as `get_snapshot`, `plan_restore`, and `get_restore_plan`. Compact list and
detail tool calls accept `limit` where applicable.

The MCP server uses `HASNA_SNAPSHOTS_DB_PATH` from the server process for
database selection. Per-call `dbPath` arguments are rejected intentionally.

## Local HTTP Server

```sh
SNAPSHOTS_TOKEN=change-me snapshots-serve
curl http://localhost:7337/health
curl -H 'authorization: Bearer change-me' http://localhost:7337/snapshots
curl -H 'authorization: Bearer change-me' http://localhost:7337/resume/latest
curl -H 'authorization: Bearer change-me' http://localhost:7337/plans
curl -X POST http://localhost:7337/snapshots -H 'authorization: Bearer change-me' -H 'content-type: application/json' -d '{"name":"manual"}'
```

The HTTP server binds to `127.0.0.1` by default. Non-loopback binding requires `SNAPSHOTS_ALLOW_NON_LOOPBACK=1`, and unauthenticated non-health endpoints require the explicit `SNAPSHOTS_ALLOW_UNAUTHENTICATED=1` override.

## Release Verification

```sh
bun run typecheck
bun run typecheck:tests
bun test
bun run build
bun run verify:release
```

Publishing still depends on normal external credentials for npm and GitHub.
