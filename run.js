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
import { renderPost, sendMessage, getMe, relatedNote } from "./telegram.js";
import { EVENTS } from "./events.js";
import {
  dueWarnings, groupWarnings, digestDue, outcomeWindowDue, expiryDue, matchOccurrence,
  whenPhrase, validateEvents, partsInTz, ymdInTz,
  MAX_LATENESS_MS, QUIET_FROM, QUIET_UNTIL, CHANNEL_TZ,
} from "./calendar.js";
import { renderWarning, renderDigest, renderExpiry, threadNote } from "./calpost.js";
import {
  loadState, alreadyPosted, remember, prune, saveState, storyKeys, seenAnyWording,
  rememberTopic, recentTopics, SUBJECT_COOLDOWN_MS,
  rememberLinkable, linkableStories,
  rememberWarning, warningSent, rememberWarningPost, warningPosts,
  rememberOutcome, dueOutcomes, resolveOutcome, outcomeHistoryInWindow, ACCOUNTABILITY_DELAY_MS,
} from "./state.js";
import { detectCoin, fetchPrice, makePriceCache, formatPriceLine, formatUsd } from "./price.js";
import { renderOutcomeReply, renderWeeklyOutcomes } from "./outcomepost.js";
import {
  morningDue, renderMorning, fetchMarket, fetchFearGreed, fetchCbaRates, fetchMacro, fetchChannelUsername, MORNING_SILENT,
} from "./morning.js";
import { rememberRecentPost, recentPostsBetween } from "./state.js";
import { eveningDue, absorbable, renderEvening, EVENING_SILENT } from "./evening.js";
import { choosePreview, cardUrl } from "./media.js";
import { verifyNumbers, NUMBERS_RETRY_NOTE } from "./verify.js";
import {
  pulseDue, fetchStableWeek, fetchNetLiquidity, renderPulse, PULSE_SILENT,
  fetchStableDay, dueAlerts, renderStableAlert,
} from "./liquidity.js";
import {
  dueReleases, referenceMonth, fetchBls, seriesFor, computeRelease, renderRelease, coveredByRelease,
} from "./release.js";

const DRY = process.argv.includes("--dry-run");

/**
 * "release" = one of the extra short runs the workflow schedules in the
 * minutes after 08:30 New York on weekdays. It checks ONLY for CPI/payroll
 * numbers — no feeds, no Gemini, no calendar — so it costs a few seconds and
 * none of the summariser's quota, and the numbers land 5–15 minutes after the
 * release instead of whenever the next half-hourly run happens to fall.
 * On any other day it finds nothing due and exits at once.
 */
