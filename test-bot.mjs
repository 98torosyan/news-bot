// Guards the parts that turn a chosen story into a message, and the memory
// that stops it going out twice.
//
//   node scripts/test-bot.mjs
//
// These run with no network and no key: everything here is pure, which is why
// it can be tested at all. The ranking has its own file, scripts/test-rank.mjs.

import { parseSummary, summaryPrompt, INSUFFICIENT, ask, MODELS, discoverModels } from "./ai.js";
import { renderPost, esc, sendMessage, stripBlockquotes, noOrphan } from "./telegram.js";
import {
  storyKey, storyKeys, MAX_KEYS_PER_STORY, alreadyPosted, remember, prune,
  rememberTopic, recentTopics, SUBJECT_COOLDOWN_MS,
} from "./state.js";
import { keyWords, sameSubject, importanceOf, scoreCluster } from "./rank.js";
import { parseFeed, looksLikeNews, freshNews, stripHtml } from "./feeds.js";

let failures = 0;
const pass = (m) => console.log(`  ok   ${m}`);
const fail = (m) => {
  console.log(`  FAIL ${m}`);
  failures++;
};

console.log("\n1. Reading the model's answer");
{
  const good = `ՎԵՐՆԱԳԻՐ: Senate-ը արգելափակել է Clarity Act օրինագիծը
ԻՆՉ: Օրենսդիրները արգելափակել են օրինագիծը՝ հավանաբար տապալելով այն 2026-ի համար։
ԻՆՉՈՒ: Որոշումը հետաձգում է ոլորտի կարգավորումը։`;
  const s = parseSummary(good);
  if (!s || s.insufficient) fail("a well-formed answer must parse");
  else pass("a well-formed answer parses");
  // ԻՆՉՈՒ also begins with ԻՆՉ, which a naive prefix search reads as the
  // ԻՆՉ line — putting the significance sentence in the body and losing the
  // body entirely.
  if (s && s.what.startsWith("Օրենսդիրները")) pass("ԻՆՉ and ԻՆՉՈՒ are not confused");
  else fail(`ԻՆՉ line wrong: ${s && s.what}`);
  if (s && s.why.startsWith("Որոշումը")) pass("the significance line is read separately");
  else fail(`ԻՆՉՈՒ line wrong: ${s && s.why}`);

  if (parseSummary(INSUFFICIENT)?.insufficient !== true) fail("ԱՆԲԱՎԱՐԱՐ must be recognised");
  else pass("ԱՆԲԱՎԱՐԱՐ is recognised as a refusal, not as a headline");

  if (parseSummary("just some prose with no labels at all") !== null) {
    fail("an unparseable answer must be null so the story is skipped");
  } else pass("an unparseable answer yields null — the story is skipped, not half-posted");

  // Belt and braces: the prompt forbids markdown, but a stray ** must never
  // reach Telegram as literal asterisks.
  const starred = parseSummary("ՎԵՐՆԱԳԻՐ: **Ուժեղ**\nԻՆՉ: Ինչ-որ բան եղավ։");
  if (starred?.headline.includes("*")) fail("markdown must be stripped");
  else pass("stray markdown is stripped rather than published");
}

console.log("\n2. The prompt carries its rules");
{
  const p = summaryPrompt({ title: "T", body: "B", source: "S" });
  for (const rule of ["Մի՛ հորինիր", "լատինատառ", INSUFFICIENT, "ներդրումային խորհուրդ"]) {
    if (!p.includes(rule)) fail(`the prompt lost a rule: ${rule}`);
  }
  pass("no-invention, no-transliteration, insufficiency and no-advice rules are all present");

  const noBody = summaryPrompt({ title: "T", body: "", source: "S" });
  if (!noBody.includes("Տեքստ չկա")) fail("a bodyless item must say so rather than pretend");
  else pass("a bodyless item tells the model it has only a headline");

  // A whole article would blow past the free tier's token budget for no gain.
  const huge = summaryPrompt({ title: "T", body: "x".repeat(9000), source: "S" });
  if (huge.length > 3000) fail(`body must be capped, prompt was ${huge.length}`);
  else pass("an over-long body is capped");
}

