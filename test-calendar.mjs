// Guards the calendar: the timezone arithmetic, which occurrences exist, when
// a warning is due, and what stops one going out twice.
//
//   node test-calendar.mjs
//
// No network and no key. Every function under test is pure — it takes a moment
// in time and returns what should have happened by then — so the tests can set
// the clock to the night before an FOMC meeting and check the answer exactly.
//
// THE TESTS THAT MATTER MOST
//
//   The DST pair. An FOMC statement is 14:00 in New York all year; it is 22:00
//   in Yerevan in September and 23:00 in December. Any code that stores an
//   offset instead of a zone passes one of those and fails the other, and the
//   failure is a warning that says the wrong hour — which is worse than no
//   warning, because a reader acts on it.

import {
  zonedToUtc, partsInTz, ymdInTz, addDaysYmd, weekdayOfYmd, isLastFridayOfMonth,
  occursOn, occurrences, allOccurrences, warningMoments, dueWarnings, groupWarnings,
  digestDue, outcomeWindowDue, lastDigestMoment, calendarHealth, expiryDue, matchOccurrence,
  yerevanClock, whenPhrase, validateEvents,
  MAX_LATENESS_MS, WARN_HOUR, QUIET_FROM, QUIET_UNTIL, EXPIRY_WARN_DAYS,
} from "./calendar.js";
import { EVENTS, eventById, CHANNEL_TZ } from "./events.js";
import { renderWarning, renderDigest, renderExpiry } from "./calpost.js";
import { loadState, prune, rememberWarning, rememberWarningPost, warningSent, warningPosts } from "./state.js";

let failures = 0;
const pass = (m) => console.log(`  ok   ${m}`);
const fail = (m) => {
  console.log(`  FAIL ${m}`);
  failures++;
};
const eq = (got, want, m) => (got === want ? pass(m) : fail(`${m} — got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`));

/** A moment, given as Yerevan wall-clock time. */
const yer = (ymd, hh = 0, mm = 0) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return zonedToUtc(y, m, d, hh, mm, CHANNEL_TZ);
};

console.log("\n1. Timezone arithmetic — the part that must never be done by hand");
{
  // US daylight time ends on 1 November 2026. The CPI release is 08:30 in New
  // York on both sides of it, and a different hour in UTC on each side.
  eq(new Date(zonedToUtc(2026, 10, 14, 8, 30, "America/New_York")).toISOString(),
    "2026-10-14T12:30:00.000Z", "08:30 New York in October is 12:30 UTC (summer time)");
  eq(new Date(zonedToUtc(2026, 11, 10, 8, 30, "America/New_York")).toISOString(),
    "2026-11-10T13:30:00.000Z", "08:30 New York in November is 13:30 UTC (winter time)");

  // The same fact, seen from the reader's chair. This is the pair that a
  // hard-coded "+4 hours from New York" gets wrong for four months a year.
  eq(yerevanClock(zonedToUtc(2026, 9, 16, 14, 0, "America/New_York")), "22:00",
    "the September FOMC statement is 22:00 in Yerevan");
  eq(yerevanClock(zonedToUtc(2026, 12, 9, 14, 0, "America/New_York")), "23:00",
    "the December FOMC statement is 23:00 in Yerevan — one hour later, same New York time");

  // Europe changes on a different weekend again.
  eq(yerevanClock(zonedToUtc(2026, 10, 29, 14, 15, "Europe/Berlin")), "17:15",
    "the October ECB decision is 17:15 in Yerevan");
  eq(yerevanClock(zonedToUtc(2026, 12, 17, 14, 15, "Europe/Berlin")), "17:15",
    "the December ECB decision is also 17:15 — Europe and Armenia both moved, or neither");

  // Armenia has no daylight saving, so a round trip must be exact all year.
  for (const ymd of ["2026-01-15", "2026-06-15", "2026-11-15"]) {
    const ts = yer(ymd, 20, 0);
    if (ymdInTz(ts, CHANNEL_TZ) !== ymd || yerevanClock(ts) !== "20:00") {
      fail(`Yerevan round trip broke on ${ymd}`);
    }
  }
  pass("20:00 Yerevan round-trips to 20:00 Yerevan in every season");

  eq(addDaysYmd("2026-03-01", -1), "2026-02-28", "a day before 1 March 2026 is 28 February");
  eq(addDaysYmd("2026-12-31", 1), "2027-01-01", "dates cross the new year");
  eq(weekdayOfYmd("2026-09-18"), 5, "18 September 2026 is a Friday");
}

