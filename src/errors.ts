/**
 * Upstream HTTP refusals, made readable for the agent and the person reading
 * its transcript. The SDK reports a non-2xx answer as a StreamableHTTPError
 * whose message wraps the raw body ("Streamable HTTP error: Error POSTing to
 * endpoint: <body>"). The hosted server's bodies are `{error_description}`
 * (401), `{error, retryAfterSeconds}` (429) or a JSON-RPC error object (405,
 * 413, 400); anything else is shown as text.
 *
 * Server-supplied text is untrusted: if it echoes the API key (a custom host,
 * or a handler that reflects the Authorization header), the key is replaced
 * before the text reaches the agent's transcript or stderr.
 */

const MAX_DETAIL_CHARS = 500;
/** What an echoed key becomes. */
export const REDACTED_KEY = "iv_sk_…";
/** Shorter values cannot be one of our keys, and replacing them would mangle ordinary text. */
const MIN_REDACTED_LENGTH = 8;

export function redactKey(text: string, apiKey: string | undefined): string {
  if (!apiKey || apiKey.length < MIN_REDACTED_LENGTH) return text;
  return text.split(apiKey).join(REDACTED_KEY);
}

function detailOf(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  if (typeof b.error_description === "string") return b.error_description;
  const err = b.error;
  if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  if (typeof err === "string") {
    return typeof b.retryAfterSeconds === "number" ? `${err} (retry after ${b.retryAfterSeconds} s)` : err;
  }
  return typeof b.message === "string" ? b.message : undefined;
}

/** A 401 seen through the bridge: what to change is INSTAVISION_API_KEY, not a header. */
function bridgeHint(status: number | undefined, hasKey: boolean): string {
  if (status !== 401) return "";
  return hasKey
    ? " instavision-mcp sent the key from INSTAVISION_API_KEY: check that value in your MCP client config."
    : " With instavision-mcp, set INSTAVISION_API_KEY in your MCP client config for this server; the bridge sends the header.";
}

export function describeUpstreamError(
  status: number | undefined,
  message: string,
  apiKey: string | undefined,
): string {
  const raw = message
    .replace(/^Streamable HTTP error:\s*/, "")
    .replace(/^Error POSTing to endpoint:\s*/, "")
    .trim();
  let detail = raw;
  try {
    detail = detailOf(JSON.parse(raw)) ?? raw;
  } catch {
    // Not JSON: keep the text.
  }
  // Redact first, then cap: a cut through an echoed key must not leave part of it.
  detail = redactKey(detail, apiKey);
  if (detail.length > MAX_DETAIL_CHARS) detail = `${detail.slice(0, MAX_DETAIL_CHARS)}…`;
  const head = status ? `InstaVision answered HTTP ${status}` : "InstaVision request failed";
  return `${head}: ${detail || "(no details)"}${bridgeHint(status, !!apiKey)}`;
}