console.log("\n3. The post");
{
  const summary = { headline: "SEC-ը հաստատեց Solana ETF-ը", what: "Երեք դիմում հաստատվեց։", why: "Նոր կապիտալ։" };
  const text = renderPost({
    summary,
    source: "CoinDesk",
    link: "https://coindesk.com/x?a=1&b=2",
    why: "3 աղբյուր՝ CoinDesk, Decrypt, Protos",
    sources: ["CoinDesk", "Decrypt", "Protos"],
    sourceCount: 3,
  });

  if (!text.includes("CoinDesk")) fail("the source must always be named");
  else pass("the source is named — this is a summary, not a republication");
  if (!text.includes('<a href="https://coindesk.com/x?a=1&amp;b=2">')) {
    fail(`the link must be present and escaped:\n${text}`);
  } else pass("the original is linked, with the URL escaped");
  if (!text.includes("ևս 2 աղբյուր՝ Decrypt, Protos")) fail(`the reason for posting must be visible:\n${text}`);
  else pass("the other outlets are named, and the linked one is not counted twice");
  if ((text.match(/CoinDesk/g) ?? []).length === 1) pass("CoinDesk appears once — as the link, not also in the count");
  else fail("the linked source is repeated in its own evidence line");

  // "1 աղբյուր՝ ECB" reads as a confession rather than a credential, even
  // though one ECB release outranks four aggregators by design. Named as what
  // it is, the same fact becomes the strongest line in the post.
  const single = renderPost({
    summary, source: "ECB", link: "https://x/y", why: "1 աղբյուր՝ ECB", cat: "MACRO",
    sourceCount: 1, importance: "HIGH", primary: ["ECB"],
  });
  if (single.includes("1 աղբյուր")) fail("a single-source footer weakens the post");
  else pass("a primary source is not published as a lonely count of one");
  if (!single.includes("պաշտոնական աղբյուր")) fail(`a primary source must be named as one:\n${single}`);
  else pass("a primary source is marked as official instead");
  // And not stuttered: the source is already the link at the head of that line.
  if (single.includes("պաշտոնական աղբյուր՝ ECB")) fail(`the name must not repeat on one line:\n${single}`);
  else pass("the name is not repeated on the same line it already opens");
  if (!single.includes("ECB")) fail("the source itself must still be credited");
  else pass("the source is still credited on its own line");

  // A primary source WITH corroboration says both things.
  const mixed = renderPost({
    summary, source: "Federal Reserve", link: "https://x/y",
    why: "4 աղբյուր՝ Federal Reserve, CoinDesk, Decrypt, Protos",
    cat: "MACRO", sourceCount: 4, importance: "HIGH", primary: ["Federal Reserve"],
  });
  if (mixed.includes("ևս 3 աղբյուր")) pass("with corroboration the other outlets are counted alongside");
  else fail(`the extra sources should be counted:\n${mixed}`);

  // Telegram rejects the whole message on a stray tag, so model text is escaped.
  const nasty = renderPost({
    summary: { headline: "<script>x</script>", what: "a & b < c", why: "" },
    source: "S",
    link: "https://x/y",
    why: "",
  });
  if (nasty.includes("<script>")) fail("model text must be escaped before it reaches Telegram");
  else pass("model output cannot inject HTML into the message");
  if (!nasty.includes("a &amp; b &lt; c")) fail(`ampersands and angle brackets must escape: ${nasty}`);
  else pass("ampersands and angle brackets are escaped");

  if (esc("<b>") !== "&lt;b&gt;") fail("esc is wrong");
  else pass("esc handles the three characters Telegram cares about");

  const long = renderPost({
    summary: { headline: "H", what: "x".repeat(5000), why: "" },
    source: "S",
    link: "https://x/y",
    why: "",
  });
  if (long.length > 4096) fail(`must fit Telegram's cap, was ${long.length}`);
  else pass("an over-long post is truncated to Telegram's limit");
}

