import { describe, expect, test } from "bun:test";
import { captureAll } from "../src/capture/index.js";

describe("captureAll", () => {
  test("always captures the local machine resource", async () => {
    const result = await captureAll({ include: ["machine"], now: "2026-06-19T00:00:00.000Z" });

    expect(result.resources).toHaveLength(1);
    expect(result.resources[0].kind).toBe("machine");
    expect(result.resources[0].attributes.hostname).toBeTruthy();
  });

  test("turns missing optional integrations into diagnostics", async () => {
    const result = await captureAll({ include: ["browser"], now: "2026-06-19T00:00:00.000Z" });

    expect(result.resources.every((resource) => resource.kind === "browser-state" || resource.kind === "diagnostic")).toBe(true);
  });
});
