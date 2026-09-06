// ============================================================
// i18n Tests
// ============================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectLanguage, formatError, getLanguage, setLanguage, t } from "../tui/i18n.js";

describe("i18n", () => {
  describe("detectLanguage", () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it("should detect Chinese from CCR_LANGUAGE env", () => {
      process.env.CCR_LANGUAGE = "zh-CN";
      expect(detectLanguage()).toBe("zh-CN");
    });

    it("should detect English from CCR_LANGUAGE env", () => {
      process.env.CCR_LANGUAGE = "en";
      expect(detectLanguage()).toBe("en");
    });

    it("ignores ambient LANG (official-alignment: English is the default)", () => {
      process.env.LANG = "zh_CN.UTF-8";
      expect(detectLanguage()).toBe("en");
    });

    it("opts into Chinese only via CCR_LANGUAGE", () => {
      process.env.LANG = "zh_CN.UTF-8";
      process.env.CCR_LANGUAGE = "zh-CN";
      expect(detectLanguage()).toBe("zh-CN");
    });

    it("should default to English for unknown locales", () => {
      process.env.LANG = "en_US.UTF-8";
      expect(detectLanguage()).toBe("en");
    });
  });

  describe("t()", () => {
    beforeEach(() => {
      setLanguage("en");
    });

    it("should translate known keys", () => {
      expect(t("permission.denied")).toBe("Permission denied");
      expect(t("tool.notFound", { name: "bash" })).toBe("Tool not found: bash");
    });

    it("respects setLanguage for known keys (single source drives the UI)", () => {
      // Regression: t() used to re-read the ENVIRONMENT on every call, so
      // setLanguage() could never switch the UI language at runtime.
      setLanguage("zh-CN");
      expect(t("permission.denied")).toBe("权限被拒绝");
      setLanguage("en");
      expect(t("permission.denied")).toBe("Permission denied");
    });

    it("serves the UI chrome keys in both languages (P3-13)", () => {
      setLanguage("en");
      expect(t("ui.permission.yes")).toBe("Yes");
      expect(t("ui.permission.always")).toBe("Yes, and don't ask again this session");
      expect(t("ui.footer.interrupt")).toBe("esc to interrupt");
      expect(t("ui.elide.above", { n: 12 })).toContain("12");
      expect(t("ui.paste.note", { n: 7 })).toContain("7");
      expect(t("ui.tool.write")).toBe("Write file");
      expect(t("ui.tool.fallback", { name: "Webfetch" })).toBe("Webfetch operation");

      setLanguage("zh-CN");
      expect(t("ui.permission.yes")).toBe("允许");
      expect(t("ui.permission.always")).toBe("允许，本会话内不再询问");
      expect(t("ui.elide.above", { n: 12 })).toContain("12");
      expect(t("ui.paste.note", { n: 7 })).toContain("7");
      expect(t("ui.tool.write")).toBe("写入文件");
      expect(t("ui.tool.fallback", { name: "Webfetch" })).toBe("Webfetch 操作");
    });

    it("should replace placeholders", () => {
      expect(t("tool.timeout", { seconds: "30" })).toBe("Tool timed out after 30 seconds");
      expect(t("file.notFound", { path: "/etc/passwd" })).toBe("File not found: /etc/passwd");
    });

    it("should fall back to key for unknown keys", () => {
      expect(t("unknown.key")).toBe("unknown.key");
    });

    it("should fall back to English for unknown keys in Chinese mode", () => {
      setLanguage("zh-CN");
      expect(t("unknown.key")).toBe("unknown.key");
    });
  });

  describe("formatError()", () => {
    beforeEach(() => {
      setLanguage("en");
    });

    it("should format permission errors", () => {
      const error = new Error("Permission denied");
      expect(formatError(error)).toBe("Permission denied");
    });

    it("should format context length errors", () => {
      const error = new Error("context_length exceeded");
      expect(formatError(error)).toBe("Context too long, compressing...");
    });

    it("should format rate limit errors", () => {
      const error = new Error("429 rate limit exceeded");
      expect(formatError(error)).toBe("Rate limit hit, waiting 5s...");
    });

    it("should format auth errors", () => {
      const error = new Error("401 Unauthorized");
      expect(formatError(error)).toBe("Authentication error. Please check your API key.");
    });

    it("should format abort errors", () => {
      const error = new Error("Operation aborted");
      expect(formatError(error)).toBe("Operation aborted");
    });

    it("should handle non-Error values", () => {
      expect(formatError("string error")).toBe("An unknown error occurred");
      expect(formatError(null)).toBe("An unknown error occurred");
      expect(formatError(undefined)).toBe("An unknown error occurred");
      expect(formatError(123)).toBe("An unknown error occurred");
    });

    it("should truncate long error messages", () => {
      const longMessage = "a".repeat(200);
      const error = new Error(longMessage);
      const formatted = formatError(error);
      expect(formatted).toContain("Model error:");
      expect(formatted.length).toBeLessThan(150);
    });
  });

  describe("setLanguage / getLanguage", () => {
    it("should set and get language", () => {
      setLanguage("zh-CN");
      expect(getLanguage()).toBe("zh-CN");

      setLanguage("en");
      expect(getLanguage()).toBe("en");
    });
  });
});
