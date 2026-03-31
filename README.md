# MarkUDown Engine

High-performance web scraping engine powered by **BullMQ**, **Playwright**, and **Cheerio**. Converts any web page into clean markdown with a 3-layer extraction strategy.

## Architecture

```
                                    MarkUDown Engine
                                          |
                    +---------------------+---------------------+
                    |                     |                     |
              Worker (TS)          Go HTML->MD          Python LLM
              BullMQ + Node.js     Port 3001            Port 3002
                    |                     |                     |
              +-----+-----+         HTML -> MD          Gemini/OpenAI
              |     |     |                             Extract/Research
           Cheerio PW  Abrasio
           (L1)  (L2)  (L3)
```

**Worker (TypeScript)** — Main processing engine. Receives jobs via BullMQ (Redis), scrapes pages using a 3-layer fallback orchestrator, cleans HTML, and converts to markdown.

**Go HTML-to-Markdown** — Lightweight microservice for high-performance HTML-to-markdown conversion (~10-50x faster than JS alternatives). Falls back to in-process Turndown if unavailable.

**Python LLM Service** — Handles AI-powered structured data extraction, schema generation, and deep research synthesis using Gemini.

## 3-Layer Extraction Orchestrator

Each scrape request passes through layers until content is successfully extracted:

| Layer | Engine | Speed | Use Case |
|-------|--------|-------|----------|
| **1** | Cheerio | ~100ms | Static HTML sites (no JS rendering needed) |
| **2** | Playwright | ~2-5s | JavaScript-rendered SPAs, dynamic content |
| **3** | Abrasio | ~5-15s | Anti-bot protected sites (CAPTCHA, fingerprint detection) |

- **Layer 1 (Cheerio)**: HTTP fetch + DOM parsing. No browser overhead. Validates that content is > 50 chars and has no CAPTCHA markers.
- **Layer 2 (Playwright)**: Headless Chromium with semaphore-controlled concurrency. Blocks images/media/fonts for speed. Detects soft blocks (403/429/503).
- **Layer 3 (Abrasio)**: Proprietary stealth engine with browser fingerprinting, CAPTCHA solving, IP rotation, and profile management. **Only available when `ABRASIO_API_URL` is configured.**

Without Abrasio configured, the engine operates in **open-source mode** using Layers 1 and 2.

## Job Types

| Job | Type | Description |
|-----|------|-------------|
| `/scrape` | Sync | Scrape a single URL, return markdown + metadata |
| `/map` | Sync | Discover all URLs on a website (sitemap + link crawl) |
| `/crawl` | Async | Recursively crawl a site with depth/limit controls |
| `/batch-scrape` | Async | Scrape multiple URLs in parallel |
| `/extract` | Async | Scrape + LLM-based structured data extraction |
| `/search` | Async | Google search + scrape results |
| `/screenshot` | Sync | Full-page screenshot via Playwright |
| `/rss` | Async | Generate RSS feed from any web page |
| `/change-detection` | Async | Detect content changes via hash comparison |
| `/deep-research` | Async | Multi-page scrape + LLM synthesis report |
| `/agent` | Async | AI-driven autonomous web navigation — answers a question by iteratively scraping and navigating pages |

**Sync** jobs return results immediately. **Async** jobs return a `job_id` — poll `GET /{job_type}/{job_id}` for status and results.

## Quick Start

### Docker Compose (Recommended)

```bash
# 1. Clone and configure
cp .env.example .env
# Edit .env with your settings (GENAI_API_KEY for LLM features)

# 2. Start all services
docker-compose up -d

# 3. Verify
curl http://localhost:3001/health   # Go service
curl http://localhost:3002/health   # Python LLM service
```

### Development

```bash
# 1. Install dependencies
npm install
npx playwright install chromium

# 2. Start Redis
docker run -d --name redis -p 6379:6379 redis:7-alpine

# 3. Start Go service (optional, falls back to Turndown)
cd services/go-html-to-md && go run . &

# 4. Start Python LLM service (optional, needed for /extract and /deep-research)
cd services/python-llm && pip install -r requirements.txt && python main.py &

# 5. Start worker (with hot-reload)
npm run dev
```

### Build

```bash
npm run build          # Compile TypeScript to dist/
npm run typecheck      # Type check without emitting
npm run lint           # ESLint
```

## Project Structure

