// WHICH STORIES ARE WORTH POSTING — decided by arithmetic, not by judgement.
//
// THE PROBLEM
//
//   Ten crypto outlets produce a few hundred items a day, and most of them are
//   the same thirty stories told ten times. A channel that posts everything is
//   unreadable; a channel that posts a tenth of it at random is worthless.
//
// WHY NOT ASK THE MODEL
//
//   The obvious move is to hand each headline to an AI and ask "is this
//   important?". That is a guess wearing a number. It is not reproducible — the
//   same headline can score differently twice — it cannot be audited, and when
//   the channel posts something silly there is no way to find out why.
//
// WHAT IS MEASURED INSTEAD
//
//   CORROBORATION. If Cointelegraph, CoinDesk, Decrypt and Protos all ran the
//   same story within a few hours, that is four independent newsrooms deciding
//   it mattered. If one site ran it, one editor decided. Counting them costs
//   nothing, is identical every time, and can be explained in one sentence:
//   "posted because six sources carried it".
//
//   This also handles the case a keyword filter cannot. "Robert Kiyosaki Says
//   the Biggest Crash in History Has Started" is one man's opinion, and the
//   regex that would catch it would also catch "SEC says". But a Kiyosaki quote
//   is carried by the outlets that print Kiyosaki quotes, and a Fed decision is
//   carried by everyone. The vote separates them without anyone writing a rule
//   about Kiyosaki.
//
//   SOURCE WEIGHT. Not every vote is equal. An official announcement from the
//   Fed or the SEC is the event itself, not a report of one, so a single item
//   from those sources outranks a crowd of aggregators.
//
// The AI is never asked what to post. It is asked only to write Armenian about
// what this file has already chosen.

/** Two items this far apart in time are different stories, not one. */
export const CLUSTER_WINDOW_MS = 18 * 3_600_000;

/** Share of significant words two titles must have in common to be one story. */
export const SAME_STORY_THRESHOLD = 0.42;

/**
 * How much one source's vote counts.
 *
 * Primary sources are not reporting the news, they ARE the news — the Fed's
 * own statement needs no corroboration because there is nothing to corroborate
 * against. Aggregators and high-volume republishers count for less: U.Today
 * alone published 93 of the 370 items in one snapshot, and letting volume buy
 * influence would put the loudest source in charge of the channel.
 */