console.log("\n3b. The importance band");
{
  const summary = { headline: "Ինչ-որ բան", what: "Եղավ։", why: "" };
  const post = (opts) => renderPost({ summary, source: "S", link: "https://x/y", why: "", ...opts });

  // The three levels a reader is meant to learn once and use everywhere. The
  // WORD matters as much as the colour: a bare dot means nothing until someone
  // explains it, and nobody reads a channel description twice.
  const high = post({ importance: "HIGH", cat: "MACRO", primary: ["Federal Reserve"], sourceCount: 1 });
  const med = post({ importance: "MEDIUM", cat: "CRYPTO", sourceCount: 3, sources: ["S", "b", "c"] });
  const low = post({ importance: "LOW", cat: "CRYPTO", sourceCount: 2, sources: ["S", "b"] });

  // THE HEADLINE IS THE FIRST LINE, AND THE MARK IS ITS PREFIX.
  //
  // Telegram's chat list and push notification show the start of the message
  // with all tags stripped, so line one IS the notification. It used to be
  // «🔴 ԿԱՐԵՎՈՐ · 🏛 Մակրո» — the channel's filing system, ahead of the news.
  for (const [name, text, mark] of [["high", high, "●●●"], ["medium", med, "●●○"], ["low", low, "●○○"]]) {
    if (text.startsWith(`${mark} <b>Ինչ-որ\u00A0բան</b>`)) pass(`${name}: the mark prefixes the headline, and the headline is line one`);
    else fail(`${name} band is wrong:\n${text}`);
  }

  // An unknown or missing level must not produce a post with no mark at all.
  if (post({}).startsWith("●○○")) pass("a missing level falls back to ordinary rather than to nothing");
  else fail("an absent importance must still render a mark");

  // PLAIN TEXT, NOT EMOJI. 🗓 and 🏛 both have Emoji_Presentation=No, so they
  // default to text presentation and render as a monochrome glyph — or a box —
  // unless followed by U+FE0F. ● and ○ are not emoji at all, so no client can
  // render them differently from any other.
  for (const [name, text] of [["high", high], ["medium", med], ["low", low]]) {
    if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text.split("\n")[0])) {
      fail(`${name}: the headline line must carry no emoji — it is the notification text`);
    }
  }
  pass("no emoji on the headline line at all — nothing that can render differently on two phones");

  // The category moves to the quiet footer rail, as a word rather than a glyph.
  if (high.includes("Մակրո") && med.includes("Կրիպտո")) pass("the category survives, as a word in the footer");
  else fail("the category was lost");
  if (high.includes("🏛") || med.includes("🪙")) fail("the category emoji must be gone — 🏛 needs a variation selector to render");
  else pass("the category emoji are gone rather than shipped in their unsafe form");

  // EVERY BAND IS CHECKABLE. A label with no evidence under it is a claim, and
  // the channel's whole editorial position is that it does not make claims.
  if (!high.includes("պաշտոնական աղբյուր")) fail("a red band with no evidence under it is just an assertion");
  else pass("the red band prints the evidence for itself");
  if (!med.includes("ևս 2 աղբյուր")) fail(`the amber band must show its evidence:\n${med}`);
  else pass("the amber band prints the evidence for itself");

  // The rule behind the band, tested on its own.
  const I = (sources, score = 3) => importanceOf({ sources, count: sources.length, score });
  if (I(["Federal Reserve"]) === "HIGH") pass("one Fed release alone is important");
  else fail("a primary source must be the top band on its own");
  if (I(["ECB"]) === "HIGH" && I(["SEC"]) === "HIGH" && I(["BLS"]) === "HIGH") {
    pass("so are the ECB, the SEC and the BLS");
  } else fail("the primary list is wrong");
  if (I(["CoinDesk", "Decrypt", "Protos", "BeInCrypto", "NewsBTC"]) === "HIGH") {
    pass("five independent newsrooms agreeing is important too — no primary source needed");
  } else fail("broad corroboration must reach the top band");
  if (I(["CoinDesk", "Decrypt", "Protos"]) === "MEDIUM") pass("three newsrooms is the middle band");
  else fail("three sources should be medium");
  if (I(["NewsBTC", "U.Today"]) === "LOW") pass("two small outlets is ordinary");
  else fail("two weak sources should be low");

  // The trap the blended score walks into, checked explicitly: a lone Fed
  // statement scores 6.0 and four aggregators score 5.6, so a single numeric
  // threshold would put them in the same bracket. They must not be.
  const fedAlone = importanceOf({ sources: ["Federal Reserve"], count: 1, score: 6.0 });
  const fourSmall = importanceOf({ sources: ["BeInCrypto", "NewsBTC", "CoinJournal", "U.Today"], count: 4, score: 5.6 });
  if (fedAlone === "HIGH" && fourSmall === "MEDIUM") {
    pass("a Fed statement outranks four aggregators despite the lower crowd — which a score threshold alone gets wrong");
  } else fail(`the score trap is not handled: fed=${fedAlone} four=${fourSmall}`);
}

console.log("\n3c. The bugs an independent review found");
{
  // A URL from a feed is not ours to trust. esc() is correct for text and wrong
  // inside href="...", because it leaves the double quote alone: the attribute
  // ended early, Telegram answered 400, and run.js dropped the story without
  // remembering it — so it was re-summarised at the cost of a paced Gemini call
  // and re-rejected on every run for a day.
  const quoted = renderPost({
    summary: { headline: "H", what: "W", why: "" },
    source: "S", link: 'https://x.com/a?q="b"&c=1', why: "", sourceCount: 0,
  });
  if (/href="[^"]*"[^>]*"/.test(quoted)) fail(`a quote in the URL breaks the attribute:\n${quoted}`);
  else pass("a double quote inside a link cannot break out of the href");
  if (quoted.includes("&quot;")) pass("it is escaped as an entity instead");
  else fail("the quote should survive as &quot;");
  if (esc('a"b') === 'a"b') pass("esc leaves quotes alone in body text, where they are harmless");
  else fail("esc should not change quotes in text");

  // The old truncation sliced at 4095 characters wherever that landed, which
  // for a long field left an unclosed <b> or <i> — and Telegram rejects the
  // whole message.
  for (const [name, summary] of [
    ["headline", { headline: "Ա".repeat(5000), what: "W", why: "" }],
    ["body", { headline: "H", what: "Ա".repeat(9000), why: "" }],
    ["significance", { headline: "H", what: "W", why: "Ա".repeat(9000) }],
  ]) {
    const t = renderPost({ summary, source: "S", link: "https://x/y", why: "", importance: "LOW" });
    if (t.length > 4096) fail(`${name}: over Telegram's cap at ${t.length}`);
    const opens = (re) => (t.match(re) ?? []).length;
    if (opens(/<b>/g) !== opens(/<\/b>/g) || opens(/<i>/g) !== opens(/<\/i>/g)) {
      fail(`${name}: truncation left an unbalanced tag — Telegram rejects the whole message`);
    }
  }
  pass("an over-long field is clamped without ever leaving an unclosed tag");

  // typeof null === "object" and typeof [] === "object". The first made every
  // read throw INSIDE the run's finally, so a run that had already posted
  // recorded nothing and repeated itself every half hour. The second was worse:
  // writes appeared to work, JSON.stringify silently dropped them, and the
  // channel reposted everything with no error anywhere.
  for (const [name, broken] of [["null", null], ["an array", []]]) {
    const state = { posted: broken, topics: [], cal: { warned: broken, posts: broken } };
    let threw = null;
    try {
      prune(state, Date.now());
    } catch (e) {
      threw = e;
    }
    if (threw) fail(`${name} in the state file must not throw inside finally: ${threw.message}`);
    else pass(`${name} in the state file is repaired rather than thrown on`);

    rememberTopic(state, new Set(["a", "b"]));
    remember(state, "k", { title: "t", at: Date.now() });
    const roundTrip = JSON.parse(JSON.stringify({ posted: state.posted, cal: state.cal }));
    if (!roundTrip.posted.k) fail(`${name}: the record did not survive being written to disk`);
    else pass(`${name}: records written afterwards survive the JSON round trip`);
  }

  // MAX_KEYS_PER_STORY was 8, and clustering sorts newest first, so once eight
  // fresher reports of an already-posted story arrived not one stored key was
  // still in the window and the story posted a second time.
  if (MAX_KEYS_PER_STORY > 16) pass(`${MAX_KEYS_PER_STORY} keys per story — comfortably above the 16 feeds`);
  else fail(`${MAX_KEYS_PER_STORY} is at or below the feed count: a big story will post twice`);

  const items = Array.from({ length: 12 }, (_, i) => ({ title: `SEC approves spot Solana ETF filing number ${i}` }));
  const keys = storyKeys(items, keyWords);
  eq_(keys.length, 12, "every report of a story is fingerprinted, not just the newest few");

  // The real check: a story posted from four reports is still recognised after
  // eight FRESHER reports of it arrive and take over the front of the cluster.
  const state = { posted: {}, topics: [], cal: { warned: {}, posts: {} } };
  const first = storyKeys(items.slice(8), keyWords);
  for (const k of first) remember(state, k, { title: "x", at: Date.now() });
  const laterView = storyKeys(items, keyWords);
  if (laterView.some((k) => alreadyPosted(state, k))) {
    pass("a story buried under eight newer reports is still recognised as already posted");
  } else fail("the duplicate-post bug is back");
}