const RUN_KIND = process.env.RUN_KIND === "release" ? "release" : "full";

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
async function runCalendar({ state, token, chatId, now, absorbInto = null }) {
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
    // Tonight's evening summary carries ordinary day-before warnings in its
    // «Վաղը» section and records them itself — see evening.js.
    if (absorbInto && absorbable(g)) {
      absorbInto.push(...g.rows);
      log(`  🌙 ${g.rows.map((r) => r.event.short).join(" + ")} — կմտնի երեկոյան ամփոփման մեջ`);
      continue;
    }
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

  // --- the weekly outcomes recap --------------------------------------------
  //
  // Its own tracker field (`outcomeDigestWeek`), separate from the market
  // digest's `cal.digestWeek` above, so a failure sending one never blocks or
  // duplicates the other — they cover different subjects and have nothing to
  // do with each other beyond firing in the same Sunday-evening window.
  //
  // outcomeWindowDue(), NOT digestDue(). The two look like the same "is the
  // weekly thing due" check, but digestDue()'s window looks forward to the
  // week about to start — right for the market calendar above, wrong here:
  // this recap reports on stories already posted and resolved, so it needs
  // the week that just ended. See calendar.js's comment on outcomeWindowDue()
  // for how this was actually wrong here first, and why.
  const outcomeDigest = outcomeWindowDue(now, state.outcomeDigestWeek ?? null);
  if (outcomeDigest) {
    const history = outcomeHistoryInWindow(state, outcomeDigest);
    const text = renderWeeklyOutcomes(outcomeDigest, history);
    log(`  📊 շաբաթական ամփոփում (outcomes)՝ ${outcomeDigest.week}`);
    if (DRY) {
      preview(text);
      sentCount += 1;
    } else {
      const res = await sendMessage(token, chatId, text, { silent: quiet(now) });
      if (res.ok || res.unknown) {
        state.outcomeDigestWeek = outcomeDigest.week;
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
      // maintenance warning nobody reads is the same as no warning at all —
      // and when it does go to the channel, it is silent, exactly like every
      // other send in this file. This branch was the one place that forgot
      // `quiet(now)`, so a low-on-dates notice could buzz a subscriber's phone
      // at 03:00, which is precisely the promise `quiet()` exists to keep.
      const to = process.env.TELEGRAM_ADMIN_CHAT_ID || chatId;
      const res = await sendMessage(token, to, text, { silent: quiet(now) });
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

// ── THE MORNING BRIEF ────────────────────────────────────────────────────────

/**
 * Once a day, the first run at or after 09:00 Yerevan. See morning.js.
 *
 * Needs no AI, so it sits with the calendar ahead of the news half: a spent
 * Gemini quota cannot stop it. Recorded on ok OR unknown, like every other
 * send in this file — a duplicate "good morning" is the worse failure.
 */
async function runMorning({ state, token, chatId, now }) {
  const due = morningDue(now, state.morningDay ?? null);
  if (!due) return 0;

  log("");
  log("☀️ ԱՌԱՎՈՏՅԱՆ ԱՄՓՈՓՈՒՄ");
  log("─".repeat(64));

  if (due.stale) {
    log(`  ⏭️  ${due.day}՝ կեսօրն անցել է — գրանցում եմ առանց ուղարկելու`);
    state.morningDay = due.day;
    return 0;
  }

  const [market, fng, cba, macro, username] = await Promise.all([
    fetchMarket(),
    fetchFearGreed(),
    fetchCbaRates(),
    fetchMacro(),
    DRY ? Promise.resolve(null) : fetchChannelUsername(token, chatId),
  ]);
  if (!market.ok) log(`  ⚠️  գներ չստացվեցին (${market.why}) — առանց գների`);
  if (!fng.ok) log(`  ⚠️  Fear & Greed չստացվեց (${fng.why}) — առանց դրա`);
  if (!cba.ok) log(`  ⚠️  ԿԲ փոխարժեքը չստացվեց (${cba.why}) — առանց դրա`);
  if (!macro.ok) log(`  ℹ️  ԱՄՆ շուկայի տող չկա (${macro.why})`);
  if (!DRY && !username) log("  ⚠️  ալիքի @username-ը չստացվեց — վերնագրերը առանց հղումների");

  const night = recentPostsBetween(state, due.from, due.to);
  const text = renderMorning({ now, market, fng, cba, macro, night, username, events: EVENTS });

  if (DRY) {
    preview(text);
    return 1;
  }

  const res = await sendMessage(token, chatId, text, { silent: MORNING_SILENT });
  if (!res.ok && !res.unknown) {
    log(`  ❌ Telegram-ը մերժեց՝ ${res.why} — կփորձեմ հաջորդ գործարկման ժամանակ`);
    return 0;
  }
  if (res.unknown) log(`  ⚠️  անհայտ արդյունք՝ ${res.why} — գրանցում եմ, որ չկրկնվի`);
  if (res.degraded) log(`  ⚠️  ուղարկվեց առանց «${res.degraded}» ձևավորման`);
  state.morningDay = due.day;
  log("  ✅ ուղարկվեց");
  return 1;
}

// ── THE EVENING SUMMARY ──────────────────────────────────────────────────────

/**
 * See evening.js. `absorbed` are the ordinary day-before warnings the calendar
 * handed over this run; they are recorded against this message only once
 * Telegram has (or may have) taken it, so a failed send leaves them to go out
 * on their own at the next run.
 */
async function runEvening({ state, token, chatId, now, due, absorbed = [] }) {
  if (!due) return 0;

  log("");
  log("🌙 ԵՐԵԿՈՅԱՆ ԱՄՓՈՓՈՒՄ");
  log("─".repeat(64));

  if (due.stale) {
    log(`  ⏭️  ${due.day}՝ 23:00-ն անցել է — գրանցում եմ առանց ուղարկելու`);
    state.eveningDay = due.day;
    return 0;
  }

  const [market, username] = await Promise.all([
    fetchMarket(),
    DRY ? Promise.resolve(null) : fetchChannelUsername(token, chatId),
  ]);
  if (!market.ok) log(`  ⚠️  գներ չստացվեցին (${market.why}) — առանց գների`);

  const posts = recentPostsBetween(state, due.from, due.to);
  const outcomes = (state.outcomeHistory ?? []).filter((o) => (o.resolvedAt ?? 0) >= due.from && o.resolvedAt <= due.to);
  const text = renderEvening({ now, posts, outcomes, market, username, events: EVENTS });

  if (DRY) {
    preview(text);
    return 1;
  }

  const res = await sendMessage(token, chatId, text, { silent: EVENING_SILENT });
  if (!res.ok && !res.unknown) {
    log(`  ❌ Telegram-ը մերժեց՝ ${res.why} — նախազգուշացումները կգնան առանձին հաջորդ գործարկման ժամանակ`);
    return 0;
  }
  if (res.unknown) log(`  ⚠️  անհայտ արդյունք՝ ${res.why} — գրանցում եմ, որ չկրկնվի`);
  state.eveningDay = due.day;
  for (const r of absorbed) {
    rememberWarning(state, r.stateKey, now);
    rememberWarningPost(state, r.key, res.messageId, now);
  }
  log(`  ✅ ուղարկվեց${absorbed.length ? ` · ${absorbed.length} նախազգուշացում ներառված` : ""}`);
  return 1;
}

// ── LIQUIDITY: THE SUNDAY PULSE AND THE STABLECOIN ALERT ─────────────────────

/** See liquidity.js. No AI; runs with the calendar, ahead of the news half. */
async function runLiquidity({ state, token, chatId, now }) {
  let sent = 0;

  // The alert: one small CoinGecko request per run.
  state.stableAlerts = state.stableAlerts ?? {};
  const day = await fetchStableDay();
  const alerts = day.ok ? dueAlerts(day.rows, now, state.stableAlerts) : [];
  for (const a of alerts) {
    log("");
    log(`💵 ${a.symbol}՝ ${a.change > 0 ? "+" : ""}${(a.change / 1e9).toFixed(2)} մլրդ 24 ժամում`);
    const text = renderStableAlert(a);
    if (DRY) { preview(text); sent += 1; continue; }
    const res = await sendMessage(token, chatId, text, {
      silent: quiet(now), previewUrl: cardUrl("crypto", `${a.symbol}-${ymdInTz(now, CHANNEL_TZ)}`),
    });
    if (!res.ok && !res.unknown) { log(`  ❌ Telegram-ը մերժեց՝ ${res.why}`); continue; }
    state.stableAlerts[a.symbol] = now;
    rememberRecentPost(state, {
      id: res.messageId ?? null, importance: "MEDIUM", at: now,
      headline: `${a.symbol}-ի շրջանառությունը ${a.change > 0 ? "աճեց" : "նվազեց"} 24 ժամում`,
    });
    sent += 1;
  }

  // The pulse: Sunday noon.
  const due = pulseDue(now, state.pulseWeek ?? null);
  if (due) {
    log("");
    log("💧 ԻՐԱՑՎԵԼԻՈՒԹՅԱՆ ԻՄՊՈՒԼՍ");
    log("─".repeat(64));
    if (due.stale) {
      log("  ⏭️  19:00-ն անցել է — այս շաբաթ բաց եմ թողնում");
      state.pulseWeek = due.week;
      return sent;
    }
    const [stables, liquidity] = await Promise.all([fetchStableWeek(), fetchNetLiquidity()]);
    if (!liquidity.ok) log(`  ℹ️  Fed-ի իրացվելիություն չկա (${liquidity.why})`);
    if (!stables.ok && !liquidity.ok) {
      log("  ⚠️  ոչ մի տվյալ — կփորձեմ հաջորդ գործարկման ժամանակ");
      return sent;
    }
    const text = renderPulse({ now, stables, liquidity });
    if (DRY) { preview(text); return sent + 1; }
    const res = await sendMessage(token, chatId, text, { silent: PULSE_SILENT, previewUrl: cardUrl("macro", due.week) });
    if (!res.ok && !res.unknown) { log(`  ❌ Telegram-ը մերժեց՝ ${res.why}`); return sent; }
    state.pulseWeek = due.week;
    log("  ✅ ուղարկվեց");
    sent += 1;
  }
  return sent;
}

// ── THE NUMBER ITSELF: CPI AND PAYROLLS FROM THE BLS ─────────────────────────

/**
 * See release.js. Posted as a reply to the channel's own warning for that
 * release, so the question and the answer sit in one thread. No AI, so it
 * runs with the calendar, ahead of the news half.
 */
async function runReleases({ state, token, chatId, now }) {
  state.releases = state.releases ?? {};
  const due = dueReleases(now, state.releases, EVENTS);
  if (due.length === 0) return 0;

  log("");
  log("📊 ՊԱՇՏՈՆԱԿԱՆ ԹՎԵՐ (BLS)");
  log("─".repeat(64));

  let sent = 0;
  for (const o of due) {
    if (o.expired) {
      log(`  ⏭️  ${o.event.short} (${o.ymd})՝ թիվը ${Math.round((now - o.ts) / 3_600_000)}ժ-ում չհայտնվեց — թողնում եմ`);
      state.releases[o.key] = now;
      continue;
    }
    const ref = referenceMonth(o.ts);
    const data = await fetchBls(seriesFor(o.event.id), ref);
    if (!data.ok) {
      log(`  ⚠️  ${o.event.short}՝ BLS-ը չպատասխանեց (${data.why}) — կփորձեմ հաջորդ գործարկման ժամանակ`);
      continue;
    }
    const r = computeRelease(o.event.id, data.series, ref);
    if (!r) {
      log(`  ⏳ ${o.event.short}՝ BLS-ում ${ref.y}-${String(ref.m).padStart(2, "0")}-ը դեռ չկա — կփորձեմ հաջորդ գործարկման ժամանակ`);
      continue;
    }

    const text = renderRelease(r, o.event);
    const warning = warningPosts(state)[o.key]?.messageId ?? null;
    if (DRY) {
      preview(text);
      sent += 1;
      continue;
    }
    const res = await sendMessage(token, chatId, text, {
      replyTo: warning, silent: quiet(now), previewUrl: cardUrl("macro", o.key),
    });
    if (!res.ok && !res.unknown) {
      log(`  ❌ Telegram-ը մերժեց՝ ${res.why} — կփորձեմ հաջորդ գործարկման ժամանակ`);
      continue;
    }
    if (res.unknown) log(`  ⚠️  անհայտ արդյունք՝ ${res.why} — գրանցում եմ, որ չկրկնվի`);
    state.releases[o.key] = now;
    rememberRecentPost(state, { id: res.messageId ?? null, headline: `${o.event.name}՝ պաշտոնական թվեր`, importance: "HIGH", at: now });
    sent += 1;
    log(`  ✅ ${o.event.short} ${ref.y}-${String(ref.m).padStart(2, "0")}${warning ? " (շղթայով)" : ""}`);
  }
  return sent;
}

// ── THE ACCOUNTABILITY LOOP ──────────────────────────────────────────────────

/**
 * The follow-up half of the price snapshot below: for every HIGH-importance,
 * coin-resolved story the channel posted, check back once, later, and reply
 * to the original with what the price actually did.
 *
 * Runs every half hour like everything else, but each entry only ACTS once it
 * is due (`ACCOUNTABILITY_DELAY_MS` after it posted) — most runs find nothing
 * due and do nothing here.
 *
 * A price that cannot be fetched right now is left in the queue rather than
 * dropped: the next run tries again, and `prune()`'s OUTCOME_MAX_AGE_MS is
 * what eventually gives up on one that never resolves.
 */
async function runOutcomeChecks({ state, token, chatId, now }) {
  const due = dueOutcomes(state, now);
  if (due.length === 0) return 0;

  log("");
  log("📌 ՀԱՇՎԵՏՎՈՂԱԿԱՆՈՒԹՅՈՒՆ");
  log("─".repeat(64));

  let sent = 0;
  for (const entry of due) {
    const price = await fetchPrice(entry.coinId);
    if (!price.ok) {
      log(`  ⚠️  ${entry.symbol}՝ գին չստացվեց (${price.why}) — կփորձեմ հաջորդ գործարկման ժամանակ`);
      continue;
    }

    const pctChange = ((price.usd - entry.priceAtPost) / entry.priceAtPost) * 100;
    const text = renderOutcomeReply({
      symbol: entry.symbol,
      priceAtPost: entry.priceAtPost,
      priceAtCheck: price.usd,
      pctChange,
      elapsedMs: now - entry.postedAt,
    });

    if (DRY) {
      preview(text);
      resolveOutcome(state, entry.id, {
        symbol: entry.symbol, headline: entry.headline, pctChange, postedAt: entry.postedAt,
        id: entry.id, resolvedAt: now,
      });
      sent += 1;
      continue;
    }

    const res = await sendMessage(token, entry.chatId ?? chatId, text, {
      replyTo: entry.id,
      silent: quiet(now),
    });
    if (!res.ok && !res.unknown) {
      log(`  ❌ ${entry.symbol}՝ Telegram-ը մերժեց՝ ${res.why} — կփորձեմ հաջորդ գործարկման ժամանակ`);
      continue;
    }
    if (res.unknown) log(`  ⚠️  անհայտ արդյունք՝ ${res.why} — գրանցում եմ, որ չկրկնվի`);
    // Resolved only once Telegram has (or may have) confirmed — same rule as
    // every other send in this file: never lose the record of a real post, and
    // never mark this one done before it might actually have gone out.
    resolveOutcome(state, entry.id, {
      symbol: entry.symbol, headline: entry.headline, pctChange, postedAt: entry.postedAt,
      id: entry.id, resolvedAt: now,
    });
    sent += 1;
    log(`  ✅ ${entry.symbol}՝ ${pctChange >= 0 ? "+" : ""}${pctChange.toFixed(1)}%`);
  }
  return sent;
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
    // The BLS's own item for a release whose numbers already went out.
    const covered = coveredByRelease(story.lead, story.words, now, state.releases ?? {}, EVENTS);
    if (covered) {
      log(`  ⏭️  ${covered.event.short}-ի թվերն արդեն հրապարակված են — BLS-ի նույն նյութը բաց եմ թողնում`);
      for (const k of keys) remember(state, k, { title: story.lead.title, at: story.lead.at });
      continue;
    }
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

  // ONE PRICE FETCH PER COIN PER RUN.
  //
  // Several of the up-to-three stories in one run can name the same coin — a
  // Fed decision and a Bitcoin ETF headline both mentioning BTC, say — and the
  // cache (see price.js) makes that one CoinGecko call, not three.
  const priceCache = makePriceCache();

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

    // The post names and links the LEAD (the original, when there is one); the
    // model reads whichever report has enough words — see pickSummarySource().
    const material = story.summarySource ?? lead;
    if (material !== lead) log(`  📄 ամփոփման նյութը՝ ${material.source} (${lead.source}-ի տեքստը կարճ է)`);
    const r = await ask(geminiKey, summaryPrompt(material), { log, blocked: blockedModels, models });
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

    let summary = parseSummary(r.text);
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

    // EVERY NUMBER MUST COME FROM THE SOURCE — see verify.js. Checked against
    // every report of the story, not only the one the model read. One second
    // attempt with a stricter instruction; if that also invents a figure, the
    // story waits for the next run, and after two such runs it is dropped.
    const evidence = story.items.flatMap((i) => [i.title, i.body ?? ""]);
    let numbers = verifyNumbers(summary, evidence);
    if (!numbers.ok) {
      log(`  🔢 աղբյուրում չկա՝ ${numbers.unsupported.join(", ")} — երկրորդ փորձ`);
      const r2 = await ask(geminiKey, summaryPrompt(material) + NUMBERS_RETRY_NOTE, { log, blocked: blockedModels, models });
      const s2 = r2.ok ? parseSummary(r2.text) : null;
      const n2 = s2 && !s2.insufficient ? verifyNumbers(s2, evidence) : null;
      if (n2?.ok) {
        summary = s2;
        numbers = n2;
        log("  🔢 երկրորդ փորձը ճիշտ է");
      } else {
        state.numberRejects = state.numberRejects ?? {};
        const id = story.keys[0];
        const tries = (state.numberRejects[id]?.n ?? 0) + 1;
        state.numberRejects[id] = { n: tries, at: now };
        if (tries >= 2) {
          log(`  ⛔ թվերը չհամընկան ${tries} անգամ — պատմությունը բաց եմ թողնում`);
          rememberAll(state, story.keys, lead);
        } else {
          log("  ⏸️  թվերը չհամընկան — կփորձեմ հաջորդ գործարկման ժամանակ");
        }
        continue;
      }
    }
    if (numbers.checked) log(`  🔢 ${numbers.checked} թիվ ստուգված է աղբյուրով`);

    // IS THIS THE ANSWER TO A QUESTION THE CHANNEL ALREADY ASKED?
    //
    // Matched on the event's own keywords, two hits minimum, and only against
    // events that have already happened in the last day and a half. A CPI story
    // cannot be the result of a CPI release that is still in the future.
    const thread = matchOccurrence(story.words, now, warningPosts(state), EVENTS);
    if (thread) log(`  🧵 ${thread.event.short}-ի նախազգուշացման պատասխանն է (${thread.hits} համընկնում)`);

    // IS THIS RELATED TO SOMETHING THE CHANNEL ITSELF POSTED RECENTLY?
    //
    // The news-to-news version of the same idea, over a longer window and a
    // softer test — see state.js's LINK_WINDOW_MS and relatedNote() in
    // telegram.js for why this never fires alongside `thread`: a calendar
    // thread is a precise, structural claim ("this is the scheduled result of
    // that warning"); this is a plain word-overlap guess, and a post is never
    // given both kinds of footer line at once.
    let related = null;
    if (!thread) {
      const hit = linkableStories(state, now).find((c) => sameSubject(c.words, story.words));
      if (hit) {
        related = hit;
        log(`  🔗 վերջերս հրապարկածի հետ կապված թեմա է (message ${hit.id})`);
      }
    }

    // THE PRICE SNAPSHOT.
    //
    // A number attached to the news that might explain it — never this
    // channel's opinion on where it is going. See price.js for why the coin
    // list is a short allowlist rather than a regex over every ticker, and why
    // a fetch failure here is decorated-without, never a reason to skip the
    // post it would have decorated.
    const coin = detectCoin(`${lead.title} ${material.body ?? ""}`);
    let priceLine = null;
    let priceAtPost = null;
    if (coin) {
      const price = await priceCache(coin.id);
      if (price.ok) {
        priceLine = formatPriceLine(coin.symbol, price);
        priceAtPost = price.usd;
        log(`  💲 ${coin.symbol} ${formatUsd(price.usd)}`);
      } else {
        log(`  ⚠️  գին չստացվեց (${coin.symbol})՝ ${price.why} — հրապարակում եմ առանց դրա`);
      }
    }

    const text = renderPost({
      summary,
      source: lead.source,
      link: lead.link,
      cat: lead.cat,
      sourceCount: story.count,
      importance: story.importance,
      primary: story.primary,
      sources: story.sources,
      thread: thread ? threadNote(thread) : null,
      related: related ? relatedNote() : null,
      priceLine,
    });

    // The picture. Unchanged whenever the lead's page has one; otherwise another
    // outlet's report of the same story, a price chart, or the channel's card.
    const pic = DRY
      ? { url: lead.link, kind: "lead" }
      : await choosePreview(lead, story.items, coin);
    if (pic.kind !== "lead") log(`  🖼️  նկար՝ ${pic.kind}${pic.source ? ` (${pic.source})` : ""}`);

    if (DRY) {
      preview(text);
      posted += 1;
      continue;
    }

    const sent = await sendMessage(token, chatId, text, {
      previewUrl: pic.url,
      replyTo: thread?.messageId ?? related?.id ?? null,
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

    // QUEUE THE CHECK-BACK.
    //
    // Only for a HIGH-importance, coin-resolved story, and only when the send
    // came back with a real message id — an `unknown` result may not have a
    // message id at all, and without one the reply below could never be
    // threaded onto it anyway.
    if (story.importance === "HIGH" && coin && priceAtPost !== null && sent.messageId) {
      rememberOutcome(state, {
        id: sent.messageId,
        chatId,
        symbol: coin.symbol,
        coinId: coin.id,
        priceAtPost,
        postedAt: now,
        dueAt: now + ACCOUNTABILITY_DELAY_MS,
        headline: summary.headline,
      });
    }

    // For the morning brief: what the channel actually said, in Armenian.
    rememberRecentPost(state, {
      id: sent.messageId ?? null, headline: summary.headline, importance: story.importance, at: now,
    });

    // Only after Telegram confirms. Remembering first would mean a failed send
    // silently loses the story for ever.
    rememberAll(state, story.keys, lead);
    // The SUBJECT is recorded only on a real post. A skipped or unsummarisable
    // story must not silence its own topic for twelve hours.
    rememberTopic(state, story.words);
    // And made available for a LATER story to link back to — only when the
    // send returned a real message id (see rememberLinkable()'s own guard).
    rememberLinkable(state, story.words, sent.messageId, now);
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
  const startMorningDay = state.morningDay ?? null;
  if (state.recovered) log("⚠️  Հիշողության ֆայլը վնասված էր — սկսում եմ դատարկից");

  let calendarPosts = 0;
  let outcomePosts = 0;
  let morningPosts = 0;
  let releasePosts = 0;
  let eveningPosts = 0;
  let liquidityPosts = 0;
  let newsPosts = 0;

  if (RUN_KIND === "release") {
    log("⚡ ԱՐԱԳ ԳՈՐԾԱՐԿՈՒՄ — միայն պաշտոնական թվեր");
    // Saved only when something changed: saveState stamps `updatedAt`, and an
    // unconditional save would commit to the repository six times every
    // weekday for nothing.
    const before = JSON.stringify(state.releases ?? {});
    try {
      releasePosts = await runReleases({ state, token, chatId, now });
      if (releasePosts === 0) log("Հրապարակելու թիվ չկա։");
    } finally {
      if (!DRY && JSON.stringify(state.releases ?? {}) !== before) await saveState(state);
    }
    return;
  }

  try {
    // THE CALENDAR FIRST, AND OUTSIDE THE NEWS HALF'S FAILURES.
    //
    // It needs no AI and no RSS feed. If the summariser's quota is spent or
    // every feed is down, the scheduled events still go out — which is the
    // half of the channel a reader can rely on to the minute.
    // Decided BEFORE the calendar runs, because the calendar needs to know
    // whether tonight's summary will carry the ordinary 20:00 warnings.
    const evening = eveningDue(now, state.eveningDay ?? null);
    const absorbed = evening && !evening.stale ? [] : null;

    calendarPosts = await runCalendar({ state, token, chatId, now, absorbInto: absorbed });

    eveningPosts = await runEvening({ state, token, chatId, now, due: evening, absorbed: absorbed ?? [] });

    // The morning brief, same priority and same reason: no AI needed.
    morningPosts = await runMorning({ state, token, chatId, now });

    // The official numbers, same reason: no AI, must not wait on the news half.
    releasePosts = await runReleases({ state, token, chatId, now });

    liquidityPosts = await runLiquidity({ state, token, chatId, now });

    // THE ACCOUNTABILITY CHECK-BACK, SAME PRIORITY AS THE CALENDAR.
    //
    // It needs no AI and no RSS feed either — only Telegram and CoinGecko —
    // so it runs before the news half for the same reason the calendar does:
    // a spent Gemini quota must not also silence the follow-up on a story
    // already posted.
    outcomePosts = await runOutcomeChecks({ state, token, chatId, now });

    // SAVE HERE, NOT ONLY AT THE END.
    //
    // The news half makes paced calls to Gemini — thirteen seconds apart, with
    // retries — and the workflow kills the job at ten minutes. A kill does not
    // run `finally`. Without this line, a run that posted its warnings in the
    // first two seconds and was then killed waiting on the summariser would
    // have no record of them, and would post every one of them again half an
    // hour later. The calendar runs first so it survives the news half's
    // failures; this is what makes it survive the news half's timeout.
    if (!DRY && (calendarPosts > 0 || outcomePosts > 0 || morningPosts > 0 || releasePosts > 0 || eveningPosts > 0 || liquidityPosts > 0 || state.morningDay !== startMorningDay)) {
      await saveState(state);
      log("  💾 օրացույցի/հաշվետվողականության գրառումը պահպանված է");
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
      ? `ՉՈՐ՝ ${morningPosts} առավոտյան + ${eveningPosts} երեկոյան + ${liquidityPosts} իրացվելիություն + ${releasePosts} պաշտոնական թիվ + ${calendarPosts} օրացուցային + ${outcomePosts} հաշվետվողական + ${newsPosts} նորություն կհրապարակվեր։ Ոչինչ չուղարկվեց։`
      : `Հրապարակվեց՝ ${morningPosts} առավոտյան · ${eveningPosts} երեկոյան · ${liquidityPosts} իրացվելիություն · ${releasePosts} պաշտոնական թիվ · ${calendarPosts} օրացուցային · ${outcomePosts} հաշվետվողական · ${newsPosts} նորություն`
  );

  if (!DRY && morningPosts + eveningPosts + liquidityPosts + releasePosts + calendarPosts + outcomePosts + newsPosts > 0) {
    const me = await getMe(token);
    if (me.ok) log(`Բոտ՝ @${me.username}`);
  }
}

main().catch((e) => {
  console.error("\nընկավ՝", e);
  process.exit(1);
});
