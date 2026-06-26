import { describe, expect, test } from "bun:test";
import { handle } from "../src/mcp/index.js";
import { parseInclude, parseLimit, parseSnapshotId } from "../src/validation.js";

describe("input validation", () => {
  test("validates capture include values and dedupes them", () => {
    expect(parseInclude("machine,tmux,machine")).toEqual(["machine", "tmux"]);
    expect(() => parseInclude("machine,nope")).toThrow("Invalid include value");
  });

  test("validates and clamps limits", () => {
    expect(parseLimit(undefined, 50, 100)).toBe(50);
    expect(parseLimit("250", 50, 100)).toBe(100);
    expect(() => parseLimit("0", 50, 100)).toThrow("positive integer");
    expect(() => parseLimit("wat", 50, 100)).toThrow("positive integer");
    expect(() => parseLimit("0x10", 50, 100)).toThrow("positive integer");
    expect(() => parseLimit("1e2", 50, 100)).toThrow("positive integer");
    expect(() => parseLimit("1.0", 50, 100)).toThrow("positive integer");
  });

  test("rejects missing and unsafe snapshot ids", () => {
    expect(parseSnapshotId("snap_abc-123")).toBe("snap_abc-123");
    expect(parseSnapshotId("latest", "snapshot id", { allowLatest: true })).toBe("latest");
    expect(() => parseSnapshotId(undefined)).toThrow("Missing snapshot id");
    expect(() => parseSnapshotId("../snap")).toThrow("Invalid snapshot id");
  });

  test("MCP calls reject missing required snapshot ids", async () => {
    await expect(handle({
      method: "tools/call",
      params: {
        name: "get_snapshot",
        arguments: {}
      }
    })).rejects.toThrow("Missing snapshot id");
  });

  test("MCP tools reject arbitrary dbPath arguments", async () => {
    await expect(handle({
      method: "tools/call",
      params: {
        name: "list_snapshots",
        arguments: { dbPath: "/tmp/unsafe.sqlite" }
      }
    })).rejects.toThrow("do not accept dbPath");
  });
});