function eq_(got, want, m) {
  if (got === want) pass(m);
  else fail(`${m} — got ${got}, wanted ${want}`);
}

console.log("\n3d. The send path — what the final audit found");
{
  const originalFetch = globalThis.fetch;
  const stub = (fn) => { globalThis.fetch = fn; };
  const restore = () => { globalThis.fetch = originalFetch; };
  let calls = 0;

  // DELIVERED-BUT-UNREADABLE IS NOT REJECTED.
  //
  // Telegram answers 2xx — it has accepted the message — and the body cannot be
  // parsed. The old code called that a failure, run.js recorded nothing, and
  // the identical post went out again thirty minutes later. Reproduced end to
  // end by the audit.
  stub(async () => { calls += 1; return { ok: true, status: 200, json: async () => { throw new Error("bad json"); } }; });
  calls = 0;
  let r = await sendMessage("t", "@c", "x");
  restore();
  if (r.ok === false && r.unknown === true) pass("an accepted-but-unreadable response is UNKNOWN, not rejected");
  else fail(`2xx with an unreadable body must be unknown: ${JSON.stringify(r)}`);
  if (calls === 1) pass("and it is not retried — the first attempt may already be in the channel");
  else fail(`an unknown result must not be retried, saw ${calls} calls`);

  // A DROPPED CONNECTION COSTS ONE MESSAGE, NOT THE RUN.
  stub(async () => { throw new Error("ECONNRESET"); });
  r = await sendMessage("t", "@c", "x");
  restore();
  if (r.ok === false && r.unknown === true) pass("a transport error is caught and reported, not thrown");
  else fail(`a fetch throw must not escape sendMessage: ${JSON.stringify(r)}`);

  // A REAL REJECTION IS STILL A REJECTION.
  stub(async () => ({ ok: false, status: 400, json: async () => ({ ok: false, description: "Bad Request: chat not found" }) }));
  r = await sendMessage("t", "@c", "x");
  restore();
  if (r.ok === false && !r.unknown) pass("a genuine rejection stays a rejection, so it is retried next run");
  else fail("a 400 must not be treated as unknown");

  // THE BLOCKQUOTE RETRY: once, only for a parse complaint, and the id comes
  // from the attempt that actually succeeded.
  calls = 0;
  stub(async (url, init) => {
    calls += 1;
    const body = JSON.parse(init.body);
    if (body.text.includes("<blockquote>")) {
      return { ok: false, status: 400, json: async () => ({ ok: false, description: "Bad Request: can't parse entities" }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 99 } }) };
  });
  r = await sendMessage("t", "@c", "a<blockquote>b</blockquote>c");
  restore();
  if (r.ok && r.messageId === 99) pass("the retry without the rail succeeds and returns ITS message id");
  else fail(`the retry is wrong: ${JSON.stringify(r)}`);
  if (r.degraded === "blockquote") pass("and it says the post went out without its formatting");
  else fail("a degraded send must be reported so the log is not silent about it");
  if (calls === 2) pass("exactly two attempts, never more");
  else fail(`expected 2 attempts, saw ${calls}`);

  // A rate limit must NOT be retried into a second failure.
  calls = 0;
  stub(async () => { calls += 1; return { ok: false, status: 429, json: async () => ({ ok: false, description: "Too Many Requests: retry after 30" }) }; });
  await sendMessage("t", "@c", "<blockquote>x</blockquote>");
  restore();
  if (calls === 1) pass("a rate limit is not retried");
  else fail(`a 429 must not be retried, saw ${calls}`);

  // The old trigger matched "tag" inside any word.
  calls = 0;
  stub(async () => { calls += 1; return { ok: false, status: 400, json: async () => ({ ok: false, description: "Bad Request: message vintage" }) }; });
  await sendMessage("t", "@c", "<blockquote>x</blockquote>");
  restore();
  if (calls === 1) pass("an unrelated error containing «tag» inside a word no longer triggers the retry");
  else fail("the retry trigger is still matching substrings");

  // THE MARK DECIDES WHETHER THE PHONE BUZZES.
  let body = null;
  stub(async (url, init) => { body = JSON.parse(init.body); return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) }; });
  await sendMessage("t", "@c", "x", { silent: true });
  const silentBody = body;
  await sendMessage("t", "@c", "x");
  restore();
  if (silentBody.disable_notification === true) pass("a silent post is delivered without a sound");
  else fail("disable_notification is not set");
  if (body.disable_notification === false) pass("and an ordinary post still rings");
  else fail("disable_notification must be explicitly false otherwise");

  // stripBlockquotes must not leave an unbalanced tag behind.
  const withAttr = stripBlockquotes('<blockquote expandable="true">x</blockquote>');
  if (!withAttr.includes("blockquote")) pass("the retry strips a blockquote whatever attributes it carries");
  else fail(`an attributed blockquote is left unbalanced: ${withAttr}`);
}

