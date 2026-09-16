// THE RUN. Once every half hour, from GitHub Actions.
//
//   node run.js --dry-run     read, rank, summarise, print — post nothing
//   node run.js               the same, and post
//
// THE ORDER MATTERS
//
//   fetch → filter → RANK → dedupe → summarise → post
//
//   Ranking happens before the AI is touched, and the AI is never asked what is
//   important. By the time a story reaches the model, arithmetic has already
//   decided it is worth posting and can say why in one sentence. That makes
//   every post auditable: "six sources carried it" is a fact, and "the model
//   thought it mattered" is not.
//
// WHAT IT WILL NOT DO
//
//   Post a story it could not summarise. Post a summary it could not parse.
//   Post anything without naming the source and linking the original. Fill a
//   quiet hour by lowering the bar. Every one of those is a silence, and a
//   silent channel is a much smaller failure than a wrong one.

import { fetchAll, freshNews } from "./feeds.js";
import { rankStories, keyWords } from "./rank.js";
import { ask, summaryPrompt, parseSummary, discoverModels } from "./ai.js";
import { renderPost, sendMessage, getMe } from "./telegram.js";
import { loadState, alreadyPosted, remember, prune, saveState, storyKey } from "./state.js";

const DRY = process.argv.includes("--dry-run");

/** Measured quota is 5 requests/minute; three stories a run stays well under. */
const MAX_PER_RUN = 3;

/** In the ranking's own units — one Fed or SEC item clears this alone. */
const MIN_SCORE = 3.0;

/** Older than this and it is not news, whatever the feeds still list. */
const MAX_AGE_HOURS = 24;

const log = (...a) => console.log(...a);

