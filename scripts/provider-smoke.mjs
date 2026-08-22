#!/usr/bin/env node
// ============================================================
// Live provider smoke — optional network/API-key check
// ============================================================
// This is intentionally separate from `npm run smoke`: the default smoke test
// remains offline and CI-safe. Run this only when you explicitly want to verify
// real provider connectivity:
//
//   LLM_API_KEY=... LLM_PROVIDER=anthropic npm run smoke:provider
//   LLM_API_KEY=... LLM_PROVIDER=openai LLM_BASE_URL=... npm run smoke:provider
// ============================================================

import dotenv from "dotenv";

dotenv.config();

const provider = process.env.LLM_PROVIDER || "openai";
const apiKey = process.env.LLM_API_KEY;
const model = process.env.LLM_MODEL;
const baseURL = process.env.LLM_BASE_URL;

function fail(message) {
  console.error(`provider-smoke: FAILED — ${message}`);
  process.exit(1);
}

if (!apiKey) {
  fail("LLM_API_KEY is required for live provider smoke tests");
}

const { createModelCaller, resolveProviderConfig } = await import("../dist/llm-adapter.js");

const config = resolveProviderConfig({
  provider,
  apiKey,
  model,
  baseURL,
  maxTokens: 32,
  temperature: 0,
});

const caller = createModelCaller(config);
const messages = [{ role: "user", content: [{ type: "text", text: "Reply with exactly: OK" }] }];
let text = "";
let done = false;
let usage = null;

try {
  for await (const event of caller(
    messages,
    [],
    "You are a terse smoke-test assistant. Reply with exactly OK.",
    config,
  )) {
    if (event.type === "text_delta") text += event.delta;
    if (event.type === "done") {
      done = true;
      usage = event.usage ?? null;
    }
    if (event.type === "error") throw event.error;
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

if (!done) fail("stream ended without a done event");
if (!text.trim()) fail("stream produced no text");
if (!usage) fail("stream completed without usage metadata");

console.log("provider-smoke: PASSED");
console.log(`  provider: ${config.provider}`);
console.log(`  model:    ${config.model}`);
console.log(`  text:     ${JSON.stringify(text.trim())}`);
console.log(`  usage:    input=${usage.input_tokens ?? 0}, output=${usage.output_tokens ?? 0}`);