console.log("\n3e. The attribution line is not droppable");
{
  // fit() trims from the end, and the redesign moved the source and the link to
  // the end — so the one line run.js promises never to omit became the first
  // thing thrown overboard. It took roughly 800 escaped ampersands in one
  // summary to reach, which a model echoing HTML can produce.
  for (const filler of ["&".repeat(900), "<".repeat(900), "x".repeat(4000)]) {
    const t = renderPost({
      summary: { headline: "Վերնագիր", what: filler, why: "Մեկնաբանություն։" },
      source: "CoinDesk", link: "https://example.com/story", cat: "CRYPTO",
      sourceCount: 2, sources: ["CoinDesk", "Decrypt"], importance: "MEDIUM",
    });
    if (t.length > 4096) fail(`over the cap at ${t.length}`);
    if (!t.includes('<a href="https://example.com/story">')) fail("the link was dropped to make room");
    if (!t.includes("CoinDesk")) fail("the source name was dropped to make room");
    const bal = (re) => (t.match(re) ?? []).length;
    if (bal(/<b>/g) !== bal(/<\/b>/g) || bal(/<i>/g) !== bal(/<\/i>/g) || bal(/<blockquote>/g) !== bal(/<\/blockquote>/g)) {
      fail("trimming left an unbalanced tag");
    }
  }
  pass("however long the body, the source and the link survive — and every tag stays balanced");
}

console.log("\n4. Memory");
{
  const state = { posted: {}, recovered: false };
  // Keyed by the STORY, not the URL — every outlet has its own URL for one
  // event, and a URL-keyed memory would post the same event ten times.
  const a = storyKey(keyWords("SEC approves spot Solana ETF applications"));
  const b = storyKey(keyWords("SEC approves spot Solana ETF applications from three issuers"));
  const c = storyKey(keyWords("Ethereum Fusaka upgrade goes live"));

  if (alreadyPosted(state, a)) fail("an empty memory must not claim anything was posted");
  else pass("an empty memory reports nothing posted");

  remember(state, a, { title: "SEC approves spot Solana ETF applications", at: Date.now() });
  if (!alreadyPosted(state, a)) fail("a remembered story must be recognised");
  else pass("a remembered story is recognised");
  if (alreadyPosted(state, c)) fail("an unrelated story must not be blocked");
  else pass("an unrelated story is not blocked");

  // The variants DO key differently — different words, different hash. That is
  // why run.js checks and remembers every report in a cluster rather than only
  // its lead. Pinned here because the whole no-repost guarantee rests on it.
  if (a === b) fail("these two headlines differ, so their keys should differ — test assumption broken");
  else pass("variant wordings key differently, which is why every variant is remembered");

  const cluster = [
    "SEC approves spot Solana ETF applications",
    "SEC approves spot Solana ETF applications from three issuers",
    "SEC approves spot Solana ETFs",
  ].map((t) => storyKey(keyWords(t)));

  const fresh = { posted: {}, recovered: false };
  // Post it once, remembering every wording, exactly as run.js does.
  for (const k of cluster) remember(fresh, k, { title: "SEC approves spot Solana ETF", at: Date.now() });

  // Next run, a different outlet's wording leads the cluster.
  if (!cluster.some((k) => alreadyPosted(fresh, k))) {
    fail("a story must stay blocked whichever of its wordings leads next time");
  } else pass("a posted story stays blocked whichever variant leads on a later run");

  const old = { posted: { x: { postedAt: Date.now() - 40 * 86_400_000 }, y: { postedAt: Date.now() } } };
  const dropped = prune(old);
  if (dropped !== 1 || !old.posted.y || old.posted.x) fail("prune must drop only the old entry");
  else pass("prune drops entries past the window and keeps the rest");
}

