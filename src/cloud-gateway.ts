// ============================================================
// Cloud Provider Gateway Routing (11.3)
// ============================================================
// Routes requests to managed cloud model gateways (AWS Bedrock, Google
// Vertex AI) by resolving their OpenAI-compatible endpoint URLs. Both
// platforms now expose an OpenAI-compatible Chat Completions surface, so we
// reuse the existing OpenAI-compatible streaming caller and only need to
// compute the right base URL from region/project settings.
//
// Auth note: these gateways expect a short-lived bearer token (Bedrock API
// key / GCP access token) supplied as the apiKey. We do NOT mint AWS SigV4 or
// GCP service-account signatures here — the user provides a ready token via
// LLM_API_KEY, keeping this layer thin and avoiding bundling cloud SDKs.
// ============================================================

export type CloudGateway = "bedrock" | "vertex";

export interface GatewayOptions {
  /** Cloud region, e.g. "us-east-1" (Bedrock) or "us-central1" (Vertex). */
  region?: string;
  /** GCP project id — required for Vertex. */
  project?: string;
}

export interface GatewayResolution {
  baseURL: string;
  /** A sensible default model id for the gateway when none is given. */
  defaultModel: string;
}

// Defaults refreshed 2026-09 (Top10 follow-up A11): the old Bedrock default
// (claude-3-5-sonnet v2) is RETIRED — requests against it 404 — and Vertex's
// gemini-1.5-pro is past EOL. The Bedrock id follows the current `anthropic.`
// -prefixed naming; the Vertex gemini-2.5-pro id is best-effort. Neither
// gateway could be live-tested in this environment: if a default 404s, set
// LLM_MODEL explicitly (flagged in the round's acceptance report).
const DEFAULTS: Record<CloudGateway, { region: string; defaultModel: string }> = {
  bedrock: {
    region: "us-east-1",
    defaultModel: "anthropic.claude-sonnet-5",
  },
  vertex: {
    region: "us-central1",
    defaultModel: "google/gemini-2.5-pro",
  },
};

export function isCloudGateway(value: string | undefined): value is CloudGateway {
  return value === "bedrock" || value === "vertex";
}

/**
 * Resolve the OpenAI-compatible base URL + default model for a cloud gateway.
 * Throws on missing required options (e.g. Vertex without a project id).
 */
export function resolveGateway(
  gateway: CloudGateway,
  opts: GatewayOptions = {},
): GatewayResolution {
  const region = opts.region || DEFAULTS[gateway].region;

  if (gateway === "bedrock") {
    // Bedrock's OpenAI-compatible Chat Completions endpoint.
    return {
      baseURL: `https://bedrock-runtime.${region}.amazonaws.com/openai/v1`,
      defaultModel: DEFAULTS.bedrock.defaultModel,
    };
  }

  // vertex
  if (!opts.project) {
    throw new Error("Vertex AI gateway requires a project id (set LLM_GATEWAY_PROJECT).");
  }
  return {
    baseURL: `https://${region}-aiplatform.googleapis.com/v1/projects/${opts.project}/locations/${region}/endpoints/openapi`,
    defaultModel: DEFAULTS.vertex.defaultModel,
  };
}
