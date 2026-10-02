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
 * Deterministic repair of a plan whose LINK field came back empty/constant while the
 * container matched fine — the commonest LLM miss: it writes `h2 a` when the markup is
 * `<a><h2>` (Amazon search, 2026-09), so every href is null and the whole plan used to be
 * thrown away (one more discovery call + an LLM read of a 1.6 MB page, ~2 min, sometimes 0
 * items). Candidates, in order: the failing selector without its trailing `a` step (the
 * extractor then climbs to the enclosing `[href]`), the text fields' own enclosing link,
 * the card's first `a[href]`, and the container itself. First candidate that passes the
 * quality gate wins; null when none does.
 */
export function repairLinkFields(
  html: string,
  plan: SelectorPlan,
  schema: Record<string, string> | undefined,
  baseUrl?: string,
): SelectorPlan | null {
  const linkFields = linkFieldNames(schema, plan);
  if (linkFields.length === 0) return null;
  const textSelectors = Object.entries(plan.fields)
    .filter(([name, f]) => !linkFields.includes(name) && !f.attr && f.selector?.trim())
    .map(([, f]) => f.selector.trim());

  let repaired: SelectorPlan = plan;
  for (const field of linkFields) {
    const current = plan.fields[field]?.selector?.trim() ?? "";
    const stripped = current.replace(/\s*>?\s*a(\[[^\]]*\]|[.#:][\w\-:()]*)*$/i, "").trim();
    const candidates = [
      ...new Set([stripped, ...textSelectors, ...productLinkSelectors(html, plan.item_container), "a[href]", ":scope"]
        .filter((s) => s && s !== current)),
    ];
    let fixed = false;
    for (const sel of candidates) {
      const trial: SelectorPlan = { ...repaired, fields: { ...repaired.fields, [field]: { selector: sel, attr: "href" } } };
      const items = extractWithSelectors(html, trial, baseUrl);
      const values = items.map((it) => (typeof it[field] === "string" ? (it[field] as string) : ""));
      const usable = values.filter((v) => /^https?:\/\//i.test(v));
      if (items.length > 0 && usable.length / items.length > 0.5 && new Set(usable).size > 1) {
        repaired = trial;
        fixed = true;
        break;
      }
    }
    if (!fixed) return null;
  }
  return repaired;
}

/**
 * Selectors for the card's PRODUCT link rather than its first `a[href]` (which can be a seller,
 * rating or "more offers" link): per card, the product link is the href repeated most often
 * (image + title both point at it; ties -> the longer href). Returns the anchor signatures
 * (`a.<first class>[href]`) that carry that href in the most cards, best first.
 */
function productLinkSelectors(html: string, container: string): string[] {
  const $ = cheerio.load(html);
  const score = new Map<string, number>();
  let cards: cheerio.Cheerio<Element>;
  try {
    cards = $(container).slice(0, 30);
  } catch {
    return [];
  }
  cards.each((_, card) => {
    const anchors = $(card).find("a[href]").toArray();
    const freq = new Map<string, number>();
    for (const a of anchors) {
      const h = ($(a).attr("href") ?? "").trim();
      if (h && !/^(javascript:|#|mailto:|tel:)/i.test(h)) freq.set(h, (freq.get(h) ?? 0) + 1);
    }
    const modal = [...freq.entries()].sort((x, y) => y[1] - x[1] || y[0].length - x[0].length)[0]?.[0];
    if (!modal) return;
    const sigs = new Set<string>();
    for (const a of anchors) {
      if (($(a).attr("href") ?? "").trim() !== modal) continue;
      const cls = ($(a).attr("class") ?? "").split(/\s+/).find((c) => /^[A-Za-z_][\w-]*$/.test(c));
      sigs.add(cls ? `a.${cls}[href]` : "a[href]");
    }
    for (const sig of sigs) score.set(sig, (score.get(sig) ?? 0) + 1);
  });
  return [...score.entries()].sort((x, y) => y[1] - x[1]).map(([sig]) => sig).slice(0, 3);
}

/**
 * Same LLM miss on TEXT fields: `h2 .a-text-normal` when the class sits on the `<a>` that wraps
 * the `<h2>` (Amazon 2026-09: every title empty -> every item failed the caller's brand filter).
 * A text field empty on most items is retried with its selector shortened one descendant step
 * at a time (`h2 .x` -> `h2`); the first version filled on most items wins. Fields the page
 * genuinely lacks stay as they were. Returns the plan unchanged when nothing needed fixing.
 */
export function repairEmptyTextFields(html: string, plan: SelectorPlan, baseUrl?: string): SelectorPlan {
  const items = extractWithSelectors(html, plan, baseUrl);
  if (items.length < MIN_ITEMS_ALL_EMPTY) return plan;
  const filled = (its: Record<string, unknown>[], f: string) =>
    its.filter((it) => typeof it[f] === "string" && (it[f] as string).trim() !== "").length / its.length;
  let out = plan;
  for (const [field, spec] of Object.entries(plan.fields)) {
    if (spec.attr || !spec.selector || filled(items, field) > 0.5) continue;
    const steps = spec.selector.trim().split(/\s+(?![^[(]*[\])])/);
    for (let n = steps.length - 1; n >= 1; n--) {
      const trial: SelectorPlan = { ...out, fields: { ...out.fields, [field]: { selector: steps.slice(0, n).join(" "), attr: null } } };
      if (filled(extractWithSelectors(html, trial, baseUrl), field) > 0.5) {
        out = trial;
        break;
      }
    }
  }
  return out;
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
