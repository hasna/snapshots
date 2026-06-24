export const CAPTURE_INCLUDE_VALUES = [
  "machine",
  "tmux",
  "projects",
  "processes",
  "sessions",
  "agent-sessions",
  "browser",
  "desktop",
  "apps"
] as const;

export type CaptureIncludeValue = typeof CAPTURE_INCLUDE_VALUES[number];

const INCLUDE_SET = new Set<string>(CAPTURE_INCLUDE_VALUES);

export function parseInclude(value: unknown): CaptureIncludeValue[] | undefined {
  if (value == null || value === "") return undefined;
  const parts = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : invalid("include", "comma-separated string or string array");
  const parsed = parts.map((part) => {
    if (typeof part !== "string") invalid("include", "string values");
    const trimmed = part.trim();
    if (!INCLUDE_SET.has(trimmed)) {
      throw new Error(`Invalid include value: ${trimmed || "<empty>"}. Expected one of: ${CAPTURE_INCLUDE_VALUES.join(", ")}.`);
    }
    return trimmed as CaptureIncludeValue;
  });
  return [...new Set(parsed)];
}

export function parseLimit(value: unknown, defaultValue: number, maxValue: number, name = "limit"): number {
  return parsePositiveInteger(value, name, { defaultValue, maxValue });
}

export function parsePositiveInteger(
  value: unknown,
  name: string,
  options: { defaultValue?: number; maxValue?: number } = {}
): number {
  if (value == null || value === "") {
    if (options.defaultValue !== undefined) return options.defaultValue;
    throw new Error(`Missing ${name}.`);
  }
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^[1-9]\d*$/.test(value.trim())
      ? Number(value)
      : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid ${name}: ${String(value)}. Expected a positive integer.`);
  }
  return options.maxValue ? Math.min(parsed, options.maxValue) : parsed;
}

export function parseSnapshotId(value: unknown, name = "snapshot id", options: { allowLatest?: boolean } = {}): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing ${name}.`);
  const id = value.trim();
  if (id === "latest" && options.allowLatest) return id;
  if (!/^[A-Za-z0-9_.:-]+$/.test(id)) {
    throw new Error(`Invalid ${name}: ${id}.`);
  }
  return id;
}

export function parseDbPath(value: unknown): string | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string" || !value.trim()) invalid("db path", "non-empty string");
  return value;
}

function invalid(name: string, expected: string): never {
  throw new Error(`Invalid ${name}. Expected ${expected}.`);
}
