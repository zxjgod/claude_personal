import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addMarketplaceFromUrl,
  checkPluginDependencies,
  extractZip,
  findMarketplacePlugin,
  installPlugin,
  installRemotePlugin,
  listPlugins,
  pluginRoot,
  readMarketplace,
  setPluginDisabled,
  validatePluginManifest,
} from "../plugins.js";

// Namespace exports cannot be spied on in ESM. Wrap only the two filesystem
// operations that need deterministic fault injection; every other fs API stays
// real, and the original implementations are restored after each test.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: actual,
    cpSync: vi.fn(actual.cpSync),
    renameSync: vi.fn(actual.renameSync),
    rmSync: vi.fn(actual.rmSync),
  };
});
const originalFs = await vi.importActual<typeof import("node:fs")>("node:fs");
const temporaryDirs: string[] = [];

function temporaryDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirs.push(dir);
  return dir;
}

function writePlugin(
  dir: string,
  name: string,
  version: string,
  files: Record<string, string> = {},
): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ name, version }));
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(dir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

afterEach(() => {
  vi.mocked(fs.cpSync).mockReset().mockImplementation(originalFs.cpSync);
  vi.mocked(fs.renameSync).mockReset().mockImplementation(originalFs.renameSync);
  vi.mocked(fs.rmSync).mockReset().mockImplementation(originalFs.rmSync);
  for (const dir of temporaryDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("workspace plugins", () => {
  it("validates manifests", () => {
    expect(validatePluginManifest({ name: "demo", version: "1.2.3" }).name).toBe("demo");
    expect(() => validatePluginManifest({ name: "bad/name", version: "1.0.0" })).toThrow();
    expect(() => validatePluginManifest({ name: "demo", version: "1" })).toThrow();
    // Dot segments are not "absolute" to path.isAbsolute but must still be
    // rejected — a manifest using ../ could stage files outside the plugin dir.
    expect(() =>
      validatePluginManifest({ name: "demo", version: "1.0.0", skills: "../escape.md" }),
    ).toThrow();
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
  it("setPluginDisabled rejects path-traversal names (review fix)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-plugin-ws-"));
    // The name becomes a path component under .claude/plugins — without the
    // validName floor "../x" would write plugin.json outside the root.
    expect(() => setPluginDisabled(root, "../escape", true)).toThrow(/Invalid plugin name/);
    expect(() => setPluginDisabled(root, "a/b", true)).toThrow(/Invalid plugin name/);
  });
});

describe("transactional plugin installation", () => {
  it("stages a complete upgrade beside the target and removes stale components", () => {
    const root = temporaryDir("ccr-plugin-upgrade-ws-");
    const oldSource = temporaryDir("ccr-plugin-upgrade-old-");
    const newSource = temporaryDir("ccr-plugin-upgrade-new-");
    writePlugin(oldSource, "demo", "1.0.0", {
      "skills/old.md": "old skill",
      "obsolete/root.txt": "remove me",
    });
    writePlugin(newSource, "demo", "2.0.0", { "skills/new.md": "new skill" });
    installPlugin(root, oldSource);
    const copyMock = vi.mocked(fs.cpSync);
    copyMock.mockClear();

    installPlugin(root, newSource);

    const target = path.join(pluginRoot(root), "demo");
    expect(listPlugins(root)[0]?.version).toBe("2.0.0");
    expect(fs.readFileSync(path.join(target, "skills", "new.md"), "utf8")).toBe("new skill");
    expect(fs.existsSync(path.join(target, "skills", "old.md"))).toBe(false);
    expect(fs.existsSync(path.join(target, "obsolete"))).toBe(false);
    expect(fs.readdirSync(pluginRoot(root))).toEqual(["demo"]);
    expect(copyMock).toHaveBeenCalledTimes(1);
    const staging = String(copyMock.mock.calls[0]?.[1]);
    expect(path.dirname(staging)).toBe(pluginRoot(root));
    expect(path.basename(staging)).toMatch(/^\.demo\.staging-/);
    expect(staging).not.toBe(target);
  });

  it("preserves the old installation and cleans staging when copying fails", () => {
    const root = temporaryDir("ccr-plugin-copy-ws-");
    const oldSource = temporaryDir("ccr-plugin-copy-old-");
    const newSource = temporaryDir("ccr-plugin-copy-new-");
    writePlugin(oldSource, "demo", "1.0.0", { "skills/old.md": "old skill" });
    writePlugin(newSource, "demo", "2.0.0", { "skills/new.md": "new skill" });
    installPlugin(root, oldSource);
    vi.mocked(fs.cpSync).mockImplementationOnce(() => {
      throw new Error("injected copy failure");
    });

    expect(() => installPlugin(root, newSource)).toThrow("injected copy failure");

    const target = path.join(pluginRoot(root), "demo");
    expect(listPlugins(root)[0]?.version).toBe("1.0.0");
    expect(fs.readFileSync(path.join(target, "skills", "old.md"), "utf8")).toBe("old skill");
    expect(fs.existsSync(path.join(target, "skills", "new.md"))).toBe(false);
    expect(fs.readdirSync(pluginRoot(root))).toEqual(["demo"]);
  });

  it("keeps the old installation in place when moving it to backup fails", () => {
    const root = temporaryDir("ccr-plugin-backup-ws-");
    const oldSource = temporaryDir("ccr-plugin-backup-old-");
    const newSource = temporaryDir("ccr-plugin-backup-new-");
    writePlugin(oldSource, "demo", "1.0.0", { "skills/old.md": "old skill" });
    writePlugin(newSource, "demo", "2.0.0", { "skills/new.md": "new skill" });
    installPlugin(root, oldSource);
    const renameMock = vi.mocked(fs.renameSync);
    renameMock.mockClear();
    renameMock.mockImplementationOnce(() => {
      throw new Error("injected backup failure");
    });

    expect(() => installPlugin(root, newSource)).toThrow("injected backup failure");

    const target = path.join(pluginRoot(root), "demo");
    expect(listPlugins(root)[0]?.version).toBe("1.0.0");
    expect(fs.readFileSync(path.join(target, "skills", "old.md"), "utf8")).toBe("old skill");
    expect(fs.existsSync(path.join(target, "skills", "new.md"))).toBe(false);
    expect(fs.readdirSync(pluginRoot(root))).toEqual(["demo"]);
    expect(renameMock).toHaveBeenCalledTimes(1);
  });

  it("restores the old installation when activating the staged replacement fails", () => {
    const root = temporaryDir("ccr-plugin-activate-ws-");
    const oldSource = temporaryDir("ccr-plugin-activate-old-");
    const newSource = temporaryDir("ccr-plugin-activate-new-");
    writePlugin(oldSource, "demo", "1.0.0", { "skills/old.md": "old skill" });
    writePlugin(newSource, "demo", "2.0.0", { "skills/new.md": "new skill" });
    installPlugin(root, oldSource);
    const renameMock = vi.mocked(fs.renameSync);
    renameMock.mockClear();
    renameMock.mockImplementationOnce(originalFs.renameSync).mockImplementationOnce(() => {
      throw new Error("injected activation failure");
    });

    expect(() => installPlugin(root, newSource)).toThrow("injected activation failure");

    const target = path.join(pluginRoot(root), "demo");
    expect(listPlugins(root)[0]?.version).toBe("1.0.0");
    expect(fs.readFileSync(path.join(target, "skills", "old.md"), "utf8")).toBe("old skill");
    expect(fs.existsSync(path.join(target, "skills", "new.md"))).toBe(false);
    expect(fs.readdirSync(pluginRoot(root))).toEqual(["demo"]);
    // target -> unique backup, failed staging -> target, then backup -> target.
    expect(renameMock).toHaveBeenCalledTimes(3);
  });

  it("keeps cleanup failures from replacing installation outcomes", () => {
    const root = temporaryDir("ccr-plugin-cleanup-ws-");
    const oldSource = temporaryDir("ccr-plugin-cleanup-old-");
    const newSource = temporaryDir("ccr-plugin-cleanup-new-");
    writePlugin(oldSource, "demo", "1.0.0");
    writePlugin(newSource, "demo", "2.0.0");
    installPlugin(root, oldSource);

    vi.mocked(fs.cpSync).mockImplementationOnce(() => {
      throw new Error("injected copy failure");
    });
    vi.mocked(fs.rmSync).mockImplementationOnce(() => {
      throw new Error("injected cleanup failure");
    });
    expect(() => installPlugin(root, newSource)).toThrow("injected copy failure");
    expect(listPlugins(root)[0]?.version).toBe("1.0.0");

    vi.mocked(fs.rmSync).mockImplementationOnce(() => {
      throw new Error("injected cleanup failure");
    });
    expect(() => installPlugin(root, newSource)).not.toThrow();
    expect(listPlugins(root)).toHaveLength(1);
    expect(listPlugins(root)[0]?.version).toBe("2.0.0");
  });

  it("hides transaction artifacts and refuses recursively copying the install root", () => {
    const root = temporaryDir("ccr-plugin-artifacts-ws-");
    const plugins = pluginRoot(root);
    writePlugin(path.join(plugins, "demo"), "demo", "1.0.0");
    writePlugin(path.join(plugins, ".demo.staging-crashed"), "demo", "9.0.0");
    writePlugin(path.join(plugins, ".demo.staging-crashed.backup"), "demo", "0.9.0");

    expect(listPlugins(root).map((plugin) => plugin.name)).toEqual(["demo"]);
    writePlugin(root, "demo", "1.0.0");
    expect(() => installPlugin(root, root)).toThrow(/source contains the installation root/);
    expect(listPlugins(root)[0]?.version).toBe("1.0.0");
  });
});

// ============================================================
// ZIP round-trip: a hand-built archive (stored + deflated entries) is
// the format installRemotePlugin consumes; the reader must extract it
// faithfully and refuse zip-slip.
// ============================================================

function crc32(buf: Buffer): number {
  let table: Int32Array | undefined;
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = -1;
  for (const b of buf) c = (c >>> 8) ^ table![(c ^ b) & 0xff];
  return (c ^ -1) >>> 0;
}

function buildZip(entries: Array<{ name: string; data: Buffer; deflate?: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const method = e.deflate ? 8 : 0;
    const payload = e.deflate ? zlib.deflateRawSync(e.data) : e.data;
    const name = Buffer.from(e.name, "utf8");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc32(e.data), 14);
    lh.writeUInt32LE(payload.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, payload);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc32(e.data), 16);
    ch.writeUInt32LE(payload.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + payload.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

describe("zip extraction", () => {
  it("extracts stored and deflated entries, nested paths included", () => {
    const zip = buildZip([
      { name: "plugin.json", data: Buffer.from('{"name":"z","version":"1.0.0"}'), deflate: true },
      { name: "skills/demo.md", data: Buffer.from("# skill body") },
    ]);
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-zip-"));
    extractZip(zip, dest);
    expect(JSON.parse(fs.readFileSync(path.join(dest, "plugin.json"), "utf8")).name).toBe("z");
    expect(fs.readFileSync(path.join(dest, "skills", "demo.md"), "utf8")).toBe("# skill body");
  });

  it("refuses entries that escape the destination (zip-slip)", () => {
    const zip = buildZip([{ name: "../evil.txt", data: Buffer.from("nope") }]);
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-zip-slip-"));
    expect(() => extractZip(zip, dest)).toThrow(/escapes/);
  });

  it("refuses entries declaring an oversized uncompressed size (bomb floor)", () => {
    const zip = buildZip([{ name: "plugin.json", data: Buffer.from("{}") }]);
    // Corrupt the central directory's uncompressed-size field (signature
    // 0x02014b50 → size at +24) to claim 100MB. The extractor must reject on
    // the DECLARED size before touching the data; inflateRawSync's
    // maxOutputLength catches headers that lie downward instead.
    const cd = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(cd).toBeGreaterThan(0);
    zip.writeUInt32LE(100 * 1024 * 1024, cd + 24);
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-zip-cap-"));
    expect(() => extractZip(zip, dest)).toThrow(/cap/);
  });

  it("refuses an archive whose entries total past the whole-archive budget", () => {
    // 27 deflated 10MB zero blocks = 270MB of small per-entry payloads —
    // every entry individually passes the 64MB cap, only the running total
    // catches it. (Deflate turns each 10MB block into ~10KB on disk.)
    const zeros = Buffer.alloc(10 * 1024 * 1024);
    const zip = buildZip(
      Array.from({ length: 27 }, (_, i) => ({ name: `block${i}.bin`, data: zeros, deflate: true })),
    );
    expect(zip.length).toBeLessThan(2 * 1024 * 1024); // compressed, or the fixture itself is the bomb
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-zip-total-"));
    try {
      expect(() => extractZip(zip, dest)).toThrow(/total budget/);
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });

  it("refuses an archive declaring an absurd entry count", () => {
    const zip = buildZip([{ name: "plugin.json", data: Buffer.from("{}") }]);
    // EOCD is the trailing 22 bytes; its entry count sits at +10.
    zip.writeUInt16LE(20_001, zip.length - 22 + 10);
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-zip-count-"));
    expect(() => extractZip(zip, dest)).toThrow(/declares/);
  });
});

// ============================================================
// Remote install & marketplace, against a real local HTTP server.
// ============================================================

async function serve(
  routes: Record<string, { type: string; body: Buffer | string }>,
): Promise<{ url: (p: string) => string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const route = routes[new URL(req.url ?? "/", "http://local").pathname];
    if (!route) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader("content-type", route.type);
    res.end(Buffer.isBuffer(route.body) ? route.body : Buffer.from(route.body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: (p) => `http://127.0.0.1:${port}${p}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe("remote plugin install", () => {
  it("installs a zip archive — components included, not just the manifest", async () => {
    const zip = buildZip([
      {
        name: "packaged/plugin.json",
        data: Buffer.from(JSON.stringify({ name: "packaged", version: "1.0.0", skills: "skills" })),
        deflate: true,
      },
      { name: "packaged/skills/demo.md", data: Buffer.from("# real content") },
    ]);
    const srv = await serve({ "/pkg.zip": { type: "application/zip", body: zip } });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-plugin-remote-"));
    try {
      const manifest = await installRemotePlugin(root, srv.url("/pkg.zip"));
      expect(manifest.name).toBe("packaged");
      expect(
        fs.readFileSync(
          path.join(root, ".claude", "plugins", "packaged", "skills", "demo.md"),
          "utf8",
        ),
      ).toBe("# real content");
    } finally {
      await srv.close();
    }
  });

  it("fetches declared components for a bare plugin.json URL", async () => {
    const srv = await serve({
      "/plugin.json": {
        type: "application/json",
        body: JSON.stringify({ name: "flat", version: "1.0.0", skills: "skills.md" }),
      },
      "/skills.md": { type: "text/markdown", body: "# flat skill" },
    });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-plugin-flat-"));
    try {
      await installRemotePlugin(root, srv.url("/plugin.json"));
      expect(
        fs.readFileSync(path.join(root, ".claude", "plugins", "flat", "skills.md"), "utf8"),
      ).toBe("# flat skill");
    } finally {
      await srv.close();
    }
  });

  it("refuses an oversized marketplace index instead of buffering it (round 3)", async () => {
    const srv = await serve({
      // 3MB > the 2MB marketplace cap. A bare fetch + response.json() used to
      // buffer this (and anything larger) with no limit.
      "/big.json": {
        type: "application/json",
        body: JSON.stringify({ plugins: [], pad: "x".repeat(3 * 1024 * 1024) }),
      },
    });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-plugin-mkt-big-"));
    try {
      await expect(addMarketplaceFromUrl(root, srv.url("/big.json"))).rejects.toThrow(
        /declares|exceeds/,
      );
      expect(readMarketplace(root).plugins).toHaveLength(0);
    } finally {
      await srv.close();
    }
  }, 30_000);

  it("skips an oversized declared component but still installs the manifest", async () => {
    const srv = await serve({
      "/plugin.json": {
        type: "application/json",
        body: JSON.stringify({ name: "fat", version: "1.0.0", skills: "skills.md" }),
      },
      // 9MB > the 8MB per-component cap.
      "/skills.md": { type: "text/markdown", body: "x".repeat(9 * 1024 * 1024) },
    });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-plugin-fat-"));
    try {
      const manifest = await installRemotePlugin(root, srv.url("/plugin.json"));
      expect(manifest.name).toBe("fat");
      // The oversized component is dropped (best-effort fetch), not written.
      expect(fs.existsSync(path.join(root, ".claude", "plugins", "fat", "skills.md"))).toBe(false);
    } finally {
      await srv.close();
    }
  }, 30_000);

  it("addMarketplaceFromUrl persists the index; lookup resolves install sources", async () => {
    const srv = await serve({
      "/marketplace.json": {
        type: "application/json",
        body: JSON.stringify({
          plugins: [
            { name: "listed", version: "2.0.0", source: "http://127.0.0.1:1/nope.zip" },
            { name: "bad name!", version: "1", source: "x" }, // invalid — dropped
          ],
        }),
      },
    });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-plugin-mkt-"));
    try {
      const added = await addMarketplaceFromUrl(root, srv.url("/marketplace.json"));
      expect(added.plugins).toHaveLength(1);
      expect(readMarketplace(root).plugins[0]?.source).toBe("http://127.0.0.1:1/nope.zip");
      expect(findMarketplacePlugin(root, "listed")?.version).toBe("2.0.0");
      expect(findMarketplacePlugin(root, "ghost")).toBeUndefined();
    } finally {
      await srv.close();
    }
  });
});
