// The bridge end to end against a local stand-in of the hosted server (shaped
// like prod after K): it forwards the server's instructions and tools, sends
// the key only when one is set, still connects without a key (anonymous mode),
// reports every refusal readably, and never retries into an auth flow.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import {
  BAD_KEY_HINT,
  FAKE_KEY,
  KEY_HINT,
  KEYLESS_MAX_BODY_BYTES,
  TOO_LARGE_MESSAGE,
  TOOL_NAMES,
  connectThroughBridge,
  readJson,
  runBridge,
  startFakeUpstream,
  startRedirector,
} from "./helpers.mjs";

const INSTRUCTIONS = "Use estimate_credits before launch_discovery. (fake upstream)";
const VERSION = readJson("package.json").version;
const MCP_PATH = "/api/mcp/mcp";

const textOf = (result) => result.content?.find((c) => c.type === "text")?.text ?? "";

/** Raw SDK wording that must not reach the agent. */
function assertNoTransportNoise(text) {
  assert.ok(!text.includes("Streamable HTTP error"), `raw transport wording leaked: ${text}`);
  assert.ok(!text.includes("Error POSTing to endpoint"), `raw transport wording leaked: ${text}`);
  assert.ok(!/MCP error -?\d+: MCP error/.test(text), `doubled error prefix: ${text}`);
}

/** Nothing but the MCP endpoint was requested: no OAuth discovery, registration or token call. */
function assertNoAuthFlow(requests) {
  const elsewhere = requests.filter((r) => r.path !== MCP_PATH);
  assert.deepEqual(elsewhere, [], `requests outside ${MCP_PATH}: ${JSON.stringify(elsewhere)}`);
}