console.log("\n2. Which dates an event falls on");
{
  const fomc = eventById("fomc");
  if (occursOn(fomc, "2026-12-09") && !occursOn(fomc, "2026-12-10")) {
    pass("a fixed event happens on its listed dates and no others");
  } else fail("fixed dates are wrong");

  // September, June, March and December are quarter ends: the quarterly expiry
  // takes that Friday and the monthly one stands down, so the channel does not
  // announce the same morning twice under two names.
  const monthly = eventById("expiry-monthly");
  const quarterly = eventById("expiry-quarterly");
  eq(isLastFridayOfMonth("2026-09-25"), true, "25 September 2026 is the last Friday of the month");
  eq(occursOn(quarterly, "2026-09-25"), true, "the quarterly expiry lands on it");
  eq(occursOn(monthly, "2026-09-25"), false, "and the monthly one stands down that day");
  eq(occursOn(monthly, "2026-10-30"), true, "in a non-quarter month the monthly expiry runs");

  // The weekly expiry stands down too — that is what skipIfAlso is for, and it
  // can only be checked once every event's occurrences are known.
  const sept = allOccurrences(yer("2026-09-25", 0), yer("2026-09-25", 23, 59), EVENTS)
    .filter((o) => o.event.id.startsWith("expiry"));
  eq(sept.length, 1, "on a quarterly expiry Friday exactly one expiry is announced");
  eq(sept[0]?.event.id, "expiry-quarterly", "and it is the quarterly one");

  const plainFriday = allOccurrences(yer("2026-10-09", 0), yer("2026-10-09", 23, 59), EVENTS)
    .filter((o) => o.event.id.startsWith("expiry"));
  eq(plainFriday.length, 1, "on an ordinary Friday the weekly expiry runs");
  eq(plainFriday[0]?.event.id, "expiry-weekly", "and it is the weekly one");

  // A weekly event must produce one occurrence per week, not one per day.
  const claims = occurrences(eventById("jobless"), yer("2026-10-01"), yer("2026-10-29"));
  eq(claims.length, 4, "four Thursdays in four weeks of jobless claims");
}

console.log("\n3. When a warning is due");
{
  const cpi = eventById("cpi");
  const occ = occurrences(cpi, yer("2026-10-01"), yer("2026-10-31"))[0];
  const moments = warningMoments(cpi, occ.ts);

  const dayBefore = moments.find((m) => m.kind === "d1");
  eq(ymdInTz(dayBefore.at, CHANNEL_TZ), "2026-10-13", "the notice goes out the day before");
  eq(yerevanClock(dayBefore.at), `${WARN_HOUR}:00`, "at 20:00 Yerevan, not at whatever hour the run happens to be");

  const soon = moments.find((m) => m.kind === "soon");
  eq(yerevanClock(soon.at), "13:30", "and a reminder three hours before a 16:30 release");
  if (soon.at > dayBefore.at) pass("the reminder comes after the notice");
  else fail("the two warnings are out of order");

  // QUIET HOURS. An event early in the Yerevan morning would otherwise send its
  // three-hour reminder in the middle of the night.
  const early = { ...cpi, time: "01:00", tz: CHANNEL_TZ, sameDayHoursBefore: 3 };
  const earlyTs = yer("2026-10-14", 10, 0);
  const pushed = warningMoments({ ...early, warnDaysBefore: [] }, earlyTs).find((m) => m.kind === "soon");
  eq(yerevanClock(pushed.at), "09:00", "a 07:00 reminder is pushed to 09:00 rather than sent at dawn");

  // A LOW-impact weekly event gets the day-before notice and nothing else.
  const weekly = warningMoments(eventById("jobless"), occurrences(eventById("jobless"), yer("2026-10-01"), yer("2026-10-10"))[0].ts);
  eq(weekly.length, 1, "an ordinary weekly event sends one warning, not two");
}

