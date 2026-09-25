import * as cheerio from "cheerio";
import type { AnyNode as Element } from "domhandler";

/**
 * Pure (no network) helpers for the dataset job: selector-plan extraction,
 * URL absolutization and the plan quality gate. Kept separate from dataset.ts
 * so they can be unit-tested without the queue/browser/LLM dependencies.
 */

export interface FieldSelector {
  selector: string;
  attr: string | null;
}

export interface SelectorPlan {
  item_container: string;
  fields: Record<string, FieldSelector>;
  pagination_next: string | null;
}

/** Attributes whose value is a URL and must be resolved against the page URL. */
const URL_ATTRS = new Set(["href", "src", "data-src", "data-href", "data-url", "data-original", "poster", "action"]);

/** Selectors that mean "the container element itself". */
const SELF_SELECTORS = new Set(["", ":scope", "&", "self", "this", "."]);

/** Resolve `value` against `base`; leaves non-navigable schemes / unparseable values untouched. */
export function toAbsoluteUrl(value: string, base: string | undefined): string {
  const v = value.trim();
  if (!v || !base) return v;
  if (/^(javascript:|data:|mailto:|tel:|blob:|about:)/i.test(v)) return v;
  try {
    return new URL(v, base).toString();
  } catch {
    return v;
  }
}

function safeIs($: cheerio.CheerioAPI, el: Element, selector: string): boolean {
  try {
    return $(el).is(selector);
  } catch {
    return false;
  }
}

function safeFind($: cheerio.CheerioAPI, el: Element, selector: string) {
  try {
    return $(el).find(selector);
  } catch {
    return $();
  }
}

/**
 * Extract items from HTML using a pre-discovered SelectorPlan.
 * No network call — pure Cheerio. Returns [] if item_container matches nothing.
 *
 * `baseUrl` (the page's current URL) is used to turn URL-valued attributes
 * (href/src/...) into absolute URLs; a `<base href>` in the document is honored.
 */
export function extractWithSelectors(html: string, plan: SelectorPlan, baseUrl?: string): Record<string, unknown>[] {
  const $ = cheerio.load(html);
  const results: Record<string, unknown>[] = [];

  let base = baseUrl;
  const baseHref = $("base[href]").first().attr("href");
  if (baseHref && baseUrl) base = toAbsoluteUrl(baseHref, baseUrl);

  $(plan.item_container).each((_, el) => {
    const item: Record<string, unknown> = {};
    for (const [field, { selector, attr }] of Object.entries(plan.fields)) {
      const sel = (selector ?? "").trim();

      // Which element(s) carry this field? Descendants first (the historical
      // behavior); when none match, the container itself — Enjoei's cards ARE
      // the `<a href>`, so `.find()` alone never sees them.
      let found: cheerio.Cheerio<Element>;
      if (SELF_SELECTORS.has(sel)) {
        found = $(el);
      } else {
        found = safeFind($, el, sel);
        if (found.length === 0 && safeIs($, el, sel)) found = $(el);
      }

      if (found.length === 0) {
        item[field] = null;
      } else if (attr) {
        // Attribute values don't concatenate meaningfully across elements
        // (two "src"/"href" values joined is garbage either way) — first
        // match is the reasonable choice here, unlike the text case below.
        let value = found.first().attr(attr);
        if (!value) {
          // Attribute lives on an ancestor inside the card (e.g. the plan
          // points at `.title` but the `<a href>` wraps it) or on the
          // container itself.
          const owner = found.first().closest(`[${attr}]`);
          if (owner.length > 0 && (owner.is(el) || $.contains(el, owner[0]))) value = owner.attr(attr);
        }
        if (value && URL_ATTRS.has(attr.toLowerCase())) value = toAbsoluteUrl(value, base);
        item[field] = value || null;
      } else {
        // A selector can match multiple elements for two DIFFERENT reasons,
        // and they need opposite handling:
        //
        // 1. One value split across sibling nodes (KaBuM, 2026-08-19):
        //    `<span>R$</span><span>289,99</span>`, same class on both.
        //    `.first()` alone returns "R$" — incomplete, needs the rest.
        // 2. Multiple genuinely DISTINCT values sharing a selector
        //    (ligapokemon.com.br, 2026-08-20): a marketplace card shows a
        //    min/max price range as two separate elements — `.text()`
        //    concatenating both gave "R$ 0,50R$ 0,89", which isn't anyone's
        //    price, it's two prices mashed together.
        //
        // Can't tell which case it is without knowing the field's semantics,
        // so use a cheap proxy: does the FIRST match already look like a
        // complete value on its own (has a digit, or isn't just a couple of
        // characters)? If so, trust it alone. Only concatenate when the first
        // match looks like a bare fragment (no digit, very short).
        // A SINGLE matched element can also hold several values glued together
        // (ligapokemon 2026-08-21: <div class="preco"><span>R$ 0,50</span>
        // <span>R$ 0,89</span></div>) — isolate the first child NODE's own
        // text so the check reflects only the first value.
        const firstText = (found.first().contents().first().text().trim() || found.first().text().trim());
        const looksComplete = firstText.length > 3 || /\d/.test(firstText);
        item[field] = (looksComplete ? firstText : found.text().trim()) || null;
      }
    }
    results.push(item);
  });

  return results;
}

