#!/usr/bin/env bun
import {
  captureSnapshot,
  checkDbIntegrity,
  countResources,
  countRestorePlans,
  countSnapshots,
  getOpsState,
  getRestorePlan,
  getResumeContext,
  getSnapshotEnvelope,
  listPolicies,
  listResources,
  listRestorePlans,
  listSnapshots,
  planSnapshotRestore,
  restoreSmoke,
  runRetention,
  upsertPolicy
} from "../runtime.js";
import { normalizePolicyMode } from "../policy.js";
import { applyServicePlan, planService } from "../service.js";
import { defaultDbPath } from "../util.js";
import { withContract } from "../contracts.js";
import { parseDbPath, parseInclude, parseLimit, parsePositiveInteger, parseSnapshotId } from "../validation.js";
import { renderCliOutput, type DisplayKind, type DisplayOptions } from "../display.js";

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs(argv);
  const [command = "help", ...rest] = parsed.positional;
  const dbPath = parseDbPath(parsed.flags.db) ?? defaultDbPath();

  try {
    switch (command) {
      case "capture": {
        const result = await captureSnapshot({
          dbPath,
          name: stringFlag(parsed, "name"),
          include: parseInclude(parsed.flags.include),
          includePaneTail: Boolean(parsed.flags["include-pane-tail"]),
          maxPaneTailChars: parsed.flags["pane-tail-chars"] == null
            ? undefined
            : parsePositiveInteger(parsed.flags["pane-tail-chars"], "pane-tail-chars", { maxValue: 16_000 })
        });
        print("capture", result, parsed);
        return;
      }
      case "list":
      case "snapshots": {
        const limit = limitFlag(parsed, 20, 50, 500);
        const snapshots = listSnapshots({ dbPath, limit });
        const value = parsed.flags.json
          ? withContract({ snapshots })
          : withContract({ snapshots, total: countSnapshots({ dbPath }), limit });
        print("snapshots-list", value, parsed, { limit });
        return;
      }
      case "show": {
        const id = parseSnapshotId(rest[0]);
        print("snapshot-show", getSnapshotEnvelope({ dbPath, id }), parsed, { limit: displayLimit(parsed, 20, 1_000) });
        return;
      }
      case "resources": {
        const limit = limitFlag(parsed, 50, 200, 1_000);
        const resources = listResources({ dbPath, limit });
        const value = parsed.flags.json
          ? resources
          : { ...resources, total: countResources({ dbPath }), limit };
        print("resources-list", value, parsed, { limit });
        return;
      }
      case "ops-state":
      case "state": {
        print("ops-state", getOpsState({ dbPath, includeIntegrity: !Boolean(parsed.flags["no-integrity"]) }), parsed);
        return;
      }
      case "db": {
        const subcommand = rest[0] ?? "integrity";
        if (subcommand === "integrity" || subcommand === "check") {
          print("db-integrity", checkDbIntegrity({ dbPath, full: Boolean(parsed.flags.full) }), parsed);
          return;
        }
        throw new Error(`Unknown db command: ${subcommand}`);
      }
      case "retention": {
        const subcommand = rest[0] === "plan" || rest[0] === "apply" ? rest[0] : "plan";
        print("retention", runRetention({
          dbPath,
          keepSnapshots: optionalPositiveFlag(parsed, "keep-snapshots", 1_000_000),
          keepDays: optionalPositiveFlag(parsed, "keep-days", 36_500),
          keepPlans: optionalPositiveFlag(parsed, "keep-plans", 1_000_000),
          expectedPlanId: stringFlag(parsed, "plan-id"),
          apply: subcommand === "apply" || Boolean(parsed.flags.apply),
          yes: Boolean(parsed.flags.yes),
          vacuum: Boolean(parsed.flags.vacuum),
          limit: displayLimit(parsed, 20, 1_000)
        }), parsed);
        return;
      }
      case "resume": {
        print("resume", getResumeContext({
          dbPath,
          id: parseSnapshotId(rest[0] ?? "latest", "snapshot id", { allowLatest: true }),
          maxPaneTailChars: parsed.flags["pane-tail-chars"] == null
            ? undefined
            : parsePositiveInteger(parsed.flags["pane-tail-chars"], "pane-tail-chars", { maxValue: 16_000 })
        }), parsed, { limit: displayLimit(parsed, 12, 100) });
        return;
      }
      case "plan": {
        const id = parseSnapshotId(rest[0]);
        print("restore-plan", planSnapshotRestore({ dbPath, id }), parsed, { limit: displayLimit(parsed, 20, 1_000) });
        return;
      }
      case "plans": {
        const subcommand = rest[0] ?? "list";
        if (subcommand === "list") {
          const limit = limitFlag(parsed, 20, 50, 500);
          const plans = listRestorePlans({ dbPath, limit });
          const value = parsed.flags.json
            ? plans
            : { ...plans, total: countRestorePlans({ dbPath }), limit };
          print("restore-plans-list", value, parsed, { limit });
          return;
        }
        if (subcommand === "show") {
          print("restore-plan", getRestorePlan({ dbPath, id: parseSnapshotId(rest[1], "restore plan id") }), parsed, { limit: displayLimit(parsed, 20, 1_000) });
          return;
        }
        throw new Error(`Unknown plans command: ${subcommand}`);
      }
      case "restore": {
        const id = parseSnapshotId(rest[0]);
        print("restore-plan", planSnapshotRestore({
          dbPath,
          id,
          apply: Boolean(parsed.flags.apply),
          yes: Boolean(parsed.flags.yes)
        }), parsed, { limit: displayLimit(parsed, 20, 1_000) });
        return;
      }
      case "restore-smoke": {
        if (parsed.flags.apply) throw new Error("restore-smoke is always dry-run and does not accept --apply.");
        print("restore-smoke", restoreSmoke({
          dbPath,
          id: parseSnapshotId(rest[0] ?? "latest", "snapshot id", { allowLatest: true }),
          limit: displayLimit(parsed, 10, 200)
        }), parsed, { limit: displayLimit(parsed, 10, 200) });
        return;
      }
      case "policy":
      case "policies": {
        const subcommand = rest[0] ?? "list";
        if (subcommand === "list") {
          print("policy-list", withContract({ policies: listPolicies({ dbPath }) }), parsed, { limit: displayLimit(parsed, 50, 1_000) });
          return;
        }
        if (subcommand === "set") {
          const selector = required(rest[1], "selector");
          const mode = normalizePolicyMode(required(rest[2], "mode"));
          print("policy-set", withContract({ policy: upsertPolicy({ dbPath, selector, mode, reason: stringFlag(parsed, "reason") }) }), parsed);
          return;
        }
        throw new Error(`Unknown policy command: ${subcommand}`);
      }
      case "daemon": {
        const subcommand = rest[0] ?? "once";
        if (subcommand === "once") {
          print("capture", await captureSnapshot({ dbPath, name: stringFlag(parsed, "name") ?? "daemon-once" }), parsed);
          return;
        }
        if (subcommand === "run") {
          await runDaemon(
            dbPath,
            parsePositiveInteger(parsed.flags.interval, "interval", { defaultValue: 300, maxValue: 86_400 }),
            parsed.flags["max-runs"] == null ? undefined : parsePositiveInteger(parsed.flags["max-runs"], "max-runs", { maxValue: 1_000_000 }),
            outputOptions(parsed)
          );
          return;
        }
        throw new Error(`Unknown daemon command: ${subcommand}`);
      }
      case "service": {
        const subcommand = rest[0] ?? "plan";
        const servicePlan = planService({
          command: stringFlag(parsed, "command"),
          intervalSeconds: parsed.flags.interval == null
            ? undefined
            : parsePositiveInteger(parsed.flags.interval, "interval", { maxValue: 86_400 })
        });
        if (subcommand === "plan") {
          print("service", withContract({ service: servicePlan }), parsed);
          return;
        }
        if (subcommand === "install") {
          print("service", withContract(applyServicePlan(servicePlan, Boolean(parsed.flags.apply) && Boolean(parsed.flags.yes))), parsed);
          return;
        }
        throw new Error(`Unknown service command: ${subcommand}`);
      }
      case "doctor": {
        print("doctor", withContract({
          ok: true,
          db_path: dbPath,
          commands: ["capture", "list", "show", "resources", "ops-state", "db integrity", "retention", "resume", "plan", "plans", "restore", "restore-smoke", "policy", "daemon", "service"]
        }), parsed);
        return;
      }
      case "help":
      default:
        printHelp(parsed, command === "help" ? undefined : command);
        if (command !== "help") process.exitCode = 1;
    }
  } catch (error) {
    process.exitCode = 1;
    print("error", withContract({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }), parsed);
  }
}