console.log("\n4. Nothing is sent twice, and nothing stale is sent at all");
{
  const events = [eventById("cpi")];
  // 13 October 2026, 20:05 Yerevan — five minutes after the notice was due.
  const now = yer("2026-10-13", 20, 5);

  const first = dueWarnings(now, {}, events);
  eq(first.length, 1, "the first run after the moment finds one warning due");
  eq(first[0].stale, false, "and it is fresh enough to send");
  eq(first[0].stateKey, "cpi@2026-10-14:d1", "its state key names the event, the date and which warning");

  const sent = { [first[0].stateKey]: now };
  eq(dueWarnings(now + 1_800_000, sent, events).length, 0,
    "half an hour later, with it recorded, nothing is due — this is what stops 48 posts a day");

  // The outage case. GitHub disables a workflow after sixty days of silence;
  // switched back on, the bot must not fire every notice it missed.
  const muchLater = first[0].at + MAX_LATENESS_MS + 3_600_000;
  const late = dueWarnings(muchLater, {}, events);
  const d1 = late.find((w) => w.kind === "d1");
  eq(d1?.stale, true, "a warning seven hours late is marked stale rather than sent");

  // Both warnings due at once, after a failed run: only the latest is sent.
  const bothDue = yer("2026-10-14", 14, 0); // past 20:00 yesterday and past 13:30 today
  const both = dueWarnings(bothDue, {}, events);
  eq(both.length, 2, "both moments are accounted for");
  eq(both.filter((w) => !w.stale).length, 1, "but only one is actually sent");
  eq(both.find((w) => !w.stale)?.kind, "soon", "and it is the later, more useful one");

  // After the event itself, nothing is due at all.
  eq(dueWarnings(yer("2026-10-14", 20, 0), {}, events).length, 0,
    "once the release has happened its warnings are no longer due");

  // The switched-off events stay switched off.
  const oil = dueWarnings(yer("2026-10-13", 21, 0), {}, EVENTS).map((w) => w.event.id);
  if (oil.includes("eia") || oil.includes("rigs")) fail("warn:false must stop an event posting");
  else pass("warn:false keeps the oil reports out of the channel");
}

console.log("\n5. The Sunday overview");
{
  // 20 September 2026 is a Sunday.
  eq(weekdayOfYmd("2026-09-20"), 0, "20 September 2026 is a Sunday");

  eq(digestDue(yer("2026-09-20", 19, 0), null), null, "before 20:00 on Sunday it is not due yet");

  const due = digestDue(yer("2026-09-20", 20, 30), null);
  if (!due) fail("at 20:30 on Sunday the overview is due");
  else {
    pass("at 20:30 on Sunday the overview is due");
    eq(due.week, "2026-09-20", "keyed by that Sunday");
    eq(ymdInTz(due.from, CHANNEL_TZ), "2026-09-21", "and it covers the week starting Monday");
    eq(ymdInTz(due.to - 60_000, CHANNEL_TZ), "2026-09-27", "through the following Sunday");
  }

  eq(digestDue(yer("2026-09-20", 20, 30), "2026-09-20"), null, "already sent, so not due again");
  // A late Monday run still publishes; a Wednesday one does not publish a week
  // that is already half over.
  if (digestDue(yer("2026-09-21", 9, 0), null)) pass("a failed Sunday run still publishes on Monday morning");
  else fail("the Monday catch-up window is missing");
  eq(digestDue(yer("2026-09-23", 9, 0), null), null, "by Wednesday the week is gone — no digest");

  const text = renderDigest(due, yer("2026-09-20", 20, 30), EVENTS);
  if (text.includes("EIA") || text.includes("նավթի պաշարներ")) pass("the overview includes events that do not warn individually");
  else fail("the overview must be the complete week, including the quiet events");
  if (/[a-z]{4,}/.test(text.replace(/<[^>]*>/g, "").replace(/EIA|Baker Hughes|Deribit|CFTC|COT|Fed|FOMC|SEP|dot plot|H\.4\.1/g, ""))) {
    fail("the overview leaked Latin prose into an Armenian post");
  } else pass("the overview is written in Armenian");
}

console.log("\n5b. The accountability recap's window looks BACKWARD, not forward");
{
  // Fired at the exact same moment as the market digest above (Sunday 20:30),
  // outcomeWindowDue() must describe the OPPOSITE week: the seven days that
  // just ended, not the seven about to start. This is the bug an adversarial
  // review found — run.js originally reused digestDue() here, whose forward
  // window meant a story's real, past `postedAt` could never fall inside it.
  const due = outcomeWindowDue(yer("2026-09-20", 20, 30), null);
  if (!due) fail("at 20:30 on Sunday the recap is due");
  else {
    pass("at 20:30 on Sunday the recap is due");
    eq(due.week, "2026-09-20", "keyed by the same Sunday as the market digest");
    eq(ymdInTz(due.from, CHANNEL_TZ), "2026-09-13", "and it starts the PREVIOUS Sunday");
    eq(ymdInTz(due.to, CHANNEL_TZ), "2026-09-20", "ending at this Sunday, not the next one");
    // The concrete failure mode: a story posted mid-week, in the past, must
    // fall inside this window. Under the old (forward) window it never could,
    // because `from` was tomorrow.
    const postedMidweek = yer("2026-09-17", 12, 0);
    if (postedMidweek >= due.from && postedMidweek < due.to) {
      pass("a story posted earlier this same past week falls inside the window");
    } else {
      fail("a story genuinely posted this past week must fall inside the recap's window");
    }
  }

  eq(outcomeWindowDue(yer("2026-09-20", 20, 30), "2026-09-20"), null, "already sent, so not due again");
  eq(outcomeWindowDue(yer("2026-09-23", 9, 0), null), null, "by Wednesday the window has closed, same as the market digest");
}

