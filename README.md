# instavision-mcp

**InstaVision — Instagram niche discovery for AI agents.**

[InstaVision](https://instavision.co/mcp?utm_source=npm&utm_medium=readme&utm_campaign=iv16)
finds Instagram creators and leads by niche, city, follower range or lookalike
accounts. Ask your agent in plain language ("find forex mentorship accounts in
Nigeria, 2k–50k followers, cap 100 credits") and it will pick a playbook,
estimate credits, launch the run, and return results. Runs show up in your
InstaVision dashboard and use your account's credits: 1 credit = 1 profile
scanned.

There are two ways to connect:

- **Remote:** clients that can send a header to an HTTP MCP server (Claude
  Code, Cursor, Codex) connect straight to `https://instavision.co/api/mcp/mcp`.
  Nothing to install.
- **This package:** `npx instavision-mcp` is a thin local bridge for clients
  that run local (stdio) servers, such as Claude Desktop. It forwards MCP
  traffic, including the server's instructions, to the same hosted server.
  The bridge itself keeps nothing on disk; your key lives in your client's
  config.

Setup guide and limits: [instavision.co/mcp](https://instavision.co/mcp?utm_source=npm&utm_medium=readme&utm_campaign=iv16)

## 1. Get an API key

**[Sign in to InstaVision](https://instavision.co/login?next=/settings/api-keys&utm_source=npm&utm_medium=readme&utm_campaign=iv16)**
(you land on Settings → API keys) and create a key (it's shown once — copy it).
Keys start with `iv_sk_`. Don't type a real key into a command line: it would
stay in your shell history.

## 2. Connect your client

### Claude Code

```bash
read -rs INSTAVISION_API_KEY && claude mcp add --scope user --transport http instavision https://instavision.co/api/mcp/mcp --header "Authorization: Bearer $INSTAVISION_API_KEY"
```

Paste into a terminal (bash or zsh) and press Enter. It then waits for your
key: paste it and press Enter. The key isn't shown or saved to your shell
history; Claude Code stores it in `~/.claude.json` and makes the server
available in every project.

### Cursor — `~/.cursor/mcp.json`

```json
{"mcpServers":{"instavision":{"url":"https://instavision.co/api/mcp/mcp","headers":{"Authorization":"Bearer ${env:INSTAVISION_API_KEY}"}}}}
```

### Codex

```bash
codex mcp add instavision --url https://instavision.co/api/mcp/mcp --bearer-token-env-var INSTAVISION_API_KEY
```

Cursor and Codex read the key from the `INSTAVISION_API_KEY` environment
variable, so it must be set in the environment they start from.

### Claude Desktop (through this package) — `claude_desktop_config.json`

Settings → Developer → Edit Config, add the block below with your key in place
of `iv_sk_...`, then restart Claude Desktop. Any client that runs local MCP
servers can use the same `command`, `args` and `env`.

```json
{
  "mcpServers": {
    "instavision": {
      "command": "npx",
      "args": ["-y", "instavision-mcp"],
      "env": { "INSTAVISION_API_KEY": "iv_sk_..." }
    }
  }
}
```

> **Windows:** if `npx` fails to launch, use `"command": "cmd"` with
> `"args": ["/c", "npx", "-y", "instavision-mcp"]`.

Then ask your agent to "list InstaVision playbooks" to confirm it's connected.

## Without a key

The bridge also starts without `INSTAVISION_API_KEY`: it connects without a key
and prints a hint on stderr. Your client can then list the tools and playbooks
and estimate credits; calls that need your account (launching runs, reading
results, your seen-accounts list, PDF export) fail with a pointer to the API
keys page.

## What your agent can do

List playbooks · estimate credits · launch discovery (spends credits) · check
run status · get results · export a PDF · manage the accounts you've already
seen.

## Environment variables (this package)

| Variable | Required | Description |
| --- | --- | --- |
| `INSTAVISION_API_KEY` | no | Your key from [Settings → API keys](https://instavision.co/login?next=/settings/api-keys&utm_source=npm&utm_medium=readme&utm_campaign=iv16). Without it the bridge connects without a key (see above). |
| `INSTAVISION_MCP_URL` | no | Override the endpoint (default `https://instavision.co/api/mcp/mcp`). It must be `https://instavision.co/…` unless `INSTAVISION_ALLOW_CUSTOM_URL=1`. |
| `INSTAVISION_ALLOW_CUSTOM_URL` | no | `1` allows another https host, or `http://localhost` / `http://127.0.0.1` for development. The bridge then prints a warning naming the host, and your key, if set, is sent there. |

The bridge sends your key only as an `Authorization: Bearer` header to that
endpoint, and checks the endpoint before it sends anything. You can revoke a
key on the API keys page.

InstaVision is an independent product, not affiliated with or endorsed by
Instagram or Meta.

## License

MIT
