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
  CoinDesk: 2,
  Cointelegraph: 2,
  Decrypt: 2,
  Protos: 2,
  "Bitcoin Magazine": 1.5,
  CryptoSlate: 1.5,
  BeInCrypto: 1,
  NewsBTC: 1,
  CoinJournal: 1,
  "Yahoo Finance": 1,
  "U.Today": 0.6,
};

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
export function scoreCluster(cluster) {
  const sources = Array.from(cluster.sources);
  // The strongest single voice, plus a smaller credit for each additional
  // outlet. A Fed release alone must beat five aggregators repeating a rumour,
  // but six independent newsrooms must still beat one mid-tier report.
  const best = Math.max(...sources.map(weightOf));
  const rest = sources.reduce((sum, s) => sum + weightOf(s), 0) - best;
  const score = best + rest * 0.8;

  return {
    score,
    sources,
    count: sources.length,
    why: `${sources.length} աղբյուր՝ ${sources.join(", ")}`,
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

export function rankStories(items, { minScore = 3.0, limit = 3 } = {}) {
  const clusters = clusterStories(items);
  const scored = clusters
    .map((c) => {
      const s = scoreCluster(c);
      return { ...s, at: c.at, lead: c.items[0], items: c.items, words: c.words };
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
    if (picked.some((p) => similarity(p.words, story.words) >= SAME_SUBJECT_THRESHOLD)) continue;
    picked.push(story);
    if (picked.length >= limit) break;
  }
  return picked;
}
