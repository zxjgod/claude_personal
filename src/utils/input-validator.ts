// ============================================================
// Input Validation Framework
// ============================================================
// Provides unified input validation for all tools to prevent
// injection attacks, path traversal, and malformed inputs.

import * as net from "node:net";

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Input Validator - Centralized validation logic for tools
 */
// biome-ignore lint/complexity/noStaticOnlyClass: namespaced static helpers, instantiated nowhere by design
export class InputValidator {
  /**
   * Validate file path input.
   * Checks: length, control characters, path-traversal / dangerous patterns.
   * NOTE: workspace-boundary enforcement is NOT done here — callers follow up
   * with resolveInWorkspace() (src/tools/utils/path.ts), which owns that check.
   */
  static validateFilePath(filePath: string): ValidationResult {
    // Check path length (most filesystems have limits around 4096)
    if (filePath.length > 4096) {
      return { valid: false, error: "Path exceeds maximum length (4096 characters)" };
    }

    // Check for null bytes (can cause issues in C-based filesystem APIs)
    if (/[\x00-\x1F]/.test(filePath)) {
      return { valid: false, error: "Path contains illegal control characters" };
    }

    // Check for dangerous patterns
    if (InputValidator.containsDangerousPathPattern(filePath)) {
      return { valid: false, error: "Path contains potentially dangerous pattern" };
    }

    return { valid: true };
  }

  /**
   * Validate shell command input
   * Checks: length, dangerous patterns (fork bomb, device writes, etc.)
   */
  static validateCommand(command: string): ValidationResult {
    // Check command length (prevent resource exhaustion)
    if (command.length > 100000) {
      return { valid: false, error: "Command exceeds maximum length (100,000 characters)" };
    }

    // Check for dangerous patterns
    const dangerous = InputValidator.detectDangerousCommandPattern(command);
    if (dangerous) {
      return { valid: false, error: `Dangerous command pattern detected: ${dangerous}` };
    }

    return { valid: true };
  }

  /**
   * Validate URL input for web tools
   */
  static validateUrl(url: string): ValidationResult {
    // Check URL length
    if (url.length > 8192) {
      return { valid: false, error: "URL exceeds maximum length (8192 characters)" };
    }

    // Check for valid URL format
    try {
      const parsed = new URL(url);

      // Block certain protocols
      if (!["http:", "https:"].includes(parsed.protocol)) {
        return { valid: false, error: `Protocol ${parsed.protocol} is not allowed` };
      }

      // Block private/internal networks (SSRF prevention)
      if (InputValidator.isPrivateNetwork(parsed.hostname)) {
        return { valid: false, error: "Access to private networks is not allowed" };
      }

      return { valid: true };
    } catch {
      return { valid: false, error: "Invalid URL format" };
    }
  }

  /**
   * Validate text content length
   */
  static validateContentLength(content: string, maxLength: number): ValidationResult {
    if (content.length > maxLength) {
      return {
        valid: false,
        error: `Content exceeds maximum length (${maxLength} characters)`,
      };
    }
    return { valid: true };
  }

  /**
   * Validate numeric input is within bounds
   */
  static validateNumericRange(
    value: number,
    min: number,
    max: number,
    name: string = "value",
  ): ValidationResult {
    if (!Number.isFinite(value)) {
      return { valid: false, error: `${name} must be a finite number` };
    }
    if (value < min || value > max) {
      return { valid: false, error: `${name} must be between ${min} and ${max}` };
    }
    return { valid: true };
  }

  // ============================================================
  // Private Helper Methods
  // ============================================================

  /**
   * Check for dangerous path patterns.
   *
   * NOTE: Path traversal (`..`) is NOT checked here — it is correctly handled
   * by resolveInWorkspace() which resolves the path and verifies containment.
   * Windows invalid filename chars are NOT checked — valid on Unix.
   */
  private static containsDangerousPathPattern(filePath: string): boolean {
    const dangerous = [
      /^[/\\]{2,}/, // UNC paths on Windows (\\server\share)
      /[\x00-\x1F]/, // Control characters (null byte and below)
    ];

    return dangerous.some((pattern) => pattern.test(filePath));
  }

