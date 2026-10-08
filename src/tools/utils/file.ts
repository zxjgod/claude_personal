// ============================================================
// File Utilities for Tools
// ============================================================

import * as path from "node:path";

/**
 * Check if a buffer contains binary data by looking for null bytes
 * in the first 8KB.
 */
export function isBinary(buffer: Buffer): boolean {
  const sampleSize = Math.min(buffer.length, 8192);
  for (let i = 0; i < sampleSize; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

/**
 * Format byte size in human-readable format (B, KB, MB).
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Max bytes for an inline image (base64 inflates ~33%, so keep modest).
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// PDFs are recognized here but parsed locally instead of sent as raw media.
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

/** Return the media type for a multimodal-readable file, or undefined. */
export function imageMediaType(filePath: string): string | undefined {
  return IMAGE_MEDIA_TYPES[path.extname(filePath).toLowerCase()];
}