```
MarkUDown-Engine/
├── src/                           # TypeScript Worker (main engine)
│   ├── index.ts                   # Entry: starts BullMQ workers + Playwright
│   ├── config.ts                  # Zod-validated environment config
│   ├── engine/
│   │   ├── orchestrator.ts        # 3-layer fallback (Cheerio -> Playwright -> Abrasio)
│   │   ├── cheerio-engine.ts      # Layer 1: HTTP fetch + Cheerio parse
│   │   ├── playwright-engine.ts   # Layer 2: headless browser + semaphore
│   │   └── abrasio-engine.ts      # Layer 3: proprietary stealth API
│   ├── jobs/
│   │   ├── scrape.ts              # Single URL scrape
│   │   ├── crawl.ts               # Recursive BFS crawl
│   │   ├── map.ts                 # URL discovery (sitemap + links)
│   │   ├── batch-scrape.ts        # Parallel multi-URL scrape
│   │   ├── extract.ts             # Scrape + LLM extraction
│   │   ├── search.ts              # Google search + scrape
│   │   ├── screenshot.ts          # Full-page screenshot
│   │   ├── rss.ts                 # RSS feed generation
│   │   ├── change-detection.ts    # Content diff via SHA-256 hash
│   │   ├── deep-research.ts       # Multi-page research synthesis
│   │   └── agent.ts               # AI autonomous navigation agent
│   ├── processors/
│   │   ├── html-cleaner.ts        # Cheerio-based HTML sanitization
│   │   └── markdown-client.ts     # Go service client + Turndown fallback
│   ├── queues/
│   │   ├── connection.ts          # Redis connection
│   │   ├── queues.ts              # BullMQ queue definitions (10 queues)
│   │   └── workers.ts             # Worker registration and lifecycle
│   └── utils/
│       ├── logger.ts              # Winston structured logging
│       ├── errors.ts              # TransportableError hierarchy
│       ├── url-utils.ts           # URL normalize, filter, extract
│       └── redis.ts               # Redis client for auxiliary storage
├── services/
│   ├── go-html-to-md/             # Go microservice (~15MB Docker image)
│   │   ├── main.go                # HTTP server on port 3001
│   │   ├── handler.go             # POST /convert endpoint
│   │   ├── converter.go           # html-to-markdown v2
│   │   ├── go.mod
│   │   └── Dockerfile
│   └── python-llm/                # Python LLM microservice
│       ├── main.py                # FastAPI on port 3002
│       ├── routers/
│       │   ├── extract.py         # POST /extract (Gemini structured extraction)
│       │   ├── schema.py          # POST /schema/create (NL -> JSON schema)
│       │   └── deep_research.py   # POST /deep-research (multi-source synthesis)
│       ├── requirements.txt
│       └── Dockerfile
├── package.json
├── tsconfig.json
├── Dockerfile                     # Worker: node:20-slim + Playwright Chromium
├── docker-compose.yml             # Production: Redis + Worker + Go + Python
├── docker-compose.dev.yml         # Development with hot-reload
└── .env.example
```

## Configuration

All configuration is via environment variables. See [.env.example](.env.example) for the full list.

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_URL` | `redis://localhost:6379` | Redis connection for BullMQ |
| `GO_MD_SERVICE_URL` | `http://localhost:3001` | Go HTML-to-Markdown service |
| `PYTHON_LLM_URL` | `http://localhost:3002` | Python LLM service |
| `ABRASIO_API_URL` | _(empty)_ | Abrasio stealth engine URL (empty = disabled) |
| `ABRASIO_API_KEY` | _(empty)_ | Abrasio API key |
| `GENAI_API_KEY` | _(empty)_ | Google Gemini API key (for /extract, /deep-research) |
| `PROXY_URL` | _(empty)_ | Proxy server address, e.g. `http://host:port` |
| `PROXY_USERNAME` | _(empty)_ | Proxy username prefix — target country code is appended per request (e.g. `user-country-`) |
| `PROXY_PASSWORD` | _(empty)_ | Proxy password |
| `HEADLESS` | `true` | Run Playwright browser in headless mode. Set to `false` to open a visible window (local dev only — requires a display server such as Xvfb in Docker) |
| `MAX_CONCURRENT_PAGES` | `10` | Max simultaneous Playwright pages |
| `MAX_CRAWL_DEPTH` | `5` | Default max crawl depth |
| `MAX_CRAWL_URLS` | `1000` | Default max URLs per crawl |
| `DEFAULT_TIMEOUT` | `60` | Default timeout in seconds |

