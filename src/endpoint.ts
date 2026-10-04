/**
 * Where the bridge may connect (C-25 URL guard). Decided from the environment
 * before anything touches the network: until this returns ok, no request is
 * made, so no API key can leave the machine.
 *
 *   - unset INSTAVISION_MCP_URL          → the hosted endpoint below
 *   - https://instavision.co/…           → allowed
 *   - https://<any other host>/…         → only with INSTAVISION_ALLOW_CUSTOM_URL=1
 *   - http://localhost / http://127.0.0.1 → only with INSTAVISION_ALLOW_CUSTOM_URL=1
 *   - anything else (other http, ws:, file:, credentials in the URL) → refused
 *
 * A custom endpoint is reported back (`custom: true`) so the caller warns on
 * stderr, naming the host.
 */

export const DEFAULT_MCP_URL = "https://instavision.co/api/mcp/mcp";
export const OFFICIAL_HOST = "instavision.co";
export const ALLOW_CUSTOM_URL_ENV = "INSTAVISION_ALLOW_CUSTOM_URL";

/** The only hosts reachable over plain http: a local dev server. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);

export type EndpointEnv = {
  INSTAVISION_MCP_URL?: string;
  INSTAVISION_ALLOW_CUSTOM_URL?: string;
};

export type EndpointDecision =
  | { ok: true; url: URL; custom: boolean }
  | { ok: false; error: string };

export function resolveEndpoint(env: EndpointEnv): EndpointDecision {
  const raw = env.INSTAVISION_MCP_URL?.trim();
  if (!raw) return { ok: true, url: new URL(DEFAULT_MCP_URL), custom: false };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "INSTAVISION_MCP_URL is not a valid URL." };
  }
  if (url.username || url.password) {
    return { ok: false, error: "INSTAVISION_MCP_URL must not contain a user name or password." };
  }

  const allowCustom = env.INSTAVISION_ALLOW_CUSTOM_URL?.trim() === "1";
  // The URL parser lowercases the scheme and the host.
  const host = url.hostname;

  if (url.protocol === "https:") {
    if (host === OFFICIAL_HOST) return { ok: true, url, custom: false };
    if (!allowCustom) {
      return {
        ok: false,
        error:
          `INSTAVISION_MCP_URL points at ${url.host}, not ${OFFICIAL_HOST}. ` +
          `Set ${ALLOW_CUSTOM_URL_ENV}=1 only for a server you trust with your API key.`,
      };
    }
    return { ok: true, url, custom: true };
  }

  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(host)) {
    if (!allowCustom) {
      return {
        ok: false,
        error:
          `INSTAVISION_MCP_URL uses plain http (${url.host}). Plain http is allowed only for ` +
          `localhost or 127.0.0.1, and only with ${ALLOW_CUSTOM_URL_ENV}=1.`,
      };
    }
    return { ok: true, url, custom: true };
  }

  return {
    ok: false,
    error:
      `INSTAVISION_MCP_URL must be an https:// URL (plain http only for localhost or ` +
      `127.0.0.1 with ${ALLOW_CUSTOM_URL_ENV}=1).`,
  };
}
