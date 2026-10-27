import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { pluginCommand } from "../commands/plugin.js";
import type { CommandContext } from "../commands/types.js";
import { listPlugins, pluginRoot } from "../plugins.js";

describe("/plugin install argument parsing", () => {
  it("passes the complete local path containing spaces to the installer", async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-plugin-command-"));
    const workspaceRoot = path.join(fixture, "workspace with spaces");
    const source = path.join(fixture, "local plugin source with spaces");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(
      path.join(source, "plugin.json"),
      JSON.stringify({ name: "spaced", version: "1.0.0" }),
    );
    fs.mkdirSync(path.join(source, "skills"));
    fs.writeFileSync(path.join(source, "skills", "demo.md"), "spaced path skill");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await pluginCommand.run(`install   ${source}   `, { workspaceRoot } as CommandContext);

      expect(listPlugins(workspaceRoot)[0]?.name).toBe("spaced");
      expect(
        fs.readFileSync(
          path.join(pluginRoot(workspaceRoot), "spaced", "skills", "demo.md"),
          "utf8",
        ),
      ).toBe("spaced path skill");
      expect(log).toHaveBeenCalledWith(expect.stringContaining("Installed plugin spaced@1.0.0."));
    } finally {
      log.mockRestore();
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("resolves a quoted relative path against the active workspace", async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-plugin-relative-"));
    const workspaceRoot = path.join(fixture, "workspace");
    const otherCwd = path.join(fixture, "other-cwd");
    const source = path.join(workspaceRoot, "relative plugin");
    const originalCwd = process.cwd();
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(otherCwd, { recursive: true });
    fs.writeFileSync(
      path.join(source, "plugin.json"),
      JSON.stringify({ name: "relative", version: "1.0.0" }),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      process.chdir(otherCwd);
      await pluginCommand.run('install "relative plugin"', { workspaceRoot } as CommandContext);
      expect(listPlugins(workspaceRoot)[0]?.name).toBe("relative");
    } finally {
      process.chdir(originalCwd);
      log.mockRestore();
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
});
