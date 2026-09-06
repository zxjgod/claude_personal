// ============================================================
// i18n — Internationalization for error messages and UI strings
// ============================================================
// Provides consistent language for all user-facing messages.
// Currently supports English only, but structured for easy extension.
// ============================================================

export type Language = "en" | "zh-CN";

export interface I18nOptions {
  language: Language;
}

// Detect language from environment or CLI flag.
// Official-alignment decision (2026-09-06): English is the DEFAULT — the
// official client ships English chrome, and an ambient LANG=zh no longer
// silently flips the UI. Chinese is opt-in via CCR_LANGUAGE=zh-CN only.
export function detectLanguage(): Language {
  const envLang = process.env.CCR_LANGUAGE;
  if (envLang === "zh-CN" || envLang === "zh") return "zh-CN";
  return "en";
}

// Translation maps
const translations: Record<Language, Record<string, string>> = {
  en: {
    // Permission errors
    "permission.denied": "Permission denied",
    "permission.requiresApproval": "This action requires your approval",
    "permission.planModeBlocked": "This action is not available in plan mode",

    // Tool errors
    "tool.notFound": "Tool not found: {name}",
    "tool.executionFailed": "Tool execution failed: {error}",
    "tool.timeout": "Tool timed out after {seconds} seconds",

    // File errors
    "file.notFound": "File not found: {path}",
    "file.accessDenied": "Access denied: {path}",
    "file.outsideWorkspace": "Access denied: {path} resolves outside workspace",
    "file.writeError": "Error writing file: {path}",
    "file.readError": "Error reading file: {path}",

    // Model errors
    "model.error": "Model error: {message}",
    "model.contextTooLong": "Context too long, compressing...",
    "model.rateLimit": "Rate limit hit, waiting {seconds}s...",
    "model.authError": "Authentication error. Please check your API key.",

    // Session errors
    "session.saveError": "Failed to save session",
    "session.loadError": "Failed to load session",

    // General
    "error.unknown": "An unknown error occurred",
    "error.aborted": "Operation aborted",
    "error.cancelled": "Operation cancelled",

    // --- UI chrome (P3-13: one source for the mixed-language TUI strings) ---
    // Permission menus (Ink Prompts.tsx + raw-mode cli-interactive.ts) —
    // official option wording.
    "ui.permission.yes": "Yes",
    "ui.permission.always": "Yes, and don't ask again this session",
    "ui.permission.no": "No, and tell Claude what to do differently (esc)",
    "ui.permission.alwaysBash": "Yes, and don't ask again for commands in {dir}",
    "ui.permission.alwaysEdits": "Yes, and allow all edits this session",
    "ui.permission.yes.desc": "Allow once",
    "ui.permission.always.desc": "Don't ask again this session",
    "ui.permission.no.desc": "Cancel the operation",
    "ui.permission.proceed": "Do you want to proceed?",
    "ui.permission.chooseAction": "Choose an action:",
    "ui.permission.hint": "↑↓ choose · Enter confirm · Esc cancel",
    "ui.permission.title": "Permission request",
    "ui.permission.textHint": "type y allow / a always / n deny (Esc cancels)",

    // Permission prompt tool labels (line-CLI text fallback)
    "ui.tool.bash": "Shell command",
    "ui.tool.write": "Write file",
    "ui.tool.edit": "Edit file",
    "ui.tool.read": "Read file",
    "ui.tool.glob": "Find files",
    "ui.tool.grep": "Search content",
    "ui.tool.task": "Sub-agent task",
    "ui.tool.fallback": "{name} operation",

    // Prompt footer (official PromptInputFooterLeftSide hints)
    "ui.footer.shortcuts": "? for shortcuts",
    "ui.footer.interrupt": "esc to interrupt",
    "ui.footer.modeCycle": "(shift+tab to cycle)",
    "ui.footer.untilAutoCompact": "{pct}% until auto-compact",

    // Status line phases (statusLabel)
    "ui.phase.thinking": "Thinking",
    "ui.phase.responding": "Responding",
    "ui.phase.runningTools": "Running {n} tools",

    // Live-region elision hints
    "ui.elide.above": "… {n} lines above elided",
    "ui.elide.thinking": "… {n} earlier thinking lines elided",

    // Input box
    "ui.paste.note": "Pasted {n} lines — review, then Enter to send",
    "ui.file.hint": "Tab insert · Esc close",
    "ui.suggest.moreAbove": "↑ {n} more",
    "ui.suggest.moreBelow": "↓ {n} more",
    "ui.input.queuedHint": "⏎ queues your next message (runs after the current turn)",

    // Tool cards
    "ui.tool.expandHint": "(ctrl+o to expand)",
    "ui.tool.expandMore": "… +{n} lines (ctrl+o to expand)",
    "ui.tools.moreRunning": "… +{n} more running",

    // Turn events
    "ui.abort.user": "user interrupt",
    "ui.queue.queued": "⏎ queued — will run after the current turn",
    "ui.queue.limitDropped": "⎿ Queued-turn limit reached ({max}); dropped {n} queued messages",
    "ui.schedule.parked": "⏰ {label} — will be delivered after the current turn",
    "ui.compact.started": "Compacting context…",
    "ui.interrupted.hint": "Interrupted · What should Claude do instead?",

    // Context-gauge toasts
    "ui.ctx.warn": "Context at {pct}% — nearing auto-compact",
    "ui.ctx.critical": "Context at {pct}% — auto-compact imminent",

    // Full-screen scrolled hint
    "ui.fs.scrolled": "↑ viewing history — Ctrl+End or G to jump to latest",

    // Collapsed thinking (P0-2)
    "ui.thinking.collapsed": "✻ Thought for {s}s · {n} lines (Ctrl+O to expand)",
    // No duration recorded (e.g. /resume replayed history)
    "ui.thinking.noSecs": "✻ Thinking · {n} lines (Ctrl+O to expand)",

    // Model retry countdown (P0-4)
    "ui.retry.status": "{reason} — retrying in {s}s (attempt {a}/{m})",
    "ui.retry.now": "{reason} — retrying now… (attempt {a}/{m})",
    "ui.retry.rateLimit": "API 429 rate limit",
    "ui.retry.transient": "connection error",

    // Transcript viewer (P0-1)
    "ui.viewer.title": "Transcript — {n} lines (verbose)",
    "ui.viewer.titleStreaming": "Transcript — {n} lines (verbose) · still streaming",
    "ui.viewer.hint": "/ search · n/N matches · { } prompts · v editor · q/Esc close",
    "ui.viewer.searchPrompt": "search: {q}",
    "ui.viewer.matches": "{n} matches",
    "ui.viewer.editorFailed": "could not open the transcript in $VISUAL/$EDITOR — kept at {path}",

    // Rewind menu (P0-3)
    "ui.rewind.title": "Rewind to a previous message",
    "ui.rewind.hint": "↑↓ select · Enter rewind (restores files) · Esc cancel",
    "ui.rewind.armHint": "Esc again to open the rewind menu",
    "ui.rewind.draftCleared": "draft cleared — Esc again to rewind",

    // Image paste (P0-5)
    "ui.image.pasted": "attached {chip} — will be sent with your next message",
    "ui.image.none": "no image found in the clipboard",
    "ui.image.stale": "clipboard image arrived after the draft was sent — paste again to attach it",

    // Pickers
    "ui.picker.commands": "↑↓ move · Enter run · Esc cancel · Shift+Tab mode",
    "ui.picker.sessions": "↑↓ move · Enter resume · Esc cancel · Shift+Tab mode",
    "ui.picker.providers": "↑↓ move · Enter switch · Esc cancel · Shift+Tab mode",

    // Todos
    "ui.todo.moreAbove": "↑ {n} more",
    "ui.todo.moreBelow": "↓ {n} more",
  },
  "zh-CN": {
    // Permission errors
    "permission.denied": "权限被拒绝",
    "permission.requiresApproval": "此操作需要您的批准",
    "permission.planModeBlocked": "此操作在计划模式下不可用",

    // Tool errors
    "tool.notFound": "未找到工具：{name}",
    "tool.executionFailed": "工具执行失败：{error}",
    "tool.timeout": "工具超时，{seconds} 秒后",

    // File errors
    "file.notFound": "文件未找到：{path}",
    "file.accessDenied": "访问被拒绝：{path}",
    "file.outsideWorkspace": "访问被拒绝：{path} 超出工作区范围",
    "file.writeError": "写入文件错误：{path}",
    "file.readError": "读取文件错误：{path}",

    // Model errors
    "model.error": "模型错误：{message}",
    "model.contextTooLong": "上下文过长，正在压缩...",
    "model.rateLimit": "触发速率限制，等待 {seconds} 秒...",
    "model.authError": "认证错误，请检查您的 API 密钥。",

    // Session errors
    "session.saveError": "保存会话失败",
    "session.loadError": "加载会话失败",

    // General
    "error.unknown": "发生未知错误",
    "error.aborted": "操作已中止",
    "error.cancelled": "操作已取消",

    // --- UI chrome（P3-13：TUI 混杂文案的单一来源；英文对齐官方措辞） ---
    "ui.permission.yes": "允许",
    "ui.permission.always": "允许，本会话内不再询问",
    "ui.permission.no": "拒绝，并告诉 Claude 换个做法 (esc)",
    "ui.permission.alwaysBash": "允许，且此目录下的命令不再询问：{dir}",
    "ui.permission.alwaysEdits": "允许，本会话内的全部编辑不再询问",
    "ui.permission.yes.desc": "仅本次允许",
    "ui.permission.always.desc": "本会话内不再询问",
    "ui.permission.no.desc": "取消操作",
    "ui.permission.proceed": "是否执行此操作？",
    "ui.permission.chooseAction": "选择操作：",
    "ui.permission.hint": "↑↓ 选择 · Enter 确认 · Esc 取消",
    "ui.permission.title": "权限请求",
    "ui.permission.textHint": "输入 y 允许 / a 始终允许 / n 拒绝 (Esc 取消)",

    // 权限提示工具标签（行式文本回退路径）
    "ui.tool.bash": "Shell 命令",
    "ui.tool.write": "写入文件",
    "ui.tool.edit": "编辑文件",
    "ui.tool.read": "读取文件",
    "ui.tool.glob": "搜索文件",
    "ui.tool.grep": "搜索内容",
    "ui.tool.task": "子代理任务",
    "ui.tool.fallback": "{name} 操作",

    // 输入框底部提示行（对齐官方 PromptInputFooterLeftSide）
    "ui.footer.shortcuts": "? 查看快捷键",
    "ui.footer.interrupt": "esc 中断",
    "ui.footer.modeCycle": "（shift+tab 切换）",
    "ui.footer.untilAutoCompact": "距自动压缩还有 {pct}%",

    // 状态行动作词（statusLabel）
    "ui.phase.thinking": "思考中",
    "ui.phase.responding": "回复中",
    "ui.phase.runningTools": "正在运行 {n} 个工具",

    "ui.elide.above": "… 上文约 {n} 行已省略",
    "ui.elide.thinking": "… 思考前文约 {n} 行已省略",

    "ui.paste.note": "已粘贴 {n} 行 — 检查后 Enter 发送",
    "ui.file.hint": "Tab 插入 · Esc 关闭",
    "ui.suggest.moreAbove": "↑ 还有 {n} 条",
    "ui.suggest.moreBelow": "↓ 还有 {n} 条",
    "ui.input.queuedHint": "⏎ 排队下一条消息（当前回合结束后执行）",

    // 工具卡
    "ui.tool.expandHint": "（ctrl+o 展开）",
    "ui.tool.expandMore": "… +{n} 行（ctrl+o 展开）",
    "ui.tools.moreRunning": "… 还有 {n} 个工具运行中",

    // 选择器
    "ui.picker.commands": "↑↓ 移动 · Enter 运行 · Esc 取消 · Shift+Tab 切换模式",
    "ui.picker.sessions": "↑↓ 移动 · Enter 恢复 · Esc 取消 · Shift+Tab 切换模式",
    "ui.picker.providers": "↑↓ 移动 · Enter 切换 · Esc 取消 · Shift+Tab 切换模式",

    // 待办
    "ui.todo.moreAbove": "↑ 还有 {n} 项",
    "ui.todo.moreBelow": "↓ 还有 {n} 项",

    // 回合事件
    "ui.abort.user": "用户中断",
    "ui.queue.queued": "⏎ 已排队 — 当前回合结束后执行",
    "ui.queue.limitDropped": "⎿ 连续排队回合已达上限（{max}），丢弃 {n} 条排队输入",
    "ui.schedule.parked": "⏰ {label} —— 当前回合结束后送达",
    "ui.compact.started": "正在压缩上下文…",
    "ui.interrupted.hint": "已中断 · 接下来让 Claude 做什么？",

    "ui.ctx.warn": "上下文已用 {pct}% — 接近自动压缩阈值",
    "ui.ctx.critical": "上下文已用 {pct}% — 即将自动压缩",

    "ui.fs.scrolled": "↑ 正在查看历史 — Ctrl+End 或按 G 返回最新",

    // 折叠的思维块（P0-2）
    "ui.thinking.collapsed": "✻ 已思考 {s} 秒 · 共 {n} 行（Ctrl+O 展开）",
    // 无时长记录（如 /resume 回放的历史）
    "ui.thinking.noSecs": "✻ 思考内容 · 共 {n} 行（Ctrl+O 展开）",

    // 模型重试倒计时（P0-4）
    "ui.retry.status": "{reason} — {s} 秒后重试（第 {a}/{m} 次）",
    "ui.retry.now": "{reason} — 正在重试…（第 {a}/{m} 次）",
    "ui.retry.rateLimit": "API 429 限流",
    "ui.retry.transient": "连接错误",

    // 会话查看器（P0-1）
    "ui.viewer.title": "会话记录 — 共 {n} 行（完整模式）",
    "ui.viewer.titleStreaming": "会话记录 — 共 {n} 行（完整模式）· 仍在输出",
    "ui.viewer.hint": "/ 搜索 · n/N 匹配项 · { } 跳转提问 · v 编辑器 · q/Esc 关闭",
    "ui.viewer.searchPrompt": "搜索：{q}",
    "ui.viewer.matches": "{n} 处匹配",
    "ui.viewer.editorFailed": "无法在 $VISUAL/$EDITOR 中打开会话记录 — 已保留在 {path}",

    // 回退菜单（P0-3）
    "ui.rewind.title": "回退到之前的某条消息",
    "ui.rewind.hint": "↑↓ 选择 · Enter 回退（会还原文件）· Esc 取消",
    "ui.rewind.armHint": "再按一次 Esc 打开回退菜单",
    "ui.rewind.draftCleared": "已清空输入 — 再按 Esc 回退",

    // 图片粘贴（P0-5）
    "ui.image.pasted": "已附加 {chip} — 将随下一条消息发送",
    "ui.image.none": "剪贴板中没有图片",
    "ui.image.stale": "剪贴板图片在草稿发送后才读取完成 — 请重新粘贴",
  },
};

