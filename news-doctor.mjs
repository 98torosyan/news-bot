// NEWS DOCTOR — decides the source list and the AI call by measuring them.
//
//   node scripts/news-doctor.mjs
//
// WHY THIS RUNS BEFORE ANYTHING IS BUILT
//
//   Two things about this project cannot be settled by reading documentation.
//
//   THE FEEDS. Published "best crypto RSS" lists are mostly stale. The four
//   feeds already in the trading dashboard were kept only because each one was
//   fetched and checked first — and in doing that, CryptoCompare turned out to
//   have quietly stopped being free, Investing.com was serving items nearly two
//   years old, and CNBC and MarketWatch rejected server-side fetches outright.
//   A source list assembled from articles instead of from responses would have
//   included all four.
//
//   THE MODEL. Google's rate-limit page no longer publishes free-tier numbers —
//   they depend on the account and are shown in AI Studio. The API also has two
//   shapes right now, a current one and a legacy one, and which model names a
//   given key may use is not something to assume. So this asks the key itself.
//
//   Nothing here posts anything. It reads feeds and, if a key is present, makes
//   a couple of small AI calls and prints the Armenian they produce, so the
//   writing can be judged before a channel exists to judge it in.

const FEED_TIMEOUT_MS = 12_000;
/** Older than this and a feed is not a news source, whatever it claims. */
const STALE_HOURS = 48;

const UA = "Mozilla/5.0 (compatible; NewsBot/1.0; personal channel)";

