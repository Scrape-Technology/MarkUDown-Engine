import * as cheerio from "cheerio";
import { parseHTML } from "linkedom";
import { extractLinksFromHtml } from "../utils/url-utils.js";
import { logger } from "../utils/logger.js";

// defuddle's "./node" subpath only declares an "import" export condition (no
// "require" fallback), but this package compiles to CommonJS (no "type":
// "module" in package.json) — a static `import` here transpiles to a
// `require()` that Node's CJS resolver rejects with ERR_PACKAGE_PATH_NOT_EXPORTED,
// confirmed via a real build+run, not just reasoning about it. Dynamic
// `import()` always resolves via ESM rules regardless of the caller's own
// module type, which is the standard way to consume an ESM-only package from
// CJS — so it's loaded lazily here instead of statically. Cached as a module-
// level promise so the dynamic import only happens once per process.
let defuddleModule: Promise<typeof import("defuddle/node")> | undefined;
function loadDefuddle(): Promise<typeof import("defuddle/node")> {
  if (!defuddleModule) defuddleModule = import("defuddle/node");
  return defuddleModule;
}

export interface CleanResult {
  html: string;
  links: string[];
  title: string;
  description: string;
}

const DEFAULT_REMOVE_TAGS = [
  "script", "style", "noscript", "iframe", "svg",
  "nav", "header", "footer",
];

const STRIP_ATTRS = ["class", "id", "style", "onclick", "onload", "data-*"];

/**
 * Density-based main-content extraction (Defuddle, over a linkedom DOM — not
 * jsdom, notably lighter/faster for a server-side batch job). Replaces the old
 * `$("main") || $("article") || $('[role="main"]')` fallback, which had no
 * scoring at all: the moment a page had none of those three, it silently fell
 * through to the ENTIRE document (sidebar, cookie banner, related-articles
 * widget, comments — all of it treated as content). Runs on the untouched raw
 * HTML so Defuddle sees the structural cues (nav/header/etc.) it needs to score
 * against, before our own DEFAULT_REMOVE_TAGS pass ever removes them.
 *
 * Best-effort: any failure here (malformed HTML, no confident content region)
 * falls back to the caller running the old tag-removal pipeline on the full
 * document, same as pre-Defuddle behavior — never a hard failure for a job.
 */
async function extractMainContentHtml(html: string, baseUrl: string): Promise<string | null> {
  try {
    const { Defuddle } = await loadDefuddle();
    const { document } = parseHTML(html);
    const result = await Defuddle(document, baseUrl);
    return result.content || null;
  } catch (err) {
    logger.debug("Defuddle main-content extraction failed, falling back to full document", {
      baseUrl,
      error: (err as Error).message,
    });
    return null;
  }
}

export async function cleanHtml(
  html: string,
  baseUrl: string,
  opts: {
    excludeTags?: string[];
    mainContent?: boolean;
    includeLinks?: boolean;
  } = {},
): Promise<CleanResult> {
  const $original = cheerio.load(html);

  // Extract metadata before cleaning
  const title = $original("title").first().text().trim() || $original("h1").first().text().trim() || "";
  const description = $original('meta[name="description"]').attr("content") || "";

  // Extract links from the FULL original document, regardless of mainContent —
  // preserves the pre-existing behavior (links were always page-wide, not
  // scoped to whatever the content-selection heuristic picked).
  const links = opts.includeLinks !== false ? extractLinksFromHtml($original, baseUrl) : [];

  // For mainContent, run the density-based extractor on the RAW html first;
  // otherwise (or on extractor failure) clean the full original document, same
  // as before.
  const mainContentHtml = opts.mainContent ? await extractMainContentHtml(html, baseUrl) : null;
  const $ = mainContentHtml ? cheerio.load(mainContentHtml) : $original;

  // Remove unwanted tags
  const tagsToRemove = [...DEFAULT_REMOVE_TAGS, ...(opts.excludeTags ?? [])];
  for (const tag of tagsToRemove) {
    $(tag).remove();
  }

  // Strip presentation attributes
  $("*").each((_, el) => {
    const elem = $(el);
    for (const attr of STRIP_ATTRS) {
      if (attr.endsWith("*")) {
        const prefix = attr.slice(0, -1);
        const node = el as any;
        if (node.attribs) {
          for (const key of Object.keys(node.attribs)) {
            if (key.startsWith(prefix)) elem.removeAttr(key);
          }
        }
      } else {
        elem.removeAttr(attr);
      }
    }
  });

  // Resolve relative URLs
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (href && !href.startsWith("http") && !href.startsWith("#") && !href.startsWith("javascript:")) {
      try {
        $(el).attr("href", new URL(href, baseUrl).href);
      } catch {}
    }
  });
  $("img[src]").each((_, el) => {
    const src = $(el).attr("src");
    if (src && !src.startsWith("http") && !src.startsWith("data:")) {
      try {
        $(el).attr("src", new URL(src, baseUrl).href);
      } catch {}
    }
  });

  const cleanedHtml = $.html();

  return { html: cleanedHtml, links, title, description };
}
