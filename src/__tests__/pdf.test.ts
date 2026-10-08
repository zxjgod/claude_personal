import { createCanvas, loadImage } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { prepareMultimodalMessages, supportsImageInput } from "../multimodal.js";
import { MAX_PDF_BYTES, readPdf } from "../pdf.js";
import type { Message, ModelConfig } from "../types.js";
import { makePdf } from "./fixtures/pdf.js";

const config: ModelConfig = { provider: "anthropic", model: "k3", apiKey: "test" };

describe("local PDF input", () => {
  it("extracts text and produces a nonblank PNG for the selected page", async () => {
    const result = await readPdf(makePdf(3), { pages: "2" });
    expect(result.content).toContain("PDF pages 2-2 of 3");
    expect(result.content).toContain("Page 2 content");
    expect(result.content).not.toContain("Page 1 content");
    expect(result.images).toHaveLength(1);
    expect(result.images?.[0].source.media_type).toBe("image/png");
    const image = await loadImage(Buffer.from(result.images?.[0].source.data ?? "", "base64"));
    expect([image.width, image.height]).toEqual([400, 400]);
    const canvas = createCanvas(400, 400);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);
    expect(Array.from(ctx.getImageData(120, 240, 1, 1).data)).toEqual([255, 0, 0, 255]);
    expect(result.truncated).toBe(true);
  });

  it("caps the default window and advertises the next page range", async () => {
    const result = await readPdf(makePdf(7), { renderImages: false });
    expect(result.content).toContain("PDF pages 1-5 of 7");
    expect(result.content).toContain('pages="6-7"');
    expect(result.images).toBeUndefined();
    expect(result.content).toContain("visual content has not been inspected");
  });

  it("keeps graphical pages visible when there is no extractable text", async () => {
    const result = await readPdf(makePdf(1, false));
    expect(result.content).toContain("No extractable text");
    expect(result.images).toHaveLength(1);
    const textOnly = await readPdf(makePdf(1, false), { renderImages: false });
    expect(textOnly.images).toBeUndefined();
    expect(textOnly.content).toContain("visual content has not been inspected");
  });

  it("rejects malformed PDFs, oversized files and invalid ranges", async () => {
    await expect(readPdf(Buffer.from("%PDF-1.4 fake"))).rejects.toThrow();
    await expect(readPdf(new Uint8Array(MAX_PDF_BYTES + 1))).rejects.toThrow(/limit/);
    for (const pages of ["0", "1-6", "3-2", "garbage", "1,3", "9007199254740992"]) {
      await expect(readPdf(makePdf(), { pages })).rejects.toThrow(/pages must/);
    }
    await expect(readPdf(makePdf(), { pages: "2" })).rejects.toThrow(/out of range/);
  });

  it("terminates work on timeout and abort, then allows the next read", async () => {
    await expect(readPdf(makePdf(), { timeoutMs: 1 })).rejects.toThrow(/timed out/);
    const controller = new AbortController();
    const pending = readPdf(makePdf(), { signal: controller.signal });
    controller.abort(new Error("cancel PDF"));
    await expect(pending).rejects.toThrow("cancel PDF");
    const result = await readPdf(makePdf(), { renderImages: false });
    expect(result.content).toContain("Page 1 content");
  });

  it("converts old-session PDF blocks without modifying saved history", async () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: makePdf().toString("base64"),
            },
          },
        ],
      },
    ];
    const prepared = await prepareMultimodalMessages(messages, config);
    const blocks = (prepared[0] as (typeof messages)[0] & { role: "user" }).content;
    expect(blocks.some((b) => b.type === "text" && b.text.includes("Page 1 content"))).toBe(true);
    expect(blocks.some((b) => b.type === "image" && b.source.media_type === "image/png")).toBe(
      true,
    );
    expect(JSON.stringify(prepared)).not.toContain("application/pdf");
    expect(JSON.stringify(messages)).toContain("application/pdf");
    expect((await prepareMultimodalMessages(messages, config))[0]).toBe(prepared[0]);
    const textOnly = await prepareMultimodalMessages(messages, {
      ...config,
      options: { supportsImages: false },
    });
    expect(JSON.stringify(textOnly)).not.toContain('"type":"image"');
  });

  it("allows a text follow-up after an invalid legacy attachment", async () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: Buffer.from("not a PDF").toString("base64"),
            },
          },
        ],
      },
      { role: "user", content: [{ type: "text", text: "continue" }] },
    ];
    const prepared = await prepareMultimodalMessages(messages, config);
    expect(JSON.stringify(prepared)).toContain("could not be processed");
    expect(prepared[1]).toBe(messages[1]);
    expect(JSON.stringify(prepared)).not.toContain("application/pdf");
  });

  it("gates known text models and permits explicit relay overrides", () => {
    expect(supportsImageInput({ ...config, model: "deepseek-chat" })).toBe(false);
    expect(supportsImageInput(config)).toBe(true);
    expect(supportsImageInput({ ...config, model: "qwen3-vl-plus" })).toBe(true);
    expect(
      supportsImageInput({ ...config, model: "deepseek-chat", options: { supportsImages: true } }),
    ).toBe(true);
  });
});
