// Shared helpers for the bridge tests. They run the BUILT bridge (dist/index.js,
// what npx installs) as a child process, so `npm run build` comes first.
// BRIDGE_UNDER_TEST points them at another copy instead — in CI, the packed
// tarball installed without our lockfile, i.e. with the dependencies npx users get.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
export const BRIDGE = process.env.BRIDGE_UNDER_TEST
  ? resolvePath(process.env.BRIDGE_UNDER_TEST)
  : fileURLToPath(new URL("../dist/index.js", import.meta.url));
export const TRAP = new URL("./fixtures/network-trap.mjs", import.meta.url).href;

if (!existsSync(BRIDGE)) {
  throw new Error(`Built bridge not found at ${BRIDGE}. Run: npm run build`);
}

export function readJson(relativePath) {
  return JSON.parse(readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8"));
}

/** A fake key: the right prefix, deliberately not the 43-char shape of a real one. */
export const FAKE_KEY = "iv_sk_bridge_test_not_a_real_key";

/** The hosted server's 9 tools (names only matter here). */
export const TOOL_NAMES = [
  "list_playbooks",
  "estimate_credits",
  "launch_discovery",
  "get_run_status",
  "get_run_results",
  "get_seen_accounts",
  "add_seen_accounts",
  "reset_seen_accounts",
  "export_run_pdf",
];
const PUBLIC_TOOLS = new Set(["list_playbooks", "estimate_credits"]);

// The hosted server's refusals, verbatim (src/lib/mcp/gate.ts, prod 02.10).
const HOW_TO_SEND =
  "Create one at https://instavision.co/settings/api-keys and send it in the header Authorization: Bearer <key>.";
export const KEY_HINT = `This call needs an InstaVision API key. ${HOW_TO_SEND}`;
export const BAD_KEY_HINT = `The API key was not accepted (unknown, revoked or malformed). ${HOW_TO_SEND}`;
export const KEYLESS_MAX_BODY_BYTES = 64 * 1024;
const KEYED_MAX_BODY_BYTES = 1024 * 1024;
export const TOO_LARGE_MESSAGE =
  "Request body too large: the limit is 65,536 bytes without an API key (1,048,576 with one)";

/**
 * Only what the child needs. Never the parent's environment: a developer's
 * real INSTAVISION_API_KEY must not reach these runs.
 */
function childEnv(env) {
  const base = {};
  for (const k of ["PATH", "HOME", "SYSTEMROOT"]) if (process.env[k]) base[k] = process.env[k];
  return { ...base, ...env };
}

/**
 * Run the bridge until it exits (or `timeoutMs`), with stdin left open so a
 * bridge that passes its checks keeps running. With `trap`, every outbound
 * request is recorded on stderr and refused (fixtures/network-trap.mjs).
 */
export function runBridge({ env = {}, trap = false, timeoutMs = 15000 } = {}) {
  const args = trap ? ["--import", TRAP, BRIDGE] : [BRIDGE];
  const child = spawn(process.execPath, args, {
    env: childEnv(env),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const attempts = stderr
        .split("\n")
        .filter((l) => l.startsWith("NETWORK_ATTEMPT "))
        .map((l) => l.slice("NETWORK_ATTEMPT ".length));
      resolve({ code, signal, stdout, stderr, attempts, timedOut: signal === "SIGKILL" });
    });
  });
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/**
 * A stand-in for the hosted server as it answers on prod after K (C-21,
 * gate.ts): stateless Streamable HTTP; a successful request is answered as an
 * SSE `message` event (or plain JSON with `sse: false`); initialize, the lists
 * and the two public tools work without a key; any other tool call without a
 * key is a 401 with the server's hint; a key other than FAKE_KEY is a 401
 * invalid_token on every request; a body over 64 KB without a key (1 MB with
 * one) is a 413; any non-POST is a 405 with `Allow: POST`; methods or tools
 * named in `rateLimited` get a 429; an unknown tool is a JSON-RPC error.
 * Hostile or odd servers: `echoInvalidKey` reflects the refused Authorization
 * header in the 401's text, and `refusals[tool](authorization)` answers that
 * tool with any `{status, body, contentType}`. Records every request,
 * including its path.
 */
