/**
 * Shared "is this page real content or a block/challenge page" check, used by every
 * extraction layer (cheerio, Patchright, Abrasio-backed dataset pagination) so the
 * marker list and the gating rule can't drift between them again.
 *
 * Consolidated 2026-09-09 from four independent copies (orchestrator.ts, cheerio-engine.ts,
 * playwright-engine.ts, dataset.ts) that had each grown a slightly different marker list
 * and a different length gate. dataset.ts's gate was fixed on 2026-08-21 after a real
 * Cloudflare/hCaptcha interstitial on ligapokemon.com.br slipped past a raw-html.length
 * gate — the interstitial's heavy inline JS/CSS pushed raw HTML past 5,000 chars even
 * though its actual visible text was small. That fix never made it into the other three
 * copies; this module is the single place it now lives.
 */

/** Minimum visible (tag-stripped) text characters to consider a page as having real content. */
export const MIN_CONTENT_CHARS = 200;

/**
 * Visible-text length below which a block-marker hit is trusted. Real challenge/captcha
 * interstitials are boilerplate-sized in terms of what a user actually sees, regardless of
 * how much inline JS/CSS backs them — gate on stripped text, not raw HTML length, or a
 * heavy interstitial can clear the bar undetected (see module comment). A large real page
 * that happens to mention "captcha" in passing (an article about bots, a login form's help
 * text) shouldn't get flagged just for containing the word.
 */
const BLOCK_MARKER_TEXT_GATE = 2000;

/**
 * Markers of a Cloudflare (or similar) interstitial / captcha wall. Chosen to be
 * LANGUAGE-INDEPENDENT where possible: Turnstile's hidden field name and the
 * challenges.cloudflare.com script origin are the same in every locale Cloudflare serves,
 * unlike a challenge page's visible copy.
 */
export const BLOCK_MARKERS = [
  "cf-turnstile", "challenges.cloudflare.com", "cf-chl-", "cf-please-wait",
  "captcha", "hcaptcha", "recaptcha", "g-recaptcha", "cf-challenge", "challenge-platform",
  "just a moment", "please wait while we verify", "checking your browser",
  "verify you are human", "attention required", "access denied", "ray id:",
];

/** Strips scripts, styles and tags down to plain visible text. */
export function stripToVisibleText(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isBlockedGivenText(html: string, visibleText: string): boolean {
  if (visibleText.length >= BLOCK_MARKER_TEXT_GATE) return false;
  const lower = html.toLowerCase();
  return BLOCK_MARKERS.some((m) => lower.includes(m));
}

/**
 * True when the page carries an anti-bot challenge marker (Cloudflare Turnstile, a
 * generic captcha wall, ...). Does NOT consider a page "blocked" just for being short —
 * use `hasContent()` when thin-but-unmarked pages should also count as no content.
 */
export function looksBlocked(html: string): boolean {
  return isBlockedGivenText(html, stripToVisibleText(html));
}

/**
 * True when the page has meaningful visible text AND doesn't carry an anti-bot
 * challenge marker. False for empty shells (JS-gated pages, blank responses) and for
 * verbose-but-fake interstitials (Cloudflare Turnstile, generic captcha walls).
 */
export function hasContent(html: string): boolean {
  const text = stripToVisibleText(html);
  if (text.length < MIN_CONTENT_CHARS) return false;
  return !isBlockedGivenText(html, text);
}
