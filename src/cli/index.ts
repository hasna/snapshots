#!/usr/bin/env bun
import { captureSnapshot, getSnapshotEnvelope, listPolicies, listResources, listSnapshots, planSnapshotRestore, upsertPolicy } from "../runtime.js";
import { normalizePolicyMode } from "../policy.js";
import { applyServicePlan, planService } from "../service.js";
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
          include
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
        print(listResources({ dbPath, limit: numberFlag(parsed, "limit") ?? 200 }));
        return;
      }
      case "plan": {
        const id = required(rest[0], "snapshot id");
        print(planSnapshotRestore({ dbPath, id }));
        return;
      }
      case "restore": {
        const id = required(rest[0], "snapshot id");
        print(planSnapshotRestore({
          dbPath,
          id,
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
          print(await captureSnapshot({ dbPath, name: stringFlag(parsed, "name") ?? "daemon-once" }));
          return;
        }
        if (subcommand === "run") {
          await runDaemon(dbPath, numberFlag(parsed, "interval") ?? 300, numberFlag(parsed, "max-runs"));
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

async function runDaemon(dbPath: string, intervalSeconds: number, maxRuns?: number): Promise<void> {
  let runs = 0;
  while (!maxRuns || runs < maxRuns) {
    const result = await captureSnapshot({ dbPath, name: `daemon-${new Date().toISOString()}` });
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
      "snapshots capture [--name name] [--include machine,tmux,projects,processes,sessions,browser,desktop,apps]",
      "snapshots list [--limit n]",
      "snapshots show <snapshot-id>",
      "snapshots resources [--limit n]",
      "snapshots plan <snapshot-id>",
      "snapshots restore <snapshot-id> [--apply --yes]",
      "snapshots policy list",
      "snapshots policy set <selector> <observe|restore|ignore> [--reason text]",
      "snapshots daemon once|run [--interval seconds] [--max-runs n]",
      "snapshots service plan|install [--apply --yes]",
      "snapshots doctor"
    ]
  });
}

if (import.meta.main) {
  await main();
}
