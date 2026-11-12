import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { query } from "../sdk.js";

const { runEvaluation } = await import(pathToFileURL(path.resolve("scripts/evaluation.mjs")).href);
const suiteDirectory = path.resolve("examples");
const suite = JSON.parse(
  fs.readFileSync(path.join(suiteDirectory, "repository-task-suite.json"), "utf8"),
);

const types = `export interface Task {id:string;title:string;priority:0|1|2;status:'todo'|'done';}\n`;
const compare = `export function compareTasks(a:Pick<Task,'priority'>,b:Pick<Task,'priority'>):number{return b.priority-a.priority;}\n`;
const implementation = String.raw`
export function parseTaskLines(text:string):Task[] {
  const tasks:Task[]=[], ids=new Set<string>();
  for(const [index,line] of text.split('\n').entries()) {
    if(!line.trim()) continue;
    try {
      const value:unknown=JSON.parse(line);
      if(!value||typeof value!=='object'||Array.isArray(value)) throw Error('object required');
      const row=value as Record<string,unknown>;
      if(typeof row.id!=='string'||!row.id.trim()||typeof row.title!=='string'||!row.title.trim()||
        (row.priority!==0&&row.priority!==1&&row.priority!==2)||(row.status!=='todo'&&row.status!=='done')) throw Error('invalid task');
      const id=row.id.trim();
      if(ids.has(id)) throw Error('duplicate id');
      ids.add(id);tasks.push({id,title:row.title.trim(),priority:row.priority,status:row.status});
    } catch(error) {throw Error('line '+(index+1)+': '+String(error));}
  }
  return tasks;
}
export class TaskCatalog {
  private readonly tasks:Task[];
  constructor(input:Task[]){this.tasks=input.map(task=>({...task}));}
  static fromLines(text:string):TaskCatalog{return new TaskCatalog(parseTaskLines(text));}
  list(status?:Task['status']):Task[]{return this.tasks.filter(task=>!status||task.status===status).sort(compareTasks).map(task=>({...task}));}
  complete(id:string):boolean{const task=this.tasks.find(task=>task.id===id);if(!task||task.status==='done')return false;task.status='done';return true;}
}
`;