/** Remember every wording of one story, so no variant of it posts again. */
function rememberAll(state, keys, lead) {
  for (const key of keys) remember(state, key, { title: lead.title, at: lead.at });
}

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const geminiKey = process.env.GEMINI_API_KEY;

  log(`\n📰 NEWS BOT · ${new Date().toISOString()}${DRY ? " · ՉՈՐ ԳՈՐԾԱՐԿՈՒՄ" : ""}`);
  log("═".repeat(64));

  if (!geminiKey) {
    log("GEMINI_API_KEY չկա — առանց դրա ամփոփում հնարավոր չէ։");
    process.exit(1);
  }
  if (!DRY && (!token || !chatId)) {
    log("TELEGRAM_BOT_TOKEN կամ TELEGRAM_CHAT_ID չկա — հրապարակել հնարավոր չէ։");
    log("Չոր գործարկման համար՝ node run.js --dry-run");
    process.exit(1);
  }

  // --- 1. read -------------------------------------------------------------
  const { items, failed, okCount, total } = await fetchAll();
  log(`Աղբյուրներ՝ ${okCount}/${total} · ${items.length} նյութ`);
  // Named, not absorbed. A source that quietly stops is how a channel slowly
  // gets worse without anyone noticing.
  for (const f of failed) log(`  ⚠️  ${f.name}՝ ${f.why}`);

  const fresh = freshNews(items, { maxAgeHours: MAX_AGE_HOURS });
  log(`Թարմ ու նորության նման՝ ${fresh.length}`);

  // --- 2. rank -------------------------------------------------------------
  const ranked = rankStories(fresh, { minScore: MIN_SCORE, limit: MAX_PER_RUN * 3 });
  log(`Շեմն անցած պատմություն՝ ${ranked.length}`);

  // --- 3. drop what has already gone out -----------------------------------
  const state = await loadState();
  if (state.recovered) log("⚠️  Հիշողության ֆայլը վնասված էր — սկսում եմ դատարկից");

  // EVERY VARIANT, NOT JUST THE LEAD.
  //
  // A cluster's lead is whichever report happened to be newest on this run. Key
  // the memory on that alone and the same event reposts as soon as a different
  // outlet's wording takes the lead — which is exactly what happens when a
  // story develops and a second wave of coverage arrives a few hours later.
  //
  // So a story counts as already posted if ANY of its reports has been, and
  // posting it remembers all of them. A handful of extra keys per story is
  // nothing next to the channel repeating itself.
  const MAX_KEYS_PER_STORY = 8;
  const todo = [];
  for (const story of ranked) {
    const keys = story.items.slice(0, MAX_KEYS_PER_STORY).map((i) => storyKey(keyWords(i.title)));
    if (keys.some((k) => alreadyPosted(state, k))) continue;
    todo.push({ ...story, keys });
    if (todo.length >= MAX_PER_RUN) break;
  }
  log(`Նոր՝ ${todo.length}`);

  if (todo.length === 0) {
    log("\nՀրապարակելու բան չկա։ Հանգիստ ժամ։");
    // Still prune, so a long quiet spell does not leave the file unbounded.
    const dropped = prune(state);
    if (dropped > 0) await saveState(state);
    return;
  }

  // --- 4. summarise and post ----------------------------------------------
  let posted = 0;
  // Carried across stories: a model exhausted on the first story is exhausted on
  // the third too, and rediscovering that costs a 13-second paced call each
  // time. The first real run spent three and a half minutes doing exactly that.
  const blockedModels = new Set();

  // ASK THE API WHICH MODELS EXIST, RATHER THAN REMEMBERING.
  //
  // The hard-coded list was wrong within a day: two of its four entries came
  // back "no longer available", and Google's own error named a replacement the
  // list had never heard of. One call at the start of the run replaces all of
  // that guessing, and it prints what it found so the next surprise is visible
  // rather than inferred.
  const discovered = await discoverModels(geminiKey);
  const models = discovered.models;
  log("");
  log(
    discovered.ok
      ? `Հասանելի մոդել՝ ${models.join(", ")}`
      : `Մոդելների ցուցակը չստացվեց (${discovered.why}) — օգտագործում եմ պահեստայինը՝ ${models.join(", ")}`
  );

  for (const story of todo) {
    const { lead } = story;
    log("");
    log("─".repeat(64));
    log(`${lead.source} · ${story.why}`);
    log(`ՄԻԱՎՈՐ ${story.score.toFixed(1)} · ${lead.title}`);

    const r = await ask(geminiKey, summaryPrompt(lead), { log, blocked: blockedModels, models });
    if (!r.ok) {
      if (r.quotaExhausted) {
        // Every model is walled. A daily quota does not clear during a run, so
        // continuing means the same refusal for every remaining story. Stop,
        // keep whatever already went out, and say plainly what happened — the
        // next scheduled run in half an hour costs nothing to wait for.
        log(`  ⛔ Ոչ մի մոդել հասանելի չէ՝ ${String(r.why).slice(0, 160)}`);
        log("  Դադարեցնում եմ այս գործարկումը։ Մնացած պատմությունները կմնան հաջորդին։");
        // Google's free daily quota resets at midnight Pacific — 07:00 UTC,
        // 11:00 in Yerevan. A run at 06:26 UTC missed it by 34 minutes, which
        // looked like a broken key and was a clock.
        log("  (Անվճար քվոտան զրոյացվում է 07:00 UTC-ին՝ Երևանի ժամը 11:00)");
        break;
      }
      log(`  ❌ ամփոփում չստացվեց՝ ${String(r.why).slice(0, 120)} — բաց եմ թողնում`);
      continue;
    }

    const summary = parseSummary(r.text);
    if (!summary) {
      log("  ❌ պատասխանը սպասված ձևով չէր — բաց եմ թողնում");
      log(`     ${r.text.slice(0, 200)}`);
      continue;
    }
    if (summary.insufficient) {
      log("  ⏭️  ԱՆԲԱՎԱՐԱՐ — նյութը քիչ է, չեմ հրապարակում");
      // Remembered anyway: the material will not improve, and without this the
      // same story would be re-summarised every half hour for ten days.
      rememberAll(state, story.keys, lead);
      continue;
    }

    const text = renderPost({
      summary,
      source: lead.source,
      link: lead.link,
      why: story.why,
    });

    if (DRY) {
      log("  ── ԱՅՍՊԵՍ ԿԵՐԵՎԱ ──────────────────────────────");
      for (const line of text.split("\n")) log(`  │ ${line}`);
      posted += 1;
      continue;
    }

    const sent = await sendMessage(token, chatId, text);
    if (!sent.ok) {
      log(`  ❌ Telegram-ը մերժեց՝ ${sent.why}`);
      continue;
    }
    // Only after Telegram confirms. Remembering first would mean a failed send
    // silently loses the story for ever.
    rememberAll(state, story.keys, lead);
    posted += 1;
    log("  ✅ հրապարակվեց");
  }

  prune(state);
  if (!DRY) await saveState(state);

  log("");
  log("═".repeat(64));
  log(DRY ? `ՉՈՐ՝ ${posted} փոստ կհրապարակվեր։ Ոչինչ չուղարկվեց։` : `Հրապարակվեց՝ ${posted}`);

  if (!DRY && posted > 0) {
    const me = await getMe(token);
    if (me.ok) log(`Բոտ՝ @${me.username}`);
  }
}

main().catch((e) => {
  console.error("\nընկավ՝", e);
  process.exit(1);
});