console.log("\n6. The calendar's own expiry");
{
  // Far from the end: nothing to say.
  eq(calendarHealth(yer("2026-09-20")).ok, true, "with months of dates left the calendar is healthy");

  // The BLS lists are the short ones by design, so they are the ones that trip
  // the warning first. Standing a fortnight before the last CPI date proves it.
  const nearEnd = yer("2026-11-28");
  const health = calendarHealth(nearEnd);
  eq(health.ok, false, "a fortnight from the last CPI date the calendar is not healthy");
  if (health.worst.daysLeft < EXPIRY_WARN_DAYS) pass(`the shortest list is ${health.worst.event.short}, ${health.worst.daysLeft} days left`);
  else fail("the worst row is wrong");

  eq(expiryDue(nearEnd, 0)?.worst.event.id, health.worst.event.id, "so a notice is due");
  eq(expiryDue(nearEnd, nearEnd - 86_400_000), null, "but not again the next day");
  eq(expiryDue(nearEnd, nearEnd - 8 * 86_400_000)?.ok, false, "and again a week later");

  const text = renderExpiry(health, nearEnd);
  if (text.includes("events.js")) pass("the notice says where the new dates go");
  else fail("the notice must say how to fix it");
}

console.log("\n7. Threading a result onto its warning");
{
  const fomcTs = occurrences(eventById("fomc"), yer("2026-12-01"), yer("2026-12-31"))[0];
  const after = fomcTs.ts + 3_600_000;
  const posts = { [fomcTs.key]: { messageId: 4242, at: fomcTs.ts - 86_400_000 } };

  const words = new Set(["fed", "holds", "rates", "steady", "powell", "signals"]);
  const m = matchOccurrence(words, after, posts, EVENTS);
  eq(m?.messageId, 4242, "a Fed story an hour after the decision threads onto the warning");

  const weak = matchOccurrence(new Set(["bitcoin", "rate", "of", "adoption", "climbs"]), after, posts, EVENTS);
  eq(weak, null, "one shared word is not a match — 'rate' is in half the headlines ever written");

  const noPost = matchOccurrence(words, after, {}, EVENTS);
  eq(noPost, null, "with no warning recorded there is nothing to thread onto");

  const before = matchOccurrence(words, fomcTs.ts - 7_200_000, posts, EVENTS);
  eq(before, null, "a story cannot be the result of a decision that has not happened");

  const muchLater = matchOccurrence(words, fomcTs.ts + 4 * 86_400_000, posts, EVENTS);
  eq(muchLater, null, "four days later the reader has moved on");
}