it("routes read-only shell commands through the fixed-command approval gate in the real CLI", async () => {
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    const count = payload.messages.filter(
      (message: { role: string }) => message.role === "tool",
    ).length;
    const delta =
      count >= 2
        ? { content: "approval gate checked" }
        : {
            tool_calls: [
              {
                index: 0,
                id: count === 0 ? "readonly" : "fixed",
                type: "function",
                function: {
                  name: "bash",
                  arguments: JSON.stringify({
                    command: count === 0 ? "git status --short" : "node build.mjs",
                    description: "verify evaluation approval",
                  }),
                },
              },
            ],
          };
    response.setHeader("Content-Type", "text/event-stream");
    response.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: count >= 2 ? "stop" : "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const asked: string[] = [];
  try {
    const report = await runEvaluation(
      {
        toolchain: "typescript",
        allowedTools: ["Read"],
        disallowedTools: [],
        cases: [
          {
            name: "approval",
            prompt: "probe",
            fixture: "eval-fixtures/repository-tasks",
            shellCommands: ["node build.mjs"],
            timeoutMs: 45000,
            assertions: [{ type: "contains", text: "approval gate checked" }],
          },
        ],
      },
      {
        suiteDirectory,
        env: {
          LLM_PROVIDER: "custom",
          LLM_MODEL: "fixture",
          LLM_API_KEY: "fixture-unused",
          LLM_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
          CCR_AUTO_MEMORY_EXTRACT: "0",
        },
        query: (input: Parameters<typeof query>[0]) =>
          query({
            ...input,
            options: {
              ...input.options,
              cliModule: path.resolve("src/cli.ts"),
              env: {
                ...input.options?.env,
                NODE_OPTIONS: `--import=${pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href}`,
              },
              canUseTool: async (name, payload, context) => {
                asked.push(String(payload.command));
                const approve = input.options?.canUseTool;
                if (!approve) throw new Error("Evaluation did not install its approval gate");
                return approve(name, payload, context);
              },
            },
          }),
      },
    );
    expect(report.cases[0].error).toBeUndefined();
    expect(report.passed).toBe(1);
    expect(report.cases[0].shell_approval).toBe("all-shell-ask-v1");
    const results = report.cases[0].tool_trace.filter(
      (event: { type: string }) => event.type === "tool_result",
    );
    expect(
      results.find((event: { tool_use_id: string }) => event.tool_use_id === "readonly"),
    ).toMatchObject({
      is_error: true,
      content: expect.stringContaining("Permission denied"),
    });
    expect(asked).toEqual(["git status --short", "node build.mjs"]);
    expect(
      results.find((event: { tool_use_id: string }) => event.tool_use_id === "fixed")?.content,
    ).toContain("REPOSITORY_BUILD_FAILED");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 60000);

it.each([
  "repair",
  "migration",
  "ignored-source",
])("repository verifier and patch replay enforce %s", async (mode) => {
  const migration = mode !== "repair";
  const entry = suite.cases[migration ? 1 : 0];
  const report = await runEvaluation(
    { ...suite, cases: [entry] },
    {
      suiteDirectory,
      query: async function* ({
        options,
      }: {
        options: { cwd: string; env: Record<string, string> };
      }) {
        const cwd = options.cwd;
        const use = (id: string, name: string, input: Record<string, string>) => ({
          type: "assistant",
          message: { content: [{ type: "tool_use", id, name, input }] },
        });
        const result = (id: string, content: string, is_error = false) => ({
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error }] },
        });
        const run = (script: string) =>
          execFileSync(process.execPath, [script], {
            cwd,
            windowsHide: true,
            env: { ...process.env, ...options.env },
            stdio: "pipe",
            encoding: "utf8",
          });
        yield use("initial-build", "bash", { command: "node build.mjs" });
        let initial = "";
        try {
          run("build.mjs");
        } catch (error) {
          initial = String((error as { stderr: string }).stderr);
        }
        expect(initial).toContain("REPOSITORY_BUILD_FAILED");
        yield result("initial-build", initial, true);
        if (migration) {
          yield use("move", "bash", { command: "git mv src/legacy.ts src/task-model.ts" });
          execFileSync("git", ["mv", "src/legacy.ts", "src/task-model.ts"], {
            cwd,
            windowsHide: true,
          });
          yield result("move", "moved");
        }
        const model = migration ? "task-model" : "legacy";
        const edits: Array<[string, string]> = [
          [
            `src/${model}.ts`,
            types +
              (migration ? "import {compareTasks} from './priority.js';\n" : compare) +
              implementation,
          ],
          [
            "src/commands.ts",
            `import {TaskCatalog} from './${model}.js';export function readyTitles(text:string):string{return TaskCatalog.fromLines(text).list('todo').map(task=>task.title).join(', ');}`,
          ],
          [
            "src/index.ts",
            `export {TaskCatalog,parseTaskLines} from './${model}.js';export type {Task} from './${model}.js';export {compareTasks} from './${migration ? "priority" : "legacy"}.js';export {readyTitles} from './commands.js';`,
          ],
        ];
        if (migration)
          edits.push(
            ["src/priority.ts", `import type {Task} from './task-model.js';\n${compare}`],
            [
              "README.md",
              "Public parseTaskLines API uses src/task-model.ts and src/priority.ts.\n",
            ],
          );
        for (const [index, [file, content]] of edits.entries()) {
          const target = path.join(cwd, file);
          yield use(`edit-${index}`, "write", { file_path: target, content });
          fs.writeFileSync(target, content);
          yield result(`edit-${index}`, "written");
        }
        if (mode === "ignored-source") {
          fs.mkdirSync(path.join(cwd, ".git/info"), { recursive: true });
          fs.appendFileSync(path.join(cwd, ".git/info/exclude"), "\nsrc/priority.ts\n");
        }
        yield use("final-build", "bash", { command: "node build.mjs" });
        yield result("final-build", run("build.mjs"));
        yield use("test", "bash", { command: "node test.mjs" });
        yield result("test", run("test.mjs"));
        yield { type: "result", is_error: false, result: "build and tests passed" };
      },
    },
  );
  expect(report.cases[0].error).toBeUndefined();
  expect(report.passed).toBe(mode === "ignored-source" ? 0 : 1);
  expect(report.cases[0].toolchain.name).toBe("typescript");
  expect(report.cases[0].toolchain.library_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(report.cases[0].patch_replay_verified).toBe(mode !== "ignored-source");
  if (migration) {
    expect(report.cases[0].patch).toContain("README.md");
    expect(report.cases[0].patch).toContain("src/task-model.ts");
    if (mode === "migration") expect(report.cases[0].patch).toContain("src/priority.ts");
    else {
      expect(report.cases[0].assertions[0].error).toContain("Independent command failed");
      expect(report.cases[0].assertions[0].phase).toBe("patch-replay");
      expect(report.cases[0].assertions[0].workspace_passed).toBe(true);
    }
  }
}, 60000);