describe("bridge ↔ upstream", () => {
  let upstream;
  before(async () => {
    upstream = await startFakeUpstream({ instructions: INSTRUCTIONS, rateLimited: ["get_run_status", "resources/list"] });
  });
  after(async () => {
    await upstream.close();
  });

  it("with a key: forwards instructions and tools, sends the key on every request, and shrugs off the 405 on GET", async () => {
    upstream.requests.length = 0;
    const { client, stderr } = await connectThroughBridge({
      INSTAVISION_MCP_URL: upstream.url,
      INSTAVISION_ALLOW_CUSTOM_URL: "1",
      INSTAVISION_API_KEY: FAKE_KEY,
    });
    try {
      assert.equal(client.getInstructions(), INSTRUCTIONS, "instructions are forwarded unchanged");
      assert.deepEqual(client.getServerVersion(), { name: "instavision", version: VERSION });

      const tools = await client.listTools();
      assert.deepEqual(tools.tools.map((t) => t.name), TOOL_NAMES);
      assert.equal(tools.tools[0].annotations?.readOnlyHint, true, "annotations pass through");

      const res = await client.callTool({ name: "launch_discovery", arguments: {} });
      assert.ok(!res.isError, `keyed call should succeed: ${JSON.stringify(res)}`);

      // The SDK opens a GET stream after initialize; the server's 405 must not break anything.
      const gets = upstream.requests.filter((r) => r.httpMethod === "GET");
      assert.ok(gets.length >= 1, "the SDK's GET stream attempt reached the server (and got 405)");
      assert.ok(upstream.requests.length > gets.length, "POSTs kept working after the 405");

      for (const r of upstream.requests) {
        assert.equal(r.authorization, `Bearer ${FAKE_KEY}`, `${r.httpMethod} ${r.rpcMethod} lacks the key`);
      }
      assertNoAuthFlow(upstream.requests);
      assert.ok(stderr().includes(`WARNING: using a custom endpoint, ${upstream.host}`), stderr());
      assert.ok(!stderr().includes(FAKE_KEY), "the key must never be printed");
    } finally {
      await client.close();
    }
  });

  it("without a key: connects anonymously, lists tools, and never sends an Authorization header", async () => {
    upstream.requests.length = 0;
    const { client, stderr } = await connectThroughBridge({
      INSTAVISION_MCP_URL: upstream.url,
      INSTAVISION_ALLOW_CUSTOM_URL: "1",
    });
    try {
      assert.equal(client.getInstructions(), INSTRUCTIONS, "instructions are forwarded unchanged");
      const tools = await client.listTools();
      assert.equal(tools.tools.length, 9, "all 9 tools are listed without a key");

      const pub = await client.callTool({ name: "list_playbooks", arguments: {} });
      assert.ok(!pub.isError, `a public tool works without a key: ${JSON.stringify(pub)}`);

      assert.ok(upstream.requests.length > 0, "the upstream saw requests");
      for (const r of upstream.requests) {
        assert.equal(r.authorization, null, `${r.httpMethod} ${r.rpcMethod} carried an Authorization header`);
      }
      assert.ok(stderr().includes("No INSTAVISION_API_KEY set"), `stderr hint expected: ${stderr()}`);
      assert.ok(stderr().includes("https://instavision.co/settings/api-keys"), stderr());
    } finally {
      await client.close();
    }
  });

  it("without a key, a protected tool's 401 comes back as a readable tool error — once, with no auth flow", async () => {
    upstream.requests.length = 0;
    const { client } = await connectThroughBridge({
      INSTAVISION_MCP_URL: upstream.url,
      INSTAVISION_ALLOW_CUSTOM_URL: "1",
    });
    try {
      const res = await client.callTool({ name: "launch_discovery", arguments: {} });
      assert.equal(res.isError, true, `a refused call is a tool error: ${JSON.stringify(res)}`);
      const text = textOf(res);
      assert.ok(text.startsWith("InstaVision answered HTTP 401: "), text);
      assert.ok(text.includes(KEY_HINT), `the server's hint reaches the agent: ${text}`);
      assert.ok(text.includes("set INSTAVISION_API_KEY in your MCP client config"), `bridge hint: ${text}`);
      assertNoTransportNoise(text);

      const calls = upstream.requests.filter((r) => r.toolName === "launch_discovery");
      assert.equal(calls.length, 1, `the refused call is not retried: ${JSON.stringify(calls)}`);
      assertNoAuthFlow(upstream.requests);

      const after401 = await client.callTool({ name: "estimate_credits", arguments: {} });
      assert.ok(!after401.isError, "the bridge keeps working after a 401");
    } finally {
      await client.close();
    }
  });

  it("a body over the keyless limit: the 413 message reaches the agent, and the bridge keeps working", async () => {
    const { client } = await connectThroughBridge({
      INSTAVISION_MCP_URL: upstream.url,
      INSTAVISION_ALLOW_CUSTOM_URL: "1",
    });
    try {
      const big = "x".repeat(KEYLESS_MAX_BODY_BYTES + 1024);
      const res = await client.callTool({ name: "estimate_credits", arguments: { searchQueries: [big] } });
      assert.equal(res.isError, true, JSON.stringify(res).slice(0, 300));
      assert.equal(textOf(res), `InstaVision answered HTTP 413: ${TOO_LARGE_MESSAGE}`);
      const small = await client.callTool({ name: "estimate_credits", arguments: {} });
      assert.ok(!small.isError, "a normal call after the 413 works");
    } finally {
      await client.close();
    }
  });

  it("a 429 is readable: as a tool error for tools/call, as an error carrying the status elsewhere", async () => {
    const { client } = await connectThroughBridge({
      INSTAVISION_MCP_URL: upstream.url,
      INSTAVISION_ALLOW_CUSTOM_URL: "1",
      INSTAVISION_API_KEY: FAKE_KEY,
    });
    try {
      const res = await client.callTool({ name: "get_run_status", arguments: {} });
      assert.equal(res.isError, true);
      assert.equal(textOf(res), "InstaVision answered HTTP 429: rate_limited (retry after 7 s)");

      await assert.rejects(client.listResources(), (err) => {
        assert.equal(err.code, 429, `the HTTP status is kept as the error code: ${err.code}`);
        assert.equal(err.message, "MCP error 429: InstaVision answered HTTP 429: rate_limited (retry after 7 s)");
        return true;
      });
    } finally {
      await client.close();
    }
  });

  it("a JSON-RPC error from the server passes through with its code and a single prefix", async () => {
    const { client } = await connectThroughBridge({
      INSTAVISION_MCP_URL: upstream.url,
      INSTAVISION_ALLOW_CUSTOM_URL: "1",
      INSTAVISION_API_KEY: FAKE_KEY,
    });
    try {
      await assert.rejects(client.callTool({ name: "no_such_tool", arguments: {} }), (err) => {
        assert.equal(err.code, -32602);
        assert.equal(err.message, "MCP error -32602: Unknown tool: no_such_tool");
        return true;
      });
    } finally {
      await client.close();
    }
  });

  it("a whole session, close included, sends only POSTs plus the SDK's one GET probe — never a DELETE", async () => {
    upstream.requests.length = 0;
    const { client } = await connectThroughBridge({
      INSTAVISION_MCP_URL: upstream.url,
      INSTAVISION_ALLOW_CUSTOM_URL: "1",
      INSTAVISION_API_KEY: FAKE_KEY,
    });
    await client.listTools();
    await client.close(); // the bridge sees stdin end, closes its upstream and exits
    const methods = [...new Set(upstream.requests.map((r) => r.httpMethod))].sort();
    assert.deepEqual(methods, ["GET", "POST"], `HTTP methods seen: ${methods.join(",")}`);
    assert.equal(upstream.requests.filter((r) => r.httpMethod === "GET").length, 1, "one GET probe, answered 405, not retried");
  });

  it("a blank key counts as no key", async () => {
    upstream.requests.length = 0;
    const { client } = await connectThroughBridge({
      INSTAVISION_MCP_URL: upstream.url,
      INSTAVISION_ALLOW_CUSTOM_URL: "1",
      INSTAVISION_API_KEY: "   ",
    });
    try {
      await client.listTools();
      assert.ok(upstream.requests.length > 0, "the upstream saw requests");
      assert.ok(upstream.requests.every((r) => r.authorization === null), JSON.stringify(upstream.requests));
    } finally {
      await client.close();
    }
  });

  it("a refused key at connect: one request, a readable reason on stderr, exit 1", async () => {
    upstream.requests.length = 0;
    const wrongKey = "iv_sk_wrong_test_key";
    const run = await runBridge({
      env: { INSTAVISION_MCP_URL: upstream.url, INSTAVISION_ALLOW_CUSTOM_URL: "1", INSTAVISION_API_KEY: wrongKey },
    });
    assert.equal(run.code, 1, `exit code ${run.code}; stderr: ${run.stderr}`);
    assert.ok(run.stderr.includes(`InstaVision answered HTTP 401: ${BAD_KEY_HINT}`), run.stderr);
    assert.ok(run.stderr.includes("check that value in your MCP client config"), run.stderr);
    // One line says it all: no second "Check your …" line after a 401.
    const failed = run.stderr.split("\n").filter((l) => l.includes("Failed to connect"));
    assert.equal(failed.length, 1, `exactly one 'Failed to connect' line: ${run.stderr}`);
    assert.ok(!run.stderr.includes("Check your"), `no 'Check your' line after a 401: ${run.stderr}`);
    assertNoTransportNoise(run.stderr);
    assert.ok(!run.stderr.includes(wrongKey), "the key must never be printed");
    assert.equal(upstream.requests.length, 1, `no retry, no auth flow: ${JSON.stringify(upstream.requests)}`);
  });
});

