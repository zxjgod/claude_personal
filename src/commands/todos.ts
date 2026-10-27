import chalk from "chalk";
import { getTodos } from "../tools/extended/todo.js";
import { sanitizeTerminalText } from "../tui/terminal-width.js";
import type { SlashCommand } from "./types.js";
export const todosCommand: SlashCommand = {
  name: "todos",
  description: "Show the current todo list",
  run: (_args, ctx): undefined => {
    const todos = getTodos(ctx.sessionId);
    console.log(
      todos.length
        ? todos
            .map((t) => `  [${sanitizeTerminalText(t.status)}] ${sanitizeTerminalText(t.content)}`)
            .join("\n")
        : chalk.gray("  No todos."),
    );
  },
};
export default todosCommand;
