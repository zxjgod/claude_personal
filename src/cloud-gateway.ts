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
  /** Vertex API version segment — defaults to "v1" (see resolveGateway). */
  apiVersion?: string;
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

  // Review fix: region/project are interpolated into the request URL without
  // validation — a region containing "@" turns the URL authority into
  // userinfo (`https://evil.com@-aiplatform.googleapis.com/...`) and silently
  // redirects API-key-bearing requests to an attacker host. Whitelist the
  // charset both clouds actually use (letters, digits, hyphens).
  const SAFE = /^[a-z0-9][a-z0-9-]*$/i;
  if (!SAFE.test(region)) {
    throw new Error(
      `Invalid gateway region "${region}" — expected letters, digits and hyphens only.`,
    );
  }

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
  if (!SAFE.test(opts.project)) {
    throw new Error(
      `Invalid Vertex project id "${opts.project}" — expected letters, digits and hyphens only.`,
    );
  }
  // The version segment is interpolated into the URL, so whitelist it too.
  const apiVersion = opts.apiVersion || process.env.LLM_GATEWAY_API_VERSION || "v1";
  if (!/^v[0-9][a-z0-9]*$/.test(apiVersion)) {
    throw new Error(
      `Invalid Vertex API version "${apiVersion}" — expected a version like v1 or v1beta1.`,
    );
  }
  return {
    // Google's documented OpenAI-compatible Vertex base URL puts the compat
    // gateway under **v1** (`.../v1/projects/P/locations/L/endpoints/openapi`);
    // the v1beta1 prefix belongs to the NATIVE publisher-model endpoints
    // (`.../v1beta1/projects/P/locations/L/publishers/google/models/...`).
    // An earlier round flipped this to v1beta1 on the assumption that /v1/
    // 404s — an assumption that was never live-tested (neither variant can be
    // reached from this environment), so it turned a documented URL into an
    // unverified guess. The default is now back on the documented /v1/, and
    // LLM_GATEWAY_API_VERSION lets a deployment that really needs v1beta1 (or
    // the reverse) switch without patching.
    baseURL: `https://${region}-aiplatform.googleapis.com/${apiVersion}/projects/${opts.project}/locations/${region}/endpoints/openapi`,
    defaultModel: DEFAULTS.vertex.defaultModel,
  };
}
