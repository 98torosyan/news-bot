// Guards the parts that turn a chosen story into a message, and the memory
// that stops it going out twice.
//
//   node scripts/test-bot.mjs
//
// These run with no network and no key: everything here is pure, which is why
// it can be tested at all. The ranking has its own file, scripts/test-rank.mjs.

import { parseSummary, summaryPrompt, INSUFFICIENT, ask, MODELS } from "./ai.js";
import { renderPost, esc } from "./telegram.js";
import { storyKey, alreadyPosted, remember, prune } from "./state.js";
import { keyWords } from "./rank.js";
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
  });

  if (!text.includes("CoinDesk")) fail("the source must always be named");
  else pass("the source is named — this is a summary, not a republication");
  if (!text.includes('<a href="https://coindesk.com/x?a=1&amp;b=2">')) {
    fail(`the link must be present and escaped:\n${text}`);
  } else pass("the original is linked, with the URL escaped");
  if (!text.includes("3 աղբյուր")) fail("the reason for posting must be visible to readers");
  else pass("the ranking's reason is published, not just logged");

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

console.log("");
if (failures > 0) {
  console.log(`${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("All checks passed.");