describe("server text is untrusted: an echoed key never reaches the agent or stderr; long text is cut", () => {
  const WRONG_KEY = "iv_sk_wrong_test_key";
  let upstream;
  before(async () => {
    upstream = await startFakeUpstream({
      echoInvalidKey: true,
      refusals: {
        // A handler that reflects the Authorization header in its refusal.
        export_run_pdf: (auth) => ({ status: 401, body: JSON.stringify({ error_description: `Refused header: ${auth}` }) }),
        // The key straddles character 500 of the detail: redaction must come before the cut.
        get_run_results: (auth) => ({
          status: 500,
          body: `${"x".repeat(482)}${auth}${"y".repeat(1000)}`,
          contentType: "text/plain",
        }),
        estimate_credits: () => ({ status: 503, body: "z".repeat(1200), contentType: "text/plain" }),
      },
    });
  });
  after(async () => {
    await upstream.close();
  });

  it("a 401 that echoes the Authorization header: the key becomes iv_sk_… in the tool result", async () => {
    const { client, stderr } = await connectThroughBridge({
      INSTAVISION_MCP_URL: upstream.url,
      INSTAVISION_ALLOW_CUSTOM_URL: "1",
      INSTAVISION_API_KEY: FAKE_KEY,
    });
    try {
      const res = await client.callTool({ name: "export_run_pdf", arguments: {} });
      assert.equal(res.isError, true);
      const text = textOf(res);
      assert.ok(text.includes("Refused header: Bearer iv_sk_…"), text);
      assert.ok(!text.includes(FAKE_KEY), `the key leaked into the tool result: ${text}`);
      assert.ok(!stderr().includes(FAKE_KEY), "the key must never be printed");
    } finally {
      await client.close();
    }
  });

  it("a refused key echoed back at connect: stderr shows iv_sk_…, never the key, in one line", async () => {
    const run = await runBridge({
      env: { INSTAVISION_MCP_URL: upstream.url, INSTAVISION_ALLOW_CUSTOM_URL: "1", INSTAVISION_API_KEY: WRONG_KEY },
    });
    assert.equal(run.code, 1, `exit code ${run.code}; stderr: ${run.stderr}`);
    assert.ok(run.stderr.includes("Received: Bearer iv_sk_…"), run.stderr);
    assert.ok(!run.stderr.includes(WRONG_KEY), `the key leaked to stderr: ${run.stderr}`);
    assert.equal(run.stderr.split("\n").filter((l) => l.includes("Failed to connect")).length, 1, run.stderr);
  });

  it("refusal text over 500 characters is cut with '…'", async () => {
    const { client } = await connectThroughBridge({
      INSTAVISION_MCP_URL: upstream.url,
      INSTAVISION_ALLOW_CUSTOM_URL: "1",
    });
    try {
      const res = await client.callTool({ name: "estimate_credits", arguments: {} });
      assert.equal(res.isError, true);
      assert.equal(textOf(res), `InstaVision answered HTTP 503: ${"z".repeat(500)}…`);
    } finally {
      await client.close();
    }
  });

  it("the key is replaced before the cut, so no fragment of it survives at the boundary", async () => {
    const { client } = await connectThroughBridge({
      INSTAVISION_MCP_URL: upstream.url,
      INSTAVISION_ALLOW_CUSTOM_URL: "1",
      INSTAVISION_API_KEY: FAKE_KEY,
    });
    try {
      const res = await client.callTool({ name: "get_run_results", arguments: {} });
      const text = textOf(res);
      // 482 + "Bearer " (7) + "iv_sk_…" (7) + 4 = 500 characters, then the cut.
      assert.equal(text, `InstaVision answered HTTP 500: ${"x".repeat(482)}Bearer iv_sk_…${"y".repeat(4)}…`);
      assert.ok(!text.includes(FAKE_KEY.slice(0, 8)), `a fragment of the key survived: ${text}`);
    } finally {
      await client.close();
    }
  });
});