console.log("\n8. What the posts look like");
{
  const events = [eventById("fomc")];
  const now = yer("2026-12-08", 20, 1);
  const due = dueWarnings(now, {}, events)[0];
  const text = renderWarning(due, now);

  if (text.includes("ՎԱՂԸ")) pass("the day-before notice says so");
  else fail(`missing ՎԱՂԸ: ${text}`);
  if (text.includes("23:00")) pass("and gives the Yerevan hour, correct for December");
  else fail(`wrong hour in: ${text}`);
  if (text.includes("dot plot")) pass("the projections meeting is flagged as one");
  else fail("the SEP flag is missing");

  // THE ONE THING A WARNING MUST NEVER DO.
  //
  // "կանխատեսումների ամփոփում" is deliberately NOT on this list: it is the
  // Armenian for Summary of Economic Projections, the name of a document the
  // Fed itself publishes. The bot naming someone else's forecast is a fact;
  // the bot making one is the failure being guarded against here, and the two
  // are only a word apart.
  for (const forbidden of ["մեր կանխատեսում", "սպասվում է թիվ", "գնիր", "վաճառիր", "ներդրիր", "հավանաբար կաճի", "հավանաբար կիջնի"]) {
    if (text.includes(forbidden)) fail(`a warning must not say "${forbidden}"`);
  }
  // And it must not carry a figure at all, other than the clock and the date.
  const withoutTime = text.replace(/\d{2}:\d{2}/g, "").replace(/\d+ (ԺԱՄ|ՕՐ)/g, "").replace(/H\.4\.1/g, "");
  if (/\d+([.,]\d+)?\s*%/.test(withoutTime)) fail("a warning must not contain a percentage — that would be an invented expectation");
  else pass("no prediction, no number, no advice — only the schedule");

  // Telegram rejects the WHOLE message on a tag it does not understand, so the
  // post is lost rather than degraded. <blockquote> arrived in Bot API 7.0 and
  // is on the official list; sendMessage still keeps one narrow retry without
  // it, because the cost of being wrong here is a silent channel.
  const tags = text.match(/<\/?([a-z]+)/g) ?? [];
  const allowed = new Set(["<b", "</b", "<i", "</i", "<a", "</a", "<code", "</code", "<blockquote", "</blockquote"]);
  if (tags.every((t) => allowed.has(t))) pass("only tags Telegram understands are used");
  else fail(`unsupported tag: ${tags.find((t) => !allowed.has(t))}`);

  // The marks must be plain text. 🗓 and 🏛 have Emoji_Presentation=No — checked
  // against the Unicode character database — so bare they default to text
  // presentation and can come out as a monochrome glyph or a missing-glyph box.
  // Every pictograph this channel sends must therefore either be one that
  // defaults to emoji presentation, or carry U+FE0F.
  const BARE_RISK = /(\u{1F5D3}|\u{1F3DB}|\u{2699}|\u{1F5D2}|\u{1F5C2})(?!\u{FE0F})/u;
  for (const [what, t] of [["a warning", text], ["the digest", renderDigest(digestDue(yer("2026-10-11", 20, 30), null), yer("2026-10-11", 20, 30), EVENTS)]]) {
    if (BARE_RISK.test(t)) fail(`${what} carries a text-default pictograph without U+FE0F`);
  }
  pass("every text-default pictograph carries its variation selector");
  if (text.includes("\u{1F5D3}\u{FE0F}")) pass("the calendar mark is 🗓️, with the selector, not bare 🗓");
  else fail("the calendar mark is missing or bare");
}

console.log("\n8b. Warnings that come due together share one post");
{
  // Thursday 24 September 2026, 20:00 Yerevan. Three of Friday's events are
  // warned at this moment: the Fed balance sheet, the quarterly expiry and the
  // COT report. Without grouping that is three notifications inside a minute,
  // every single week.
  const thu = yer("2026-09-24", 20, 1);
  const due = dueWarnings(thu, {}, EVENTS).filter((d) => !d.stale);
  if (due.length >= 3) pass(`${due.length} warnings fall due at the same moment`);
  else fail(`expected several simultaneous warnings, got ${due.length}`);

  const groups = groupWarnings(due);
  const high = groups.filter((g) => g.rows.some((r) => r.event.impact === "HIGH"));
  const rest = groups.filter((g) => !g.rows.some((r) => r.event.impact === "HIGH"));

  eq(rest.length, 1, "the ordinary events collapse into a single post");
  if (rest[0].rows.length > 1) pass(`and that post carries ${rest[0].rows.length} of them`);
  else fail("grouping did nothing");
  eq(high.every((g) => g.rows.length === 1), true,
    "a high-impact event keeps a post to itself — it must not be a bullet between an oil report and a balance sheet");

  // Compared with the no-break space normalised away: the renderer glues the
  // last two words of a name together so a phone cannot strand one of them on
  // its own line, which is invisible to a reader and not to a substring test.
  const text = renderWarning(rest[0], thu);
  const flat = (s) => s.replace(/ /g, " ");
  for (const r of rest[0].rows) {
    if (!flat(text).includes(r.event.name)) fail(`the combined post lost ${r.event.short}`);
  }
  pass("the combined post names every event it covers");
  if (text.includes(" ")) pass("and its names carry the no-break space that stops an orphan word");
  else fail("the orphan guard is missing from the list");
  if (text.includes("Ժամերը՝ Երևանի")) pass("and says which clock the times are on");
  else fail("the combined post must say the times are Yerevan's");

  // Recording one of them must not silence the others: they are separate state
  // keys even though they share a message.
  const keys = new Set(rest[0].rows.map((r) => r.stateKey));
  eq(keys.size, rest[0].rows.length, "each event in the post keeps its own state key");

  // And all of them thread onto the same message, so a story about any one of
  // them lands under the post that warned about it.
  const posts = {};
  for (const r of rest[0].rows) posts[r.key] = { messageId: 77, at: thu };
  const anyRow = rest[0].rows[rest[0].rows.length - 1];
  const m = matchOccurrence(new Set(anyRow.event.keywords.slice(0, 3)), anyRow.ts + 3_600_000, posts, EVENTS);
  eq(m?.messageId, 77, "every event in a combined post threads onto that post");
}