  /**
   * Detect dangerous command patterns
   */
  private static detectDangerousCommandPattern(command: string): string | null {
    const patterns: [RegExp, string][] = [
      // Fork bomb
      [/:\(\)\{\s*:\|:&\s*\};:/, "fork bomb"],

      // Device writes
      [/>\s*\/dev\/(sd[a-z]|nvme\d+n\d+|hd[a-z])/, "device write"],

      // dd to device
      [/\bdd\s+.*of=\/dev\//, "dd to device"],

      // Dangerous rm patterns — short flag clusters (-rf, -R) AND the
      // --recursive long form, in any flag order, targeting `/` or `/*`.
      [
        /\brm\b[^|;&\n]*(?:(?:\s|^)['"]?-[a-z]*r[a-z]*['"]?|(?:\s|^)['"]?--recursive['"]?)[^|;&\n]*\s+\/\s*(?:\*|$)/i,
        "recursive delete of root",
      ],

      // mkfs (format filesystem)
      [/\bmkfs/, "filesystem format"],

      // fdisk (partition manipulation)
      [/\bfdisk/, "disk partitioning"],

      // Kernel module manipulation
      [/\b(insmod|rmmod|modprobe)\b/, "kernel module manipulation"],
    ];

    for (const [pattern, description] of patterns) {
      if (pattern.test(command)) {
        return description;
      }
    }

    return null;
  }

  /**
   * Check if hostname is in a private/special network range (SSRF prevention).
   *
   * The old regex-only check missed three forms that reach the network stack:
   *   - Node's `URL.hostname` returns IPv6 addresses WITH brackets ("[::1]"),
   *     which the bare "::1" / "fe80:" / "fd..:" regexes never matched — so
   *     IPv6 loopback, link-local and ULA were silently ALLOWED.
   *   - IPv4-mapped IPv6 ("::ffff:7f00:1", the normalized form of
   *     "::ffff:127.0.0.1") embeds a private IPv4 that a prefix check cannot see.
   *   - 0.0.0.0 (all interfaces) and :: (unspecified) were in no range at all.
   */
  static isPrivateNetwork(hostname: string): boolean {
    // Strip IPv6 brackets before any address parsing.
    let host = hostname;
    if (host.startsWith("[") && host.endsWith("]")) {
      host = host.slice(1, -1);
    }

    // Local hostnames.
    if (/(^|\.)localhost\.?$/i.test(host)) {
      return true;
    }

    const version = net.isIP(host);
    if (version === 4) {
      return InputValidator.isPrivateIPv4(host);
    }
    if (version === 6) {
      return InputValidator.isPrivateIPv6(host);
    }
    return false;
  }

  /** Private/special IPv4 ranges: this-network, loopback, private, CGNAT,
   * link-local, benchmarking, documentation, multicast, reserved. */
  private static isPrivateIPv4(addr: string): boolean {
    const octets = addr.split(".").map(Number);
    const [a, b, c] = octets;
    if (a === undefined || b === undefined) return false;
    return (
      a === 0 || // 0.0.0.0/8 "this network"
      a === 10 || // 10.0.0.0/8 private
      (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 CGNAT (incl. Tailscale)
      a === 127 || // 127.0.0.0/8 loopback
      (a === 169 && b === 254) || // 169.254.0.0/16 link-local
      (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 private
      (a === 192 && b === 0 && c === 0) || // 192.0.0.0/24 IETF protocol assignments
      (a === 192 && b === 0 && c === 2) || // 192.0.2.0/24 TEST-NET-1 documentation
      (a === 192 && b === 168) || // 192.168.0.0/16 private
      (a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15 benchmarking
      (a === 198 && b === 51 && c === 100) || // 198.51.100.0/24 TEST-NET-2 documentation
      (a === 203 && b === 0 && c === 113) || // 203.0.113.0/24 TEST-NET-3 documentation
      a >= 224 // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + 255.255.255.255 broadcast
    );
  }

  /** Private/special IPv6 ranges: unspecified, loopback, IPv4-mapped, link-local,
   * ULA, multicast, documentation. */
  private static isPrivateIPv6(addr: string): boolean {
    const lower = addr.toLowerCase();

    // Unspecified / loopback.
    if (lower === "::" || lower === "::1") return true;

    // IPv4-mapped ("::ffff:a.b.c.d" or the normalized "::ffff:xxxx:xxxx") —
    // unwrap the embedded IPv4 and apply the IPv4 checks.
    if (lower.startsWith("::ffff:")) {
      const ipv4 = InputValidator.mappedIPv4(lower);
      return ipv4 ? InputValidator.isPrivateIPv4(ipv4) : false;
    }

    // NAT64 (RFC 6052 well-known 64:ff9b::/96, RFC 8215 local 64:ff9b:1::/48):
    // the trailing 32 bits embed an IPv4 that a prefix check cannot see —
    // "64:ff9b::7f00:1" is 127.0.0.1 in disguise.
    if (lower.startsWith("64:ff9b::") || lower.startsWith("64:ff9b:1:")) {
      const ipv4 = InputValidator.nat64EmbeddedIPv4(lower);
      return ipv4 ? InputValidator.isPrivateIPv4(ipv4) : false;
    }

    // Link-local fe80::/10 (first byte fe, second byte 80–bf).
    if (
      lower.startsWith("fe8") ||
      lower.startsWith("fe9") ||
      lower.startsWith("fea") ||
      lower.startsWith("feb")
    ) {
      return true;
    }
    // ULA fc00::/7 (first byte fc or fd).
    if (lower.startsWith("fc") || lower.startsWith("fd")) {
      return true;
    }
    // Multicast ff00::/8.
    if (lower.startsWith("ff")) return true;
    // Documentation 2001:db8::/32.
    if (lower === "2001:db8" || lower.startsWith("2001:db8:")) return true;

    return false;
  }

  /** Extract the embedded IPv4 from an IPv4-mapped IPv6 address, or undefined. */
  private static mappedIPv4(addr: string): string | undefined {
    const rest = addr.slice("::ffff:".length);
    if (rest.includes(".")) {
      // Dotted form: "::ffff:127.0.0.1".
      return net.isIPv4(rest) ? rest : undefined;
    }
    // Hex form (Node's normalization of the above): "::ffff:7f00:1" — the last
    // two 16-bit groups are the four IPv4 octets.
    const groups = rest.split(":");
    if (groups.length === 2) {
      const hi = Number.parseInt(groups[0]!, 16);
      const lo = Number.parseInt(groups[1]!, 16);
      if (Number.isNaN(hi) || Number.isNaN(lo)) return undefined;
      return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    }
    return undefined;
  }

  /** Extract the embedded IPv4 from a NAT64 address, or undefined. */
  private static nat64EmbeddedIPv4(addr: string): string | undefined {
    // Dotted suffix form: "64:ff9b::127.0.0.1".
    const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(addr)?.[1];
    if (dotted) return net.isIPv4(dotted) ? dotted : undefined;
    // Normalized form: the last two hextets are the four IPv4 octets
    // ("64:ff9b::7f00:1" → 127.0.0.1).
    const hextets = /([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(addr);
    if (!hextets) return undefined;
    const hi = Number.parseInt(hextets[1]!, 16);
    const lo = Number.parseInt(hextets[2]!, 16);
    if (Number.isNaN(hi) || Number.isNaN(lo)) return undefined;
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
}
