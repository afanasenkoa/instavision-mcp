// C-25 URL guard: INSTAVISION_MCP_URL must be https and on instavision.co,
// unless INSTAVISION_ALLOW_CUSTOM_URL=1 (which also unlocks http://localhost
// and http://127.0.0.1); nothing is sent before the checks pass.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { FAKE_KEY, readJson, runBridge, startFakeUpstream } from "./helpers.mjs";

const HOSTED = readJson("server.json").remotes[0].url;

/** A refusal: exit 1, the guard's message, and not one outbound request. */
function assertRefused(run, mustMention) {
  assert.equal(run.timedOut, false, `bridge did not exit; stderr: ${run.stderr}`);
  assert.equal(run.code, 1, `exit code ${run.code}; stderr: ${run.stderr}`);
  assert.deepEqual(run.attempts, [], `requests were attempted: ${run.attempts.join(" | ")}`);
  assert.ok(run.stderr.includes(mustMention), `stderr should mention ${mustMention}: ${run.stderr}`);
  assert.ok(!run.stderr.includes(FAKE_KEY), "the key must never be printed");
  assert.equal(run.stdout, "", "stdout is the protocol channel and stays empty");
}

describe("refused before any request", () => {
  const cases = [
    ["foreign http, no flag", { INSTAVISION_MCP_URL: "http://evil.example/api/mcp/mcp" }, "https://"],
    [
      "foreign http, with the flag",
      { INSTAVISION_MCP_URL: "http://evil.example/api/mcp/mcp", INSTAVISION_ALLOW_CUSTOM_URL: "1" },
      "https://",
    ],
    ["foreign https, no flag", { INSTAVISION_MCP_URL: "https://evil.example/api/mcp/mcp" }, "evil.example"],
    [
      "look-alike host, no flag",
      { INSTAVISION_MCP_URL: "https://instavision.co.evil.example/api/mcp/mcp" },
      "instavision.co.evil.example",
    ],
    ["www subdomain is another host", { INSTAVISION_MCP_URL: "https://www.instavision.co/api/mcp/mcp" }, "www.instavision.co"],
    ["localhost http, no flag", { INSTAVISION_MCP_URL: "http://localhost:3000/api/mcp/mcp" }, "INSTAVISION_ALLOW_CUSTOM_URL=1"],
    ["127.0.0.1 http, no flag", { INSTAVISION_MCP_URL: "http://127.0.0.1:3000/api/mcp/mcp" }, "INSTAVISION_ALLOW_CUSTOM_URL=1"],
    [
      "flag must be exactly 1",
      { INSTAVISION_MCP_URL: "http://localhost:3000/api/mcp/mcp", INSTAVISION_ALLOW_CUSTOM_URL: "true" },
      "INSTAVISION_ALLOW_CUSTOM_URL=1",
    ],
    [
      "IPv6 loopback over http is not on the list",
      { INSTAVISION_MCP_URL: "http://[::1]:3000/api/mcp/mcp", INSTAVISION_ALLOW_CUSTOM_URL: "1" },
      "https://",
    ],
    [
      "credentials in the URL",
      { INSTAVISION_MCP_URL: "https://user:pw@127.0.0.1/api/mcp/mcp", INSTAVISION_ALLOW_CUSTOM_URL: "1" },
      "user name or password",
    ],
    ["not a URL", { INSTAVISION_MCP_URL: "instavision.co/api/mcp/mcp" }, "not a valid URL"],
    ["another scheme", { INSTAVISION_MCP_URL: "ws://instavision.co/api/mcp/mcp", INSTAVISION_ALLOW_CUSTOM_URL: "1" }, "https://"],
  ];
  for (const [name, env, mention] of cases) {
    for (const withKey of [true, false]) {
      it(`${name} (${withKey ? "with" : "without"} a key)`, async () => {
        const run = await runBridge({
          env: withKey ? { ...env, INSTAVISION_API_KEY: FAKE_KEY } : env,
          trap: true,
        });
        assertRefused(run, mention);
      });
    }
  }
});

