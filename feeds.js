// THE SOURCE LIST AND THE PARSER.
//
// Every feed here returned current, parseable items when checked — the
// original 16 from Karen's machine on 2026-09-15, the rest from a deliberate
// expansion on 2026-09-23 done in several rounds, each one an actual fetch of
// the actual URL, never a guess carried over from a "best RSS feeds" article.
// A source that was tried and rejected is named below rather than quietly
// dropped, so nobody re-adds it from that same kind of article later.
//
//   CoinGape       HTTP 403 — refuses server-side fetches
//   AMBCrypto, The Defiant                      robots.txt refuses fetching
//   Chainwire                                   press-release wire, not journalism —
//                                                every item is a project's own
//                                                announcement, never independently
//                                                corroborated, which is the one thing
//                                                this channel's ranking requires
//   Bankless                                    opinion/hot-take headlines, not reporting
//   Bank of Canada, Swiss National Bank,
//   Reserve Bank of India, UK OFSI              real feeds, but administrative/
//                                                operational noise (auctions, board
//                                                appointments, routine licence
//                                                notices) with no actual market-moving
//                                                content in what was sampled
//   Benzinga, Finbold, Watcher.Guru, ZyCrypto,
//   Coinpaper, Crypto Daily, Cryptopolitan,
//   CoinGape, The Crypto Basic, Nasdaq.com
//   (Markets RSS), Motley Fool, 24/7 Wall St    "price prediction/target" spam or
//                                                pure stock-picking advice — the exact
//                                                genre looksLikeNews() below exists
//                                                to keep out
//   Crypto Briefing                             lost crypto focus (esports items
//                                                turned up alongside crypto ones)
//   ZeroHedge                                   very fast, but dominated by political
//                                                editorializing rather than market
//                                                reporting
//   Rekt.news, CertiK (Medium)                  real, but infrequent and mostly
//                                                marketing/essay content, not the hack
//                                                disclosures the names promise
//   Reuters, Bloomberg, CNBC, Financial Times,
//   Forbes, Business Insider, Seeking Alpha,
//   EIA, Investopedia, Naked Capitalism,
//   Trading Economics, Barchart                 no working free/public RSS — most of
//                                                these deliberately killed it years ago
//                                                to stop aggregators; re-tried more than
//                                                once, always the same result
//   DailyFX, RBA, Kitco, CryptoGlobe, Coin
//   Rivet, TheStreet Crypto, US Treasury,
//   RBNZ, Milk Road, PeckShield, Arkham/
//   Nansen/Kaiko/CryptoQuant blogs, PBOC,
//   Bank of Korea, Banxico, Forex Factory,
//   BK Asset Management, Myfxbook, EU
//   Sanctions Map, IMF, BIS (news RSS),
//   CFTC pressroom                              dead, discontinued, never had a public
//                                                feed, or the guessed URL 404s — no
//                                                working feed found
//   Wolf Street                                 content reads like a good fit, but its
//                                                feed URL could not be fetched and
//                                                verified in the session that did this
//                                                research — NOT added until someone
//                                                actually confirms it parses; this is
//                                                exactly the mistake the header above
//                                                exists to prevent
//
// `rare` marks a source where silence is normal. The Fed's monetary feed went
// 506 hours without an item at the time of checking, and calling that stale was
// a wrong verdict from a correct number: it publishes around eight times a
// year, at FOMC meetings, and those eight items move the market harder than a
// month of crypto headlines. For these sources only an HTTP error or an
// unparseable body means broken. The same logic now covers every other
// central-bank, regulator, and research-blog feed added below — Bitcoinist is
// the one exception worth flagging: it was DROPPED on 2026-09-15 for having
// gone quiet, and only re-added on 2026-09-23 after a fresh check found it
// posting again, hourly. It carries no `rare` flag, because a genuine 8-day
// silence from it again would mean exactly what it meant before — stopped
// publishing, not a quiet quarter.

export const FEED_TIMEOUT_MS = 12_000;
const UA = "Mozilla/5.0 (compatible; NewsBot/1.0; personal channel)";