## API Integration

MarkUDown Engine is designed to be used with a separate API gateway that handles authentication, billing, and rate limiting. The API pushes jobs to BullMQ queues and polls Redis for results.

### Push a Job (Python example with python-bullmq)

```python
from bullmq import Queue

queue = Queue("scrape", {"connection": "redis://localhost:6379"})

job = await queue.add("scrape", {
    "url": "https://example.com",
    "options": {
        "main_content": True,
        "include_link": True,
        "timeout": 60
    }
})

print(f"Job ID: {job.id}")
```

### Poll for Results

```python
import redis
import json

r = redis.from_url("redis://localhost:6379", decode_responses=True)

# Check job status
key = f"bull:scrape:{job_id}"
finished = r.hget(key, "finishedOn")

if finished:
    result = json.loads(r.hget(key, "returnvalue"))
    print(result["data"]["markdown"])
```

### Job Data Formats

**Scrape Job:**
```json
{
  "url": "https://example.com",
  "options": {
    "timeout": 60,
    "exclude_tags": ["nav", "footer"],
    "main_content": true,
    "include_link": true,
    "include_html": false,
    "force_playwright": false,
    "force_abrasio": false
  }
}
```

**Crawl Job:**
```json
{
  "url": "https://example.com",
  "options": {
    "max_depth": 3,
    "limit": 50,
    "concurrency": 5,
    "blocked_words": ["login", "admin"],
    "allowed_patterns": ["/blog/", "/docs/"],
    "main_content": true
  }
}
```

**Extract Job:**
```json
{
  "url": "https://example.com/products",
  "schema": {
    "name": "string",
    "price": "float",
    "description": "string",
    "url": "url"
  },
  "extract_query": "Extract all product listings"
}
```

**Map Job:**
```json
{
  "url": "https://example.com",
  "options": {
    "max_urls": 500,
    "allowed_words": ["blog", "docs"],
    "blocked_words": ["login", "cart"]
  }
}
```

**Batch Scrape Job:**
```json
{
  "urls": ["https://example.com/page1", "https://example.com/page2"],
  "options": {
    "main_content": true,
    "timeout": 30
  }
}
```

**Search Job:**
```json
{
  "query": "best web scraping tools 2026",
  "options": {
    "limit": 5,
    "scrape_results": true,
    "lang": "en",
    "country": "us"
  }
}
```

**RSS Job:**
```json
{
  "url": "https://example.com/blog",
  "options": {
    "max_items": 20,
    "title": "Example Blog Feed"
  }
}
```

**Screenshot Job:**
```json
{
  "url": "https://example.com",
  "options": {
    "full_page": true,
    "type": "png",
    "timeout": 30
  }
}
```

**Change Detection Job:**
```json
{
  "url": "https://example.com/pricing",
  "options": {
    "main_content": true,
    "include_diff": true
  }
}
```

**Deep Research Job:**
```json
{
  "query": "Compare pricing strategies of SaaS companies",
  "urls": [
    "https://example1.com/pricing",
    "https://example2.com/pricing"
  ],
  "options": {
    "max_tokens": 4096
  }
}
```

