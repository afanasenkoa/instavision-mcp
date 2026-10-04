// The npm tarball holds the built bridge and its docs, nothing else: no
// sources, tests, manifests or lockfile.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { it } from "node:test";

import { PACKAGE_DIR } from "./helpers.mjs";

it("npm pack ships only dist/index.js, README.md, LICENSE and package.json", () => {
  const run = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: PACKAGE_DIR,
    encoding: "utf8",
  });
  assert.equal(run.status, 0, `npm pack failed:\n${run.stderr}`);
  const [report] = JSON.parse(run.stdout);
  const files = report.files.map((f) => f.path).sort();
  assert.deepEqual(files, ["LICENSE", "README.md", "dist/index.js", "package.json"]);
});