describe("a redirect to another origin is not followed (SDK ≥ 1.32 'same-origin' policy)", () => {
  let target;
  let redirector;
  before(async () => {
    target = await startFakeUpstream();
    redirector = await startRedirector(target.url); // another port, so another origin
  });
  after(async () => {
    await redirector.close();
    await target.close();
  });

  it("the key never reaches the redirect target; the bridge says why and exits 1", async () => {
    const run = await runBridge({
      env: { INSTAVISION_MCP_URL: redirector.url, INSTAVISION_ALLOW_CUSTOM_URL: "1", INSTAVISION_API_KEY: FAKE_KEY },
    });
    assert.equal(run.code, 1, `exit code ${run.code}; stderr: ${run.stderr}`);
    assert.ok(redirector.hits() >= 1, "the configured endpoint was asked");
    assert.equal(target.requests.length, 0, `the redirect target was reached: ${JSON.stringify(target.requests)}`);
    assert.ok(run.stderr.includes("not followed"), `the refusal names the redirect: ${run.stderr}`);
    assert.ok(!run.stderr.includes(FAKE_KEY), "the key must never be printed");
  });
});

describe("plain JSON answers (no SSE) work the same", () => {
  let upstream;
  before(async () => {
    upstream = await startFakeUpstream({ instructions: INSTRUCTIONS, sse: false });
  });
  after(async () => {
    await upstream.close();
  });

  it("instructions, tools and a call", async () => {
    const { client } = await connectThroughBridge({
      INSTAVISION_MCP_URL: upstream.url,
      INSTAVISION_ALLOW_CUSTOM_URL: "1",
      INSTAVISION_API_KEY: FAKE_KEY,
    });
    try {
      assert.equal(client.getInstructions(), INSTRUCTIONS);
      assert.equal((await client.listTools()).tools.length, 9);
      assert.ok(!(await client.callTool({ name: "get_seen_accounts", arguments: {} })).isError);
    } finally {
      await client.close();
    }
  });
});
