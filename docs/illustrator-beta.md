# Illustrator: Adobe's official MCP beta

Adobe Illustrator **(Beta) 30.4+** ships a built-in MCP server on your machine at
`http://localhost:18412/v1/mcp` (Streamable HTTP, Bearer key). A live probe (see
[`docs/spikes/01-illustrator-beta-tools.md`](spikes/01-illustrator-beta-tools.md)) found **46 tools**. It can create
documents, artboards, layers, and groups; move, scale, rotate, and restyle objects; replace text and fonts;
export; and capture previews. It **cannot draw new shapes, paths, or text**, **cannot save a `.ai`**, and has
no run-script escape hatch. It runs only while Illustrator
Beta is open with *MCP & Tools* enabled.

That is exactly complementary to `adobe-cc-mcp`'s own Illustrator lane (the `ai_*` tools, which
drive ExtendScript to **draw new art and save** the full DOM). So the two compose: our tools draw and
save; Adobe’s arrange, restyle, analyze, and export.

There are two ways to use Adobe's server. Both are fine under Claude Code.

## Get your key

In Illustrator (Beta): **Application Bar ▸ MCP & Tools**. Copy the URL and key (or the ready-made
`claude mcp add …` command). The key looks like `ilst_<64 hex>`, is unique per install, and stays
valid until you **regenerate** it (which invalidates the old one). Treat it as a secret.

## Model A — side-by-side (zero code)

Register Adobe's server directly with Claude Code, alongside `adobe-cc-mcp`:

```bash
claude mcp add --transport http \
  --header "Authorization: Bearer ilst_<your-key>" \
  --scope user illustrator http://localhost:18412/v1/mcp
```

Adobe’s 46 tools then appear next to ours. Simplest, but you get two overlapping Illustrator
menus and our pipeline tools can't call Adobe's.

## Model B — through adobe-cc-mcp (the delegate lane)

Give `adobe-cc-mcp` the key and it proxies Adobe's server behind three tools, so everything is one
server and the key stays on the server side (never in your Claude config, never sent to the model):

- `ai_beta_status` — is Adobe's server reachable, and how many tools does it expose?
- `ai_beta_list_tools` — the exact tools this Illustrator build offers (names + descriptions).
- `ai_beta_call` — run one of them: `{ "tool": "<name>", "arguments": { … } }`.

Set the key one of two ways (env wins):

```bash
# either an env var in your MCP server config…
ADOBE_CC_MCP_ILLUSTRATOR_KEY=ilst_<your-key>

# …or ~/.adobe-cc-mcp/config.json (chmod 600):
# { "illustratorKey": "ilst_<your-key>" }
```

The delegate tools are registered only when a key is set. The connection is **lazy** — it dials
Illustrator on first use, so if Illustrator Beta is closed you get an actionable error, and it
reconnects automatically once you open it. A `401` means the key was regenerated — re-copy it.

> This runs on your machine (Adobe's server is on *your* localhost). A remote/cloud Claude session
> cannot reach it. To enumerate the real tool list, run `ai_beta_list_tools` locally with Illustrator
> Beta open.

## Installer and the move from Beta to the shipping release

`npm run install-cc` asks for the Illustrator key: paste the whole `claude mcp add … Bearer ilst_…`
line Illustrator shows, or just the key. The installer checks it against the endpoint right away
(accepted / Illustrator not running / refused) and saves it to `~/.adobe-cc-mcp/config.json`
(`illustratorKey`). Flags: `--illustrator-key`, `--illustrator-url`, `--no-illustrator`.

When the official release ships and the endpoint or key format changes, nothing in the tools
needs to change: set the new address as `illustratorUrl` in `config.json` (or
`ADOBE_CC_MCP_ILLUSTRATOR_URL`), paste the new key, and re-run the installer. If the pasted
`claude mcp add` line carries a different URL, the installer stores it automatically. Only if
Adobe changes the transport (away from Streamable HTTP + bearer) would
`src/drivers/illustrator-delegate.ts` need an edit.
