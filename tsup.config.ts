import { defineConfig } from "tsup";

// Compiles src/index.ts -> dist/index.js (ESM, Node 18+) with an executable
// shebang. The MCP SDK stays external (declared in `dependencies`) and is
// installed by npm/npx at install time — keeps the published tarball tiny.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node18",
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
});