console.log("\n5. Feed handling");
{
  const xml = `<rss><channel>
    <item><title>SEC approves spot Solana ETF</title><link>https://a/1</link>
      <pubDate>${new Date().toUTCString()}</pubDate>
      <description><![CDATA[<p>Regulators cleared three filings.</p><img src="x.png"/>]]></description></item>
    <item><title>Top 5 Altcoins To Watch</title><link>https://a/2</link>
      <pubDate>${new Date().toUTCString()}</pubDate><description>promo</description></item>
    <item><title>Ancient news item</title><link>https://a/3</link>
      <pubDate>${new Date(Date.now() - 200 * 3_600_000).toUTCString()}</pubDate><description>old</description></item>
  </channel></rss>`;

  const parsed = parseFeed(xml);
  if (parsed.length !== 3) fail(`expected 3 items, got ${parsed.length}`);
  else pass("all items parsed");
  if (parsed[0].body.includes("<") || parsed[0].body.includes("x.png")) {
    fail(`markup must not reach the prompt: ${parsed[0].body}`);
  } else pass("HTML and image markup stripped from the body");

  const kept = freshNews(parsed.map((p) => ({ ...p, source: "T" })), { maxAgeHours: 24 });
  if (kept.length !== 1) fail(`promo and stale items must both go, kept ${kept.length}`);
  else pass("the promo item and the stale item are both dropped");
  if (kept[0]?.title !== "SEC approves spot Solana ETF") fail("the real story must survive");
  else pass("the real story survives");

  if (looksLikeNews("Bitcoin Price Prediction 2027")) fail("price predictions are not news");
  else pass("price predictions are filtered before any API call");
  if (!looksLikeNews("Fed holds rates steady")) fail("a real event must not be filtered");
  else pass("a real event passes the filter");

  if (stripHtml("<p>a&amp;b</p>") !== "a&b") fail("stripHtml must decode entities too");
  else pass("stripHtml decodes entities");

  // An item with no date must not be treated as breaking news.
  const undated = parseFeed(`<rss><channel><item><title>No date</title><link>h</link></item></channel></rss>`);
  if (undated[0].at !== 0) fail("a missing date must be 0, never now");
  else pass("a missing date is 0, so an undated item can never look fresh");
  const survives = freshNews(undated.map((p) => ({ ...p, source: "T" })), { maxAgeHours: 24 });
  if (survives.length !== 0) fail("an undated item must not pass the freshness test");
  else pass("an undated item cannot slip through as fresh");
}

console.log("\n6. A quota wall on one model does not silence the others");
{
  // THE BUG THIS PINS. The first live run tried gemini-flash-latest four times,
  // got "exceeded your current quota" four times, and never asked the other
  // three models — because the code assumed the wall belonged to the key.
  // Google's own error names the model in the metric, so it does not.
  const tried = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const model = JSON.parse(init.body).model ?? String(url).match(/models\/([^:]+)/)?.[1];
    tried.push(model);
    // Only the first model is exhausted; the second answers.
    if (model === MODELS[0]) {
      return {
        ok: false,
        status: 429,
        json: async () => ({ error: { message: "You exceeded your current quota, please check your plan" } }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ steps: [{ content: [{ type: "text", text: "ՎԵՐՆԱԳԻՐ: Ա\nԻՆՉ: Բ։" }] }] }),
    };
  };

  const r = await ask("fake-key", "prompt", { log: () => {}, gapMs: 0 });
  globalThis.fetch = originalFetch;

  if (!r.ok) fail(`the second model should have answered: ${r.why}`);
  else pass("a model past its quota falls through to the next one");
  if (r.model === MODELS[0]) fail("the exhausted model must not be reported as the one that answered");
  else pass(`the answer is attributed to the model that gave it (${r.model})`);
  if (tried.length < 2) fail(`only ${tried.length} model tried — the fallback never ran`);
  else pass(`more than one model was tried (${tried.length})`);
}

console.log("\n7. Every model walled stops the run instead of grinding");
{
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return {
      ok: false,
      status: 429,
      json: async () => ({ error: { message: "You exceeded your current quota" } }),
    };
  };
  const r = await ask("fake-key", "prompt", { log: () => {}, gapMs: 0 });
  globalThis.fetch = originalFetch;

  if (r.ok) fail("nothing should have succeeded");
  else if (!r.quotaExhausted) fail("an all-quota failure must be reported as such, so the run can stop");
  else pass("an all-quota failure is flagged so the run stops rather than retrying");
  // Without the flag the retry ladder ran every model four times over three and
  // a half minutes. Each combination should now be asked exactly once.
  if (calls > MODELS.length * 2) fail(`each model should be asked once, got ${calls} calls`);
  else pass(`each model/shape asked once, not repeatedly (${calls} calls)`);
}