export const SOURCE_WEIGHT = {
  "Federal Reserve": 6,
  "Fed (all press)": 5,
  SEC: 5,
  ECB: 4,
  BLS: 5,
  // Added alongside the Fed/SEC/ECB/BLS group on 2026-09-23: another G7
  // central bank whose own rate decisions and statements are the event
  // itself, exactly like the Fed's — not a report of one.
  "Bank of England": 5,
  // Added 2026-09-24. The G7's other rate-setting central bank, same reasoning
  // as the Bank of England above.
  "Bank of Japan": 4,
  // The two regulators whose rulings reach crypto directly (MiCA, UK crypto
  // authorisation). Primary, but only on a market-moving topic — see
  // PRIMARY_TOPIC below; their feeds are mostly consultations and notices.
  ESMA: 4,
  FCA: 4,

  // TIER 1 — CRYPTO NEWSROOMS WITH THEIR OWN REPORTING.
  // The Block, Blockworks and DL News were added on 2026-09-23 and fell through
  // to DEFAULT_WEIGHT, which ranked them below CoinDesk for no reason anyone
  // chose. They break stories themselves, and are weighted as the peers they are.
  CoinDesk: 2,
  Cointelegraph: 2,
  Decrypt: 2,
  Protos: 2,
  "The Block": 2,
  Blockworks: 2,
  "DL News": 2,

  "Bitcoin Magazine": 1.5,
  CryptoSlate: 1.5,
  Forkast: 1.5,
  // Dow Jones' own newsroom, not a wire rewrite.
  MarketWatch: 1.5,

  BeInCrypto: 1,
  NewsBTC: 1,
  CoinJournal: 1,
  Bitcoinist: 1,
  CryptoPotato: 1,
  "crypto.news": 1,
  Cryptonews: 1,
  SlowMist: 1,
  "Yahoo Finance": 1,
  "Mining.com": 1,
  "OilPrice.com": 1,
  // Research blogs: analysis of events, not events. A full vote, never primary.
  "Glassnode Research": 1,
  "FRED Blog": 1,
  "Liberty Street Economics": 1,

  "U.Today": 0.6,
  // High volume, thin original reporting, heavy on sponsored and listicle
  // content — a vote, but not a full one, for the same reason as U.Today.
  Coinpedia: 0.6,
  "The Daily Hodl": 0.6,
  // FOUR FOREX/MACRO WIRE SERVICES, WEIGHTED LIKE U.TODAY AND FOR THE SAME
  // REASON — added 2026-09-23, then immediately found (by a fresh adversarial
  // review, not by using them) to need this weight rather than the default.
  //
  // A scheduled macro release — a PMI print, a Fed speaker's remarks — gets
  // near-simultaneous coverage from every forex-news site the moment the
  // number drops, because reacting fast to the calendar IS their business
  // model. That is not five newsrooms independently deciding a story matters;
  // it is one wire event with five stopwatches on it. Investing.com's own
  // feed explicitly republishes Reuters content (see feeds.js's note on why
  // it is used as a Reuters workaround), and FXStreet's own sample was "half
  // bank-research-note aggregation" — neither is the "independent newsroom"
  // vote importanceOf()'s `count >= 5` rule was written to count.
  //
  // Left at DEFAULT_WEIGHT: MarketWatch, Mining.com and OilPrice.com — each
  // confirmed (when these sources were researched) to run its own original
  // reporting rather than same-day wire reaction, so no reason to treat them
  // differently from any other ordinary outlet on this list.
  "Investing.com": 0.6,
  InvestingLive: 0.6,
  FXStreet: 0.6,
  ActionForex: 0.6,
};

// ── PRIMARY STATUS IS EARNED BY THE TOPIC, NOT GRANTED BY THE NAME ──────────
//
// A primary source's weight is what lets one item post on its own, marked
// 🟪🟪🟪, with a sound. That was right for "Federal Reserve issues FOMC
// statement" and wrong for everything else those same feeds publish. Every
// primary-source title the bot handled up to 2026-09-24, and what the old
// rule did with it:
//
//   Federal Reserve issues FOMC statement                          HIGH ✓
//   Federal Reserve Board announces approval of application by
//     BancFirst Corporation                                       HIGH ✗
//   Federal Reserve Board announces termination of enforcement
//     action with SNB Bancshares and Bank of Eufaula              HIGH ✗
//   Almost ten million people took part in ECB survey on new
//     euro banknotes                                              HIGH ✗
//   Foreign Currency Reserves 2026 – Market Notice (BoE)          HIGH ✗
//   SEC Censures OTC Link LLC … Regulation SCI                    HIGH ✗
//   SEC Charges South Florida Resident and His Company …          HIGH ✗
//   SEC Proposes Rescission of Shareholder Proposal Rule …        HIGH ✗
//   SEC Publishes Updated Market Statistics …                     HIGH ✗
//   ECB Consumer Expectations Survey / wage tracker / a speech    HIGH ✗
//
// One in eleven. So a primary item keeps its weight only when its TITLE is
// about something that moves markets: rates and monetary policy, the big
// scheduled data, or crypto itself. Anything else counts as one ordinary vote
// (DEFAULT_WEIGHT) — which alone is below MIN_SCORE, so a bank's merger
// approval simply does not post, while a genuinely big SEC case that the
// press picks up still does, through corroboration, like any other story.
//
// An allowlist, not a blocklist, on purpose: the noise is open-ended (every
// enforcement action, notice and survey has its own wording), the signal is a
// short, stable vocabulary. The cost of a miss is a story that has to be
// corroborated to post — not a story lost.

