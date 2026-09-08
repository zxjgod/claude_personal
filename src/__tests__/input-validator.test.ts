// ============================================================
// Error Scenario Tests - Input Validation
// ============================================================

import { describe, expect, it } from "vitest";
import { InputValidator } from "../utils/input-validator.js";

describe("InputValidator", () => {
  describe("validateFilePath", () => {
    it("should reject paths exceeding maximum length", () => {
      const longPath = "a".repeat(5000);
      const result = InputValidator.validateFilePath(longPath);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("exceeds maximum length");
    });

    it("should reject paths with null bytes", () => {
      const result = InputValidator.validateFilePath("/path\x00/file.txt");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("illegal control characters");
    });

    // Path traversal is NOT checked by InputValidator — it's correctly handled
    // by resolveInWorkspace() which resolves the path and verifies containment.
    it("should accept paths with path traversal (checked by resolveInWorkspace)", () => {
      const result = InputValidator.validateFilePath("../../etc/passwd");
      expect(result.valid).toBe(true);
    });

    it("should reject UNC paths", () => {
      const result = InputValidator.validateFilePath("\\\\server\\share");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("dangerous pattern");
    });

    it("should accept valid paths", () => {
      const result = InputValidator.validateFilePath("/workspace/file.txt");
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });

  describe("validateCommand", () => {
    it("should reject commands exceeding maximum length", () => {
      const longCommand = "echo " + "a".repeat(100001);
      const result = InputValidator.validateCommand(longCommand);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("exceeds maximum length");
    });

    it("should reject fork bomb", () => {
      const result = InputValidator.validateCommand(":(){ :|:& };:");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("fork bomb");
    });

    it("should reject device writes", () => {
      const result = InputValidator.validateCommand("echo test > /dev/sda");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("device write");
    });

    it("should reject dd to device", () => {
      const result = InputValidator.validateCommand("dd if=/dev/zero of=/dev/sda");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("dd to device");
    });

    it("should reject recursive delete of root", () => {
      const result = InputValidator.validateCommand("rm -rf /");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("recursive delete");
    });

    it("should reject recursive delete of root via long options", () => {
      for (const cmd of [
        "rm --recursive /",
        "rm --recursive --force /",
        "rm --force --recursive /*",
        "rm -R /",
      ]) {
        const result = InputValidator.validateCommand(cmd);
        expect(result.valid, cmd).toBe(false);
        expect(result.error).toContain("recursive delete");
      }
    });

    it("should not flag recursive deletes of ordinary paths", () => {
      for (const cmd of ["rm -r build/", "rm --recursive tmp/cache", "rm -rf /tmp/x"]) {
        expect(InputValidator.validateCommand(cmd).valid, cmd).toBe(true);
      }
    });

    it("should reject mkfs", () => {
      const result = InputValidator.validateCommand("mkfs.ext4 /dev/sda1");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("filesystem format");
    });

    it("should accept safe commands", () => {
      const result = InputValidator.validateCommand("ls -la");
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });

  describe("validateUrl", () => {
    it("should reject URLs exceeding maximum length", () => {
      const longUrl = "http://example.com/" + "a".repeat(8200);
      const result = InputValidator.validateUrl(longUrl);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("exceeds maximum length");
    });

    it("should reject file:// protocol", () => {
      const result = InputValidator.validateUrl("file:///etc/passwd");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("not allowed");
    });

    it("should reject javascript: protocol", () => {
      const result = InputValidator.validateUrl("javascript:alert(1)");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("not allowed");
    });

    it("should reject localhost", () => {
      const result = InputValidator.validateUrl("http://localhost:8080");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("private networks");
    });

    it("should reject 127.0.0.1", () => {
      const result = InputValidator.validateUrl("http://127.0.0.1");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("private networks");
    });

    it("should reject private IP (10.x.x.x)", () => {
      const result = InputValidator.validateUrl("http://10.0.0.1");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("private networks");
    });

    it("should reject private IP (192.168.x.x)", () => {
      const result = InputValidator.validateUrl("http://192.168.1.1");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("private networks");
    });

    it("should reject invalid URL format", () => {
      const result = InputValidator.validateUrl("not-a-url");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid URL");
    });

    it("should accept valid public URLs", () => {
      const result = InputValidator.validateUrl("https://example.com");
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });

  describe("validateContentLength", () => {
    it("should reject content exceeding max length", () => {
      const result = InputValidator.validateContentLength("test", 2);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("exceeds maximum length");
    });

    it("should accept content within limit", () => {
      const result = InputValidator.validateContentLength("test", 10);
      expect(result.valid).toBe(true);
    });
  });

  describe("validateNumericRange", () => {
    it("should reject non-finite numbers", () => {
      const result = InputValidator.validateNumericRange(Infinity, 0, 100);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("finite number");
    });

    it("should reject values below minimum", () => {
      const result = InputValidator.validateNumericRange(-5, 0, 100);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("between 0 and 100");
    });

    it("should reject values above maximum", () => {
      const result = InputValidator.validateNumericRange(150, 0, 100);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("between 0 and 100");
    });

    it("should accept values within range", () => {
      const result = InputValidator.validateNumericRange(50, 0, 100);
      expect(result.valid).toBe(true);
    });
  });
});
