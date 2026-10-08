import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import type { ImageContent, ToolResult } from "./types.js";

export const MAX_PDF_BYTES = 20 * 1024 * 1024;
export const MAX_PDF_PAGES = 5;

interface PdfPage {
  number: number;
  text: string;
  truncated: boolean;
  image?: string;
}

interface PdfReply {
  ok: boolean;
  error?: string;
  totalPages: number;
  pages: PdfPage[];
}

export async function readPdf(
  data: Uint8Array,
  options: {
    pages?: string;
    renderImages?: boolean;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<ToolResult> {
  if (data.byteLength > MAX_PDF_BYTES)
    throw new Error(`PDF exceeds the ${MAX_PDF_BYTES} byte limit.`);
  const match = /^(\d+)(?:-(\d+))?$/.exec(options.pages ?? `1-${MAX_PDF_PAGES}`);
  const start = Number(match?.[1]);
  const end = Number(match?.[2] ?? match?.[1]);
  if (
    !match ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 1 ||
    end < start ||
    end - start + 1 > MAX_PDF_PAGES
  ) {
    throw new Error(
      `PDF pages must be a page or range such as "1" or "2-5", at most ${MAX_PDF_PAGES} pages per read.`,
    );
  }
  options.signal?.throwIfAborted();
  const workerUrl = [
    new URL("./pdf-worker.mjs", import.meta.url),
    new URL("../pdf-worker.mjs", import.meta.url),
  ].find(existsSync);
  if (!workerUrl) throw new Error("PDF worker is missing; rebuild or reinstall the application.");
  const reply = await new Promise<PdfReply>((resolve, reject) => {
    const worker = new Worker(workerUrl, {
      workerData: {
        data,
        start,
        count: end - start + 1,
        renderImages: options.renderImages !== false,
      },
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    let settled = false;
    const finish = (error?: unknown, result?: PdfReply): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      void worker.terminate();
      if (error) reject(error);
      else if (result) resolve(result);
    };
    const onAbort = (): void => finish(options.signal?.reason ?? new Error("PDF read aborted"));
    const timer = setTimeout(
      () => finish(new Error("PDF processing timed out; read fewer pages or simplify the file.")),
      options.timeoutMs ?? 30000,
    );
    options.signal?.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (result: PdfReply) => finish(undefined, result));
    worker.once("error", (error) => finish(error));
    worker.once("exit", (code) =>
      finish(new Error(`PDF worker exited before returning a result (code ${code}).`)),
    );
    if (options.signal?.aborted) onAbort();
  });
  if (!reply.ok) throw new Error(reply.error ?? "PDF processing failed");
  const lastPage = reply.pages.at(-1);
  if (!lastPage) throw new Error("PDF processing returned no pages.");
  const last = lastPage.number;
  const images: ImageContent[] = reply.pages.flatMap((page) =>
    page.image
      ? [
          {
            type: "image" as const,
            source: { type: "base64" as const, media_type: "image/png", data: page.image },
          },
        ]
      : [],
  );
  return {
    content:
      `[PDF pages ${start}-${last} of ${reply.totalPages}]\n` +
      reply.pages
        .map(
          (page) =>
            `Page ${page.number}:\n${page.text || "[No extractable text; scanned or graphical page.]"}${page.truncated ? "\n[Page text truncated at 20000 characters.]" : ""}`,
        )
        .join("\n\n") +
      (last < reply.totalPages
        ? `\n[More pages available: read with pages="${last + 1}-${Math.min(last + MAX_PDF_PAGES, reply.totalPages)}".]`
        : "") +
      (options.renderImages === false
        ? "\n[Page images omitted: current model is configured for text input only; visual content has not been inspected.]"
        : "\n[Attached page images are in page order.]"),
    images: images.length ? images : undefined,
    truncated: last < reply.totalPages || reply.pages.some((page) => page.truncated),
    metadata: { summary: `Read PDF pages ${start}-${last} of ${reply.totalPages}` },
  };
}