console.log("\n8. A retired model is not retried either");
{
  // THE SECOND GRINDING BUG. The stop-early guard only knew about quota errors.
  // A retired model fails with "no longer available", was therefore never
  // marked exhausted, and the retry ladder asked it again at 2s, 8s and 20s —
  // minutes spent re-asking a model that no longer exists.
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return {
      ok: false,
      status: 404,
      json: async () => ({
        error: { message: "This model models/gemini-2.0-flash is no longer available. Please update your code" },
      }),
    };
  };
  const models = ["a", "b"];
  const r = await ask("fake-key", "prompt", { log: () => {}, gapMs: 0, models });
  globalThis.fetch = originalFetch;

  if (!r.quotaExhausted) fail("all models retired must stop the run, not loop");
  else pass("all models retired stops the run rather than looping");
  if (calls > models.length * 2) fail(`each combination once, got ${calls} calls`);
  else pass(`a retired model is asked once, not four times (${calls} calls)`);
}

console.log("\n9. Model discovery");
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      models: [
        { name: "models/gemini-3.8-pro", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-flash-latest", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-3.6-flash", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-flash-lite-latest", supportedGenerationMethods: ["generateContent"] },
        { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
        { name: "models/gemini-3.8-flash-image", supportedGenerationMethods: ["generateContent"] },
      ],
    }),
  });
  const d = await discoverModels("fake-key");
  globalThis.fetch = originalFetch;

  if (!d.ok) fail(`discovery should have succeeded: ${d.why}`);
  else pass("the model list is read from the API rather than remembered");
  if (d.models.includes("text-embedding-004")) fail("an embedding model cannot write prose");
  else pass("non-generative models are dropped");
  if (d.models.some((m) => /image/.test(m))) fail("an image model is not a summariser");
  else pass("image models are dropped");
  if (d.models.some((m) => /pro/.test(m))) fail("pro has too small a free allowance to rely on");
  else pass("pro models are dropped — their free allowance is tiny");
  // Quality first, then the lite models as the quota safety net.
  const liteAt = d.models.findIndex((m) => /lite/.test(m));
  const fullAt = d.models.findIndex((m) => !/lite/.test(m));
  if (liteAt < fullAt) fail(`full flash must be preferred over lite: ${d.models}`);
  else pass(`full flash is tried before lite (${d.models.join(", ")})`);

  // A failed listing must not stop the bot — it falls back to the known names.
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const bad = await discoverModels("fake-key");
  globalThis.fetch = originalFetch;
  if (bad.ok) fail("a 503 is not a successful discovery");
  else if (!bad.models.length) fail("a failed discovery must still yield a usable list");
  else pass("a failed discovery falls back to the known model names");
}

console.log("\n10. The three faults the live channel exposed");
{
  // --- a forced crypto angle -----------------------------------------------
  // Live: an ECB wage-tracker release became "wage growth may sustain
  // inflation, reducing investor interest in BTC". The prompt demanded a crypto
  // angle on every item, so one was manufactured for a story that had none.
  const p = summaryPrompt({ title: "ECB wage tracker at 2.7%", body: "x", source: "ECB" });
  if (!p.includes("Ուղղակի կապ կրիպտո շուկայի հետ չկա")) {
    fail("the model must be allowed to say there is no crypto link");
  } else pass("a non-crypto item may honestly report having no crypto link");
  if (/ինչ նշանակություն ունի կրիպտո շուկայի համար/.test(p)) {
    fail("the line that forced an angle on every item is still in the prompt");
  } else pass("the ԻՆՉՈՒ line no longer demands a crypto angle unconditionally");
  if (!p.includes("ՄԻ՛ գովազդիր")) fail("promotional language must be forbidden explicitly");
  else pass("promotional phrasing is forbidden by name");

  // --- price targets dressed as news ---------------------------------------
  // Live: "Standard Chartered Sees Arbitrum (ARB) at $0.50 This Year, $10 by
  // 2030" reached the channel with four sources behind it, so corroboration
  // could not stop it.
  const promo = [
    "Standard Chartered Sees Arbitrum (ARB) at $0.50 This Year, $10 by 2030. Here's the Path",
    "Analyst price forecast: SOL to $500",
    "Bitcoin could reach $200,000 by 2030",
  ];
  for (const t of promo) {
    if (looksLikeNews(t)) fail(`a price target must not pass as news: "${t.slice(0, 50)}"`);
  }
  pass("price targets and far-dated forecasts are filtered");

  // And the filter must not have become greedy.
  const realNews = [
    "SEC approves spot Solana ETF applications from three issuers",
    "US charges ex-Robinhood engineers over alleged pre-listing crypto trades",
    "Hong Kong crypto exchange CoinEx to cease operations after 9 years",
    "DOJ seeks forfeiture of $61 million laundered through Binance",
    "ECB wage tracker at 2.7% for first half of 2027",
  ];
  for (const t of realNews) {
    if (!looksLikeNews(t)) fail(`the stronger filter now eats real news: "${t.slice(0, 50)}"`);
  }
  pass("real news still passes the stronger filter");

  // --- the same subject twice in a morning ---------------------------------
  // Live: 01:06 "Crypto stocks slide after CLARITY Act fails" and 06:07
  // "CLARITY Act's odds of passing plunge". Different runs, so the per-run
  // diversity rule never saw them together.
  const st = { posted: {}, topics: [], recovered: false };
  const first = keyWords("Crypto stocks slide after CLARITY Act fails to advance in Senate");
  rememberTopic(st, first, Date.now());

  const second = keyWords("CLARITY Act's odds of passing plunge as Republicans reject counter-proposal");
  const recent = recentTopics(st);
  if (!recent.some((w) => sameSubject(w, second))) {
    fail("the second CLARITY Act story should be recognised as the same subject");
  } else pass("a subject posted earlier blocks a second angle on it within the cooldown");

  const unrelated = keyWords("Hong Kong crypto exchange CoinEx to cease operations after 9 years");
  if (recent.some((w) => sameSubject(w, unrelated))) {
    fail("an unrelated story must not be blocked by the cooldown");
  } else pass("an unrelated story is not blocked");

  // The cooldown must expire, or the channel goes silent on whatever matters.
  const old = { posted: {}, topics: [], recovered: false };
  rememberTopic(old, first, Date.now() - SUBJECT_COOLDOWN_MS - 60_000);
  if (recentTopics(old).length !== 0) fail("the cooldown must expire");
  else pass(`the cooldown expires after ${SUBJECT_COOLDOWN_MS / 3_600_000}h — a developing story can return`);

  // Topics must survive a save/load round trip, or every run starts blind.
  const persisted = JSON.parse(JSON.stringify({ posted: {}, topics: st.topics }));
  if (recentTopics(persisted).length !== 1) fail("topics must survive serialisation");
  else pass("topics survive being written to and read back from the state file");
}

