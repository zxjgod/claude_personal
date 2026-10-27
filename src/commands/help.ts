// /help — list all commands grouped by category
import chalk from "chalk";
import { sanitizeTerminalText } from "../tui/terminal-width.js";
import type { CommandCatalogEntry, SlashCommand } from "./types.js";

// COMMANDS is injected at registry build time to avoid a static import cycle
// (registry.ts imports this file, so this file cannot import registry.ts).
// The getter is evaluated lazily at run time (not at bind time) so disk-defined
// custom commands loaded later in startup still appear in /help.
let COMMANDS_GETTER: () => CommandCatalogEntry[] = () => [];
export function bindCommandList(list: () => CommandCatalogEntry[]): void {
  COMMANDS_GETTER = list;
}

/** Command categories for grouping */
interface CommandCategory {
  emoji: string;
  title: string;
  commands: CommandCatalogEntry[];
}

const CATEGORY_MAP: Record<string, { emoji: string; title: string }> = {
  // Session & conversation
  clear: { emoji: "🗑️", title: "会话管理" },
  compact: { emoji: "📦", title: "上下文压缩" },
  context: { emoji: "📊", title: "上下文查看" },
  tokens: { emoji: "🔢", title: "Token 显示" },
  // Model control
  model: { emoji: "🤖", title: "模型控制" },
  effort: { emoji: "💪", title: "推理强度" },
  provider: { emoji: "🔄", title: "Provider 切换" },
  // Status & info
  status: { emoji: "ℹ️", title: "状态查看" },
  cost: { emoji: "💰", title: "费用统计" },
  doctor: { emoji: "🩺", title: "环境诊断" },
  config: { emoji: "⚙️", title: "配置查看" },
  // Permissions & modes
  permissions: { emoji: "🔐", title: "权限管理" },
  mode: { emoji: "🛡️", title: "权限模式" },
  // Files & changes
  diff: { emoji: "📝", title: "改动查看" },
  tools: { emoji: "🔧", title: "工具列表" },
  // Session persistence
  sessions: { emoji: "💾", title: "会话管理" },
  resume: { emoji: "📂", title: "恢复会话" },
  memory: { emoji: "🧠", title: "CLAUDE.md" },
  init: { emoji: "📋", title: "初始化" },
  // Development workflow
  commit: { emoji: "✅", title: "Git 提交" },
  pr: { emoji: "🔀", title: "PR 操作" },
  branch: { emoji: "🌿", title: "分支操作" },
  // Advanced features
  agents: { emoji: "👥", title: "子代理" },
  team: { emoji: "🚀", title: "团队协作" },
  skills: { emoji: "🎯", title: "Skills" },
  fork: { emoji: "🍴", title: "Fork 模式" },
  review: { emoji: "🔍", title: "代码审查" },
  recap: { emoji: "📋", title: "会话摘要" },
  share: { emoji: "📤", title: "分享" },
  rewind: { emoji: "⏪", title: "回退" },
  export: { emoji: "📥", title: "导出" },
  schedule: { emoji: "⏰", title: "定时任务" },
  goal: { emoji: "🎯", title: "目标设置" },
  // Integrations
  mcp: { emoji: "🔌", title: "MCP 服务" },
  hooks: { emoji: "🪝", title: "钩子脚本" },
  // Customization
  theme: { emoji: "🎨", title: "主题设置" },
  keybindings: { emoji: "⌨️", title: "快捷键" },
  vim: { emoji: "📝", title: "Vim 模式" },
  // Onboarding
  onboarding: { emoji: "👋", title: "引导" },
};

export const helpCommand: SlashCommand = {
  name: "help",
  description: "Show available commands",
  run: (): undefined => {
    // Group commands by category
    const categories: CommandCategory[] = [];
    const categoryMap = new Map<string, CommandCatalogEntry[]>();

    for (const cmd of COMMANDS_GETTER()) {
      const catInfo = CATEGORY_MAP[cmd.name];
      const key = catInfo?.title || "其他";
      if (!categoryMap.has(key)) {
        categories.push({
          emoji: catInfo?.emoji || "📌",
          title: key,
          commands: [],
        });
        categoryMap.set(key, []);
      }
      const cat = categories.find((c) => c.title === key);
      cat?.commands.push(cmd);
    }

    console.log("");
    console.log(chalk.bold.cyan("  Claude Code Replica — 命令帮助"));
    console.log("");

    for (const cat of categories) {
      console.log(chalk.bold(`  ${cat.emoji} ${cat.title}`));
      for (const cmd of cat.commands) {
        // Disk commands (.claude/commands/*.md) contribute their frontmatter
        // description here — file content, so sanitize name and description.
        const name = chalk.cyan(`/${sanitizeTerminalText(cmd.name)}`).padEnd(18);
        const desc = chalk.gray(sanitizeTerminalText(cmd.description));
        console.log(`    ${name} ${desc}`);
      }
      console.log("");
    }

    // Tips section
    console.log(chalk.bold("  💡 快捷操作"));
    console.log(`    ${chalk.cyan("@<path>").padEnd(18)} ${chalk.gray("引用文件内容到消息中")}`);
    console.log(`    ${chalk.cyan("```").padEnd(18)} ${chalk.gray("多行输入（代码块）")}`);
    console.log(`    ${chalk.cyan("exit").padEnd(18)} ${chalk.gray("退出程序")}`);
    console.log(`    ${chalk.cyan("Ctrl+C").padEnd(18)} ${chalk.gray("中断当前操作")}`);
    console.log("");
  },
};

export default helpCommand;