export async function startFakeUpstream({
  instructions = "TEST INSTRUCTIONS",
  sse = true,
  rateLimited = [],
  echoInvalidKey = false,
  refusals = {},
} = {}) {
  const limited = new Set(rateLimited);
  const requests = [];
  const server = createServer(async (req, res) => {
    const authorization = req.headers.authorization ?? null;
    const path = new URL(req.url ?? "/", "http://fake").pathname;
    if (req.method !== "POST") {
      requests.push({ httpMethod: req.method, path, rpcMethod: null, toolName: null, authorization });
      json(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }, { allow: "POST" });
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    let message;
    try {
      message = JSON.parse(body);
    } catch {
      message = {};
    }
    const toolName = message.method === "tools/call" ? (message.params?.name ?? null) : null;
    requests.push({ httpMethod: "POST", path, rpcMethod: message.method ?? null, toolName, authorization });

    if (authorization && authorization !== `Bearer ${FAKE_KEY}`) {
      const description = echoInvalidKey ? `${BAD_KEY_HINT} Received: ${authorization}` : BAD_KEY_HINT;
      json(res, 401, { error: "invalid_token", error_description: description }, {
        "www-authenticate": `Bearer realm="instavision", error="invalid_token", error_description="${BAD_KEY_HINT}"`,
      });
      return;
    }
    if (Buffer.byteLength(body) > (authorization ? KEYED_MAX_BODY_BYTES : KEYLESS_MAX_BODY_BYTES)) {
      json(res, 413, { jsonrpc: "2.0", error: { code: -32600, message: TOO_LARGE_MESSAGE }, id: null });
      return;
    }
    if (toolName && !PUBLIC_TOOLS.has(toolName) && TOOL_NAMES.includes(toolName) && !authorization) {
      json(res, 401, { error_description: KEY_HINT }, { "www-authenticate": 'Bearer realm="instavision"' });
      return;
    }
    if (limited.has(message.method) || limited.has(toolName)) {
      json(res, 429, { error: "rate_limited", retryAfterSeconds: 7 }, { "retry-after": "7" });
      return;
    }
    if (toolName && refusals[toolName]) {
      const r = refusals[toolName](authorization);
      res.writeHead(r.status, { "content-type": r.contentType ?? "application/json" });
      res.end(r.body);
      return;
    }
    if (message.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    const send = (payload) => {
      const msg = JSON.stringify({ jsonrpc: "2.0", id: message.id, ...payload });
      if (sse) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.end(`event: message\ndata: ${msg}\n\n`);
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(msg);
      }
    };
    switch (message.method) {
      case "initialize":
        return send({
          result: {
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: {}, resources: {} },
            serverInfo: { name: "fake-upstream", version: "0.0.0" },
            instructions,
          },
        });
      case "ping":
        return send({ result: {} });
      case "tools/list":
        return send({
          result: {
            tools: TOOL_NAMES.map((name) => ({
              name,
              description: `fake ${name}`,
              inputSchema: { type: "object", properties: {} },
              annotations: { readOnlyHint: PUBLIC_TOOLS.has(name) },
            })),
          },
        });
      case "tools/call":
        if (!TOOL_NAMES.includes(toolName)) {
          return send({ error: { code: -32602, message: `Unknown tool: ${toolName}` } });
        }
        return send({ result: { content: [{ type: "text", text: JSON.stringify({ tool: toolName, ok: true }) }] } });
      case "resources/list":
        return send({ result: { resources: [] } });
      case "resources/templates/list":
        return send({ result: { resourceTemplates: [] } });
      default:
        return send({ error: { code: -32601, message: "Method not found" } });
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/api/mcp/mcp`,
    host: `127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** A server that answers every request with a 307 to `location`; counts what it got. */
export async function startRedirector(location) {
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    req.resume();
    res.writeHead(307, { location }).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/api/mcp/mcp`,
    hits: () => hits,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Connect an MCP client to the bridge over stdio, the way Claude Desktop does. */
export async function connectThroughBridge(env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BRIDGE],
    env: childEnv(env),
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (d) => (stderr += d));
  const client = new Client({ name: "bridge-test", version: "0.0.0" });
  await client.connect(transport);
  return { client, stderr: () => stderr };
}
