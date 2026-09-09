import { lookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import { isIP } from "node:net";
import { InputValidator } from "../../utils/input-validator.js";

/** Resolve once, reject every private answer, and connect to a checked IP.
 * Direct connections deliberately avoid proxy-side DNS and DNS rebinding.
 * Host and TLS SNI retain the original server name for virtual hosting and
 * certificate verification. Redirects remain the caller's responsibility.
 */
export async function publicHttpGet(
  target: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  maxBytes: number,
): Promise<Response> {
  const validation = InputValidator.validateUrl(target);
  if (!validation.valid) throw new Error(validation.error);
  signal.throwIfAborted();
  const url = new URL(target);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await new Promise<Awaited<ReturnType<typeof resolveAddresses>>>((resolve, reject) => {
        // signal.reason is optional and may be a non-Error; normalize so the
        // caller's `(err as Error).message` handling never throws a TypeError.
        const onAbort = () =>
          reject(signal.reason instanceof Error ? signal.reason : new Error("Request aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
        resolveAddresses(hostname)
          .then(resolve, reject)
          .finally(() => signal.removeEventListener("abort", onAbort));
      });
  signal.throwIfAborted();
  if (
    !addresses.length ||
    addresses.some(({ address }) => !isIP(address) || InputValidator.isPrivateNetwork(address))
  ) {
    throw new Error("Access to private networks is not allowed (DNS address)");
  }
  const address = addresses[0];
  if (!address) throw new Error("No public address found");
  return new Promise<Response>((resolve, reject) => {
    const request = (url.protocol === "https:" ? https.request : http.request)(
      {
        protocol: url.protocol,
        hostname: address.address,
        family: address.family,
        port: url.port || undefined,
        path: url.pathname + url.search,
        servername: isIP(hostname) ? undefined : hostname,
        method: "GET",
        headers: { ...headers, Host: url.host, "Accept-Encoding": "identity" },
        agent: false,
        signal,
      },
      (response) => {
        response.on("error", reject);
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined)
            responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
        const status = response.statusCode ?? 502;
        if (status < 200 || status > 599) {
          response.destroy();
          reject(new Error(`Unsupported HTTP status: ${status}`));
          return;
        }
        // Redirects need only headers. Do not download an untrusted redirect body.
        if (status >= 300 && status < 400 && response.headers.location) {
          response.destroy();
          resolve(new Response(null, { status, headers: responseHeaders }));
          return;
        }
        if (
          response.headers["content-encoding"] &&
          response.headers["content-encoding"] !== "identity"
        ) {
          response.destroy();
          reject(new Error("Unsupported response encoding (expected identity)"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            response.destroy(new Error(`Response exceeds maximum size of ${maxBytes} bytes`));
          } else chunks.push(chunk);
        });
        response.on("end", () => {
          resolve(
            new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), {
              status,
              statusText: response.statusMessage,
              headers: responseHeaders,
            }),
          );
        });
        // A socket that dies mid-body does not reliably fire 'error' (e.g. FIN
        // before Content-Length is satisfied); 'end' then never arrives either.
        // Without this branch the promise would hang until the caller watchdog.
        response.on("close", () => {
          if (!response.readableEnded) {
            reject(new Error("Response truncated: connection closed before the body completed"));
          }
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

function resolveAddresses(hostname: string) {
  return lookup(hostname, { all: true, verbatim: true });
}
