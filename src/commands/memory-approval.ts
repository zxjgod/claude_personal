// /memory-approval — MemorySave 审批门开关
//
//   /memory-approval          查看当前状态（TUI 中打开档位菜单）
//   /memory-approval on       每次记忆写入都要求显式审批（T2 严格姿态）
//   /memory-approval off      免审批直接写入（默认；deny 规则与 plan 模式仍然生效）
//
// 默认 OFF（用户拍板 2026-10-04，恢复 T2 修复前的静默写入行为；strict 姿态
// 按需开启）。持久化目标随安装位置（settings-target.ts）：全局安装 → 用户级
// ~/.claude-code-replica/settings.json；本地运行 → 项目级 .claude/settings.json
// （键 memory.requireApproval）。managed 设置始终叠加生效，管理员可强制 ON。
import chalk from "chalk";
import { isMemoryApprovalRequired, persistMemoryApproval } from "../memory-approval.js";
import { settingsTargetLabel, settingsWriteTarget } from "../settings-target.js";
import type { SlashCommand } from "./types.js";

export const memoryApprovalCommand: SlashCommand = {
  name: "memory-approval",
  description: "Toggle the MemorySave approval gate (/memory-approval [on|off])",
  run: (args, ctx): undefined => {
    const value = args.trim().toLowerCase();

    if (value === "on" || value === "off") {
      // The write can legitimately refuse (corrupt settings.json) — report it
      // instead of throwing out of the command dispatcher.
      let result: ReturnType<typeof persistMemoryApproval>;
      try {
        result = persistMemoryApproval(value === "on", ctx.workspaceRoot);
      } catch (error) {
        console.log(
          chalk.red(`  切换失败: ${error instanceof Error ? error.message : String(error)}`),
        );
        return;
      }
      const { effective: required, pinnedBy } = result;
      if (pinnedBy) {
        console.log(chalk.yellow(`  已写入 off，但审批门仍为 on —— ${pinnedBy} 强制开启`));
        console.log(
          chalk.gray(`  该层的 memory.requireApproval=true 优先级更高；如需关闭请编辑该文件。`),
        );
        return;
      }
      console.log(
        `  记忆写入审批门已${required ? chalk.green("开启") : chalk.yellow("关闭")}` +
          chalk.gray(
            required
              ? "（每次 MemorySave 都需显式批准）"
              : "（免审批直接写入；permissions.deny 与 plan 模式仍然生效）",
          ),
      );
      console.log(
        chalk.gray(`  已持久化到 ${settingsWriteTarget(ctx.workspaceRoot, "memory").label}`),
      );
      if (!required) {
        console.log(
          chalk.gray(
            "  注意：记忆原文会注入未来会话的 system prompt（project 范围还经 VCS 共享）——" +
              "免审批期间请留意模型写入的内容。",
          ),
        );
      }
      return;
    }

    if (value) {
      console.log(chalk.yellow("  用法: /memory-approval [on|off]"));
      return;
    }

    const required = isMemoryApprovalRequired();
    console.log("");
    console.log(
      `  记忆写入审批门: ${required ? chalk.green("on") : chalk.yellow("off（默认）")}` +
        chalk.gray("  — MemorySave 持久化跨会话记忆前是否要求显式审批"),
    );
    console.log(
      chalk.gray(
        `  切换: /memory-approval on|off（持久化到 ${settingsTargetLabel(ctx.workspaceRoot)}）`,
      ),
    );
  },
};

export default memoryApprovalCommand;
