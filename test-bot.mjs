// Guards the parts that turn a chosen story into a message, and the memory
// that stops it going out twice.
//
//   node scripts/test-bot.mjs
//
// These run with no network and no key: everything here is pure, which is why
// it can be tested at all. The ranking has its own file, scripts/test-rank.mjs.

import { parseSummary, summaryPrompt, INSUFFICIENT, ask, MODELS, discoverModels } from "./ai.js";
import { renderPost, esc, sendMessage } from "./telegram.js";
import { storyKey, alreadyPosted, remember, prune, rememberTopic, recentTopics, SUBJECT_COOLDOWN_MS } from "./state.js";
import { keyWords, sameSubject } from "./rank.js";
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
  });
  if (!withMark.includes("🪙")) fail("a crypto post should carry its marker");
  else pass("a crypto post is marked");
  const macro = renderPost({
    summary: { headline: "ECB-ն պահեց տոկոսադրույքը", what: "Անփոփոխ։", why: "" },
    source: "ECB", link: "https://x/y", why: "1 աղբյուր", cat: "MACRO",
  });
  if (!macro.includes("🏛")) fail("a macro post should be marked differently");
  else pass("macro and crypto are visually distinguishable at a glance");

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
