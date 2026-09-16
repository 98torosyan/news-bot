// THE SOURCE LIST AND THE PARSER.
//
// Every feed here returned current, parseable items when checked from Karen's
// machine on 2026-09-15. Two candidates were dropped by that same check and
// are named below rather than quietly deleted, so nobody re-adds them from a
// "best crypto RSS feeds" article later.
//
//   Bitcoinist   8 items, newest 183 hours old — publishing has stopped
//   CoinGape     HTTP 403 — refuses server-side fetches
//
// `rare` marks a source where silence is normal. The Fed's monetary feed went
// 506 hours without an item at the time of checking, and calling that stale was
// a wrong verdict from a correct number: it publishes around eight times a
// year, at FOMC meetings, and those eight items move the market harder than a
// month of crypto headlines. For these sources only an HTTP error or an
// unparseable body means broken.

export const FEED_TIMEOUT_MS = 12_000;
const UA = "Mozilla/5.0 (compatible; NewsBot/1.0; personal channel)";

export const FEEDS = [
  { name: "Cointelegraph", url: "https://cointelegraph.com/rss", cat: "CRYPTO" },
  { name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/", cat: "CRYPTO" },
  { name: "Decrypt", url: "https://decrypt.co/feed", cat: "CRYPTO" },
  { name: "CryptoSlate", url: "https://cryptoslate.com/feed/", cat: "CRYPTO" },
  { name: "BeInCrypto", url: "https://beincrypto.com/feed/", cat: "CRYPTO" },
  { name: "NewsBTC", url: "https://www.newsbtc.com/feed/", cat: "CRYPTO" },
  { name: "U.Today", url: "https://u.today/rss", cat: "CRYPTO" },
  { name: "Bitcoin Magazine", url: "https://bitcoinmagazine.com/.rss/full/", cat: "CRYPTO" },
  { name: "CoinJournal", url: "https://coinjournal.net/feed/", cat: "CRYPTO" },
  { name: "Protos", url: "https://protos.com/feed/", cat: "CRYPTO" },
  { name: "Federal Reserve", url: "https://www.federalreserve.gov/feeds/press_monetary.xml", cat: "MACRO", rare: true },
  { name: "Fed (all press)", url: "https://www.federalreserve.gov/feeds/press_all.xml", cat: "MACRO", rare: true },
  { name: "Yahoo Finance", url: "https://finance.yahoo.com/news/rssindex", cat: "MACRO" },
  { name: "SEC", url: "https://www.sec.gov/news/pressreleases.rss", cat: "MACRO", rare: true },
  { name: "BLS", url: "https://www.bls.gov/feed/bls_latest.rss", cat: "MACRO", rare: true },
  { name: "ECB", url: "https://www.ecb.europa.eu/rss/press.html", cat: "MACRO", rare: true },
];

// --- parsing -----------------------------------------------------------------
// Regex rather than an XML library so the bot runs with nothing installed.
// Both RSS <item> and Atom <entry> appear among these sources.

function stripCdata(s) {
  const m = s.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return m ? m[1] : s;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#8217;/g, "'")
    .replace(/&#8216;/g, "'")
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .replace(/&#8211;/g, "–")
    .replace(/&#8212;/g, "—")
    .replace(/&nbsp;/g, " ");
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decodeEntities(stripCdata(m[1])).trim() : null;
}

export function stripHtml(s) {
  return decodeEntities(
    s
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

export function parseFeed(xml) {
  const items = [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) ?? [];
  for (const block of blocks) {
    const title = tag(block, "title");
    if (!title) continue;

    let link = tag(block, "link");
    if (!link) {
      const m = block.match(/<link[^>]*href=["']([^"']+)["']/i);
      link = m ? m[1] : null;
    }

    const when = tag(block, "pubDate") ?? tag(block, "published") ?? tag(block, "updated");
    const raw =
      tag(block, "description") ?? tag(block, "summary") ?? tag(block, "content:encoded") ?? tag(block, "content");

    items.push({
      title,
      link,
      // A missing date is 0, never "now". Stamping an undated item with the
      // current time would make every old item look like breaking news.
      at: when ? Date.parse(when) || 0 : 0,
      body: raw ? stripHtml(raw) : "",
    });
  }
  return items;
}

// --- what is not news --------------------------------------------------------
//
// Runs on the title, before any API call. Found necessary when the first live
// test picked a podcast episode — "…Financial Future w/ John Deaton" — and
// spent a request to be told, correctly, that nothing had happened.
//
// Deliberately conservative, and measured at about 3% of items on the real
// feeds. A missed advert costs one wasted call; a wrongly dropped story is
// never seen again. Anything ambiguous is left to the ranking, which is the
// real filter — that is why there is no pattern here for "X says Y", even
// though pundit quotes are noise: "SEC says" is not. The vote sorts those out
// without anyone writing a rule about a particular pundit.
const NOT_NEWS = [
  /\bw\/\s/i,
  /\bpodcast\b/i,
  /\bepisode\b/i,
  /\binterview\b/i,
  /\bAMA\b/,
  /\bopinion\b/i,
  /\bop-ed\b/i,
  /\bsponsored\b/i,
  /\bpress release\b/i,
  /\bprice (prediction|analysis|forecast|target)s?\b/i,
  // "Standard Chartered Sees Arbitrum (ARB) at $0.50 This Year, $10 by 2030"
  // reached the channel and read as promotion. It IS news that a bank opened
  // coverage, but the headline is a price target and the summary that came out
  // of it praised the asset. Corroboration alone could not stop it — four
  // outlets carried it — so the filter has to.
  /\bsees\b[^.]*\bat\s*\$/i,
  /\$[\d.,]+\s*(by|in)\s*20[2-9]\d\b/i,
  /\bby\s+20[3-9]\d\b/i,
  /\bforecasts?\b[^.]*\$/i,
  /\bwhat to expect\b/i,
  /\bhere'?s why\b/i,
  /\bcould (hit|reach|soar|surge|explode)\b/i,
  /\btop \d+\b/i,
  /\bbest .* (of|for) \d{4}\b/i,
  /\bhow to\b/i,
  /\bguide\b/i,
  /\breview\b/i,
  /\bgiveaway\b/i,
  /\bwebinar\b/i,
];

export function looksLikeNews(title) {
  return !NOT_NEWS.some((re) => re.test(title));
}

// --- fetching ----------------------------------------------------------------

async function fetchOne(feed) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
  try {
    const res = await fetch(feed.url, {
      cache: "no-store",
      signal: controller.signal,
      headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml, text/xml, */*" },
    });
    if (!res.ok) return { feed, ok: false, why: `HTTP ${res.status}`, items: [] };
    const items = parseFeed(await res.text()).map((i) => ({ ...i, source: feed.name, cat: feed.cat }));
    return { feed, ok: true, items };
  } catch (e) {
    return {
      feed,
      ok: false,
      why: e?.name === "AbortError" ? "ժամանակը լրացավ" : String(e?.message ?? e),
      items: [],
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read every feed. One failing source never stops the run — the whole point of
 * sixteen sources is that no single one is load-bearing — but each failure is
 * returned so it can be printed rather than absorbed.
 */
export async function fetchAll(feeds = FEEDS) {
  const results = await Promise.all(feeds.map(fetchOne));
  const items = results.flatMap((r) => r.items);
  const failed = results.filter((r) => !r.ok).map((r) => ({ name: r.feed.name, why: r.why }));
  return { items, failed, okCount: results.length - failed.length, total: results.length };
}

/** Items recent enough to be worth considering, and that look like events. */
export function freshNews(items, { maxAgeHours = 24, now = Date.now() } = {}) {
  const cutoff = now - maxAgeHours * 3_600_000;
  return items.filter((i) => i.at > cutoff && i.link && looksLikeNews(i.title));
}
