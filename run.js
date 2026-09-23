// THE RUN. Once every half hour, from GitHub Actions.
//
//   node run.js --dry-run     read, rank, summarise, print — post nothing
//   node run.js               the same, and post
//
// TWO HALVES, IN THIS ORDER
//
//   1. THE CALENDAR. Scheduled events: a warning the day before, a reminder
//      three hours before the big ones, one overview every Sunday evening.
//      It touches no network but Telegram's, uses no AI, and cannot be stopped
//      by a spent Gemini quota — which is exactly why it runs first. On a day
//      when the summariser is walled, the calendar still works.
//
//   2. THE NEWS. Everything the previous version did.
//
//   The two meet in one place: when a news story is the RESULT of an event the
//   channel warned about, the post is sent as a reply to that warning. The
//   reader sees the question and the answer as one conversation.
//
// THE NEWS HALF'S ORDER MATTERS TOO
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
//   quiet hour by lowering the bar. Predict a number an event has not produced
//   yet. Every one of those is a silence, and a silent channel is a much
//   smaller failure than a wrong one.

import { fetchAll, freshNews } from "./feeds.js";
import { rankStories, keyWords, sameSubject } from "./rank.js";
import { ask, summaryPrompt, parseSummary, discoverModels } from "./ai.js";
import { renderPost, sendMessage, getMe } from "./telegram.js";
import { EVENTS } from "./events.js";
import {
  dueWarnings, groupWarnings, digestDue, expiryDue, matchOccurrence,
  whenPhrase, validateEvents, partsInTz,
  MAX_LATENESS_MS, QUIET_FROM, QUIET_UNTIL, CHANNEL_TZ,
} from "./calendar.js";
import { renderWarning, renderDigest, renderExpiry, threadNote } from "./calpost.js";
import {
  loadState, alreadyPosted, remember, prune, saveState, storyKeys, seenAnyWording,
  rememberTopic, recentTopics, SUBJECT_COOLDOWN_MS,
  rememberWarning, warningSent, rememberWarningPost, warningPosts,
} from "./state.js";

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

function preview(text) {
  log("  ── ԱՅՍՊԵՍ ԿԵՐԵՎԱ ──────────────────────────────");
  for (const line of text.split("\n")) log(`  │ ${line}`);
}

/**
 * Is it the middle of the night in Yerevan?
 *
 * The calendar already refused to SCHEDULE a warning inside these hours. The
 * news half had no such notion at all — a feed publishing at 03:40 produced a
 * post that woke every subscriber. Nothing is withheld: the post is published
 * on time, it simply arrives without a sound.
 */
function quiet(at) {
  const h = partsInTz(at, CHANNEL_TZ).hh;
  return h >= QUIET_FROM || h < QUIET_UNTIL;
}

// ── THE CALENDAR HALF ──────────────────────────────────────────────────────

/**
 * Warnings, the weekly overview, and the bot's notice about its own expiry.
 *
 * Every send is recorded BEFORE the next one is attempted and only AFTER
 * Telegram confirms, with one exception: a stale warning is recorded without
 * being sent. That is the mechanism that stops a bot switched back on after a
 * long outage from firing a month of missed notices at once.
 */