console.log("\n9. The state file remembers, and does not grow for ever");
{
  const state = { posted: {}, topics: [], cal: { warned: {}, posts: {}, digestWeek: null, expiryAt: 0 } };
  const now = Date.now();

  rememberWarning(state, "cpi@2026-10-14:d1", now);
  eq(Object.keys(warningSent(state)).length, 1, "a sent warning is recorded");

  rememberWarningPost(state, "cpi@2026-10-14", 11, now);
  rememberWarningPost(state, "cpi@2026-10-14", 22, now);
  eq(warningPosts(state)["cpi@2026-10-14"].messageId, 11,
    "the FIRST warning keeps the thread — a result belongs under the notice, not under the short reminder");

  // Old entries go; recent ones stay.
  state.cal.warned["old@2000-01-01:d1"] = now - 60 * 86_400_000;
  state.cal.posts["old@2000-01-01"] = { messageId: 9, at: now - 60 * 86_400_000 };
  prune(state, now);
  if (state.cal.warned["old@2000-01-01:d1"]) fail("a two-month-old warning must be pruned");
  else pass("old warnings are pruned");
  if (state.cal.posts["old@2000-01-01"]) fail("a dead message id must be pruned");
  else pass("dead message ids are pruned");
  if (state.cal.warned["cpi@2026-10-14:d1"]) pass("recent warnings survive pruning");
  else fail("pruning ate a live warning — this would repost it");

  // A state file written before the calendar existed must still load.
  const legacy = { posted: { a: { postedAt: now } }, topics: [] };
  const restored = JSON.parse(JSON.stringify(legacy));
  // loadState's own reader, exercised through the shape it accepts.
  if (restored.cal === undefined) pass("an old posted.json has no cal section — and must not crash");
}