export const FEEDS = [
  // --- crypto ----------------------------------------------------------------
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
  // Re-added 2026-09-23 — see the long comment above on why this one, alone
  // among today's additions, is not just "new" but a genuine second chance.
  { name: "Bitcoinist", url: "https://bitcoinist.com/feed/", cat: "CRYPTO" },
  { name: "The Block", url: "https://www.theblock.co/rss.xml", cat: "CRYPTO" },
  { name: "DL News", url: "https://www.dlnews.com/arc/outboundfeeds/rss/", cat: "CRYPTO" },
  // blockworks.co/feed redirects here; the .com URL is used directly so the
  // fetch never depends on a redirect being followed. Atom, not RSS — the
  // parser below reads <entry> exactly like <item>, so no special case needed.
  { name: "Blockworks", url: "https://blockworks.com/feed", cat: "CRYPTO" },
  { name: "CryptoPotato", url: "https://cryptopotato.com/feed/", cat: "CRYPTO" },
  { name: "crypto.news", url: "https://crypto.news/feed/", cat: "CRYPTO" },
  { name: "The Daily Hodl", url: "https://dailyhodl.com/feed/", cat: "CRYPTO" },
  { name: "Forkast", url: "https://forkast.news/feed/", cat: "CRYPTO" },
  // Coinpedia and Cryptonews both carry more "price prediction"-flavoured
  // filler than the rest of this list — looksLikeNews() in this file catches
  // the literal cases, and what slips through still has to clear rank.js's
  // corroboration bar before it can post. Kept because the real-news share of
  // each is still a genuine, independent addition.
  { name: "Coinpedia", url: "https://coinpedia.org/feed/", cat: "CRYPTO" },
  { name: "Cryptonews", url: "https://cryptonews.com/news/feed/", cat: "CRYPTO" },
  // A hack/exploit post-mortem wire, not a general news outlet — exactly the
  // kind of fast, verifiable-event source the ranking's corroboration model
  // rewards when a second outlet later covers the same incident.
  { name: "SlowMist", url: "https://slowmist.medium.com/feed", cat: "CRYPTO" },
  // Weekly-cadence, first-party on-chain data analysis rather than repeated
  // news — `rare` for the same reason as the central-bank feeds below: an
  // ordinary quiet week here is not a broken feed.
  { name: "Glassnode Research", url: "https://research.glassnode.com/rss/", cat: "CRYPTO", rare: true },

  // --- macro / forex / markets -------------------------------------------------
  { name: "Federal Reserve", url: "https://www.federalreserve.gov/feeds/press_monetary.xml", cat: "MACRO", rare: true },
  { name: "Fed (all press)", url: "https://www.federalreserve.gov/feeds/press_all.xml", cat: "MACRO", rare: true },
  { name: "Yahoo Finance", url: "https://finance.yahoo.com/news/rssindex", cat: "MACRO" },
  { name: "SEC", url: "https://www.sec.gov/news/pressreleases.rss", cat: "MACRO", rare: true },
  { name: "BLS", url: "https://www.bls.gov/feed/bls_latest.rss", cat: "MACRO", rare: true },
  { name: "ECB", url: "https://www.ecb.europa.eu/rss/press.html", cat: "MACRO", rare: true },
  { name: "Bank of England", url: "https://www.bankofengland.co.uk/rss/news", cat: "MACRO", rare: true },
  { name: "MarketWatch", url: "https://feeds.content.dowjones.io/public/rss/mw_topstories", cat: "MACRO" },
  // Reuters' own RSS has been dead for years (tried more than once, always
  // blocked) — this is the practical way its wire content still reaches this
  // channel, since Investing.com republishes a meaningful share of it.
  { name: "Investing.com", url: "https://www.investing.com/rss/news.rss", cat: "MACRO" },
  // Rebranded from forexlive.com to investinglive.com — the old domain's feed
  // URLs no longer work, so this one is used directly rather than relying on
  // a redirect.
  { name: "InvestingLive", url: "https://www.investinglive.com/feed/", cat: "MACRO" },
  { name: "FXStreet", url: "https://www.fxstreet.com/rss/news", cat: "MACRO" },
  { name: "ActionForex", url: "https://www.actionforex.com/feed/", cat: "MACRO" },
  { name: "FCA", url: "https://www.fca.org.uk/news/rss.xml", cat: "MACRO" },
  { name: "Mining.com", url: "https://www.mining.com/feed/", cat: "MACRO" },
  // Real energy-market reporting at high frequency, with some contributor
  // opinion columns mixed in — the same tier as Investing.com/MarketWatch
  // above, and handled the same way: by the filter and the ranking, not by
  // excluding the source.
  { name: "OilPrice.com", url: "https://oilprice.com/rss/main", cat: "MACRO" },
  // The four below are official research/press feeds: authoritative and
  // opinion-free, but genuinely low-frequency — `rare` for the same reason as
  // the Fed feeds, not because anything is wrong with them.
  { name: "FRED Blog", url: "https://fredblog.stlouisfed.org/feed/", cat: "MACRO", rare: true },
  { name: "Liberty Street Economics", url: "https://libertystreeteconomics.newyorkfed.org/feed/", cat: "MACRO", rare: true },
  { name: "Bank of Japan", url: "https://www.boj.or.jp/en/rss/whatsnew.xml", cat: "MACRO", rare: true },
  { name: "ESMA", url: "https://www.esma.europa.eu/rss.xml", cat: "MACRO", rare: true },
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
  // Added 2026-09-24 from what actually got through. The explainer genre
  // ("Why is Crypto Market Going Down Today?") is the "here's why" pattern
  // above in question form — a recap of other news, not news. And two
  // data-dump pages ("Eco Data 9/24/26", "Major Economic Indicators Latest
  // Numbers") are tables with a headline, which the model can only restate.
  /\bwhy (is|are)\b.*\btoday\b/i,
  /^eco data\b/i,
  /\blatest numbers\b/i,
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