async function runCalendar({ state, token, chatId, now }) {
  log("");
  log("📅 ՕՐԱՑՈՒՅՑ");
  log("─".repeat(64));

  // CHECK THE DATA FILE BEFORE TRUSTING IT.
  //
  // events.js is the one file the bot asks its owner to edit, and a broken edit
  // must not become a post with the wrong hour in it. Loud, and not fatal: the
  // news half is untouched by anything wrong in here.
  const problems = validateEvents(EVENTS);
  if (problems.length > 0) {
    log("⛔ events.js-ում սխալ կա — օրացույցը բաց եմ թողնում այս գործարկման ընթացքում՝");
    for (const p of problems) log(`   • ${p}`);
    log("   Նորությունները շարունակում են աշխատել։");
    return 0;
  }

  let sentCount = 0;

  // --- warnings ------------------------------------------------------------
  const due = dueWarnings(now, warningSent(state), EVENTS);

  // Stale first, and out loud. A silent skip here would look identical to a bug
  // that drops warnings, and this is the path a bot taken off the shelf after a
  // long outage walks down — recording a month of missed notices instead of
  // firing them all at once.
  //
  // THE REASON IS NAMED, because there are two and they are not the same thing.
  // A row is stale either because its moment is long gone, or because a LATER
  // moment for the same event is also due and only the latest is worth sending.
  // The log said "the moment passed long ago" for both, which is the wrong
  // diagnosis in the one place a non-technical owner would be asked to look.
  for (const d of due.filter((x) => x.stale)) {
    const late = now - d.at > MAX_LATENESS_MS;
    const why = late
      ? `պահը վաղուց անցել է (${Math.round((now - d.at) / 3_600_000)}ժ)`
      : "ավելի ուշ հիշեցումը գերակայում է";
    log(`  ⏭️  ${d.event.short} (${d.ymd}, ${d.kind}) — ${why}, գրանցում եմ առանց ուղարկելու`);
    rememberWarning(state, d.stateKey, now);
  }

  const groups = groupWarnings(due);
  if (groups.length === 0) log("Ուղարկելու նախազգուշացում չկա։");

  for (const g of groups) {
    const text = renderWarning(g, now);
    const names = g.rows.map((r) => r.event.short).join(" + ");
    log(`  ⏰ ${names} · ${whenPhrase(g.rows[0].ts, now)} · ${g.kind}`);

    if (DRY) {
      preview(text);
      sentCount += 1;
      continue;
    }

    const res = await sendMessage(token, chatId, text, { silent: quiet(now) });
    if (!res.ok && !res.unknown) {
      // NOT recorded. An unrecorded warning is retried in half an hour, which
      // is the right outcome for a transient Telegram REJECTION — and the
      // staleness rule stops it retrying for ever.
      log(`  ❌ Telegram-ը մերժեց՝ ${res.why}`);
      continue;
    }
    // UNKNOWN IS RECORDED, REJECTED IS NOT.
    //
    // A dropped connection or an unreadable 2xx body means Telegram may well
    // have delivered this. Treating that as a failure is what put the same
    // warning in the channel twice, half an hour apart. Recording it costs at
    // most one warning that never arrived; not recording it costs a duplicate,
    // and a duplicate is the thing this project promises never to do.
    if (res.unknown) log(`  ⚠️  անհայտ արդյունք՝ ${res.why} — գրանցում եմ, որ չկրկնվի`);
    if (res.degraded) log(`  ⚠️  ուղարկվեց առանց «${res.degraded}» ձևավորման`);
    // Every event in the post points at that post, so a story about any one of
    // them threads onto it.
    for (const r of g.rows) {
      rememberWarning(state, r.stateKey, now);
      // No message id when the result was unknown — so the story simply will
      // not thread onto it. A missing rail beats a repeated post.
      rememberWarningPost(state, r.key, res.messageId, now);
    }
    sentCount += 1;
    log("  ✅ ուղարկվեց");
  }

  // --- the weekly overview -------------------------------------------------
  const digest = digestDue(now, state.cal?.digestWeek ?? null);
  if (digest) {
    const text = renderDigest(digest, now, EVENTS);
    log(`  📅 շաբաթական ակնարկ՝ ${digest.week}`);
    if (DRY) {
      preview(text);
      sentCount += 1;
    } else {
      const res = await sendMessage(token, chatId, text, { silent: quiet(now) });
      if (res.ok || res.unknown) {
        state.cal.digestWeek = digest.week;
        sentCount += 1;
        log(res.unknown ? `  ⚠️  անհայտ արդյունք՝ ${res.why} — գրանցում եմ, որ չկրկնվի` : "  ✅ ուղարկվեց");
        if (res.degraded) log(`  ⚠️  ուղարկվեց առանց «${res.degraded}» ձևավորման`);
      } else {
        log(`  ❌ Telegram-ը մերժեց՝ ${res.why}`);
      }
    }
  }

  // --- the calendar's own expiry -------------------------------------------
  const expiring = expiryDue(now, state.cal?.expiryAt ?? 0, EVENTS);
  if (expiring) {
    const text = renderExpiry(expiring, now);
    log(`  ⚙️  օրացույցը սպառվում է՝ ${expiring.worst.event.short}, ${expiring.worst.daysLeft} օր`);
    if (DRY) {
      preview(text);
      sentCount += 1;
    } else {
      // Sent to the admin chat when one is configured, so readers do not see
      // the plumbing. With no admin chat it goes to the channel, because a
      // maintenance warning nobody reads is the same as no warning at all.
      const to = process.env.TELEGRAM_ADMIN_CHAT_ID || chatId;
      const res = await sendMessage(token, to, text);
      // COUNTED. This branch was the only send in the file that did not
      // increment, and the counter is what triggers the mid-run save below. So
      // the notice went out, `calendarPosts` stayed 0, the save was skipped,
      // the news half then spent minutes on paced Gemini calls, and a run
      // killed by the workflow's ten-minute timeout lost `expiryAt` — making
      // the notice fire again every half hour. The seven-day guard could not
      // help, because the value it guards was the one never written.
      if (res.ok || res.unknown) {
        state.cal.expiryAt = now;
        sentCount += 1;
        log(res.unknown ? `  ⚠️  անհայտ արդյունք՝ ${res.why} — գրանցում եմ, որ չկրկնվի` : "  ✅ ուղարկվեց");
        if (res.degraded) log(`  ⚠️  ուղարկվեց առանց «${res.degraded}» ձևավորման`);
      } else {
        log(`  ❌ Telegram-ը մերժեց՝ ${res.why}`);
      }
    }
  }

  return sentCount;
}

