// Offline preview of the real TUI components. No API key or model request.
// Run: npx tsx scripts/tui-theme-preview.tsx [--light]
import chalk from "chalk";
import { Box, Text, renderToString } from "ink";
import { renderMarkdown } from "../src/tui/markdown.js";
import { CompletedToolCard } from "../src/tui/ToolCard.js";
import { applyTheme, palette } from "../src/tui/theme.js";

chalk.level = 3;
applyTheme(process.argv.includes("--light") ? "light" : "dark");
Object.defineProperty(process.stdout, "columns", { value: 104, configurable: true });
const code = `// Keep the active workspace in sync
import { clearCwd } from "./session-cwd.js";

type Session = { id: string; root: string };

export function changeWorkspace(session: Session, next: string) {
  clearCwd(session.id);
  session.root = next;
  return true;
}`;
const output = renderToString(
  <Box flexDirection="column" paddingX={1}>
    <Text color={palette.secondary}>{"  Thought for 4s (ctrl+o to expand)\n"}</Text>
    <CompletedToolCard detail="src/session.ts" expanded result={{
      toolName: "write", formatted: "Created file: src/session.ts",
      result: { content: "Created file: src/session.ts", metadata: {
        codePreview: { filePath: "src/session.ts", text: code, totalLines: 10 },
      } },
    }} />
    <Text>{" "}</Text>
    <CompletedToolCard detail="src/session.ts" expanded result={{
      toolName: "edit", formatted: `Edit applied to src/session.ts:
- import { getCwd } from "./session-cwd.js";
+ import { clearCwd } from "./session-cwd.js";
-   return session.root;
+   clearCwd(session.id);
+   session.root = next;`,
    }} />
    <Text>{" "}</Text>
    <CompletedToolCard detail="npm test" expanded result={{
      toolName: "bash", formatted: "Test Files  8 passed (8)\n     Tests  152 passed (152)\n  Duration  8.08s",
    }} />
    <Text>{" "}</Text>
    <Text color={palette.text}>{renderMarkdown("## Review complete\n\nThe workspace is now synchronized. See `src/session.ts` for the change.\n\n- **Code:** magenta keywords, yellow strings, lime functions\n- **Diff:** dark red removals and dark green additions")}</Text>
    <Text>{" "}</Text>
    <Text color={palette.promptBorder}>{"─".repeat(99)}</Text>
    <Text color={palette.text}>{"❯ "}</Text>
    <Text color={palette.secondary}>{"  ? for shortcuts                                            /theme dark"}</Text>
  </Box>,
  { columns: 106 },
);
process.stdout.write(`${output}\n`);