/**
 * Get a translated message by key.
 * Replaces {placeholder} with provided values.
 *
 * Reads the `currentLanguage` singleton (seeded from detectLanguage at import
 * time) — NOT the environment on every call. Otherwise setLanguage()/a /lang
 * command could never take effect, and a mid-process env change would silently
 * flip the UI language.
 */
export function t(key: string, values?: Record<string, string | number>): string {
  const lang = currentLanguage;
  let message = translations[lang][key] || translations.en[key] || key;

  if (values) {
    for (const [k, v] of Object.entries(values)) {
      message = message.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }

  return message;
}

/**
 * Format an error for user display.
 * Ensures all user-facing errors use consistent language.
 */
export function formatError(error: unknown): string {
  if (error instanceof Error) {
    // Translate known error patterns
    const msg = error.message.toLowerCase();

    if (msg.includes("permission") || msg.includes("denied")) {
      return t("permission.denied");
    }

    if (msg.includes("not found")) {
      return t("error.unknown");
    }

    if (msg.includes("context_length") || msg.includes("too long")) {
      return t("model.contextTooLong");
    }

    if (msg.includes("429") || msg.includes("rate limit")) {
      return t("model.rateLimit", { seconds: 5 });
    }

    if (msg.includes("401") || msg.includes("403") || msg.includes("auth")) {
      return t("model.authError");
    }

    if (msg.includes("aborted") || msg.includes("cancel")) {
      return t("error.aborted");
    }

    // Generic error: show message but not technical details
    return t("model.error", { message: error.message.slice(0, 100) });
  }

  return t("error.unknown");
}

// Singleton for consistent language across the app
let currentLanguage: Language = detectLanguage();

export function setLanguage(lang: Language): void {
  currentLanguage = lang;
}

export function getLanguage(): Language {
  return currentLanguage;
}