async function runDaemon(dbPath: string, intervalSeconds: number, maxRuns: number | undefined, options: DisplayOptions): Promise<void> {
  let runs = 0;
  while (!maxRuns || runs < maxRuns) {
    const result = await captureSnapshot({ dbPath, name: `daemon-${new Date().toISOString()}` });
    console.log(renderCliOutput("capture", { event: "snapshot", ...result }, options));
    runs += 1;
    if (maxRuns && runs >= maxRuns) break;
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, intervalSeconds) * 1_000));
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith("--")) {
      const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
      if (inlineValue !== undefined) {
        flags[rawKey] = inlineValue;
      } else if (argv[index + 1] && !argv[index + 1].startsWith("-")) {
        flags[rawKey] = argv[index + 1];
        index += 1;
      } else {
        flags[rawKey] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function stringFlag(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags[name];
  return typeof value === "string" ? value : undefined;
}

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`Missing ${label}.`);
  return value;
}

function print(kind: DisplayKind, value: unknown, parsed: ParsedArgs, options: DisplayOptions = {}): void {
  console.log(renderCliOutput(kind, value, { ...outputOptions(parsed), ...options }));
}

function printHelp(parsed: ParsedArgs, unknown?: string): void {
  print("help", withContract({
    ok: !unknown,
    error: unknown ? `Unknown command: ${unknown}` : undefined,
    usage: [
      "snapshots capture [--name name] [--include machine,tmux,projects,processes,sessions,agent-sessions,browser,desktop,apps] [--include-pane-tail] [--json]",
      "snapshots list [--limit n] [--verbose] [--json]",
      "snapshots show <snapshot-id> [--limit n] [--verbose] [--json]",
      "snapshots resources [--limit n] [--verbose] [--json]",
      "snapshots ops-state [--no-integrity] [--json]",
      "snapshots db integrity [--full] [--json]",
      "snapshots retention [plan|apply] [--keep-snapshots n] [--keep-days n] [--keep-plans n] [--limit n] [--plan-id id] [--yes] [--vacuum] [--json]",
      "snapshots resume [snapshot-id|latest] [--pane-tail-chars n] [--verbose] [--json]",
      "snapshots plan <snapshot-id> [--limit n] [--verbose] [--json]",
      "snapshots plans list [--limit n] [--json]",
      "snapshots plans show <plan-id> [--limit n] [--verbose] [--json]",
      "snapshots restore <snapshot-id> [--apply --yes] [--verbose] [--json]",
      "snapshots restore-smoke [snapshot-id|latest] [--limit n] [--json]",
      "snapshots policy list [--limit n] [--json]",
      "snapshots policy set <selector> <observe|restore|ignore> [--reason text] [--json]",
      "snapshots daemon once|run [--interval seconds] [--max-runs n]",
      "snapshots service plan|install [--apply --yes] [--verbose] [--json]",
      "snapshots doctor [--json]"
    ]
  }), parsed);
}

function outputOptions(parsed: ParsedArgs): DisplayOptions {
  return {
    json: Boolean(parsed.flags.json),
    verbose: Boolean(parsed.flags.verbose)
  };
}

function limitFlag(parsed: ParsedArgs, compactDefault: number, jsonDefault: number, maxValue: number): number {
  return parseLimit(parsed.flags.limit, parsed.flags.json ? jsonDefault : compactDefault, maxValue);
}

function displayLimit(parsed: ParsedArgs, defaultValue: number, maxValue: number): number {
  return parseLimit(parsed.flags.limit, defaultValue, maxValue);
}

function optionalPositiveFlag(parsed: ParsedArgs, name: string, maxValue: number): number | undefined {
  return parsed.flags[name] == null
    ? undefined
    : parsePositiveInteger(parsed.flags[name], name, { maxValue });
}

if (import.meta.main) {
  await main();
}
