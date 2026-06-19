#!/usr/bin/env bun
import { main } from "../cli/index.js";

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    await main(["daemon", "run"]);
  } else {
    await main(["daemon", ...args]);
  }
}
