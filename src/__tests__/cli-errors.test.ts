// ============================================================
// Tests: CLI error formatting
// ============================================================

import { describe, it, expect } from "vitest";
import { formatCliError } from "../cli-errors.js";

describe("formatCliError", () => {
  it("formats auth/provider permission errors as an action item", () => {
    const err = {
      status: 403,
      headers: { noisy: "header" },
      error: { error: { type: "forbidden", message: "Request not allowed" } },
    };
    const out = formatCliError(err);
    expect(out).toContain("Authentication/permission error (403)");
    expect(out).toContain("Check LLM_API_KEY");
    expect(out).toContain("Request not allowed");
    expect(out).not.toContain("headers");
  });

  it("formats rate limit errors", () => {
    expect(formatCliError({ status: 429, message: "Too many requests" })).toContain(
      "Rate limit error",
    );
  });

  it("formats context/token limit errors", () => {
    expect(
      formatCliError({ status: 400, message: "maximum context length exceeded" }),
    ).toContain("Context/token limit");
  });

  it("formats server errors", () => {
    expect(formatCliError({ status: 500, message: "oops" })).toContain(
      "Provider server error",
    );
  });

  it("falls back to Error.message", () => {
    expect(formatCliError(new Error("boom"))).toBe("boom");
  });
});
