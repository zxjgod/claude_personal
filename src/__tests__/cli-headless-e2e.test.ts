import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { confirmExecutableConfig } from "../executable-config-trust.js";

const execute = promisify(execFile);
it("emits only JSON and resumes the saved session through a real CLI subprocess", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-headless-e2e-"));
  const requests: unknown[] = [];
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    requests.push(payload);
    response.setHeader("Content-Type", "text/event-stream");
    if (
      JSON.stringify(payload.messages).includes("navigate-fixture") &&
      !payload.messages.some((message: { role: string }) => message.role === "tool")
    ) {
      response.end(
        `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "navigation", type: "function", function: { name: "lsp", arguments: JSON.stringify({ operation: "definition", filePath: "fixture.py", line: 1, column: 1 }) } }] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`,
      );
      return;
    }
    response.end(
      `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { content: "Fixture answer" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as { port: number };
    const env = {
      ...process.env,
      WORKSPACE_ROOT: root,
      LLM_API_KEY: "fixture-unused",
      LLM_PROVIDER: "custom",
      LLM_MODEL: "fixture",
      LLM_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      CCR_USER_CONFIG_DIR: path.join(root, "user"),
      CCR_CONFIG_TRUST_STORE: path.join(root, "fixture-trust.json"),
    };
    fs.mkdirSync(path.join(root, ".claude", "skills", "fixture"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".claude", "skills", "fixture", "SKILL.md"),
      "---\nname: fixture\ndescription: fixture\n---\nfixture",
    );
    const initial = await execute(
      process.execPath,
      ["--import", "tsx", path.resolve("src/cli.ts"), "-p", "first", "--output-format", "json"],
      { env, timeout: 15000, windowsHide: true },
    );
    const result = JSON.parse(initial.stdout);
    expect(result.is_error).toBe(false);
    expect(result.result).toBe("Fixture answer");
    expect(initial.stderr).toContain("Loaded");
    expect(fs.existsSync(path.join(root, ".claude", "sessions", `${result.session_id}.json`))).toBe(
      true,
    );
    const resumed = await execute(
      process.execPath,
      [
        "--import",
        "tsx",
        path.resolve("src/cli.ts"),
        "-p",
        "second",
        "--resume",
        result.session_id,
        "--output-format",
        "json",
      ],
      { env, timeout: 15000, windowsHide: true },
    );
    expect(JSON.parse(resumed.stdout).session_id).toBe(result.session_id);
    expect(JSON.stringify(requests.at(-1))).toContain("first");
    expect(JSON.stringify(requests.at(-1))).toContain("second");
    fs.writeFileSync(path.join(root, "fixture.py"), "def fixture(): pass");
    fs.writeFileSync(
      path.join(root, ".claude", "lsp.json"),
      JSON.stringify({
        fixture: {
          command: process.execPath,
          args: [path.resolve("src/__tests__/fixtures/mock-lsp-server.mjs")],
          extensionToLanguage: { ".py": "python" },
        },
      }),
    );
    vi.stubEnv("CCR_CONFIG_TRUST_STORE", env.CCR_CONFIG_TRUST_STORE);
    const lspConfigFile = path.join(root, ".claude", "lsp.json");
    await confirmExecutableConfig(
      lspConfigFile,
      fs.readFileSync(lspConfigFile, "utf8"),
      async () => true,
    );
    const navigated = await execute(
      process.execPath,
      [
        "--import",
        "tsx",
        path.resolve("src/cli.ts"),
        "-p",
        "navigate-fixture",
        "--permission-mode",
        "plan",
        "--output-format",
        "json",
      ],
      { env, timeout: 15000, windowsHide: true },
    );
    expect(JSON.parse(navigated.stdout).is_error).toBe(false);
  } finally {
    vi.unstubAllEnvs();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
  // Three sequential CLI cold starts each have a 15s process timeout. The test
  // budget must cover all three plus fixture setup/cleanup on Windows CI.
}, 60000);
