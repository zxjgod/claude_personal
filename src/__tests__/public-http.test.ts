import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("node:http", () => ({ request: mocks.request }));
vi.mock("node:https", () => ({ request: mocks.request }));

import { WebFetchTool } from "../tools/extended/web-fetch.js";
import { publicHttpGet } from "../tools/utils/public-http.js";

function respond(body = "ok", statusCode = 200, headers = { "content-type": "text/plain" }) {
  mocks.request.mockImplementationOnce((_options, callback) => {
    const request = new EventEmitter() as EventEmitter & { end(): void };
    request.end = () => {
      const response = Object.assign(new PassThrough(), {
        statusCode,
        statusMessage: "OK",
        headers,
      });
      callback(response);
      response.end(body);
    };
    return request;
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.lookup.mockResolvedValue([{ address: "93.184.215.14", family: 4 }]);
});

describe("public HTTP address pinning", () => {
  it.each([
    "http://localhost./",
    "http://127.0.0.1/",
    "http://[::1]/",
    "gopher://example.com/",
  ])("rejects literal private hosts and unsupported protocols: %s", async (url) => {
    await expect(publicHttpGet(url, {}, new AbortController().signal, 100)).rejects.toThrow();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it.each([
    "10.0.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "::1",
    "::ffff:7f00:1",
    "fd00::1",
  ])("rejects all DNS answers when any resolves to %s", async (address) => {
    mocks.lookup.mockResolvedValue([
      { address: "93.184.215.14", family: 4 },
      { address, family: address.includes(":") ? 6 : 4 },
    ]);
    await expect(
      publicHttpGet("https://public.example/", {}, new AbortController().signal, 100),
    ).rejects.toThrow(/private/);
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("pins the socket IP and preserves TLS SNI and Host without a second DNS lookup", async () => {
    respond();
    const response = await publicHttpGet(
      "https://public.example:8443/a?q=1",
      {},
      new AbortController().signal,
      100,
    );
    expect(await response.text()).toBe("ok");
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
    expect(mocks.request.mock.calls[0][0]).toMatchObject({
      hostname: "93.184.215.14",
      family: 4,
      servername: "public.example",
      port: "8443",
      path: "/a?q=1",
      headers: { Host: "public.example:8443" },
      agent: false,
    });
  });

  it("revalidates DNS on redirected URLs before opening a second connection", async () => {
    respond("", 302, {
      "content-type": "text/plain",
      location: "https://other.example/private",
    } as any);
    mocks.lookup
      .mockResolvedValueOnce([{ address: "93.184.215.14", family: 4 }])
      .mockResolvedValueOnce([{ address: "10.0.0.1", family: 4 }]);
    const result = await WebFetchTool.call(
      { url: "https://public.example", fetchInfo: "probe" },
      {
        workspaceRoot: process.cwd(),
        sessionId: "network-test",
        permissionMode: "default",
      },
    );
    expect(result.error).toContain("private");
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it("caps the downloaded body", async () => {
    respond("too many bytes");
    await expect(
      publicHttpGet("https://public.example", {}, new AbortController().signal, 3),
    ).rejects.toThrow(/maximum size/);
  });

  it("rejects when the connection closes mid-body without an end event", async () => {
    mocks.request.mockImplementationOnce((_options, callback) => {
      const request = new EventEmitter() as EventEmitter & { end(): void };
      request.end = () => {
        const response = Object.assign(new PassThrough(), {
          statusCode: 200,
          statusMessage: "OK",
          headers: { "content-type": "text/plain" },
        });
        callback(response);
        response.write("partial");
        response.destroy(); // close without end/error — the hang scenario
      };
      return request;
    });
    await expect(
      publicHttpGet("https://public.example", {}, new AbortController().signal, 100),
    ).rejects.toThrow(/truncated/);
  });

  it("aborts pending DNS without sending a request", async () => {
    mocks.lookup.mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();
    const pending = publicHttpGet("https://public.example", {}, controller.signal, 100);
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