// ── Plan quality gate ─────────────────────────────────────────────────────────

const IMAGE_HINT_RE = /(image|img|imagem|foto|photo|thumb|picture|avatar|logo|icon|src)/i;
const LINK_KEY_RE = /(^|[_\-\s.])(url|link|href|permalink|uri)$|^(url|link|href|permalink)([_\-\s.]|$)/i;
const LINK_DESC_RE = /\b(url|link|href)\b/i;

/**
 * Which fields of the schema/plan are item links (not image URLs)? Decided by
 * the field NAME first; the description only counts when the name is neutral.
 */
export function linkFieldNames(schema: Record<string, string> | undefined, plan: SelectorPlan): string[] {
  const names = new Set<string>([...Object.keys(schema ?? {}), ...Object.keys(plan.fields)]);
  const out: string[] = [];
  for (const name of names) {
    if (IMAGE_HINT_RE.test(name)) continue;
    const desc = schema?.[name] ?? "";
    if (LINK_KEY_RE.test(name) || (LINK_DESC_RE.test(desc) && !IMAGE_HINT_RE.test(desc))) out.push(name);
  }
  return out;
}

export interface PlanVerdict {
  valid: boolean;
  reason?: string;
}

/** Minimum item count for the ratio / distinct-value rules to apply. */
const MIN_ITEMS_FOR_GATE = 5;
/** Below MIN_ITEMS_FOR_GATE, a link field that is empty on EVERY item of at least this many is still garbage. */
const MIN_ITEMS_ALL_EMPTY = 3;

/**
 * Sanity check of a plan's page-1 output. A plan can "succeed" (items > 0) and
 * still be garbage: Amazon once returned `url` empty on all 60 items, Mercado
 * Livre one identical generic link on 59. Only judges link fields the caller
 * asked for; small lists (<5) are only rejected when every link is empty.
 */
export function assessPlanQuality(
  items: Record<string, unknown>[],
  schema: Record<string, string> | undefined,
  plan: SelectorPlan,
): PlanVerdict {
  const n = items.length;
  if (n === 0) return { valid: true };

  for (const field of linkFieldNames(schema, plan)) {
    const values = items.map((it) => {
      const v = it[field];
      return typeof v === "string" ? v.trim() : "";
    });
    const nonEmpty = values.filter((v) => v !== "");
    const emptyCount = n - nonEmpty.length;
    const distinct = new Set(nonEmpty).size;

    if (n >= MIN_ITEMS_FOR_GATE) {
      if (emptyCount / n >= 0.5) {
        return { valid: false, reason: `link field "${field}" empty on ${emptyCount}/${n} items` };
      }
      if (distinct <= 1) {
        return { valid: false, reason: `link field "${field}" has only ${distinct} distinct value(s) across ${n} items` };
      }
    } else if (n >= MIN_ITEMS_ALL_EMPTY && emptyCount === n) {
      return { valid: false, reason: `link field "${field}" empty on all ${n} items` };
    }
  }
  return { valid: true };
}

/**
 * Resolve relative URLs on link fields of items that did NOT come through a
 * selector plan (LLM fallback output), against the page URL.
 */
export function absolutizeLinkFields(
  items: Record<string, unknown>[],
  schema: Record<string, string> | undefined,
  baseUrl: string,
): Record<string, unknown>[] {
  const fields = new Set<string>();
  for (const name of Object.keys(schema ?? {})) {
    const desc = schema?.[name] ?? "";
    if (IMAGE_HINT_RE.test(name)) continue;
    if (LINK_KEY_RE.test(name) || (LINK_DESC_RE.test(desc) && !IMAGE_HINT_RE.test(desc))) fields.add(name);
  }
  if (fields.size === 0) return items;
  return items.map((item) => {
    const copy = { ...item };
    for (const f of fields) {
      const v = copy[f];
      if (typeof v === "string" && /^(\/|\.\/|\.\.\/|\?)/.test(v.trim())) copy[f] = toAbsoluteUrl(v, baseUrl);
    }
    return copy;
  });
}

/** Validate an ISO-3166 alpha-2 country code (uppercase). Returns it, or undefined. */
export function normalizeCountry(country: unknown): string | undefined {
  return typeof country === "string" && /^[A-Z]{2}$/.test(country.trim().toUpperCase()) ? country.trim().toUpperCase() : undefined;
}