**Agent Job:**
```json
{
  "url": "https://example.com",
  "prompt": "What is the return policy and how many days do I have to return a product?",
  "options": {
    "timeout": 60,
    "max_steps": 10,
    "max_pages": 5,
    "allow_navigation": true,
    "main_content": true
  }
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `max_steps` | `10` | Max LLM decision steps (capped at 25) |
| `max_pages` | `5` | Max pages the agent can navigate to (capped at 15) |
| `allow_navigation` | `true` | Allow the agent to follow links to other pages |
| `main_content` | `true` | Strip nav/footer/ads from pages before sending to LLM |

**Agent Response:**
```json
{
  "success": true,
  "data": {
    "url": "https://example.com",
    "answer": "You have 30 days to return any product in original condition...",
    "steps": [
      {
        "step": 1,
        "url": "https://example.com",
        "action": "navigate",
        "reasoning": "Need to find the returns policy page",
        "result": "Navigating to: https://example.com/returns"
      },
      {
        "step": 2,
        "url": "https://example.com/returns",
        "action": "answer",
        "reasoning": "Found the complete returns policy on this page",
        "result": "You have 30 days to return..."
      }
    ],
    "pages_visited": ["https://example.com", "https://example.com/returns"],
    "total_steps": 2
  },
  "processing_time_ms": 4821
}
```

> **Note:** Requires `GENAI_API_KEY`. The agent uses the Python LLM service (`/agent/step/`) to decide the next action at each step. Without Abrasio configured, scraping uses Cheerio → Playwright fallback.

## Response Formats

### Scrape Response

```json
{
  "success": true,
  "data": {
    "url": "https://example.com",
    "markdown": "# Example Domain\n\nThis domain is for use in illustrative examples...",
    "links": ["https://www.iana.org/domains/example"],
    "metadata": {
      "title": "Example Domain",
      "description": "",
      "source": "cheerio",
      "statusCode": 200
    }
  },
  "processing_time_ms": 145
}
```

### Crawl Response

```json
{
  "success": true,
  "status": "completed",
  "total": 15,
  "data": [
    {
      "url": "https://example.com",
      "markdown": "# Page content...",
      "metadata": { "title": "...", "source": "cheerio", "statusCode": 200 }
    }
  ],
  "processing_time_ms": 12500
}
```

### Extract Response

```json
{
  "success": true,
  "data": [
    { "name": "Product A", "price": 29.99, "description": "...", "url": "..." },
    { "name": "Product B", "price": 49.99, "description": "...", "url": "..." }
  ],
  "total": 2,
  "url": "https://example.com/products",
  "processing_time_ms": 8500
}
```

## Self-Hosting Guide

### Requirements

- **Docker** and **Docker Compose** (recommended)
- OR: Node.js 20+, Redis 7+, Go 1.22+ (optional), Python 3.10+ (optional)

### Production Deployment

```bash
# 1. Configure
cp .env.example .env
# Set GENAI_API_KEY for LLM features
# Set ABRASIO_API_URL/KEY for stealth mode (optional, paid)

# 2. Build and run
docker-compose up -d --build

# 3. Monitor
docker-compose logs -f worker
```

### Kubernetes

The worker, Go service, and Python LLM service each have their own Dockerfile and can be deployed as separate Kubernetes Deployments with a shared Redis (or Redis Cluster) as the message broker.

### Scaling

- **Horizontal**: Run multiple worker replicas. BullMQ handles job distribution across workers automatically.
- **Vertical**: Increase `MAX_CONCURRENT_PAGES` for more simultaneous Playwright pages per worker (requires more RAM).
- **Recommended**: 1 worker per 2 CPU cores, 2GB RAM per worker.

## Python LLM Service API

Base URL: `http://localhost:3002`

All endpoints accept and return `application/json`.

---

### `POST /extract/`

Extract structured data from Markdown content using Gemini.

**Request body:**