// ── THE NEWS HALF ──────────────────────────────────────────────────────────

async function runNews({ state, token, chatId, geminiKey , now}) {
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
  //
  // EVERY VARIANT, NOT JUST THE LEAD — AND NOT JUST THE NEWEST EIGHT.
  //
  // A cluster's lead is whichever report happened to be newest on this run. Key
  // the memory on that alone and the same event reposts as soon as a different
  // outlet's wording takes the lead — which is exactly what happens when a
  // story develops and a second wave of coverage arrives a few hours later.
  //
  // The first version capped this at the eight NEWEST reports, and clustering
  // sorts newest first. So once eight fresher reports of an already-posted
  // story arrived, not one of the stored keys was still in the window, every
  // check missed, and the story posted a second time — with only the twelve-hour
  // subject cooldown standing in the way, and a big story easily outlives that.
  // A court ruling or an ETF approval, the two kinds of story that draw a dozen
  // follow-ups across a day, are precisely the ones that hit it.
  //
  // A cluster cannot be larger than the number of feeds, so there is no real
  // ceiling to buy here. The cap remains only as a bound on the state file, and
  // it now lives in state.js where a test can reach it — the old one sat inside
  // this function, unreachable, which is why the bug survived two test suites.

  // SUBJECT COOLDOWN, ACROSS RUNS.
  //
  // The per-run diversity rule stopped three CLARITY Act posts going out
  // together. It could not stop them going out five hours apart, because each
  // run only saw its own batch.
  const recent = recentTopics(state);
  const todo = [];
  let subjectBlocked = 0;
  for (const story of ranked) {
    // Checked against EVERY wording, stored as the first forty. See the note
    // on seenAnyWording — a big story can hold far more items than there are
    // feeds, and the previous check only looked at the newest few.
    if (seenAnyWording(state, story.items, keyWords)) continue;
    const keys = storyKeys(story.items, keyWords);
    if (recent.some((w) => sameSubject(w, story.words))) {
      subjectBlocked += 1;
      continue;
    }
    todo.push({ ...story, keys });
    if (todo.length >= MAX_PER_RUN) break;
  }
  log(`Նոր՝ ${todo.length}${subjectBlocked ? ` · ${subjectBlocked} բաց թողնված՝ նույն թեման վերջին ${SUBJECT_COOLDOWN_MS / 3_600_000}ժ-ում` : ""}`);

  if (todo.length === 0) {
    log("\nՀրապարակելու բան չկա։ Հանգիստ ժամ։");
    return 0;
  }

  // --- 4. summarise and post ----------------------------------------------
  let posted = 0;
  // Carried across stories: a model exhausted on the first story is exhausted on
  // the third too, and rediscovering that costs a 13-second paced call each
  // time. The first real run spent three and a half minutes doing exactly that.
  const blockedModels = new Set();

  // ASK THE API WHICH MODELS EXIST, RATHER THAN REMEMBERING.
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
    log(`ՄԻԱՎՈՐ ${story.score.toFixed(1)} · ${story.importance} · ${lead.title}`);

    const r = await ask(geminiKey, summaryPrompt(lead), { log, blocked: blockedModels, models });
    if (!r.ok) {
      if (r.quotaExhausted) {
        // Every model is walled. A daily quota does not clear during a run, so
        // continuing means the same refusal for every remaining story.
        log(`  ⛔ Ոչ մի մոդել հասանելի չէ՝ ${String(r.why).slice(0, 160)}`);
        log("  Դադարեցնում եմ այս գործարկումը։ Մնացած պատմությունները կմնան հաջորդին։");
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

    // IS THIS THE ANSWER TO A QUESTION THE CHANNEL ALREADY ASKED?
    //
    // Matched on the event's own keywords, two hits minimum, and only against
    // events that have already happened in the last day and a half. A CPI story
    // cannot be the result of a CPI release that is still in the future.
    const thread = matchOccurrence(story.words, Date.now(), warningPosts(state), EVENTS);
    if (thread) log(`  🧵 ${thread.event.short}-ի նախազգուշացման պատասխանն է (${thread.hits} համընկնում)`);

    const text = renderPost({
      summary,
      source: lead.source,
      link: lead.link,
      why: story.why,
      cat: lead.cat,
      sourceCount: story.count,
      importance: story.importance,
      primary: story.primary,
      sources: story.sources,
      thread: thread ? threadNote(thread) : null,
    });

    if (DRY) {
      preview(text);
      posted += 1;
      continue;
    }

    const sent = await sendMessage(token, chatId, text, {
      previewUrl: lead.link,
      replyTo: thread?.messageId ?? null,
      // THE MARK DECIDES WHETHER THE PHONE BUZZES.
      //
      // An ordinary post arrives silently, and so does anything at all inside
      // the quiet hours the calendar already respects and the news half used to
      // ignore entirely — a ●○○ Dogecoin item was waking every subscriber at
      // 04:00. The post still arrives and still sits in the channel; it just
      // makes no sound. That is what turns the three-level scale from a label
      // into a promise about someone's evening.
      silent: story.importance === "LOW" || quiet(now),
    });
    if (!sent.ok && !sent.unknown) {
      log(`  ❌ Telegram-ը մերժեց՝ ${sent.why}`);
      continue;
    }
    if (sent.unknown) log(`  ⚠️  անհայտ արդյունք՝ ${sent.why} — գրանցում եմ, որ չկրկնվի`);
    if (sent.degraded) log(`  ⚠️  ուղարկվեց առանց «${sent.degraded}» ձևավորման`);
    // Only after Telegram confirms. Remembering first would mean a failed send
    // silently loses the story for ever.
    rememberAll(state, story.keys, lead);
    // The SUBJECT is recorded only on a real post. A skipped or unsummarisable
    // story must not silence its own topic for twelve hours.
    rememberTopic(state, story.words);
    posted += 1;
    log("  ✅ հրապարակվեց");
  }

  return posted;
}

// ── THE RUN ────────────────────────────────────────────────────────────────

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const geminiKey = process.env.GEMINI_API_KEY;
  const now = Date.now();

  log(`\n📰 NEWS BOT · ${new Date(now).toISOString()}${DRY ? " · ՉՈՐ ԳՈՐԾԱՐԿՈՒՄ" : ""}`);
  log("═".repeat(64));

  if (!DRY && (!token || !chatId)) {
    log("TELEGRAM_BOT_TOKEN կամ TELEGRAM_CHAT_ID չկա — հրապարակել հնարավոր չէ։");
    log("Չոր գործարկման համար՝ node run.js --dry-run");
    process.exit(1);
  }

  const state = await loadState();
  if (state.recovered) log("⚠️  Հիշողության ֆայլը վնասված էր — սկսում եմ դատարկից");

  let calendarPosts = 0;
  let newsPosts = 0;

  try {
    // THE CALENDAR FIRST, AND OUTSIDE THE NEWS HALF'S FAILURES.
    //
    // It needs no AI and no RSS feed. If the summariser's quota is spent or
    // every feed is down, the scheduled events still go out — which is the
    // half of the channel a reader can rely on to the minute.
    calendarPosts = await runCalendar({ state, token, chatId, now });

    // SAVE HERE, NOT ONLY AT THE END.
    //
    // The news half makes paced calls to Gemini — thirteen seconds apart, with
    // retries — and the workflow kills the job at ten minutes. A kill does not
    // run `finally`. Without this line, a run that posted its warnings in the
    // first two seconds and was then killed waiting on the summariser would
    // have no record of them, and would post every one of them again half an
    // hour later. The calendar runs first so it survives the news half's
    // failures; this is what makes it survive the news half's timeout.
    if (!DRY && calendarPosts > 0) {
      await saveState(state);
      log("  💾 օրացույցի գրառումը պահպանված է");
    }

    log("");
    log("📰 ՆՈՐՈՒԹՅՈՒՆՆԵՐ");
    log("─".repeat(64));

    if (!geminiKey) {
      log("GEMINI_API_KEY չկա — ամփոփում հնարավոր չէ, նորությունները բաց եմ թողնում։");
    } else {
      newsPosts = await runNews({ state, token, chatId, geminiKey ,now });
    }
  } finally {
    // ALWAYS. A crash in the news half must not throw away the record of
    // warnings that have already gone out — losing that record means posting
    // them all again in half an hour.
    //
    // prune() is inside its own try because a throw HERE would skip the save
    // below, which is the one failure that costs more than whatever caused it.
    // A state file that is too large is a nuisance; a state file that was never
    // written is a channel repeating itself for ever.
    try {
      prune(state, now);
    } catch (e) {
      log(`⚠️  հիշողության մաքրումը ձախողվեց՝ ${e?.message ?? e} — պահպանում եմ առանց մաքրելու`);
    }
    if (!DRY) await saveState(state);
  }

  log("");
  log("═".repeat(64));
  log(
    DRY
      ? `ՉՈՐ՝ ${calendarPosts} օրացուցային + ${newsPosts} նորություն կհրապարակվեր։ Ոչինչ չուղարկվեց։`
      : `Հրապարակվեց՝ ${calendarPosts} օրացուցային · ${newsPosts} նորություն`
  );

  if (!DRY && calendarPosts + newsPosts > 0) {
    const me = await getMe(token);
    if (me.ok) log(`Բոտ՝ @${me.username}`);
  }
}

main().catch((e) => {
  console.error("\nընկավ՝", e);
  process.exit(1);
});
