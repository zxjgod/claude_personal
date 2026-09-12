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
}

function values(argv: string[], names: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const name = names.find((n) => a === n || a.startsWith(`${n}=`));
    if (!name) continue;
    const v = a.startsWith(`${name}=`) ? a.slice(name.length + 1) : argv[++i];
    if (v) out.push(v);
  }
  return out;
}

export function parseCliArgs(argv: string[]): CliArgs {
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
    resume: values(argv, ["--resume"])[0],
    continue: argv.includes("--continue"),
    forkSession: argv.includes("--fork-session"),
    sessionId: values(argv, ["--session-id"])[0],
    addDirs: values(argv, ["--add-dir"]),
    appendSystemPrompt: values(argv, ["--append-system-prompt"])[0],
  };
}
