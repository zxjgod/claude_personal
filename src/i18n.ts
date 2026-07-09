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

// Detect language from environment or CLI flag
export function detectLanguage(): Language {
  // Check environment variable
  const envLang = process.env.CCR_LANGUAGE;
  if (envLang === "zh-CN" || envLang === "zh") return "zh-CN";
  if (envLang === "en") return "en";

  // Check locale
  const locale = process.env.LANG || process.env.LC_ALL || "";
  if (locale.startsWith("zh")) return "zh-CN";

  // Default to English
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
  },
};

/**
 * Get a translated message by key.
 * Replaces {placeholder} with provided values.
 */
export function t(key: string, values?: Record<string, string | number>): string {
  const lang = detectLanguage();
  let message = translations[lang][key] || translations["en"][key] || key;

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
