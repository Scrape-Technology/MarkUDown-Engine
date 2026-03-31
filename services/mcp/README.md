# MarkUDown MCP Server — Self-Hosted

A [Model Context Protocol](https://modelcontextprotocol.io/) server that connects AI agents (Claude, Cursor, Windsurf, n8n, LangGraph, etc.) directly to your MarkUDown Engine instance.

Unlike the cloud version, this server pushes jobs **directly into BullMQ/Redis** — the same Redis your engine workers consume. No extra HTTP hop, no API key management.

---

## How it works

```
AI Agent (Claude Desktop, Cursor, etc.)
        │  MCP protocol
        ▼
  markudown-mcp  (this server)
        │  BullMQ job dispatch + Redis polling
        ▼
    Redis (shared with engine)
        │
        ▼
  MarkUDown Engine workers
```

---

## Prerequisites

- Node.js >= 20
- A running **MarkUDown Engine** (workers must be active)
- Access to the **same Redis** instance the engine uses

---

## Quick start

```bash
cd services/mcp
npm install
npm run build
node dist/index.js
```

For development (no build step):

```bash
npm run dev
```

---

## Claude Desktop

Add to `claude_desktop_config.json`:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "markudown": {
      "command": "node",
      "args": ["/absolute/path/to/services/mcp/dist/index.js"],
      "env": {
        "REDIS_URL": "redis://localhost:6379"
      }
    }
  }
}
```

Restart Claude Desktop after saving.

---

## HTTP transport (remote agents)

For agents running in a different process or machine, expose an HTTP endpoint instead of stdio:

```bash
MCP_TRANSPORT=http MCP_PORT=3010 node dist/index.js
```

The server uses the **Streamable HTTP** transport (the current MCP standard for remote connections — SSE is deprecated).

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | Redis URL — must point to the same Redis as the engine |
| `MCP_TRANSPORT` | `stdio` | Transport: `stdio` (local) or `http` (remote) |
| `MCP_PORT` | `3010` | Port for HTTP transport (ignored in stdio mode) |

---

## Available tools

### `scrape`
Scrape a single URL and return its content as clean Markdown.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `url` | string | required | URL to scrape |
| `main_content` | boolean | `true` | Strip navigation, ads, and sidebars |
| `include_links` | boolean | `false` | Include hyperlinks in output |
| `timeout` | number | `60` | Timeout in seconds |

---

### `map`
Discover all URLs on a website via sitemap parsing and link crawling.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `url` | string | required | Root URL of the site |
| `max_urls` | number | `1000` | Maximum URLs to return |
| `allowed_words` | string[] | `[]` | Only include URLs containing these words |
| `blocked_words` | string[] | `[]` | Exclude URLs containing these words |

---

### `crawl`
Recursively crawl a website, following internal links up to a specified depth. Returns Markdown per page.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `url` | string | required | Starting URL |
| `max_depth` | number | `5` | Maximum link depth to follow |
| `limit` | number | `1000` | Maximum pages to crawl |
| `main_content` | boolean | `true` | Extract only main content per page |

Timeout: **5 minutes** (crawl jobs can take long).

---

### `search`
Run a Google search and optionally scrape the full content of each result page.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `query` | string | required | Search query |
| `limit` | number | `5` | Number of results to return |
| `lang` | string | `"pt"` | Language code (e.g. `"en"`, `"pt"`) |
| `country` | string | `"br"` | Country code (e.g. `"us"`, `"br"`) |
| `scrape_results` | boolean | `true` | Scrape full content for each result |

---

### `extract`
Scrape a URL and use an LLM to extract structured data based on a natural language prompt.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `url` | string | required | URL to extract data from |
| `prompt` | string | required | What to extract, e.g. `"Extract all product names and prices"` |
| `timeout` | number | `60` | Timeout in seconds |

---

### `batch_scrape`
Scrape multiple URLs in parallel. Returns Markdown for each.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `urls` | string[] | required | List of URLs to scrape |
| `main_content` | boolean | `true` | Extract only main content |
| `timeout` | number | `60` | Per-page timeout in seconds |

---

### `screenshot`
Take a full-page screenshot of a URL. Returns a base64-encoded PNG.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `url` | string | required | URL to screenshot |
| `timeout` | number | `60` | Navigation timeout in seconds |

---

### `deep_research`
Scrape multiple URLs and synthesize their content into a research report using an LLM.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `query` | string | required | Research question or topic |
| `urls` | string[] | required | Source URLs to scrape |
| `max_tokens` | number | `4096` | Maximum tokens for the report |

Timeout: **5 minutes**.

---

### `change_detection`
Check whether a URL's content has changed since it was last scraped.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `url` | string | required | URL to monitor |
| `include_diff` | boolean | `false` | Include previous and current markdown in response |

---

## Building

```bash
npm run build      # Compile TypeScript → dist/
npm run typecheck  # Type check without emitting
npm run dev        # Run with tsx (hot reload, no build needed)
```