export const PRIMARY_TOPIC = [
  // rates and monetary policy
  /\bFOMC\b/i,
  /\bmonetary policy\b/i,
  /\binterest rates?\b/i,
  /\b(policy|bank|key|base|federal funds|deposit facility) rates?\b/i,
  /\brate (decision|cut|cuts|hike|hikes|increase|reduction)\b/i,
  /\b(raises?|cuts?|lowers?|holds?|keeps?|leaves?|maintains?)\b[^.]{0,40}\brates?\b/i,
  /\bbasis points?\b/i,
  /\b(balance sheet|quantitative (easing|tightening)|asset purchases?)\b/i,
  /\bemergency\b/i,
  // the scheduled data that moves everything
  /\b(consumer|producer) price/i,
  /\bCPI\b|\bPPI\b|\bPCE\b/,
  /\binflation\b/i,
  /\bemployment situation\b/i,
  /\b(non-?farm )?payrolls?\b/i,
  /\bunemployment\b/i,
  /\bjob openings\b/i,
  /\bGDP\b|\bgross domestic product\b/i,
  // crypto itself
  /\bcrypto/i,
  /\bbitcoin\b|\bether(eum)?\b/i,
  /\bstablecoins?\b/i,
  /\bdigital (assets?|euro|currenc(y|ies))\b/i,
  /\bCBDC\b|\bMiCA\b/,
  /\btokeni[sz](ed|ation)\b/i,
  /\bblockchain\b|\bdistributed ledger\b/i,
  /\bspot\b[^.]{0,30}\b(ETF|exchange-traded)/i,
];

export function isMarketMovingTopic(title) {
  const t = String(title ?? "");
  return PRIMARY_TOPIC.some((re) => re.test(t));
}

/**
 * One ITEM's weight: its source's weight, except that a primary source on a
 * topic outside PRIMARY_TOPIC counts as an ordinary vote. See the note above.
 */
export function itemWeight(item) {
  const base = weightOf(item?.source);
  if (base < PRIMARY_WEIGHT) return base;
  return isMarketMovingTopic(item?.title) ? base : DEFAULT_WEIGHT;
}

export const DEFAULT_WEIGHT = 1;

export function weightOf(source) {
  return SOURCE_WEIGHT[source] ?? DEFAULT_WEIGHT;
}

// Words that carry no information about WHICH story this is. Without this list
// two unrelated headlines share "the", "for", "with" and start to look similar.
const STOP = new Set([
  "the","a","an","and","or","but","of","to","in","on","at","for","with","by","from","as","is","are",
  "was","were","be","been","it","its","this","that","these","those","after","before","over","under",
  "into","out","up","down","new","now","says","said","will","could","would","may","might","has","have",
  "had","not","no","more","most","than","then","amid","about","against","how","why","what","who","when",
]);

/**
 * The words that identify a story.
 *
 * Numbers are KEPT deliberately — "$340 million" and "12,000 BTC" are often the
 * single most identifying thing in a headline, and two stories about different
 * amounts are different stories.
 */
export function keyWords(title) {
  return new Set(
    String(title)
      .toLowerCase()
      .replace(/[^a-z0-9$%.\s-]/g, " ")
      .split(/\s+/)
      .map((w) => w.replace(/^[-.]+|[-.]+$/g, ""))
      .filter((w) => w.length > 2 && !STOP.has(w))
  );
}

/**
 * Overlap between two word sets, scaled by the SMALLER set.
 *
 * Plain Jaccard divides by the union, which punishes a pair of headlines simply
 * for one being longer — "Fed holds rates" against "Federal Reserve holds rates
 * steady at 4.25% as officials signal caution on further cuts" would score low
 * on union even though the short one is entirely contained in the long one.
 * Dividing by the smaller set asks the question that actually matters: is one
 * headline essentially a subset of the other?
 */
