#!/usr/bin/env bun
import {
  applySavedRestorePlan,
  captureSnapshot,
  getSnapshotEnvelope,
  listPolicies,
  listResources,
  listSnapshotResources,
  listSnapshots,
  planSnapshotRestore,
  upsertPolicy
} from "../runtime.js";
import { normalizePolicyMode } from "../policy.js";
import { applyServicePlan, planService, serviceStatus } from "../service.js";
import { defaultDbPath } from "../util.js";

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs(argv);
  const [command = "help", ...rest] = parsed.positional;
  const dbPath = stringFlag(parsed, "db") ?? defaultDbPath();

  try {
    switch (command) {
      case "capture": {
        const include = stringFlag(parsed, "include")?.split(",").map((part) => part.trim()).filter(Boolean);
        const result = await captureSnapshot({
          dbPath,
          name: stringFlag(parsed, "name"),
          include,
          tmuxPaneTailLines: numberFlag(parsed, "tmux-tail-lines")
        });
        print(result);
        return;
      }
      case "list":
      case "snapshots": {
        print({ snapshots: listSnapshots({ dbPath, limit: numberFlag(parsed, "limit") ?? 50 }) });
        return;
      }
      case "show": {
        const id = required(rest[0], "snapshot id");
        print(getSnapshotEnvelope({ dbPath, id }));
        return;
      }
      case "resources": {
        if (rest[0]) {
          print(listSnapshotResources({ dbPath, id: rest[0], tree: Boolean(parsed.flags.tree) }));
          return;
        }
        print(listResources({ dbPath, limit: numberFlag(parsed, "limit") ?? 200 }));
        return;
      }
      case "plan": {
        const id = required(rest[0], "snapshot id");
        print(planSnapshotRestore({ dbPath, id, ...restoreRequestFromFlags(parsed) }));
        return;
      }
      case "restore": {
        const planId = stringFlag(parsed, "plan");
        if (planId) {
          print(applySavedRestorePlan({
            dbPath,
            planId,
            planHash: stringFlag(parsed, "plan-hash"),
            apply: Boolean(parsed.flags.apply),
            yes: Boolean(parsed.flags.yes)
          }));
          return;
        }
        const id = required(rest[0], "snapshot id");
        print(planSnapshotRestore({
          dbPath,
          id,
          ...restoreRequestFromFlags(parsed),
          apply: Boolean(parsed.flags.apply),
          yes: Boolean(parsed.flags.yes)
        }));
        return;
      }
      case "policy":
      case "policies": {
        const subcommand = rest[0] ?? "list";
        if (subcommand === "list") {
          print({ policies: listPolicies({ dbPath }) });
          return;
        }
        if (subcommand === "set") {
          const selector = required(rest[1], "selector");
          const mode = normalizePolicyMode(required(rest[2], "mode"));
          print({ policy: upsertPolicy({ dbPath, selector, mode, reason: stringFlag(parsed, "reason") }) });
          return;
        }
        throw new Error(`Unknown policy command: ${subcommand}`);
      }
      case "daemon": {
        const subcommand = rest[0] ?? "once";
        if (subcommand === "once") {
          print(await captureSnapshot({
            dbPath,
            name: stringFlag(parsed, "name") ?? "daemon-once",
            tmuxPaneTailLines: numberFlag(parsed, "tmux-tail-lines")
          }));
          return;
        }
        if (subcommand === "run") {
          await runDaemon(dbPath, numberFlag(parsed, "interval") ?? 300, numberFlag(parsed, "max-runs"), numberFlag(parsed, "tmux-tail-lines"));
          return;
        }
        throw new Error(`Unknown daemon command: ${subcommand}`);
      }
      case "service": {
        const subcommand = rest[0] ?? "plan";
        const servicePlan = planService({
          command: stringFlag(parsed, "command"),
          intervalSeconds: numberFlag(parsed, "interval")
        });
        if (subcommand === "plan") {
          print({ service: servicePlan });
          return;
        }
        if (subcommand === "install") {
          print(applyServicePlan(servicePlan, Boolean(parsed.flags.apply) && Boolean(parsed.flags.yes)));
          return;
        }
        if (subcommand === "status") {
          print(serviceStatus(servicePlan));
          return;
        }
        throw new Error(`Unknown service command: ${subcommand}`);
      }
      case "doctor": {
        print({
          ok: true,
          db_path: dbPath,
          commands: ["capture", "list", "show", "resources", "plan", "restore", "policy", "daemon", "service"]
        });
        return;
      }
      case "help":
      default:
        printHelp(command === "help" ? undefined : command);
        if (command !== "help") process.exitCode = 1;
    }
  } catch (error) {
    process.exitCode = 1;
    print({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function runDaemon(dbPath: string, intervalSeconds: number, maxRuns?: number, tmuxPaneTailLines?: number): Promise<void> {
  let runs = 0;
  while (!maxRuns || runs < maxRuns) {
    const result = await captureSnapshot({ dbPath, name: `daemon-${new Date().toISOString()}`, tmuxPaneTailLines });
    print({ event: "snapshot", ...result });
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

function numberFlag(parsed: ParsedArgs, name: string): number | undefined {
  const value = stringFlag(parsed, name);
  if (!value) return undefined;
  const parsedValue = Number(value);
  if (!Number.isFinite(parsedValue)) throw new Error(`Invalid number for --${name}: ${value}`);
  return parsedValue;
}

function listFlag(parsed: ParsedArgs, name: string): string[] | undefined {
  const value = stringFlag(parsed, name);
  if (!value) return undefined;
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

function restoreRequestFromFlags(parsed: ParsedArgs) {
  return {
    include: listFlag(parsed, "resource") ?? listFlag(parsed, "include"),
    exclude: listFlag(parsed, "exclude"),
    dependencyMode: Boolean(parsed.flags["with-dependencies"]) ? "full" as const : "none" as const,
    targetMode: Boolean(parsed.flags["merge-existing"]) ? "merge-existing" as const : "strict" as const,
    tmuxMode: stringFlag(parsed, "tmux-mode") === "resume-marked" ? "resume-marked" as const : "layout-only" as const
  };
}

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`Missing ${label}.`);
  return value;
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printHelp(unknown?: string): void {
  print({
    ok: !unknown,
    error: unknown ? `Unknown command: ${unknown}` : undefined,
    usage: [
      "snapshots capture [--name name] [--include machine,tmux,projects,processes,sessions,browser,desktop,apps] [--tmux-tail-lines n]",
      "snapshots list [--limit n]",
      "snapshots show <snapshot-id>",
      "snapshots resources [--limit n]",
      "snapshots resources <snapshot-id> [--tree]",
      "snapshots plan <snapshot-id> [--resource selector[,selector]] [--exclude selector[,selector]] [--with-dependencies] [--merge-existing]",
      "snapshots restore <snapshot-id> [--apply --yes] [--resource selector[,selector]] [--exclude selector[,selector]] [--with-dependencies] [--merge-existing]",
      "snapshots restore --plan <plan-id> --plan-hash hash [--apply --yes]",
      "snapshots policy list",
      "snapshots policy set <selector> <observe|restore|ignore> [--reason text]",
      "snapshots daemon once|run [--interval seconds] [--max-runs n] [--tmux-tail-lines n]",
      "snapshots service plan|install|status [--apply --yes]",
      "snapshots doctor"
    ]
  });
}

if (import.meta.main) {
  await main();
}
