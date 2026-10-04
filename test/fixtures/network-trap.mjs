// Preloaded into the bridge with `node --import` by the tests. The bridge's
// upstream transport sends every request through the global fetch, so
// replacing it here records each attempt on stderr and refuses it: a test can
// prove what would have left the process (or that nothing did) without ever
// touching the real network. The Authorization header is reported as present
// or absent only, never its value.
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const headers = new Headers(init?.headers);
  const auth = headers.has("authorization") ? "yes" : "no";
  process.stderr.write(`NETWORK_ATTEMPT ${init?.method ?? "GET"} ${url} auth=${auth}\n`);
  throw new TypeError("network disabled by the test trap");
};