export function similarity(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

/**
 * Group items that are the same story told by different outlets.
 *
 * Greedy single-link clustering: each item joins the first cluster it matches.
 * Not the most sophisticated choice available, and deliberately so — a
 * clustering that cannot be traced by hand cannot be debugged when the channel
 * posts two halves of one story, and this one can be.
 */
export function clusterStories(items) {
  const withWords = items.map((i) => ({ ...i, words: keyWords(i.title) }));
  // Newest first, so the cluster's representative item is its freshest report.
  withWords.sort((a, b) => b.at - a.at);

  const clusters = [];
  for (const item of withWords) {
    let joined = false;
    for (const cluster of clusters) {
      if (Math.abs(cluster.at - item.at) > CLUSTER_WINDOW_MS) continue;
      if (similarity(cluster.words, item.words) >= SAME_STORY_THRESHOLD) {
        cluster.items.push(item);
        // One outlet publishing twice about its own story is one vote, not two.
        cluster.sources.add(item.source);
        joined = true;
        break;
      }
    }
    if (!joined) {
      clusters.push({
        at: item.at,
        words: item.words,
        items: [item],
        sources: new Set([item.source]),
      });
    }
  }
  return clusters;
}

/**
 * A cluster's score, and the sentence that explains it.
 *
 * Every posted story can answer "why was this posted" with a number and a list
 * of names. That is the property the whole design exists to have.
 */
/** At or above this weight a source IS the news rather than a report of it. */
export const PRIMARY_WEIGHT = 4;

/**
 * HOW IMPORTANT IS THIS — on the same three levels the calendar uses.
 *
 * A reader should be able to tell at a glance whether a post is the Fed moving
 * rates or a mid-tier site noticing that a coin went up. One colour scale,
 * learned once, used by both halves of the channel.
 *
 * NOT DERIVED FROM THE BLENDED SCORE, though that was the obvious move. A lone
 * Fed statement scores 6.0 and four aggregators agreeing score 5.6, so any
 * single threshold on that number puts a rate decision and a repeated rumour in
 * the same bracket. The two things that make news important are different in
 * kind, so they are asked about separately:
 *
 *   IS A PRIMARY SOURCE INVOLVED — the Fed, the SEC, the ECB, the BLS. They do
 *   not report the news, they are it, and one of them alone is the top tier.
 *
 *   HOW MANY INDEPENDENT NEWSROOMS RAN IT — five or more is the press as a
 *   whole deciding something mattered.
 *
 * Both are counted facts, so the tier can be published with its evidence
 * underneath it. That is the difference between a label and a claim.
 *
 * `count >= 5` USED TO MEAN raw sources.length, WHICH STOPPED BEING SAFE THE
 * DAY THE SOURCE LIST GREW.
 *
 * At ten crypto outlets, five distinct names agreeing was a reasonable proxy
 * for "the press as a whole" — getting five separate newsrooms to run the
 * same non-primary story took real, independent editorial pickup. Once the
 * forex/macro wire services were added (see the SOURCE_WEIGHT comment above),
 * that stopped being true: five of THOSE on one scheduled data release is
 * five stopwatches on the same wire event, not five editors. Demonstrated
 * directly — a routine "durable goods orders rise 0.3%" headline, corroborated
 * only by Investing.com/InvestingLive/FXStreet/ActionForex/MarketWatch/Yahoo
 * Finance, scored HIGH under the raw count, the same tier as a lone Fed
 * statement, which is exactly the failure this file's own `score` design
 * (best-source-plus-partial-credit, not a flat sum) already exists to prevent
 * for the blended number — `count` was just never given the same treatment.
 *
 * So the top tier now requires five sources that are each worth a FULL vote
 * (weight >= 1) — U.Today and the wire services above sit below that specifically
 * so volume from them cannot substitute for independent judgement. `count`
 * itself is untouched and still means what it says: the literal number of
 * named outlets, which is what evidenceLine() in telegram.js prints and
 * promises is checkable. Only the HIGH gate reads a stricter number.
 */
export function importanceOf({ sources, count, score, weights = null }) {
  const w = (s) => (weights && s in weights ? weights[s] : weightOf(s));
  const primary = sources.some((s) => w(s) >= PRIMARY_WEIGHT);
  const fullVotes = sources.filter((s) => w(s) >= 1).length;
  if (primary || fullVotes >= 5) return "HIGH";
  if (count >= 3 || score >= 5) return "MEDIUM";
  return "LOW";
}

/**
 * Each source's weight IN THIS CLUSTER — the best of its items, through
 * itemWeight(), so a Fed item on an off-topic subject counts as one vote.
 * Built from `items` when the cluster has them; a bare `sources` set (as some
 * tests pass) falls back to the name alone, exactly as before.
 */
export function clusterWeights(cluster) {
  const weights = {};
  if (Array.isArray(cluster.items) && cluster.items.length) {
    for (const item of cluster.items) {
      const w = itemWeight(item);
      if (!(item.source in weights) || w > weights[item.source]) weights[item.source] = w;
    }
  }
  for (const s of cluster.sources ?? []) if (!(s in weights)) weights[s] = weightOf(s);
  return weights;
}

// ── WHICH REPORT SPEAKS FOR THE STORY ────────────────────────────────────────
//
// The lead used to be items[0] — simply the NEWEST report. On a Fed decision
// that is the wrong one almost by construction: the Fed publishes first, then
// CoinDesk, then Yahoo, so the newest is the furthest from the source. The
// post linked the reader to a retelling, and the model summarised a retelling.
//
// Now: the heaviest voice in the cluster (by itemWeight — so an on-topic Fed
// or SEC release wins outright), and among equals the newest, which keeps the
// old behaviour for everything that has no primary source.
export function pickLead(items) {
  let best = items[0];
  for (const i of items) {
    const d = itemWeight(i) - itemWeight(best);
    if (d > 0 || (d === 0 && (i.at ?? 0) > (best.at ?? 0))) best = i;
  }
  return best;
}

/** Material shorter than this is not enough for a 2–3 sentence summary. */
export const MIN_SUMMARY_BODY = 200;

/**
 * What the model reads. Normally the lead itself. But official feeds often
 * carry a title and one line — "Federal Reserve issues FOMC statement" with no
 * body — and the model would rightly answer ԱՆԲԱՎԱՐԱՐ, losing the most
 * important story of the week. So when the lead is thin, the model reads the
 * fullest report from the best-weighted outlet instead, while the post still
 * names and links the lead. The reader gets the original; the summary gets
 * enough words to be accurate.
 */
export function pickSummarySource(lead, items) {
  if (String(lead?.body ?? "").length >= MIN_SUMMARY_BODY) return lead;
  const rich = items
    .filter((i) => i !== lead && String(i.body ?? "").length >= MIN_SUMMARY_BODY)
    .sort((a, b) => itemWeight(b) - itemWeight(a) || String(b.body).length - String(a.body).length);
  return rich[0] ?? lead;
}

export function scoreCluster(cluster) {
  const sources = Array.from(cluster.sources);
  const weights = clusterWeights(cluster);
  const wOf = (s) => weights[s] ?? weightOf(s);
  // The strongest single voice, plus a smaller credit for each additional
  // outlet. A Fed release alone must beat five aggregators repeating a rumour,
  // but six independent newsrooms must still beat one mid-tier report.
  const best = Math.max(...sources.map(wOf));
  const rest = sources.reduce((sum, s) => sum + wOf(s), 0) - best;
  const score = best + rest * 0.8;
  const count = sources.length;

  return {
    score,
    sources,
    count,
    weights,
    importance: importanceOf({ sources, count, score, weights }),
    // Named rather than counted. "1 աղբյուր՝ Federal Reserve" reads as a
    // confession; "պաշտոնական աղբյուր՝ Federal Reserve" reads as what it is.
    // Only sources that EARNED primary status on this story's topic.
    primary: sources.filter((s) => wOf(s) >= PRIMARY_WEIGHT),
    why: `${count} աղբյուր՝ ${sources.join(", ")}`,
  };
}

/**
 * The stories worth posting right now, best first.
 *
 * `minScore` is the only tuning knob, and it is expressed in the same units as
 * SOURCE_WEIGHT so it can be reasoned about: at 3.0 a single Fed or SEC item
 * passes alone, while ordinary crypto news needs two or three outlets to agree.
 */
export const SAME_SUBJECT_THRESHOLD = 0.3;

/**
 * Words that appear in half the crypto headlines ever written.
 *
 * Plain overlap treats "crypto" and "CLARITY" as equally informative, which is
 * how the two CLARITY Act posts slipped past: they shared exactly the bill's
 * name and scored 0.25, because the rest of each headline was ordinary
 * vocabulary diluting the one token that mattered.
 */
const COMMON = new Set([
  "crypto","cryptocurrency","bitcoin","btc","ethereum","eth","token","tokens","coin","coins",
  "price","prices","market","markets","trading","trade","trades","exchange","exchanges",
  "stocks","shares","investors","investor","fund","funds","etf","etfs","blockchain",
  "million","billion","percent","week","month","year","day","report","reports","data",
  "firm","company","companies","group","bank","banks","industry","sector","news","update",
]);

/** Tokens that actually identify a subject: names, places, bills, tickers. */
export function distinctive(words) {
  return new Set(Array.from(words).filter((w) => !COMMON.has(w) && !/^\d+$/.test(w)));
}

/**
 * Are two stories about the same THING?
 *
 * Two independent tests, either of which is enough:
 *   - broad overlap, for stories phrased similarly;
 *   - two or more shared distinctive tokens, for stories that share a named
 *     subject inside otherwise different sentences. "CLARITY" + "act" is two,
 *     and that is the case the first version missed. A single shared name is
 *     not enough — "SEC" appears in a great many unrelated stories.
 */
export function sameSubject(a, b) {
  if (similarity(a, b) >= SAME_SUBJECT_THRESHOLD) return true;
  const da = distinctive(a);
  const db = distinctive(b);
  let shared = 0;
  for (const w of da) if (db.has(w)) shared += 1;
  return shared >= 2;
}

export function rankStories(items, { minScore = 3.0, limit = 3 } = {}) {
  const clusters = clusterStories(items);
  const scored = clusters
    .map((c) => {
      const s = scoreCluster(c);
      const lead = pickLead(c.items);
      return {
        ...s, at: c.at, lead, summarySource: pickSummarySource(lead, c.items), items: c.items, words: c.words,
      };
    })
    .filter((c) => c.score >= minScore)
    .sort((a, b) => b.score - a.score || b.at - a.at);

  // ONE SUBJECT DOES NOT GET THE WHOLE RUN.
  //
  // The first run against real feeds picked three stories and all three were the
  // CLARITY Act: "crypto stocks slide after it fails to advance", "Democrats
  // move the goalposts", and a senator saying it is now or never. The ranking
  // was right — that genuinely was the day's story — but three posts about one
  // bill in one batch reads as a stuck channel, and it crowds out everything
  // else that happened.
  //
  // SAME_SUBJECT_THRESHOLD is deliberately lower than SAME_STORY_THRESHOLD:
  // clustering asks "is this the same event", this asks the softer "is this the
  // same subject", because a reader does not care that the angle differs.
  //
  // The highest-scoring report of a subject wins and the rest wait for a later
  // run. If nothing else clears the bar, the run posts one story instead of
  // three — the correct outcome on a one-story day.
  const picked = [];
  for (const story of scored) {
    if (picked.some((p) => sameSubject(p.words, story.words))) continue;
    picked.push(story);
    if (picked.length >= limit) break;
  }
  return picked;
}
