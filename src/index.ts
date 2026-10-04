/**
 * instavision-mcp — a thin local MCP server that bridges any stdio MCP client
 * (Claude Desktop, Claude Code, Codex, Cursor, …) to the hosted InstaVision MCP
 * endpoint over Streamable HTTP, authenticated with your InstaVision API key.
 *
 * It is a generic forwarder: it proxies tools/resources and the server's
 * instructions, so it never needs republishing when InstaVision adds or
 * changes tools.
 *
 * Config (env):
 *   INSTAVISION_API_KEY           (optional)  your key from https://instavision.co/settings/api-keys.
 *                                             Without it the bridge connects anonymously: tools and
 *                                             playbooks are listed, calls that need an account fail
 *                                             with a hint.
 *   INSTAVISION_MCP_URL           (optional)  override the endpoint (default below); see endpoint.ts
 *   INSTAVISION_ALLOW_CUSTOM_URL  (optional)  "1" allows an endpoint other than https://instavision.co
 *                                             (and http://localhost / http://127.0.0.1)
 *
 * IMPORTANT: stdout is the MCP protocol channel — never write to it. All logging
 * goes to stderr.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { OFFICIAL_HOST, resolveEndpoint } from "./endpoint.js";
import { describeUpstreamError, redactKey } from "./errors.js";

const VERSION = "0.2.0";
const KEYS_PAGE = "https://instavision.co/settings/api-keys";

function log(...args: unknown[]): void {
  // stderr only — stdout carries the MCP JSON-RPC stream.
  console.error("[instavision-mcp]", ...args);
}

/**
 * An upstream failure re-raised for the downstream client, keeping its code
 * (the HTTP status for a refusal, the JSON-RPC code for a protocol error).
 * The client adds its own "MCP error <code>:" prefix, so ours is stripped.
 * Server-supplied text never carries the key back (redactKey). No auth flow
 * is ever started: the transport has no auth provider, so a 401 is reported,
 * never retried.
 */
function upstreamFailure(err: unknown, apiKey: string | undefined): Error {
  if (err instanceof StreamableHTTPError) {
    return Object.assign(new Error(describeUpstreamError(err.code, err.message, apiKey)), {
      code: err.code,
    });
  }
  if (err instanceof McpError) {
    const message = redactKey(err.message.replace(/^MCP error -?\d+:\s*/, ""), apiKey);
    const data =
      err.data === undefined ? undefined : JSON.parse(redactKey(JSON.stringify(err.data), apiKey));
    return Object.assign(new Error(message), { code: err.code, data });
  }
  return err instanceof Error ? err : new Error(String(err));
}

async function main(): Promise<void> {
  // The URL guard runs first: nothing (and so no key) is sent before it passes.
  const endpoint = resolveEndpoint(process.env);
  if (!endpoint.ok) {
    log(`${endpoint.error} Exiting.`);
    process.exit(1);
  }
  const apiKey = process.env.INSTAVISION_API_KEY?.trim() || undefined;
  if (endpoint.custom) {
    log(
      `WARNING: using a custom endpoint, ${endpoint.url.host} (not ${OFFICIAL_HOST}).` +
        (apiKey ? " Your INSTAVISION_API_KEY is sent to this host." : ""),
    );
  }
  if (!apiKey) {
    log(
      "No INSTAVISION_API_KEY set: connecting without a key. Tools that read your account or" +
        ` spend credits need one: create it at ${KEYS_PAGE} and set INSTAVISION_API_KEY in your` +
        " MCP client config.",
    );
  }
  // Never log the query string or fragment: only where we connect.
  const where = `${endpoint.url.origin}${endpoint.url.pathname}`;

  // Upstream: the hosted InstaVision MCP server. Static Bearer header → no OAuth;
  // without a key, no Authorization header at all.
  const upstream = new Client(
    { name: "instavision-mcp-bridge", version: VERSION },
    { capabilities: {} },
  );
  const upstreamTransport = new StreamableHTTPClientTransport(
    endpoint.url,
    apiKey ? { requestInit: { headers: { Authorization: `Bearer ${apiKey}` } } } : undefined,
  );

  try {
    await upstream.connect(upstreamTransport);
  } catch (err) {
    log(`Failed to connect to InstaVision at ${where}: ${upstreamFailure(err, apiKey).message}`);
    // A 401 already says what to do with INSTAVISION_API_KEY.
    if (!(err instanceof StreamableHTTPError && err.code === 401)) {
      log(
        apiKey
          ? `Check your INSTAVISION_API_KEY (and INSTAVISION_MCP_URL if set). Keys: ${KEYS_PAGE}`
          : "Check your network (and INSTAVISION_MCP_URL if set). If the server requires a key," +
              ` create one at ${KEYS_PAGE} and set INSTAVISION_API_KEY.`,
      );
    }
    process.exit(1);
  }
  log(`connected to ${where}${apiKey ? "" : " (no API key)"}`);

  // Downstream: a stdio MCP server the local AI client spawns and talks to. It
  // hands the client the upstream server's instructions unchanged.
  const downstream = new Server(
    { name: "instavision", version: VERSION },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: upstream.getInstructions(),
    },
  );

  // Forward each request type straight to the upstream client; failures come
  // back readable (upstreamFailure).
  const forward = <T>(call: Promise<T>): Promise<T> =>
    call.catch((err: unknown) => {
      throw upstreamFailure(err, apiKey);
    });
  downstream.setRequestHandler(ListToolsRequestSchema, (req) =>
    forward(upstream.listTools(req.params)),
  );
  downstream.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      return await upstream.callTool(req.params);
    } catch (err) {
      // An HTTP refusal (no key, key refused, body too large, rate limit) is
      // this call's failure: reported in the result, where the agent reads it.
      if (err instanceof StreamableHTTPError) {
        return {
          content: [{ type: "text" as const, text: describeUpstreamError(err.code, err.message, apiKey) }],
          isError: true,
        };
      }
      throw upstreamFailure(err, apiKey);
    }
  });
  downstream.setRequestHandler(ListResourcesRequestSchema, (req) =>
    forward(upstream.listResources(req.params)),
  );
  downstream.setRequestHandler(ListResourceTemplatesRequestSchema, (req) =>
    forward(upstream.listResourceTemplates(req.params)),
  );
  downstream.setRequestHandler(ReadResourceRequestSchema, (req) =>
    forward(upstream.readResource(req.params)),
  );

  const shutdown = async (): Promise<void> => {
    await upstream.close().catch(() => {});
    await downstream.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // MCP stdio shutdown: the client closes our stdin and waits for us to exit.
  process.stdin.on("end", shutdown);

  await downstream.connect(new StdioServerTransport());
  log("ready (stdio)");
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  log(`fatal: ${message}`);
  process.exit(1);
});