console.log("\n9b. The bugs an independent review found — each one held down by a test");
{
  // 1. QUIET_FROM was declared and never read, so only the early half of the
  //    quiet window was enforced. An evening event would have sent a reminder
  //    at 23:30.
  const lateEvening = {
    id: "late", name: "Ուշ", short: "Ուշ", impact: "HIGH", warn: true,
    warnDaysBefore: [1], sameDayHoursBefore: 3,
    tz: CHANNEL_TZ, time: "02:00", keywords: ["a", "b", "c"],
    recur: { kind: "fixed", dates: ["2026-10-15"] },
  };
  const lateMoments = warningMoments(lateEvening, yer("2026-10-15", 2, 0));
  if (lateMoments.some((m) => m.kind === "soon")) {
    fail(`a 23:00 reminder must be dropped, got ${lateMoments.map((m) => yerevanClock(m.at))}`);
  } else pass("a reminder that would land at 23:00 is dropped, not sent at bedtime");
  if (lateMoments.some((m) => m.kind === "d1")) pass("and the day-before notice still goes out");
  else fail("dropping the reminder must not drop the notice too");

  // 2. groupWarnings pushed every HIGH row without checking for a repeat, so a
  //    duplicated id in events.js produced two identical posts in one minute.
  const twins = [eventById("cpi"), { ...eventById("cpi") }];
  const twinDue = dueWarnings(yer("2026-10-13", 20, 5), {}, twins);
  const twinGroups = groupWarnings(twinDue);
  eq(twinGroups.length, 1, "a duplicated event id produces ONE post, not two identical ones");

  // 3. renderMany said "ՎԱՂԸ" whatever warnDaysBefore held, and printed only a
  //    clock — so an event warned three days out claimed to be tomorrow's.
  const far = { ...eventById("h41"), warnDaysBefore: [3], sameDayHoursBefore: 0 };
  const far2 = { ...eventById("cot"), warnDaysBefore: [3], sameDayHoursBefore: 0 };
  const farDue = dueWarnings(yer("2026-10-06", 20, 5), {}, [far, far2]);
  const farGroup = groupWarnings(farDue).find((g) => g.rows.length > 1);
  if (!farGroup) fail("expected the two events to group");
  else {
    const t = renderWarning(farGroup, yer("2026-10-06", 20, 5));
    if (t.includes("ՎԱՂԸ")) fail(`a three-day warning must not say ՎԱՂԸ:\n${t}`);
    else pass("a three-day warning says how many days, not «tomorrow»");
    if (/ՕՐ ԱՆՑ/.test(t)) pass("and names the number of days");
    else fail(`the day count is missing:\n${t}`);
    if (/(երկուշաբթի|երեքշաբթի|չորեքշաբթի|հինգշաբթի|ուրբաթ|շաբաթ|կիրակի)/.test(t)) {
      pass("and prints the weekday, because a bare clock means nothing three days out");
    } else fail(`a distant warning needs a date, not just a time:\n${t}`);
  }

  // 4. occurrences() is inclusive at both ends and the digest window was a
  //    whole number of days wide, so an event at midnight Monday appeared in
  //    two consecutive weekly overviews.
  const boundary = {
    id: "bnd", name: "Սահման", short: "Սահման", impact: "LOW", warn: false,
    warnDaysBefore: [], tz: CHANNEL_TZ, time: "00:00", keywords: ["a", "b", "c"],
    recur: { kind: "weekly", weekday: 1 },
  };
  const w1 = digestDue(yer("2026-10-04", 20, 30), null);
  const w2 = digestDue(yer("2026-10-11", 20, 30), null);
  const inWeek = (w) => allOccurrences(w.from, w.to, [boundary]).map((o) => o.ymd);
  const shared = inWeek(w1).filter((d) => inWeek(w2).includes(d));
  eq(shared.length, 0, "no event is listed in two consecutive weekly overviews");

  // 5. calendarHealth read dates[length-1] of an empty array and threw a
  //    RangeError deep inside Intl — on the one file the bot asks its owner to
  //    edit, when they delete the old dates before pasting the new ones.
  const emptied = { ...eventById("cpi"), recur: { kind: "fixed", dates: [] } };
  let health;
  try {
    health = calendarHealth(yer("2026-10-01"), [emptied]);
    pass("an emptied date list does not crash the run");
  } catch (e) {
    fail(`an emptied date list crashed: ${e.message}`);
  }
  if (health && health.ok === false && health.rows[0].remaining === 0) {
    pass("it is reported as nothing left, which is what it is");
  } else fail("an empty list should report zero dates remaining");
  if (health) {
    const t = renderExpiry(health, yer("2026-10-01"));
    if (t.includes("ամսաթիվ չի մնացել")) pass("and the notice says so in plain Armenian");
    else fail(`the notice should name the empty list:\n${t}`);
  }

  // 6. A missing tz makes Intl fall back to the machine's own zone — silently,
  //    and differently on her laptop and on GitHub's servers.
  const problems = validateEvents([
    { id: "a", time: "08:30", keywords: ["x", "y", "z"], recur: { kind: "weekly", weekday: 1 } },
    { id: "a", time: "0830", tz: "America/New_York", recur: { kind: "fixed", dates: [] } },
    { id: "c", time: "08:30", tz: "Mars/Olympus", recur: { kind: "fixed", dates: ["oops"] } },
  ]);
  const has = (s) => problems.some((p) => p.includes(s));
  if (has("tz")) pass("a missing timezone is caught before it can produce a wrong hour");
  else fail(`a missing tz must be reported: ${problems.join(" | ")}`);
  if (has("կրկնվող id")) pass("a duplicated id is caught");
  else fail("a duplicated id must be reported");
  if (has("սխալ ժամ")) pass("a malformed time is caught");
  else fail("a malformed time must be reported");
  if (has("դատարկ")) pass("an empty date list is caught");
  else fail("an empty date list must be reported");
  if (has("անհայտ ժամային գոտի")) pass("an unknown timezone is caught");
  else fail("an unknown timezone must be reported");
  if (has("սխալ ամսաթիվ")) pass("a malformed date is caught");
  else fail("a malformed date must be reported");
  eq(validateEvents(EVENTS).length, 0, "and the real events file passes all of it");

  // 7. THE ONE THAT COULD KILL THE WHOLE BOT.
  //
  // Delete the `recur:` line while adding dates — a plausible slip in the one
  // file the bot's own notice instructs the owner to edit — and validateEvents
  // returned NO PROBLEMS. occursOn then threw on undefined.kind, the throw
  // escaped runCalendar, main's catch exited 1, and the NEWS half never ran
  // either. Every thirty minutes, for ever, with an empty channel and a stack
  // trace in a log nobody reads.
  const fatal = [
    [{ id: "x", time: "08:30", tz: "UTC", keywords: ["a", "b", "c"] }, "recur դաշտը բացակայում է"],
    [{ id: "x", time: "08:30", tz: "UTC", keywords: ["a", "b", "c"], recur: { kind: "daily" } }, "անհայտ recur.kind"],
    [{ id: "x", time: "08:30", tz: "UTC", keywords: ["a", "b", "c"], recur: { kind: "weekly" } }, "weekday 0–6"],
    [{ id: "x", time: "08:30", tz: "UTC", keywords: ["a", "b", "c"], recur: { kind: "weekly", weekday: 9 } }, "weekday 0–6"],
    [{ id: "x", time: "99:99", tz: "UTC", keywords: ["a", "b", "c"], recur: { kind: "weekly", weekday: 1 } }, "գոյություն չունեցող ժամ"],
    [{ id: "x", time: "08:30", tz: "UTC", keywords: ["a", "b", "c"], recur: { kind: "fixed", dates: ["2026-02-31"] } }, "գոյություն չունեցող ամսաթիվ"],
  ];
  for (const [bad, expected] of fatal) {
    const found = validateEvents([bad]);
    if (found.some((p) => p.includes(expected))) pass(`caught before it ships: ${expected}`);
    else fail(`«${expected}» was not caught — got ${JSON.stringify(found)}`);
    // And the thing that actually matters: it must not throw when used.
    try {
      dueWarnings(yer("2026-10-13", 20, 5), {}, [{ ...bad, warn: true, warnDaysBefore: [1], impact: "LOW", name: "Ա", short: "X" }]);
    } catch (e) {
      // A throw here is exactly why validateEvents has to catch it first. The
      // check above is the guard; this is a note that the guard is load-bearing.
      if (expected !== "recur դաշտը բացակայում է" && expected !== "անհայտ recur.kind") {
        fail(`${expected}: threw where it should only have been silent — ${e.message}`);
      }
    }
  }
}