// Verified in the trading dashboard and carried over, plus candidates that
// still have to earn their place. Kept in one list so the output reads as one
// table rather than two.
//
// KEPT IN SYNC WITH feeds.js BY HAND.
//
// This file exists specifically to measure a candidate BEFORE it earns a place
// in feeds.js, so the two lists are not the same file for a reason — but once
// a candidate is promoted, leaving it out here means the next health check
// silently stops watching it. Every entry feeds.js gained on 2026-09-23 is
// mirrored below for that reason; see feeds.js's own header for the full
// list of what was tried and rejected that same day, which is not repeated
// here to avoid the two comments drifting apart.
const FEEDS = [
  // --- crypto ---------------------------------------------------------------
  { name: "Cointelegraph", url: "https://cointelegraph.com/rss", cat: "CRYPTO", known: true },
  { name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/", cat: "CRYPTO", known: true },
  { name: "Decrypt", url: "https://decrypt.co/feed", cat: "CRYPTO" },
  { name: "CryptoSlate", url: "https://cryptoslate.com/feed/", cat: "CRYPTO" },
  { name: "BeInCrypto", url: "https://beincrypto.com/feed/", cat: "CRYPTO" },
  { name: "NewsBTC", url: "https://www.newsbtc.com/feed/", cat: "CRYPTO" },
  { name: "U.Today", url: "https://u.today/rss", cat: "CRYPTO" },
  { name: "Bitcoin Magazine", url: "https://bitcoinmagazine.com/.rss/full/", cat: "CRYPTO" },
  { name: "CoinJournal", url: "https://coinjournal.net/feed/", cat: "CRYPTO" },
  { name: "Protos", url: "https://protos.com/feed/", cat: "CRYPTO" },
  // Dropped 2026-09-15 (8 items, newest 183h old — publishing had stopped),
  // re-verified and re-added 2026-09-23 once it was posting hourly again. If
  // this one goes stale here a second time, believe the number, not the name.
  { name: "Bitcoinist", url: "https://bitcoinist.com/feed/", cat: "CRYPTO" },
  { name: "The Block", url: "https://www.theblock.co/rss.xml", cat: "CRYPTO" },
  { name: "DL News", url: "https://www.dlnews.com/arc/outboundfeeds/rss/", cat: "CRYPTO" },
  { name: "Blockworks", url: "https://blockworks.com/feed", cat: "CRYPTO" },
  { name: "CryptoPotato", url: "https://cryptopotato.com/feed/", cat: "CRYPTO" },
  { name: "crypto.news", url: "https://crypto.news/feed/", cat: "CRYPTO" },
  { name: "The Daily Hodl", url: "https://dailyhodl.com/feed/", cat: "CRYPTO" },
  { name: "Forkast", url: "https://forkast.news/feed/", cat: "CRYPTO" },
  { name: "Coinpedia", url: "https://coinpedia.org/feed/", cat: "CRYPTO" },
  { name: "Cryptonews", url: "https://cryptonews.com/news/feed/", cat: "CRYPTO" },
  { name: "SlowMist", url: "https://slowmist.medium.com/feed", cat: "CRYPTO" },
  { name: "Glassnode Research", url: "https://research.glassnode.com/rss/", cat: "CRYPTO", rare: true },
  // --- macro ----------------------------------------------------------------
  //
  // `rare: true` MEANS SILENCE IS NORMAL, NOT BROKEN.
  //
  // The first run marked the Fed's monetary feed stale at 506 hours and that
  // was the wrong verdict from a correct number. The Fed publishes monetary
  // policy releases about eight times a year, at FOMC meetings. Three weeks of
  // silence is the feed working. And when it does speak, that one item moves
  // the market harder than a week of crypto headlines put together.
  //
  // So for these sources age is not a health check. What would actually mean
  // "broken" here is an HTTP error or an unparseable body, and those are
  // checked for every feed anyway.
  {
    name: "Federal Reserve",
    url: "https://www.federalreserve.gov/feeds/press_monetary.xml",
    cat: "MACRO",
    known: true,
    rare: true,
  },
  {
    name: "Fed (all press)",
    url: "https://www.federalreserve.gov/feeds/press_all.xml",
    cat: "MACRO",
    rare: true,
  },
  { name: "Yahoo Finance", url: "https://finance.yahoo.com/news/rssindex", cat: "MACRO", known: true },
  { name: "SEC", url: "https://www.sec.gov/news/pressreleases.rss", cat: "MACRO", rare: true },
  // Returned exactly one item on the first run. That is either a very quiet
  // feed or a shape this parser reads badly, and the difference matters: BLS
  // publishes CPI and the jobs report, two of the few scheduled releases that
  // reliably move crypto. The item count is printed so it can be watched.
  { name: "BLS", url: "https://www.bls.gov/feed/bls_latest.rss", cat: "MACRO", rare: true },
  { name: "ECB", url: "https://www.ecb.europa.eu/rss/press.html", cat: "MACRO", rare: true },
  { name: "Bank of England", url: "https://www.bankofengland.co.uk/rss/news", cat: "MACRO", rare: true },
  { name: "MarketWatch", url: "https://feeds.content.dowjones.io/public/rss/mw_topstories", cat: "MACRO" },
  { name: "Investing.com", url: "https://www.investing.com/rss/news.rss", cat: "MACRO" },
  { name: "InvestingLive", url: "https://www.investinglive.com/feed/", cat: "MACRO" },
  { name: "FXStreet", url: "https://www.fxstreet.com/rss/news", cat: "MACRO" },
  { name: "ActionForex", url: "https://www.actionforex.com/feed/", cat: "MACRO" },
  { name: "FCA", url: "https://www.fca.org.uk/news/rss.xml", cat: "MACRO" },
  { name: "Mining.com", url: "https://www.mining.com/feed/", cat: "MACRO" },
  { name: "OilPrice.com", url: "https://oilprice.com/rss/main", cat: "MACRO" },
  { name: "FRED Blog", url: "https://fredblog.stlouisfed.org/feed/", cat: "MACRO", rare: true },
  { name: "Liberty Street Economics", url: "https://libertystreeteconomics.newyorkfed.org/feed/", cat: "MACRO", rare: true },
  { name: "Bank of Japan", url: "https://www.boj.or.jp/en/rss/whatsnew.xml", cat: "MACRO", rare: true },
  { name: "ESMA", url: "https://www.esma.europa.eu/rss.xml", cat: "MACRO", rare: true },
];

// --- a small feed parser -----------------------------------------------------
// RSS <item> and Atom <entry> both appear among these sources, so both shapes
// are handled. Regex rather than an XML library on purpose: this must run with
// nothing installed.

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
    .replace(/&#8211;/g, "–");
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decodeEntities(stripCdata(m[1])).trim() : null;
}

/**
 * Strip HTML down to readable prose.
 *
 * Feed descriptions are usually a paragraph of real HTML — links, images, a
 * "read more" anchor. The model should see the sentences, not the markup, and
 * a trailing image tag is pure noise in a prompt.
 */
function stripHtml(s) {
  return decodeEntities(
    s
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

function parseFeed(xml) {
  const items = [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) ?? [];
  for (const block of blocks) {
    const title = tag(block, "title");
    if (!title) continue;
    // Atom puts the URL in an attribute rather than in the element body.
    let link = tag(block, "link");
    if (!link) {
      const m = block.match(/<link[^>]*href=["']([^"']+)["']/i);
      link = m ? m[1] : null;
    }
    const when = tag(block, "pubDate") ?? tag(block, "published") ?? tag(block, "updated");

    // THE FIELD THE FIRST VERSION THREW AWAY.
    //
    // The first summary read as three sentences carrying one sentence of fact,
    // because the model was handed nothing but a headline and asked for a
    // paragraph. That is not a model failing to write; that is being asked to
    // produce information it was not given. Most feeds ship a real summary
    // paragraph here, and content:encoded often carries the whole article.
    const raw =
      tag(block, "description") ??
      tag(block, "summary") ??
      tag(block, "content:encoded") ??
      tag(block, "content");
    const body = raw ? stripHtml(raw) : "";

    items.push({ title, link, when, at: when ? Date.parse(when) || 0 : 0, body });
  }
  return items;
}

async function checkFeed(feed) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
  try {
    const res = await fetch(feed.url, {
      cache: "no-store",
      signal: controller.signal,
      headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml, text/xml, */*" },
    });
    if (!res.ok) return { ...feed, ok: false, why: `HTTP ${res.status}` };
    const xml = await res.text();
    const items = parseFeed(xml);
    if (items.length === 0) return { ...feed, ok: false, why: "0 նյութ (կամ այլ ձևաչափ)" };

    const dated = items.filter((i) => i.at > 0);
    const newest = dated.length ? Math.max(...dated.map((i) => i.at)) : 0;
    const ageH = newest ? (Date.now() - newest) / 3_600_000 : null;

    // How much prose each item actually carries, since that is what decides
    // whether a summary can say anything. Measured as the median rather than
    // the mean: one feed shipping a whole article would otherwise make the
    // other nine look richer than they are.
    const lengths = items.map((i) => i.body.length).sort((a, b) => a - b);
    const medianBody = lengths.length ? lengths[Math.floor(lengths.length / 2)] : 0;

    return {
      ...feed,
      ok: true,
      count: items.length,
      ageH,
      undated: items.length - dated.length,
      items,
      medianBody,
      stale: ageH != null && ageH > STALE_HOURS && !feed.rare,
      nodate: ageH == null,
    };
  } catch (e) {
    return { ...feed, ok: false, why: e?.name === "AbortError" ? "ժամանակը լրացավ" : String(e?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

// --- what is not news --------------------------------------------------------
//
// Found by running the first real A/B: the freshest item with a body turned out
// to be a podcast episode — "Why the Clarity Act Could Decide America's
// Financial Future w/ John Deaton". The model correctly answered ԱՆԲԱՎԱՐԱՐ,
// because nothing had happened. That was the rule working, but it also spent an
// API call to discover something the title said plainly.
//
// These feeds carry a lot of this: podcasts, interviews, opinion columns,
// sponsored posts, and "price prediction" pieces written for search engines.
// None of them are events. Filtering on the title costs nothing and runs before
// any call is made.
//
// Deliberately conservative. A missed non-news item costs one wasted call and
// an ԱՆԲԱՐԱՐ; a wrongly-dropped real story is never seen again. So this matches
// only phrasing that is nearly always promotional, and anything uncertain is
// left for the model to judge.
const NOT_NEWS = [
  /\bw\/\s/i, // "… w/ John Deaton" — the podcast guest convention
  /\bpodcast\b/i,
  /\bepisode\b/i,
  /\binterview\b/i,
  /\bAMA\b/,
  /\bopinion\b/i,
  /\bop-ed\b/i,
  /\bsponsored\b/i,
  /\bpress release\b/i,
  /\bprice prediction\b/i,
  /\bprice analysis\b/i,
  /\bwhat to expect\b/i,
  /\bhere'?s why\b/i,
  /\bcould (hit|reach|soar|surge|explode)\b/i, // speculation dressed as news
  /\btop \d+\b/i, // "Top 5 altcoins to watch"
  /\bbest .* (of|for) \d{4}\b/i,
  /\bhow to\b/i,
  /\bguide\b/i,
  /\breview\b/i,
  /\bgiveaway\b/i,
  /\bwebinar\b/i,
];

function looksLikeNews(title) {
  return !NOT_NEWS.some((re) => re.test(title));
}

// --- the AI call -------------------------------------------------------------
// Two API shapes and several model names, because which combination a given key
// may use is an empirical question. The first that answers wins and the rest
// are not tried.
//
// The fallback chain is not theoretical: on the second run gemini-flash-latest
// answered "currently experiencing high demand" and gemini-3.8-flash served the
// request. A bot with one hard-coded model name would simply have posted
// nothing that half-hour and said nothing about why.
const MODELS = ["gemini-flash-latest", "gemini-3.8-flash", "gemini-2.5-flash", "gemini-2.0-flash"];
const GEM_BASE = "https://generativelanguage.googleapis.com/v1beta";

async function askInteractions(key, model, prompt) {
  const res = await fetch(`${GEM_BASE}/interactions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({ model, input: prompt }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, why: json?.error?.message ?? `HTTP ${res.status}` };
  const text = (json?.steps ?? [])
    .flatMap((s) => s?.content ?? [])
    .filter((c) => c?.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();
  return text ? { ok: true, text } : { ok: false, why: "դատարկ պատասխան" };
}

async function askGenerateContent(key, model, prompt) {
  const res = await fetch(`${GEM_BASE}/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, why: json?.error?.message ?? `HTTP ${res.status}` };
  const text = (json?.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p?.text ?? "")
    .join("")
    .trim();
  return text ? { ok: true, text } : { ok: false, why: "դատարկ պատասխան" };
}

// PROMPT v2 — each rule below is a specific thing v1 got wrong on a real item.
//
//   PADDING       v1 saw only a headline and was asked for a paragraph, so its
//                 third sentence restated its first. The fix is mostly in the
//                 parser (feed it the description), but the instruction to
//                 write less rather than repeat belongs here too.
//   TRANSLITERATION  v1 rendered the CLARITY Act as "Քլարիթի". A reader cannot
//                 search for that, and it reads as amateur. Proper nouns, bill
//                 names and tickers stay in Latin script inside Armenian text.
//   RESTATING THE QUESTION  v1 opened its third section with "This event is
//                 important for the crypto market because…", spending a line to
//                 say nothing.
//   MARKDOWN      v1 emitted ** around headings. Telegram renders that as
//                 literal asterisks. Formatting is the code's job, so the model
//                 is asked for labelled plain lines and nothing else.
const SUMMARY_PROMPT = (headline, body, source) => {
  const material = body
    ? `Վերնագիր՝ "${headline}"\n\nՏեքստ՝ "${body.slice(0, 1500)}"`
    : `Վերնագիր՝ "${headline}"\n\n(Տեքստ չկա — միայն վերնագիրը։)`;

  return `Դու ֆինանսական լրագրող ես և գրում ես հայերեն։ Աղբյուրը՝ ${source}։

${material}

Գրիր ՃԻՇՏ այս ձևով, երեք տող, առանց այլ բանի՝

ՎԵՐՆԱԳԻՐ: <մինչև 10 բառ>
ԻՆՉ: <1-3 նախադասություն՝ ինչ է տեղի ունեցել>
ԻՆՉՈՒ: <մեկ նախադասություն՝ ինչ նշանակություն ունի կրիպտո շուկայի համար>

ԿԱՆՈՆՆԵՐ՝
- Մի՛ հորինիր թիվ, գին, տոկոս, ամսաթիվ կամ անուն, որ վերևի նյութում չկա
- Քիչ գրիր՝ լավ։ Եթե միայն մեկ նախադասության փաստ կա, գրիր մեկ նախադասություն։ ՄԻ՛ կրկնիր նույն բանը այլ բառերով
- Հատուկ անունները, ընկերությունների անունները, օրինագծերի անունները և ticker-ները թո՛ղ լատինատառ՝ CLARITY Act, SEC, BlackRock, BTC։ Մի՛ տառադարձիր
- ԻՆՉՈՒ տողը սկսի՛ր ուղիղ բովանդակությամբ։ Մի՛ գրիր «Սա կարևոր է, որովհետև...»
- Մի՛ օգտագործիր * # կամ այլ նշաններ ձևավորման համար
- Մի՛ տուր ներդրումային խորհուրդ
- Եթե նյութը չափազանց քիչ է, որ բան ասես, գրիր միայն՝ ԱՆԲԱՎԱՐԱՐ`;
};

/** Find the first API shape + model this key can actually use. */
async function findWorkingModel(key) {
  for (const shape of [
    { label: "interactions", fn: askInteractions },
    { label: "generateContent", fn: askGenerateContent },
  ]) {
    for (const model of MODELS) {
      process.stdout.write(`  ${shape.label} · ${model}  … `);
      let r;
      try {
        r = await shape.fn(key, model, "Պատասխանիր մեկ բառով՝ ԼԱՎ");
      } catch (e) {
        r = { ok: false, why: String(e?.message ?? e) };
      }
      if (r.ok) {
        console.log("✅");
        return { ...shape, model };
      }
      console.log(`❌ ${String(r.why).slice(0, 80)}`);
    }
  }
  return null;
}

async function checkGeminiMany(items) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    console.log("\nGEMINI_API_KEY չկա — AI-ի ստուգումը բաց եմ թողնում։");
    console.log("Երբ բանալին ունենաս, գործարկիր՝");
    console.log('  $env:GEMINI_API_KEY="բանալին"; node scripts/news-doctor.mjs');
    return;
  }

  console.log("\nAI ստուգում (Gemini)");
  console.log("─".repeat(60));

  const picked = await findWorkingModel(key);
  if (!picked) {
    console.log("\n  Ոչ մի մոդել չաշխատեց։ Վերևի սխալները ուղարկիր՝ միասին կկարդանք։");
    return;
  }

  console.log("");
  console.log(`  ԱՇԽԱՏՈՒՄ Է՝ ${picked.label} · ${picked.model}`);

  // THREE items, not one. The first real A/B landed on a podcast episode, both
  // sides answered ԱՆԲԱՎԱՐԱՐ — correct, and completely uninformative about
  // whether the body text improves a summary. One sample cannot answer that
  // when a fair share of every feed is not news at all.
  for (const { item, source } of items) {
    console.log("");
    console.log("═".repeat(60));
    console.log(`  ${source} · տեքստ ${item.body.length} նիշ`);
    console.log(`  ${item.title}`);
    console.log("");

    const b = await picked.fn(key, picked.model, SUMMARY_PROMPT(item.title, item.body, source));
    console.log("  ── Բ՝ ՎԵՐՆԱԳԻՐ + ՏԵՔՍՏ ──────────────────────────");
    if (b.ok) for (const line of b.text.split("\n")) console.log(`    ${line}`);
    else console.log(`    (չստացվեց՝ ${b.why})`);

    if (item.body) {
      const a = await picked.fn(key, picked.model, SUMMARY_PROMPT(item.title, "", source));
      console.log("");
      console.log("  ── Ա՝ ՄԻԱՅՆ ՎԵՐՆԱԳԻՐ ────────────────────────────");
      if (a.ok) for (const line of a.text.split("\n")) console.log(`    ${line}`);
      else console.log(`    (չստացվեց՝ ${a.why})`);
    }
  }

  console.log("");
  console.log("═".repeat(60));
  console.log("  Համեմատի՛ր Ա-ն և Բ-ն ամեն նյութի համար։");
  console.log("  Հարցը «ավելի շա՞տ բառ» չէ, այլ «ավելի շա՞տ իրական փաստ»։");
}


// --- main --------------------------------------------------------------------

async function main() {
  console.log("");
  console.log("NEWS ԱԽՏՈՐՈՇԻՉ");
  console.log("═".repeat(60));
  console.log(`Node ${process.version} · ${new Date().toISOString()}`);
  console.log(`${FEEDS.length} աղբյուր · հին = ${STALE_HOURS}ժ-ից ավել`);
  console.log("═".repeat(60));

  // Checked in parallel: they are independent, and serially this would take
  // longer than the patience of anyone watching it.
  const results = await Promise.all(FEEDS.map(checkFeed));

  const good = [];
  console.log("");
  for (const r of results) {
    const label = `${r.name.padEnd(17)} ${r.cat.padEnd(6)}`;
    if (!r.ok) {
      console.log(`❌ ${label} ${r.why}`);
    } else if (r.stale) {
      console.log(`⚠️  ${label} ${r.count} նյութ · ամենաթարմը ${Math.round(r.ageH)}ժ առաջ — ՀԻՆ`);
    } else if (r.nodate) {
      console.log(`⚠️  ${label} ${r.count} նյութ · ամսաթիվ չկա — չեմ կարող թարմությունը չափել`);
    } else {
      // The body length is printed for every feed because it decides what a
      // summary can contain. A feed of bare headlines cannot produce a
      // paragraph no matter how the prompt is worded.
      const age = r.rare && r.ageH > STALE_HOURS ? `${Math.round(r.ageH / 24)}օր (հազվադեպ՝ նորմալ)` : `${r.ageH.toFixed(1)}ժ`;
      const body = r.medianBody === 0 ? "ՏԵՔՍՏ ՉԿԱ" : `տեքստ ~${r.medianBody}ն`;
      console.log(`✅ ${label} ${String(r.count).padStart(3)} նյութ · ${age.padEnd(22)} · ${body}`);
      good.push(r);
    }
  }

  console.log("");
  console.log("═".repeat(60));
  console.log(`ՊԻՏԱՆԻ ԱՂԲՅՈՒՐ՝ ${good.length} / ${FEEDS.length}`);
  const crypto = good.filter((g) => g.cat === "CRYPTO").length;
  console.log(`  CRYPTO ${crypto} · MACRO ${good.length - crypto}`);
  console.log("═".repeat(60));

  if (good.length === 0) {
    console.log("\nՈչ մի աղբյուր չաշխատեց — ամենայն հավանականությամբ ցանցի խնդիր է, ոչ թե feed-երի։");
    return;
  }

  // --- pick the samples ------------------------------------------------------
  //
  // Three items, from three different sources, each of which looks like an
  // actual event and carries enough prose to summarise. The previous version
  // took whichever item happened to be freshest and landed on a podcast
  // episode, where both halves of the A/B correctly answered ԱՆԲԱՎԱՐԱՐ and
  // therefore measured nothing.
  const candidates = [];
  for (const feed of good) {
    for (const item of feed.items) {
      if (!looksLikeNews(item.title)) continue;
      if (item.body.length < 250) continue;
      candidates.push({ item, source: feed.name, at: item.at });
      break; // one per source, so three samples are three outlets
    }
  }
  candidates.sort((a, b) => b.at - a.at);

  // How much of the raw feed is not news at all — worth knowing before the bot
  // is written around an assumed volume.
  const allItems = good.flatMap((g) => g.items);
  const dropped = allItems.filter((i) => !looksLikeNews(i.title)).length;
  console.log("");
  console.log(`Ընդամենը ${allItems.length} նյութ · ոչ-նորություն ${dropped} (${Math.round((dropped / allItems.length) * 100)}%)`);
  console.log(`Ամփոփման պիտանի՝ ${candidates.length} աղբյուրից`);

  if (candidates.length === 0) {
    console.log("\nՈչ մի պիտանի նյութ չգտա — զտիչը չափազանց խիստ է, պիտի թուլացնեմ։");
    return;
  }

  await checkGeminiMany(candidates.slice(0, 3));
  console.log("");
}

main().catch((e) => {
  console.error("ախտորոշիչը ընկավ՝", e);
  process.exit(1);
});
