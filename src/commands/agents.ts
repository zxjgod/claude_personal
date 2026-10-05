// /agents — 子代理管理: list roles, toggle thinking, switch sidechain mode.
//
//   /agents                      list roles + current sub-agent settings
//   /agents thinking on|off      extended thinking for sub-agents (拍板 #21,
//                                DEFAULT OFF — official 2.1.88; frontmatter
//                                `thinking:` on an agent overrides per-type)
//   /agents sidechain audit|report
//                                sidechain transcript mode (拍板 #22):
//                                audit  = full tool-call detail + final report
//                                         (DEFAULT — debugging + future Resume)
//                                report = 仅最终报告回流 (no per-tool detail)
//
//   /agents history              本会话的子代理运行记录（拍板 #19 Resume）:
//                                agentId / 类型 / 状态 / 报告预览；interrupted
//                                记录是崩溃/中断遗留的 orphan，可用
//                                task/agent 的 resume:"<agentId>" 继续
//
// Both toggles persist to the resolved settings.json ("subagents" key — user
// level for a global install, project level for a local run; see
// settings-target.ts) and take effect immediately for subsequently spawned
// sub-agents.
import chalk from "chalk";
import {
  getSubagentSettings,
  persistSubagentSettings,
  subagentSettingsWriteLabel,
} from "../subagent-settings.js";
import { listRuns } from "../subagent-store.js";
import { getSubagentType, listSubagentNames } from "../subagents.js";
import { sanitizeTerminalText } from "../tui/terminal-width.js";
import type { SlashCommand } from "./types.js";

function showSettings(): void {
  const s = getSubagentSettings();
  console.log("");
  console.log(chalk.bold("  子代理设置 (subagents):"));
  console.log(
    `    thinking:    ${s.thinking ? chalk.green("on") : chalk.gray("off (默认 — #21)")}` +
      chalk.gray("  — 子代理 extended thinking"),
  );
  console.log(
    `    sidechain:   ${s.sidechainMode === "audit" ? chalk.green("audit (默认)") : chalk.yellow("report")}` +
      chalk.gray("  — audit=全量审计 / report=仅最终报告回流"),
  );
  console.log(chalk.gray("    切换: /agents thinking on|off · /agents sidechain audit|report"));
}

function showSettingsWithTarget(workspaceRoot: string): void {
  showSettings();
  console.log(chalk.gray(`    持久化到 ${subagentSettingsWriteLabel(workspaceRoot)}`));
}

/** Persist a toggle, reporting a refusal (e.g. a corrupt settings.json). */
function persistOrReport(
  workspaceRoot: string,
  partial: { thinking?: boolean; sidechainMode?: "audit" | "report" },
): boolean {
  try {
    persistSubagentSettings(workspaceRoot, partial);
    return true;
  } catch (error) {
    console.log(chalk.red(`  切换失败: ${error instanceof Error ? error.message : String(error)}`));
    return false;
  }
}

export const agentsCommand: SlashCommand = {
  name: "agents",
  description: "Subagent management — list roles, toggle thinking, switch sidechain mode",
  run: (args, ctx): undefined => {
    const [sub, value] = args.trim().split(/\s+/).filter(Boolean);

    if (sub === "thinking") {
      if (value !== "on" && value !== "off") {
        console.log(chalk.yellow("  用法: /agents thinking on|off"));
        return;
      }
      if (!persistOrReport(ctx.workspaceRoot, { thinking: value === "on" })) return;
      const next = getSubagentSettings();
      console.log(
        `  子代理 thinking 已${next.thinking ? chalk.green("开启") : chalk.gray("关闭")}` +
          chalk.gray(
            `（写入 ${subagentSettingsWriteLabel(ctx.workspaceRoot)}；frontmatter thinking: 可逐代理覆盖）`,
          ),
      );
      return;
    }

    if (sub === "sidechain") {
      if (value !== "audit" && value !== "report") {
        console.log(chalk.yellow("  用法: /agents sidechain audit|report"));
        return;
      }
      if (!persistOrReport(ctx.workspaceRoot, { sidechainMode: value })) return;
      const next = getSubagentSettings();
      console.log(
        `  sidechain 模式已切换为 ${chalk.cyan(next.sidechainMode)}` +
          chalk.gray(
            next.sidechainMode === "audit"
              ? "（全量：工具调用细节 + 最终报告 —— 审计/调试/Resume 数据源）"
              : "（仅最终报告回流，不记录工具调用细节）",
          ),
      );
      return;
    }

    if (sub === "history") {
      // 拍板 #19: run records of this session, oldest first. "interrupted"
      // entries are orphans (crash/Ctrl+C) and the prime resume candidates.
      const runs = listRuns(ctx.workspaceRoot, ctx.sessionId);
      if (runs.length === 0) {
        console.log(chalk.gray("  本会话暂无子代理运行记录。"));
        return;
      }
      console.log("");
      console.log(chalk.bold('  子代理运行记录（可用 task/agent 的 resume:"<agentId>" 继续）:'));
      const statusColor = (s: string): string =>
        s === "completed"
          ? chalk.green(s)
          : s === "interrupted"
            ? chalk.yellow(s)
            : s === "running"
              ? chalk.cyan(s)
              : chalk.red(s);
      for (const run of runs) {
        // typeName / description / report / status are model-authored or read
        // back from disk, so they are sanitized like any other untrusted text
        // before reaching the terminal (agentId too — display-only here; the
        // resume key is taken from the command line, not from this row).
        console.log("");
        console.log(
          `    ${chalk.cyan(sanitizeTerminalText(run.agentId))}  ${sanitizeTerminalText(run.typeName)}  ${statusColor(sanitizeTerminalText(run.status))}  ` +
            chalk.gray(run.updatedAt.slice(0, 19).replace("T", " ")),
        );
        console.log(chalk.gray(`      任务: ${sanitizeTerminalText(run.description)}`));
        if (run.report) {
          const preview = sanitizeTerminalText(run.report).replace(/\s+/g, " ").slice(0, 120);
          console.log(chalk.gray(`      报告: ${preview}${run.report.length > 120 ? "…" : ""}`));
        }
      }
      return;
    }

    if (sub && sub !== "list") {
      console.log(
        chalk.yellow(`  未知子命令 "${sub}"。可用: thinking | sidechain | history | list`),
      );
      return;
    }

    // Bare /agents or /agents list: roles list + current settings. (In the
    // TUI the bare form opens the interactive toggle menu instead — see
    // tui/command-menu-flow.ts.)
    const names = listSubagentNames();
    if (names.length === 0) {
      console.log(chalk.gray("  No sub-agent roles registered."));
    } else {
      console.log("");
      console.log(chalk.bold("  Sub-agent roles:"));
      for (const name of names) {
        const type = getSubagentType(name);
        if (!type) continue;
        console.log("");
        // The description and the tool list come from the agent definition
        // (.claude/agents/*.md frontmatter, or a definition file) — file
        // content, so it is sanitized like the /agents history rows.
        console.log(
          `    ${chalk.cyan(sanitizeTerminalText(name))} — ${sanitizeTerminalText(type.description)}`,
        );
        console.log(
          chalk.gray(`      tools: ${type.toolNames.map(sanitizeTerminalText).join(", ")}`),
        );
        if (type.maxTurns) console.log(chalk.gray(`      max turns: ${type.maxTurns}`));
        if (type.thinking !== undefined)
          console.log(chalk.gray(`      thinking: ${type.thinking} (frontmatter 覆盖)`));
      }
    }
    showSettingsWithTarget(ctx.workspaceRoot);
  },
};

export default agentsCommand;
