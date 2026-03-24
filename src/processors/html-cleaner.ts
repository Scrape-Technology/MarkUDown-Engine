import * as cheerio from "cheerio";
import { extractLinksFromHtml } from "../utils/url-utils.js";

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

export function cleanHtml(
  html: string,
  baseUrl: string,
  opts: {
    excludeTags?: string[];
    mainContent?: boolean;
    includeLinks?: boolean;
  } = {},
): CleanResult {
  const $ = cheerio.load(html);

  // Extract metadata before cleaning
  const title = $("title").first().text().trim() || $("h1").first().text().trim() || "";
  const description = $('meta[name="description"]').attr("content") || "";

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

  // Extract links
  const links = opts.includeLinks !== false ? extractLinksFromHtml($, baseUrl) : [];

  // If mainContent, try to extract <main> or <article>
  let cleanedHtml: string;
  if (opts.mainContent) {
    const main = $("main").html() || $("article").html() || $('[role="main"]').html();
    cleanedHtml = main || $.html();
  } else {
    cleanedHtml = $.html();
  }

  return { html: cleanedHtml, links, title, description };
}
