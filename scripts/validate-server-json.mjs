#!/usr/bin/env node
// Validates server.json (the official MCP registry manifest) against the
// vendored 2025-12-11 schema, plus the fields that must agree with
// package.json. Runs in CI (mcp-package job) and before `mcp-publisher publish`.
//
//   node scripts/validate-server-json.mjs [path/to/server.json]
//
// server.schema.json is a byte-for-byte copy of
// https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json
// (sha256 below, compared with the live file on 2026-10-02). Moving to a newer
// schema is a deliberate change: replace the file and the pin together.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv from "ajv";
import addFormats from "ajv-formats";

const SCHEMA_SHA256 = "3fba09590c99f61735d234822279f4223fab9e300c0a81e81c91ab62a4114de0";
const SCHEMA_URL = "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";

const pkgDir = fileURLToPath(new URL("..", import.meta.url));
const docPath = resolve(process.argv[2] ?? resolve(pkgDir, "server.json"));

const schemaBytes = readFileSync(resolve(pkgDir, "server.schema.json"));
const doc = JSON.parse(readFileSync(docPath, "utf8"));
const pkg = JSON.parse(readFileSync(resolve(pkgDir, "package.json"), "utf8"));

const problems = [];

const schemaSha = createHash("sha256").update(schemaBytes).digest("hex");
if (schemaSha !== SCHEMA_SHA256) {
  problems.push(`server.schema.json sha256 ${schemaSha} is not the pinned ${SCHEMA_SHA256}`);
}

const schema = JSON.parse(schemaBytes.toString("utf8"));
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
if (!ajv.validate(schema, doc)) {
  for (const e of ajv.errors ?? []) problems.push(`schema: ${e.instancePath || "/"} ${e.message}`);
}

// Fields that must agree with package.json (npm checks mcpName against `name`).
// The entry's own `version` may run ahead of the npm version: registry versions
// are immutable, so adding the npm block after a remote-only publish needs a
// new entry version while npm stays put.
if (doc.$schema !== SCHEMA_URL) problems.push(`$schema must be ${SCHEMA_URL}`);
if (doc.name !== pkg.mcpName) problems.push(`name ${doc.name} != package.json mcpName ${pkg.mcpName}`);
// The schema only describes this rule; the registry enforces it at publish time.
const VERSION_RANGE = /[\^~<>=*\s]|(^|\.)[xX](\.|$)|^latest$/;
if (VERSION_RANGE.test(String(doc.version))) problems.push(`version ${doc.version} must be one specific version`);
const repo = String(pkg.repository?.url ?? "").replace(/^git\+/, "").replace(/\.git$/, "");
if (doc.repository?.url !== repo) problems.push(`repository.url ${doc.repository?.url} != package.json repository ${repo}`);

const remote = doc.remotes?.[0];
if (remote?.type !== "streamable-http") problems.push("remotes[0] must be streamable-http");
const auth = remote?.headers?.find((h) => h.name === "Authorization");
if (!auth || auth.isSecret !== true) problems.push("remotes[0] needs an Authorization header with isSecret: true");

// An npm package entry is added only once that version is on npm (C-25).
for (const p of doc.packages ?? []) {
  if (p.registryType === "npm" && (p.identifier !== pkg.name || p.version !== pkg.version)) {
    problems.push(`packages: npm ${p.identifier}@${p.version} != ${pkg.name}@${pkg.version}`);
  }
}

if (problems.length) {
  console.error(`${docPath}: INVALID`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  `${docPath}: valid against the 2025-12-11 schema (sha256 ${SCHEMA_SHA256.slice(0, 12)}…); ` +
    `name ${doc.name}, version ${doc.version}, description ${doc.description.length}/100 chars, ` +
    `${doc.remotes?.length ?? 0} remote(s), ${doc.packages?.length ?? 0} package(s).`,
);