```json
{
  "url": "https://example.com/products",
  "markdown": "# Products\n...",
  "schema_fields": {
    "name": "string",
    "price": "float",
    "url": "url",
    "in_stock": "boolean"
  },
  "extraction_scope": "list_page",
  "extraction_target": "products",
  "extract_query": "scrape all products with their prices"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `markdown` | string | Yes | Markdown content of the page |
| `url` | string | No | Source URL |
| `schema_fields` | object | No* | Field names → types (`string`, `float`, `integer`, `date`, `url`, `boolean`) |
| `prompt` | string | No* | Free-form extraction instruction (alternative to `schema_fields`) |
| `extract_query` | string | No | Natural-language description of what to extract |
| `extraction_scope` | string | No | One of: `whole_site`, `category`, `single_page`, `list_page`, `search_query` |
| `extraction_target` | string | No | Target category or search term |

*At least one of `schema_fields`, `prompt`, or `extract_query` is required.

**Response:**

```json
{
  "success": true,
  "data": [
    { "name": "Widget A", "price": 29.99, "url": "https://example.com/widget-a", "in_stock": true },
    { "name": "Widget B", "price": 49.99, "url": "https://example.com/widget-b", "in_stock": false }
  ],
  "total": 2
}
```

---

### `POST /schema/create`

Generate a scraping schema from a natural language query.

**Request body:**

```json
{ "query": "Scrape all laptop listings from https://store.example.com including name, price, and specs" }
```

**Response:**

```json
{
  "success": true,
  "schema": {
    "url": "https://store.example.com",
    "extraction_scope": "list_page",
    "extraction_target": null,
    "name": "string",
    "price": "float",
    "specs": "string",
    "allowed_words": ["laptop", "notebook", "specs", "buy"],
    "blocked_words": ["cart", "checkout", "login"],
    "allowed_patterns": ["/laptops/", "/notebooks/"],
    "blocked_patterns": ["/cart", "/account"]
  }
}
```

The returned schema can be passed directly as `schema_fields` in a `/extract/` call or to the TypeScript worker's `extract` job.

---

### `POST /summarize/`

Summarize a web page into title, prose summary, and key points.

**Request body:**

```json
{
  "url": "https://example.com/article",
  "markdown": "# Title\n...",
  "max_length": 300,
  "language": "English"
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `markdown` | string | — | Page content in Markdown |
| `url` | string | null | Source URL |
| `max_length` | integer | 500 | Target summary length in words |
| `language` | string | null | Output language (defaults to source language) |

**Response:**

```json
{
  "success": true,
  "title": "How to Build a Web Scraper in 2024",
  "summary": "This article covers the fundamentals of web scraping...",
  "key_points": [
    "Choose between static (Cheerio) and dynamic (Playwright) scrapers",
    "Respect robots.txt and rate limits",
    "Use proxies for large-scale scraping"
  ]
}
```

---

### `POST /deep-research/`

Synthesize a comprehensive research report from multiple scraped pages.

**Request body:**

```json
{
  "query": "What are the best practices for web scraping in 2024?",
  "pages": [
    { "url": "https://source1.com", "title": "Web Scraping Guide", "markdown": "..." },
    { "url": "https://source2.com", "markdown": "..." }
  ],
  "max_tokens": 4096
}
```

**Response:**

```json
{
  "success": true,
  "research": "## Web Scraping Best Practices\n\nBased on [Source 1] and [Source 2]...",
  "sources": ["https://source1.com", "https://source2.com"],
  "pages_analyzed": 2
}
```

---

### `POST /agent/step/`

Execute one step of an autonomous web navigation agent. The caller is responsible for driving the loop: navigate to `target_url`, feed the new page back in the next request, and stop when `action` is `"answer"` or `"done"`.

**Request body:**

```json
{
  "prompt": "Find the price of the MacBook Pro 16-inch",
  "current_url": "https://www.apple.com",
  "page_content": "# Apple\nShop iPhone, Mac, iPad...",
  "available_links": ["https://www.apple.com/mac/", "https://www.apple.com/macbook-pro/"],
  "steps_so_far": [],
  "pages_visited": [],
  "step_number": 1,
  "max_steps": 10,
  "allow_navigation": true
}
```

**Response:**

```json
{
  "action": "navigate",
  "reasoning": "The homepage doesn't show prices. I should go to the MacBook Pro page.",
  "answer": null,
  "target_url": "https://www.apple.com/macbook-pro/",
  "extracted_data": null
}
```

| Action | Description |
|--------|-------------|
| `navigate` | Go to `target_url` and call again with the new page content |
| `extract` | Data extracted from the current page is in `extracted_data` |
| `answer` | Final answer is in `answer` — stop the loop |
| `done` | All data compiled — stop the loop |

---

### `GET /health`

```json
{ "status": "healthy", "service": "python-llm" }
```

---

## Technology Stack

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Job Queue | BullMQ (Redis) | Reliable job processing with retries |
| Worker Runtime | Node.js 20 + TypeScript | High-performance async I/O |
| HTTP Scraping | Cheerio + undici | Fast DOM parsing without browser |
| Browser Scraping | Playwright (Chromium) | JS-rendered content extraction |
| HTML to Markdown | Go (html-to-markdown v2) | High-performance conversion |
| Markdown Fallback | Turndown | In-process JS fallback |
| LLM Extraction | Python + Gemini | Structured data extraction |
| Logging | Winston | Structured JSON logging |
| Config Validation | Zod | Runtime env var validation |

## Support & Community

| Channel | Link |
|---------|------|
| 💬 Discord | [discord.gg/GBSKsC8DvS](https://discord.gg/GBSKsC8DvS) |
| 📧 Email | [joao.sobhie@scrapetechnology.com](mailto:joao.sobhie@scrapetechnology.com) |
| 🌐 API Docs | [scrapetechnology.com/markudown/docs](https://scrapetechnology.com/markudown/docs) |

For bug reports and feature requests, open a thread in the `#markudown-feedback` channel on Discord.

## License

AGPL-3.0
