// /provider — switch between saved API endpoint profiles (.claude/providers.json)
import chalk from "chalk";
import { PROVIDER_DEFAULTS } from "../llm-adapter.js";
import {
  applyProfile,
  findProfile,
  loadProviderProfiles,
  type ProviderProfile,
  providersFilePath,
} from "../provider-profiles.js";
import { promptSelectMenu } from "../tui/cli-interactive.js";
import { sanitizeTerminalText } from "../tui/terminal-width.js";
import type { CommandContext, SlashCommand } from "./types.js";

/** "provider/model" — one-line summary of a profile's target. */
function describe(p: ProviderProfile): string {
  return `${p.provider ?? "openai"}/${p.model ?? "default"}`;
}

/** Get default model recommendations for a provider */
function getRecommendedModel(provider: string): { model: string; reason: string } {
  const defaults = PROVIDER_DEFAULTS[provider];
  if (!defaults) {
    return { model: "请查看官方文档", reason: "未知 provider" };
  }

  const recommendations: Record<string, string> = {
    anthropic: "claude-opus-4-8: 旗舰模型，最强推理能力，适合复杂任务",
    openai: "gpt-4o: 多模态旗舰模型，性价比高",
    deepseek: "deepseek-chat: 开源模型，适合代码任务",
    qwen: "qwen-plus: 阿里通义千问，适合中文场景",
    moonshot: "moonshot-v1-128k: 支持 128k 上下文",
    zhipu: "glm-4: 智谱清言，国产大模型",
    custom: "llama3: 本地部署的 LLaMA 模型",
  };

  return {
    model: defaults.defaultModel,
    reason: recommendations[provider] || "该 provider 的默认推荐模型",
  };
}

const EXAMPLE = `  {
    "profiles": [
      { "name": "relay", "provider": "openai", "baseURL": "https://your-relay/v1", "apiKey": "sk-...", "model": "gpt-4o" },
      { "name": "deepseek", "provider": "deepseek", "apiKey": "sk-...", "model": "deepseek-chat" }
    ]
  }`;

/** Switch the live config to `profile` and print a detailed confirmation with model recommendation. */
function switchTo(ctx: CommandContext, profile: ProviderProfile): void {
  const prevProvider = ctx.modelConfig.provider;
  try {
    applyProfile(ctx.modelConfig, profile);
  } catch (error) {
    console.log(
      `${chalk.red("  ✗")} 无法切换: ${sanitizeTerminalText(error instanceof Error ? error.message : String(error))}`,
    );
    return;
  }

  console.log("");
  console.log(`${chalk.green("  ✓")} 已切换到 ${chalk.cyan(sanitizeTerminalText(profile.name))}`);
  console.log(chalk.gray("  ──────────────────────────────────────"));

  const currentProvider = ctx.modelConfig.provider;
  const currentModel = ctx.modelConfig.model;

  // Show provider change
  if (prevProvider !== currentProvider) {
    console.log(
      `  ${chalk.dim("Provider:")} ${sanitizeTerminalText(prevProvider)} → ${chalk.cyan(sanitizeTerminalText(currentProvider))}`,
    );
  }

  // Show model change and recommendation
  const recommended = getRecommendedModel(currentProvider);
  if (profile.model) {
    // User explicitly specified a model in the profile
    console.log(`  ${chalk.dim("Model:")}   ${chalk.cyan(sanitizeTerminalText(currentModel))}`);
    if (currentModel !== recommended.model) {
      console.log(
        chalk.gray(
          `           推荐模型: ${sanitizeTerminalText(recommended.model)} (${sanitizeTerminalText(recommended.reason)})`,
        ),
      );
    }
  } else {
    // Using provider default
    console.log(
      `  ${chalk.dim("Model:")}   ${chalk.cyan(sanitizeTerminalText(currentModel))} ${chalk.gray("(provider 默认)")}`,
    );
  }

  console.log(chalk.gray("  ──────────────────────────────────────"));
  console.log(chalk.gray("  提示: /status 查看当前配置，/model <id> 切换模型"));
  console.log("");
}

export const providerCommand: SlashCommand = {
  name: "provider",
  description: "Switch API endpoint profile (/provider [name]) — see .claude/providers.json",
  run: async (args, ctx): Promise<undefined> => {
    const profiles = loadProviderProfiles(ctx.workspaceRoot);
    if (profiles.length === 0) {
      console.log("");
      console.log(chalk.yellow("  ⚠️  未找到 provider 配置文件"));
      console.log(
        chalk.gray(`  请创建 ${sanitizeTerminalText(providersFilePath(ctx.workspaceRoot))}:`),
      );
      console.log(EXAMPLE);
      console.log("");
      console.log(chalk.cyan("  📋 当前支持的 Provider:"));
      console.log(chalk.gray("  ──────────────────────────────────────"));
      for (const [name, config] of Object.entries(PROVIDER_DEFAULTS)) {
        const rec = getRecommendedModel(name);
        console.log(
          `    ${chalk.cyan(name.padEnd(12))} ${chalk.gray("默认:")} ${config.defaultModel}`,
        );
        console.log(chalk.gray(`                     ${rec.reason}`));
      }
      console.log("");
      return;
    }

    const name = args.trim();

    // With an argument: switch directly (works in both front-ends).
    if (name) {
      const match = findProfile(profiles, name);
      if (!match) {
        console.log(chalk.yellow(`  未找到匹配的 profile: "${sanitizeTerminalText(name)}"`));
        console.log(
          chalk.gray(`  可用选项: ${profiles.map((p) => sanitizeTerminalText(p.name)).join(", ")}`),
        );
        return;
      }
      switchTo(ctx, match);
      return;
    }

    // No argument on a real terminal (line REPL / --no-tui): arrow-key picker.
    // The TUI intercepts bare /provider before this runs (see tui/run.tsx).
    if (process.stdin.isTTY) {
      const picked = await promptSelectMenu({
        header: "切换 Provider",
        question: "选择一个 API 端点配置:",
        options: profiles.map((p) => ({
          // The value is the profile identity; only display text is sanitized.
          value: p.name,
          // .claude/providers.json lives in the workspace — profile fields are
          // project-supplied, so sanitize the label/description shown here.
          label: sanitizeTerminalText(p.name),
          description: sanitizeTerminalText(`${p.provider ?? "openai"}/${p.model ?? "default"}`),
        })),
      });
      if (!picked || picked.length === 0) {
        console.log(chalk.gray("  已取消"));
        return;
      }
      const match = profiles.find((p) => p.name === picked[0]);
      if (match) switchTo(ctx, match);
      return;
    }

    // Non-TTY (piped / CI): list profiles, don't block on input.
    console.log("");
    console.log(chalk.bold("  Provider 配置列表:"));
    console.log(chalk.gray("  ──────────────────────────────────────"));
    for (const p of profiles) {
      const rec = getRecommendedModel(p.provider ?? "openai");
      const current = p.model ?? rec.model;
      const isCurrent =
        ctx.modelConfig.provider === (p.provider ?? "openai") && ctx.modelConfig.model === current;
      const marker = isCurrent ? chalk.green(" ◀ 当前") : "";
      console.log(
        `    ${chalk.cyan(sanitizeTerminalText(p.name))} — ${chalk.gray(sanitizeTerminalText(describe(p)))}${marker}`,
      );
      if (p.model && p.model !== rec.model) {
        console.log(chalk.gray(`                   推荐: ${sanitizeTerminalText(rec.model)}`));
      }
    }
    console.log("");
    console.log(chalk.gray("  使用 /provider <名字> 切换"));
    console.log("");
  },
};

export default providerCommand;