console.log("\n11. The picture");
{
  // Live complaint: the channel read as a wall of grey text and caught nobody's
  // eye. The preview had been disabled outright because BELOW the text it
  // repeated the headline — the right complaint, the wrong fix.
  const withMark = renderPost({
    summary: { headline: "SEC-ը հաստատեց ETF-ը", what: "Երեք դիմում։", why: "Նոր կապիտալ։" },
    source: "CoinDesk", link: "https://x/y", why: "3 աղբյուր", cat: "CRYPTO",
    sourceCount: 3, importance: "MEDIUM",
  });
  const macro = renderPost({
    summary: { headline: "ECB-ն պահեց տոկոսադրույքը", what: "Անփոփոխ։", why: "" },
    source: "ECB", link: "https://x/y", why: "1 աղբյուր", cat: "MACRO",
    sourceCount: 1, importance: "HIGH", primary: ["ECB"],
  });
  if (withMark.includes("Կրիպտո") && macro.includes("Մակրո")) {
    pass("macro and crypto are still distinguished — by the word, in the footer");
  } else fail("the category is missing");

  // The channel's own interpretation is set apart from the sourced facts.
  if (withMark.includes("<blockquote>Նոր կապիտալ։</blockquote>")) {
    pass("the «why it matters» sentence sits on the blockquote rail, not in the body");
  } else fail(`the interpretation must be visually separated:\n${withMark}`);
  if (macro.includes("<blockquote>")) fail("a post with no interpretation must not render an empty rail");
  else pass("no interpretation, no rail");

  // The source name is the link. It used to be named twice, on two lines.
  if (/<a href="https:\/\/x\/y">CoinDesk<\/a>/.test(withMark)) pass("the source name is the link");
  else fail(`the source should be the link:\n${withMark}`);
  if ((withMark.match(/CoinDesk/g) ?? []).length <= 2) pass("and it is not repeated across two stacked lines");
  else fail("the source is still named too many times");

  // The preview options themselves — captured by intercepting the request,
  // because getting these wrong fails silently: Telegram just shows a small
  // preview and nothing reports it.
  const originalFetch = globalThis.fetch;
  let body = null;
  globalThis.fetch = async (url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  await sendMessage("t", "@c", "text", { previewUrl: "https://example.com/a" });
  globalThis.fetch = originalFetch;

  const lp = body?.link_preview_options ?? {};
  if (lp.is_disabled) fail("the preview must not be disabled when a URL is given");
  else pass("a post with a link gets a preview");
  // Telegram disregards prefer_large_media when the URL is only inferred from
  // the text, so passing it explicitly is the whole fix.
  if (lp.url !== "https://example.com/a") fail("the URL must be explicit or large media is ignored");
  else pass("the preview URL is passed explicitly, not inferred");
  if (!lp.prefer_large_media) fail("a small preview is what made it look dull");
  else pass("the image is requested at full width");
  if (!lp.show_above_text) fail("below the text the preview repeats the headline");
  else pass("the image sits above the text, like a news post");

  // No link, no preview — rather than a broken card.
  globalThis.fetch = async (url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 2 } }) };
  };
  await sendMessage("t", "@c", "text");
  globalThis.fetch = originalFetch;
  if (!body?.link_preview_options?.is_disabled) fail("with no URL the preview must be off");
  else pass("with no URL there is no empty preview card");
}

console.log("");
if (failures > 0) {
  console.log(`${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("All checks passed.");
