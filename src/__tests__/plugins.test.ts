import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkPluginDependencies,
  installPlugin,
  listPlugins,
  setPluginDisabled,
  validatePluginManifest,
} from "../plugins.js";

describe("workspace plugins", () => {
  it("validates manifests", () => {
    expect(validatePluginManifest({ name: "demo", version: "1.2.3" }).name).toBe("demo");
    expect(() => validatePluginManifest({ name: "bad/name", version: "1.0.0" })).toThrow();
    expect(() => validatePluginManifest({ name: "demo", version: "1" })).toThrow();
  });
  it("installs, disables, and checks dependencies", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-plugin-ws-"));
    const source = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-plugin-src-"));
    fs.writeFileSync(
      path.join(source, "plugin.json"),
      JSON.stringify({ name: "demo", version: "1.0.0", dependencies: { missing: "1.x.x" } }),
    );
    installPlugin(root, source);
    expect(listPlugins(root)).toHaveLength(1);
    expect(checkPluginDependencies(root)).toHaveLength(1);
    setPluginDisabled(root, "demo", true);
    expect(listPlugins(root)[0]?.disabled).toBe(true);
  });
});
