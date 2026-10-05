#!/usr/bin/env node

// ============================================================
// Claude Code Replica — slim CLI entry point
// ------------------------------------------------------------
// Startup performance is a feature (see docs/个人复刻-需求台账-20261005.md,
// pillar C). The full module graph (agent loop, provider SDKs, markdown/
// highlight, TUI) costs ~1.5s of ESM resolution+evaluation, so this entry
// keeps ONLY the two light decisions every invocation needs:
//
//   1. Info flags (--version / --help / --print-command) — print and exit.
//   2. Official's hidden fast-path rejects (internal worker entry points,
//      Remote-Control bridge aliases, --cloud/--remote) — refuse and exit.
//
// Everything else is delegated to cli-main.ts via dynamic import, so the
// heavy graph loads only when a real session actually starts.
//
// Importing cli-env here is deliberate and required FIRST: it performs
// dotenv loading at module evaluation time. fast-path.ts only pulls
// bg-startup.js (pure argv decisions) — both are a handful of files.
// ============================================================

import { maybeHandleInfoFlags } from "./cli-env.js";
import { resolveFastPath } from "./fast-path.js";

if (await maybeHandleInfoFlags(process.argv)) {
  // Printed; done.
} else {
  const fastPathDecision = resolveFastPath(process.argv.slice(2), {
    isTTY: process.stdout.isTTY === true,
  });
  if (fastPathDecision.kind === "reject") {
    console.error(fastPathDecision.message);
    process.exitCode = 1;
  } else {
    await import("./cli-main.js");
  }
}