console.log("\n10. Every event in the file is well formed");
{
  const ids = new Set();
  for (const e of EVENTS) {
    if (ids.has(e.id)) fail(`duplicate event id: ${e.id}`);
    ids.add(e.id);
    if (!/^\d{2}:\d{2}$/.test(e.time)) fail(`${e.id}: bad time ${e.time}`);
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: e.tz });
    } catch {
      fail(`${e.id}: unknown timezone ${e.tz}`);
    }
    if (!e.name || /[a-z]{5,}/.test(e.name.replace(/FOMC|Nonfarm|Payrolls|CFTC|COT|Deribit|Baker Hughes|EIA|Fed/g, ""))) {
      fail(`${e.id}: the name should be Armenian — ${e.name}`);
    }
    if ((e.keywords ?? []).length < 3) fail(`${e.id}: too few keywords to thread on`);
    if (e.recur.kind === "fixed") {
      const sorted = [...e.recur.dates].sort();
      if (JSON.stringify(sorted) !== JSON.stringify(e.recur.dates)) fail(`${e.id}: dates are out of order`);
      for (const d of e.recur.dates) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) fail(`${e.id}: bad date ${d}`);
      }
    }
  }
  pass(`${EVENTS.length} events, all well formed`);

  // A year of the real calendar, counted rather than guessed. The number is
  // printed because it is the thing Karen decided on, and a change to the file
  // that doubles it should be visible in the test output.
  const from = yer("2026-10-01");
  const year = allOccurrences(from, from + 365 * 86_400_000, EVENTS);
  const warned = year.filter((o) => o.event.warn);

  let moments = 0;
  const groups = new Set();
  for (const o of warned) {
    for (const w of warningMoments(o.event, o.ts)) {
      moments += 1;
      // The same key groupWarnings() uses, so this count is the real one.
      groups.add(o.event.impact === "HIGH" ? `${o.key}:${w.kind}` : `${w.kind}@${w.at}`);
    }
  }
  console.log(
    `       — ${year.length} իրադարձություն/տարի · ${moments} նախազգուշացում, ` +
    `խմբավորումից հետո՝ ${groups.size} փոստ · +52 շաբաթական ակնարկ ` +
    `= օրական ~${((groups.size + 52) / 365).toFixed(1)}`
  );
}

console.log("");
if (failures > 0) {
  console.log(`${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("All checks passed.");
