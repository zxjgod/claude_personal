export interface CliArgs {
  print: boolean;
  outputFormat: "text" | "json" | "stream-json";
  inputFormat: "text" | "stream-json";
  prompt?: string;
  resume?: string;
  continue: boolean;
  forkSession: boolean;
  sessionId?: string;
  addDirs: string[];
  appendSystemPrompt?: string;
  systemPrompt?: string;
  jsonSchema?: string;
  maxBudgetUsd?: number;
  maxTurns?: number;
  noSessionPersistence: boolean;
  replayUserMessages: boolean;
  includePartialMessages: boolean;
}

function values(argv: string[], names: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const name = names.find((n) => a === n || a.startsWith(`${n}=`));
    if (!name) continue;
    const inline = a.startsWith(`${name}=`);
    const next = argv[i + 1];
    if (!inline && (!next || next.startsWith("-"))) {
      if (name === "--resume" || name === "-r") {
        out.push("");
        continue;
      }
      throw new Error(`${name} requires a value`);
    }
    const v = inline ? a.slice(name.length + 1) : argv[++i];
    if (v === "" && (name === "--max-turns" || name === "--max-budget-usd"))
      throw new Error(`${name} requires a value`);
    if (v === "" && (name === "--resume" || name === "-r")) out.push("");
    if (v) out.push(v);
  }
  return out;
}

export function parseCliArgs(argv: string[]): CliArgs {
  const rawTurns = values(argv, ["--max-turns"])[0];
  const turns =
    rawTurns === undefined
      ? undefined
      : ["0", "unlimited", "infinity"].includes(rawTurns.toLowerCase())
        ? Infinity
        : Number(rawTurns);
  if (
    rawTurns !== undefined &&
    turns !== Infinity &&
    (!Number.isInteger(turns) || Number(turns) < 1)
  )
    throw new Error("--max-turns must be a positive integer or unlimited");
  const output = values(argv, ["--output-format"])[0] as CliArgs["outputFormat"] | undefined;
  const input = values(argv, ["--input-format"])[0] as CliArgs["inputFormat"] | undefined;
  const printIndex = argv.findIndex((a) => a === "-p" || a === "--print");
  const printValue =
    printIndex >= 0 && argv[printIndex + 1] && !argv[printIndex + 1]!.startsWith("-")
      ? argv[printIndex + 1]
      : undefined;
  return {
    print: argv.includes("-p") || argv.includes("--print"),
    outputFormat: output === "json" || output === "stream-json" ? output : "text",
    inputFormat: input === "stream-json" ? input : "text",
    prompt: values(argv, ["--prompt"])[0] ?? printValue,
    resume: values(argv, ["--resume", "-r"])[0] || undefined,
    continue:
      argv.includes("--continue") ||
      argv.includes("-c") ||
      values(argv, ["--resume", "-r"])[0] === "",
    forkSession: argv.includes("--fork-session"),
    sessionId: values(argv, ["--session-id"])[0],
    addDirs: values(argv, ["--add-dir"]),
    appendSystemPrompt: values(argv, ["--append-system-prompt"])[0],
    systemPrompt: values(argv, ["--system-prompt"])[0],
    jsonSchema: values(argv, ["--json-schema"])[0],
    maxBudgetUsd:
      values(argv, ["--max-budget-usd"])[0] === undefined
        ? undefined
        : Number(values(argv, ["--max-budget-usd"])[0]),
    maxTurns: turns,
    noSessionPersistence: argv.includes("--no-session-persistence"),
    replayUserMessages: argv.includes("--replay-user-messages"),
    includePartialMessages: argv.includes("--include-partial-messages"),
  };
}
