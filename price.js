// PRICE, ATTACHED TO THE STORIES THAT NAME A COIN.
//
// WHY AN ALLOWLIST, NOT A REGEX OVER EVERY TICKER
//
//   A ticker is an ordinary English word more often than it looks: "ONE"
//   (Harmony), "COMP" (Compound, and a common abbreviation), "SOL" (also the
//   Spanish/Peruvian currency and a French word for "ground"). Matching bare
//   three-letter tickers against free-form headlines invents a coin mention in
//   a story that has none. The list below is deliberately short — the coins
//   this channel actually covers — and every entry is also matched on its FULL
//   NAME, so "Bitcoin" resolves even in a headline that never writes "BTC".
//
//   The symbol is matched CASE-SENSITIVELY and only as an ALL-CAPS whole word.
//   Real headlines write tickers in caps; a lowercase "sol" or "one" inside
//   ordinary prose is therefore never mistaken for one. The full name is
//   matched case-insensitively, because headlines capitalise names normally.
//
// WHY COINGECKO'S FREE, KEYLESS ENDPOINT
//
//   /simple/price needs no API key and has no meaningful limit for a bot
//   making at most a handful of calls every 30 minutes — this project's whole
//   budget is zero, so a paid price feed was never a real option. It is asked
//   for exactly one coin at a time and cached per run (see `makePriceCache`
//   below), so three stories about the same coin in one run cost one call, not
//   three.
//
// WHAT THIS IS NOT
//
//   Not a trading signal, and not this channel's opinion on where the price is
//   going. A number, next to the news that might explain it — nothing else is
//   claimed.

const CG_BASE = "https://api.coingecko.com/api/v3";

/** Network calls are capped short: a slow price lookup must not delay, or
 * fail, the post it would only have decorated. */
export const PRICE_TIMEOUT_MS = 8_000;

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The coins this channel recognises.
 *
 * `id` is CoinGecko's own identifier, which does not always match the ticker
 * or the name (Ripple's ticker is XRP, its CoinGecko id is "ripple") — looked
 * up once here rather than guessed at the call site.
 */
export const COINS = [
  { symbol: "BTC", name: "Bitcoin", id: "bitcoin" },
  { symbol: "ETH", name: "Ethereum", id: "ethereum" },
  { symbol: "SOL", name: "Solana", id: "solana" },
  { symbol: "XRP", name: "Ripple", id: "ripple" },
  { symbol: "BNB", name: "BNB", id: "binancecoin" },
  { symbol: "DOGE", name: "Dogecoin", id: "dogecoin" },
  { symbol: "ADA", name: "Cardano", id: "cardano" },
  { symbol: "AVAX", name: "Avalanche", id: "avalanche-2" },
  { symbol: "LINK", name: "Chainlink", id: "chainlink" },
  { symbol: "LTC", name: "Litecoin", id: "litecoin" },
];

/**
 * The single coin a story is about, or null.
 *
 * Checked in list order and returns the FIRST match, so a headline naming two
 * coins is attributed to whichever is listed first (BTC before the rest) —
 * a story genuinely about two coins at once is rare enough that picking one
 * deterministically beats the complexity of reporting both.
 */
export function detectCoin(text) {
  const t = String(text ?? "");
  for (const coin of COINS) {
    const nameRe = new RegExp(`\\b${escapeRegExp(coin.name)}\\b`, "i");
    const symbolRe = new RegExp(`\\b${escapeRegExp(coin.symbol)}\\b`);
    if (symbolRe.test(t) || nameRe.test(t)) return coin;
  }
  return null;
}

/**
 * One coin's current price and 24h change.
 *
 * Returns `{ ok: false, why }` rather than throwing on any failure — a price
 * this channel cannot fetch is a decoration it goes without, never a reason
 * to fail the post it would have attached to.
 */
export async function fetchPrice(coinId, { timeoutMs = PRICE_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(
      `${CG_BASE}/simple/price?ids=${encodeURIComponent(coinId)}&vs_currencies=usd&include_24hr_change=true`,
      { signal: controller.signal }
    );
    if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
    const json = await res.json().catch(() => null);
    const row = json?.[coinId];
    if (!row || typeof row.usd !== "number") return { ok: false, why: "անհայտ պատասխան" };
    const change24h = typeof row.usd_24h_change === "number" ? row.usd_24h_change : null;
    return { ok: true, usd: row.usd, change24h };
  } catch (e) {
    return { ok: false, why: e?.name === "AbortError" ? "ժամանակը լրացավ" : String(e?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A per-run cache, so a run that ranks three stories about the same coin
 * fetches its price once.
 *
 * Stores the in-flight PROMISE, not just the resolved value, so two stories
 * asking for the same coin back to back both await the one request already
 * under way rather than firing a second.
 */
export function makePriceCache(fetcher = fetchPrice) {
  const cache = new Map();
  return function cachedPrice(coinId) {
    if (!cache.has(coinId)) cache.set(coinId, fetcher(coinId));
    return cache.get(coinId);
  };
}

/**
 * "$67,234" for anything a dollar or more, "$0.4231" below that — a coin
 * trading under a dollar loses all its meaningful digits rounded to cents.
 */
export function formatUsd(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "?";
  if (v >= 1) return `$${v.toLocaleString("en-US", { maximumFractionDigits: v >= 100 ? 0 : 2 })}`;
  return `$${v.toPrecision(3)}`;
}

/**
 * The line attached to a news post: "BTC $67,234 (+2.3% 24ժ)".
 *
 * `change24h` is CoinGecko's own trailing-24h number, not anything measured
 * against this post — it answers "how is this coin doing", the context a
 * reader wants next to news about it, not "did this story move the price"
 * (that is the accountability loop's job, and a different, narrower claim).
 */
// ── THE CHANNEL'S ONE WAY OF WRITING A MOVE ─────────────────────────────────
//
// Karen's rule (2026-09-25, final): every change in the channel reads the
// same — a clean number with its sign, «+1.2%», «−2.5%», no arrows, whatever
// the size, and nothing at all when it rounds to zero. (Arrows were tried the
// same day and dropped: the sign already says the direction.) Every post that shows a move — the news price
// line, both briefs, the accountability replies, the weekly recap, the
// liquidity pulse, the CPI and payroll numbers, the dram rates — builds it
// here, so no two places can drift apart again.
//
// Rounded FIRST, to the digits shown, so the sign and the number can never
// disagree (a «▼0.0%» for a −0.04% day was exactly that). The minus
// is a real minus sign (U+2212), not a hyphen.
export function formatMove(x, { digits = 1, suffix = "%", prefix = "", zero = null } = {}) {
  if (typeof x !== "number" || !Number.isFinite(x)) return zero;
  const k = 10 ** digits;
  const r = Math.round(x * k) / k;
  if (r === 0) return zero;
  return `${r > 0 ? "+" : "−"}${prefix}${Math.abs(r).toFixed(digits)}${suffix}`;
}

export function formatPriceLine(symbol, price) {
  const amount = formatUsd(price.usd);
  // No change worth a number: «(+0.0% 24ժ)» only says the line has nothing to
  // say, and did, under a post on 2026-09-24.
  if (typeof price.change24h !== "number") return `${symbol} ${amount}`;
  // ONE RULE FOR EVERY PRICE MOVE IN THE CHANNEL (Karen, 2026-09-25): a signed
  // number, «+1.2%» / «−2.5%», whatever the size; a move that rounds to 0.0
  // gets no number at all. See formatMove above.
  const move = formatMove(price.change24h);
  return move ? `${symbol} ${amount} (${move} 24ժ)` : `${symbol} ${amount}`;
}