describe("a refused local URL gets no connection at all", () => {
  let upstream;
  before(async () => {
    upstream = await startFakeUpstream();
  });
  after(async () => {
    await upstream.close();
  });

  it("http://127.0.0.1 without the flag: the server sees 0 requests", async () => {
    const run = await runBridge({ env: { INSTAVISION_MCP_URL: upstream.url, INSTAVISION_API_KEY: FAKE_KEY } });
    assert.equal(run.code, 1, `exit code ${run.code}; stderr: ${run.stderr}`);
    assert.equal(upstream.requests.length, 0, `server saw ${JSON.stringify(upstream.requests)}`);
  });
});

describe("allowed endpoints", () => {
  it("default endpoint: the hosted URL, no warning, key sent as a header", async () => {
    const run = await runBridge({ env: { INSTAVISION_API_KEY: FAKE_KEY }, trap: true });
    assert.equal(run.attempts[0], `POST ${HOSTED} auth=yes`, run.stderr);
    assert.ok(!run.stderr.includes("WARNING"), `no warning expected: ${run.stderr}`);
    assert.ok(!run.stderr.includes(FAKE_KEY), "the key must never be printed");
  });

  it("explicit https://instavision.co (any case) is the hosted server: no flag, no warning", async () => {
    const run = await runBridge({
      env: { INSTAVISION_MCP_URL: "HTTPS://InstaVision.co/api/mcp/mcp", INSTAVISION_API_KEY: FAKE_KEY },
      trap: true,
    });
    assert.equal(run.attempts[0], `POST ${HOSTED} auth=yes`, run.stderr);
    assert.ok(!run.stderr.includes("WARNING"), `no warning expected: ${run.stderr}`);
  });

  it("foreign https with the flag: allowed, with a warning naming the host", async () => {
    const run = await runBridge({
      env: {
        INSTAVISION_MCP_URL: "https://staging.example.net/api/mcp/mcp",
        INSTAVISION_ALLOW_CUSTOM_URL: "1",
        INSTAVISION_API_KEY: FAKE_KEY,
      },
      trap: true,
    });
    assert.ok(/WARNING.*staging\.example\.net/.test(run.stderr), `warning should name the host: ${run.stderr}`);
    assert.ok(run.stderr.includes("Your INSTAVISION_API_KEY is sent to this host"), run.stderr);
    assert.equal(run.attempts[0], "POST https://staging.example.net/api/mcp/mcp auth=yes", run.stderr);
    // The warning comes before the first request.
    assert.ok(run.stderr.indexOf("WARNING") < run.stderr.indexOf("NETWORK_ATTEMPT"), run.stderr);
  });

  it("the warning does not claim a key is sent when none is set", async () => {
    const run = await runBridge({
      env: { INSTAVISION_MCP_URL: "https://staging.example.net/api/mcp/mcp", INSTAVISION_ALLOW_CUSTOM_URL: "1" },
      trap: true,
    });
    assert.ok(/WARNING.*staging\.example\.net/.test(run.stderr), run.stderr);
    assert.ok(!run.stderr.includes("is sent to this host"), run.stderr);
    assert.equal(run.attempts[0], "POST https://staging.example.net/api/mcp/mcp auth=no", run.stderr);
  });

  for (const host of ["localhost", "127.0.0.1"]) {
    it(`http://${host} with the flag: allowed, with a warning`, async () => {
      const run = await runBridge({
        env: {
          INSTAVISION_MCP_URL: `http://${host}:3999/api/mcp/mcp`,
          INSTAVISION_ALLOW_CUSTOM_URL: "1",
          INSTAVISION_API_KEY: FAKE_KEY,
        },
        trap: true,
      });
      assert.ok(run.stderr.includes(`WARNING: using a custom endpoint, ${host}:3999`), run.stderr);
      assert.equal(run.attempts[0], `POST http://${host}:3999/api/mcp/mcp auth=yes`, run.stderr);
    });
  }

  it("never logs the query string of the endpoint", async () => {
    const run = await runBridge({
      env: {
        INSTAVISION_MCP_URL: "https://staging.example.net/api/mcp/mcp?token=should-not-be-logged",
        INSTAVISION_ALLOW_CUSTOM_URL: "1",
      },
      trap: true,
    });
    const logged = run.stderr
      .split("\n")
      .filter((l) => !l.startsWith("NETWORK_ATTEMPT "))
      .join("\n");
    assert.ok(!logged.includes("should-not-be-logged"), logged);
  });
});
