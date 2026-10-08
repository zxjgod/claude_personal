import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parentPort, workerData } from "node:worker_threads";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

// Isolate PDF parsing and rasterization so malformed files cannot pin the CLI.
const require = createRequire(import.meta.url);
const assets = dirname(require.resolve("pdfjs-dist/package.json"));
const assetUrl = (name) => pathToFileURL(join(assets, name) + "/").href;

try {
  const task = getDocument({
    data: new Uint8Array(workerData.data),
    cMapUrl: assetUrl("cmaps"),
    cMapPacked: true,
    standardFontDataUrl: assetUrl("standard_fonts"),
    wasmUrl: assetUrl("wasm"),
    useWorkerFetch: false,
    isEvalSupported: false,
    verbosity: 0,
  });
  const doc = await task.promise;
  try {
    const start = workerData.start;
    if (start > doc.numPages) throw new Error(`PDF has ${doc.numPages} pages; page ${start} is out of range.`);
    const end = Math.min(doc.numPages, start + workerData.count - 1);
    const pages = [];
    let imageBytes = 0;
    for (let number = start; number <= end; number++) {
      const page = await doc.getPage(number);
      const extracted = await page.getTextContent();
      let text = "";
      for (const item of extracted.items) {
        if ("str" in item) text += item.str + (item.hasEOL ? "\n" : " ");
        if (text.length >= 20000) break;
      }
      const truncated = text.length > 20000;
      text = text.slice(0, 20000);
      let image;
      if (workerData.renderImages) {
        const base = page.getViewport({ scale: 1 });
        if (!(base.width > 0 && base.height > 0 && Number.isFinite(base.width * base.height))) {
          throw new Error(`PDF page ${number} has invalid dimensions.`);
        }
        const scale = Math.min(2, 1568 / Math.max(base.width, base.height), Math.sqrt(2000000 / (base.width * base.height)));
        const viewport = page.getViewport({ scale });
        const canvas = createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
        await page.render({ canvas, canvasContext: canvas.getContext("2d"), viewport, background: "rgb(255,255,255)" }).promise;
        const encoded = canvas.toBuffer("image/png");
        imageBytes += encoded.length;
        if (imageBytes > 5 * 1024 * 1024) throw new Error("Rendered PDF exceeds the 5 MiB image budget; read fewer pages.");
        image = encoded.toString("base64");
      }
      pages.push({ number, text: text.trim(), truncated, image });
      page.cleanup();
    }
    parentPort.postMessage({ ok: true, totalPages: doc.numPages, pages });
  } finally {
    await task.destroy();
  }
} catch (error) {
  parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
}
