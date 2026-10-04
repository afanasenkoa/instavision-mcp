// What the registry, npm and Glama read: server.json, package.json, glama.json
// (C-25), and the validator CI runs on server.json.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { PACKAGE_DIR, readJson } from "./helpers.mjs";

const server = readJson("server.json");
const pkg = readJson("package.json");
const glama = readJson("glama.json");

function validate(path) {
  const args = ["scripts/validate-server-json.mjs"];
  if (path) args.push(path);
  return spawnSync(process.execPath, args, { cwd: PACKAGE_DIR, encoding: "utf8" });
}

describe("server.json", () => {
  it("passes the validator (vendored 2025-12-11 schema + package.json agreement)", () => {
    const run = validate();
    assert.equal(run.status, 0, `validator failed:\n${run.stdout}${run.stderr}`);
  });

  it("carries the C-25 values", () => {
    assert.equal(server.name, "co.instavision/instagram-discovery");
    assert.equal(
      server.description,
      "Find Instagram creators and leads by niche, city, follower range or lookalike accounts.",
    );
    assert.ok(!/email/i.test(server.description), "no email claim in the description");
    assert.equal(
      server.websiteUrl,
      "https://instavision.co/mcp?utm_source=mcp-registry&utm_medium=listing&utm_campaign=iv16",
    );
    assert.deepEqual(server.remotes.map((r) => [r.type, r.url]), [
      ["streamable-http", "https://instavision.co/api/mcp/mcp"],
    ]);
    // C-25: the npm entry, added once 0.2.0 was live on npm (2026-10-04) —
    // exactly one, for exactly package.json's version, run over stdio.
    assert.deepEqual(
      server.packages?.map((p) => [p.registryType, p.identifier, p.version, p.transport?.type]),
      [["npm", "instavision-mcp", pkg.version, "stdio"]],
    );
    assert.equal(server.version, "0.2.1", "registry versions are immutable: 0.2.0 went out remote-only");
    assert.ok(server.title.startsWith("InstaVision — "), `title must be qualified (C-30): ${server.title}`);
  });

  describe("the validator rejects", () => {
    const broken = [
      ["a description over 100 chars", { ...server, description: "x".repeat(101) }, "description"],
      ["a name without a namespace", { ...server, name: "instagram-discovery" }, "name"],
      ["a name that is not package.json's mcpName", { ...server, name: "co.instavision/other" }, "mcpName"],
      ["a version range", { ...server, version: "^0.2.0" }, "version"],
      [
        "an Authorization header that is not secret",
        {
          ...server,
          remotes: [{ ...server.remotes[0], headers: [{ name: "Authorization", isSecret: false }] }],
        },
        "isSecret",
      ],
      [
        "an npm entry for another version",
        {
          ...server,
          packages: [
            { registryType: "npm", identifier: "instavision-mcp", version: "0.1.0", transport: { type: "stdio" } },
          ],
        },
        "packages",
      ],
    ];
    for (const [name, doc, mention] of broken) {
      it(name, () => {
        const dir = mkdtempSync(join(tmpdir(), "iv-server-json-"));
        try {
          const path = join(dir, "server.json");
          writeFileSync(path, JSON.stringify(doc));
          const run = validate(path);
          assert.equal(run.status, 1, `expected a failure:\n${run.stdout}${run.stderr}`);
          assert.ok(run.stderr.includes(mention), `stderr should mention ${mention}:\n${run.stderr}`);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  });
});

describe("package.json", () => {
  it("is the npm package the registry entry names", () => {
    assert.equal(pkg.name, "instavision-mcp");
    assert.equal(pkg.mcpName, server.name, "npm proves registry ownership through mcpName");
    assert.equal(pkg.version, "0.2.0");
    assert.equal(pkg.repository?.url, "git+https://github.com/afanasenkoa/instavision-mcp.git");
    assert.equal(pkg.homepage, "https://instavision.co/mcp");
    assert.equal(pkg.bugs?.url, "https://github.com/afanasenkoa/instavision-mcp/issues");
    assert.deepEqual(pkg.files, ["dist", "README.md", "LICENSE"]);
    assert.ok(!/[^\s@"]+@[^\s@"]+\.[a-z]{2,}/i.test(JSON.stringify(pkg)), "no email address in package.json");
  });
});

describe("glama.json", () => {
  it("lists maintainers by GitHub username only, never an email", () => {
    assert.deepEqual(glama, {
      $schema: "https://glama.ai/mcp/schemas/server.json",
      maintainers: ["afanasenkoa"],
    });
    assert.ok(!JSON.stringify(glama.maintainers).includes("@"), "no email in maintainers");
  });
});
