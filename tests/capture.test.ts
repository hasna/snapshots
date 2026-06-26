import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { captureAll } from "../src/capture/index.js";

const AGENT_ENV_KEYS = [
  "CODEWITH_HOME",
  "CODEX_HOME",
  "HASNA_SNAPSHOTS_CLAUDE_HOME",
  "HASNA_SNAPSHOTS_AICOPILOT_DB"
] as const;

async function withAgentEnv<T>(overrides: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of AGENT_ENV_KEYS) {
    previous.set(key, process.env[key]);
    process.env[key] = overrides[key] ?? join(mkdtempSync(join(tmpdir(), "snapshots-empty-")), key);
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function writeJsonl(path: string, rows: unknown[]): void {
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

describe("captureAll", () => {
  test("always captures the local machine resource", async () => {
    const result = await captureAll({ include: ["machine"], now: "2026-06-19T00:00:00.000Z" });

    expect(result.resources).toHaveLength(1);
    expect(result.resources[0].kind).toBe("machine");
    expect(result.resources[0].attributes.hostname).toBeTruthy();
  });

  test("turns missing optional integrations into diagnostics", async () => {
    const previous = process.env.HASNA_BROWSER_DIR;
    process.env.HASNA_BROWSER_DIR = join(mkdtempSync(join(tmpdir(), "snapshots-browser-missing-")), "missing");
    try {
      const result = await captureAll({ include: ["browser"], now: "2026-06-19T00:00:00.000Z" });

      expect(result.diagnostics).toMatchObject([{ source: "browser", level: "info" }]);
      expect(result.resources).toHaveLength(1);
      expect(result.resources[0].kind).toBe("diagnostic");
    } finally {
      if (previous === undefined) {
        delete process.env.HASNA_BROWSER_DIR;
      } else {
        process.env.HASNA_BROWSER_DIR = previous;
      }
    }
  });

  test("rejects invalid include values for direct SDK calls", async () => {
    await expect(captureAll({ include: ["nope"] as never })).rejects.toThrow("Invalid include value");
  });

  test("captures Codewith native resume metadata as an agent session", async () => {
    const root = mkdtempSync(join(tmpdir(), "snapshots-codewith-"));
    const home = join(root, "codewith");
    const projectDir = join(home, "projects", "fixture");
    const sessionId = "019ee2e0-1111-7222-8333-abcdefabcdef";
    mkdirSync(projectDir, { recursive: true });
    writeJsonl(join(home, "session_index.jsonl"), [{
      id: sessionId,
      thread_name: "Resume snapshots work",
      updated_at: "2026-06-19T10:00:00.000Z"
    }]);
    writeJsonl(join(projectDir, `${sessionId}.jsonl`), [{
      sessionId,
      cwd: "/tmp/codewith-project",
      message: { model: "gpt-5" }
    }]);

    await withAgentEnv({ CODEWITH_HOME: home }, async () => {
      const result = await captureAll({ include: ["agent-sessions"], now: "2026-06-19T00:00:00.000Z" });
      const resource = result.resources.find((candidate) =>
        candidate.kind === "agent-session" && candidate.attributes.tool === "codewith"
      );

      expect(resource?.attributes.session_id).toBe(sessionId);
      expect(resource?.attributes.cwd).toBe("/tmp/codewith-project");
      expect(resource?.attributes.model).toBe("gpt-5");
      expect(resource?.attributes.resume_command).toEqual(["codewith", "resume", sessionId]);
    });
  });

  test("captures Codex native resume metadata as an agent session", async () => {
    const root = mkdtempSync(join(tmpdir(), "snapshots-codex-"));
    const home = join(root, "codex");
    const sessionDir = join(home, "sessions", "2026", "06", "19");
    const sessionId = "019ee2e1-1111-7222-8333-abcdefabcdef";
    mkdirSync(sessionDir, { recursive: true });
    writeJsonl(join(home, "session_index.jsonl"), [{
      id: sessionId,
      thread_name: "Codex resume fixture",
      updated_at: "2026-06-19T11:00:00.000Z"
    }]);
    writeJsonl(join(sessionDir, `rollout-2026-06-19T11-00-00-${sessionId}.jsonl`), [{
      type: "session_meta",
      payload: {
        id: sessionId,
        cwd: "/tmp/codex-project",
        model_provider: "openai"
      }
    }]);

    await withAgentEnv({ CODEX_HOME: home }, async () => {
      const result = await captureAll({ include: ["agent-sessions"], now: "2026-06-19T00:00:00.000Z" });
      const resource = result.resources.find((candidate) =>
        candidate.kind === "agent-session" && candidate.attributes.tool === "codex"
      );

      expect(resource?.attributes.session_id).toBe(sessionId);
      expect(resource?.attributes.cwd).toBe("/tmp/codex-project");
      expect(resource?.attributes.model).toBe("openai");
      expect(resource?.attributes.resume_command).toEqual(["codex", "resume", sessionId]);
    });
  });

  test("captures Claude Code project transcripts as agent sessions", async () => {
    const root = mkdtempSync(join(tmpdir(), "snapshots-claude-"));
    const home = join(root, "claude");
    const projectDir = join(home, "projects", "fixture");
    const sessionId = "019ee2e2-1111-7222-8333-abcdefabcdef";
    mkdirSync(projectDir, { recursive: true });
    writeJsonl(join(projectDir, `${sessionId}.jsonl`), [{
      type: "summary",
      sessionId,
      summary: "Continue restore planner",
      cwd: "/tmp/claude-project"
    }]);

    await withAgentEnv({ HASNA_SNAPSHOTS_CLAUDE_HOME: home }, async () => {
      const result = await captureAll({ include: ["agent-sessions"], now: "2026-06-19T00:00:00.000Z" });
      const resource = result.resources.find((candidate) =>
        candidate.kind === "agent-session" && candidate.attributes.tool === "claude"
      );

      expect(resource?.attributes.session_id).toBe(sessionId);
      expect(resource?.attributes.title).toBe("Continue restore planner");
      expect(resource?.attributes.resume_command).toEqual(["claude", "--resume", sessionId]);
    });
  });

  test("captures aicopilot SQLite sessions as agent sessions", async () => {
    const root = mkdtempSync(join(tmpdir(), "snapshots-aicopilot-"));
    const dbPath = join(root, "aicopilot.db");
    const sessionId = "session-aicopilot-1";
    const db = new Database(dbPath);
    try {
      db.exec("CREATE TABLE session (id TEXT, directory TEXT, path TEXT, title TEXT, agent TEXT, model TEXT, time_updated INTEGER)");
      db.query("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        sessionId,
        "/tmp/aicopilot-project",
        "/tmp/aicopilot-project",
        "aicopilot fixture",
        "code",
        JSON.stringify({ providerID: "anthropic", id: "claude-sonnet-4" }),
        Date.parse("2026-06-19T12:00:00.000Z")
      );
    } finally {
      db.close();
    }

    await withAgentEnv({ HASNA_SNAPSHOTS_AICOPILOT_DB: dbPath }, async () => {
      const result = await captureAll({ include: ["agent-sessions"], now: "2026-06-19T00:00:00.000Z" });
      const resource = result.resources.find((candidate) =>
        candidate.kind === "agent-session" && candidate.attributes.tool === "aicopilot"
      );

      expect(resource?.attributes.session_id).toBe(sessionId);
      expect(resource?.attributes.cwd).toBe("/tmp/aicopilot-project");
      expect(resource?.attributes.model).toBe("anthropic/claude-sonnet-4");
      expect(resource?.attributes.resume_command).toEqual(["aicopilot", "/tmp/aicopilot-project", "--session", sessionId]);
    });
  });
});
