// THE CALENDAR'S LOGIC. No network, no AI, no state of its own.
//
// Every function here is pure: give it a moment in time and it says what should
// have been posted by then. That is what makes it testable — the tests can set
// the clock to the night before an FOMC meeting, or to the Sunday of a week
// containing a quarterly expiry, and check the answer exactly.
//
// THE THREE THINGS IT DECIDES
//
//   1. WARNINGS.  One per event occurrence, a day before, plus a three-hour
//      reminder for the high-impact ones. Karen chose "every event gets its
//      own warning", knowing the volume, so that is what this does — the only
//      restraint is the `warn` switch in events.js and the quiet hours below.
//
//   2. THE WEEKLY OVERVIEW.  Sunday evening, the whole week in one post,
//      including the events that do not warn individually.
//
//   3. ITS OWN EXPIRY.  BLS publishes its dates a year at a time. When the
//      shortest list drops under a month, the bot says so rather than quietly
//      reaching the end and going silent.
//
// WHY NOTHING HERE IS WRITTEN IN UTC OFFSETS
//
//   Offsets are the bug. The United States moves its clocks on one weekend,
//   Europe on another, Armenia never. An FOMC statement is 14:00 in New York
//   all year — it is 22:00 in Yerevan in summer and 23:00 in winter, and any
//   arithmetic that assumes one of those is wrong for four months. Every
//   conversion below goes through Node's own timezone database, which knows.

import { EVENTS, CHANNEL_TZ, IMPACT } from "./events.js";
import { band } from "./telegram.js";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** The hour in Yerevan at which a day-before warning goes out. */
export const WARN_HOUR = 20;

/** Nothing is posted between these Yerevan hours. A 04:00 notification is a bug. */
export const QUIET_FROM = 23;
export const QUIET_UNTIL = 9;

/**
 * A warning this far past its moment is not sent, only recorded.
 *
 * GitHub disables a scheduled workflow after sixty days of repository
 * inactivity. If that ever happens and the bot is switched back on, without
 * this it would immediately fire every warning it missed — a wall of posts
 * about events that have already happened. Six hours is generous enough to
 * absorb GitHub's usual 5–20 minute cron delay and a failed run or two.
 */
export const MAX_LATENESS_MS = 6 * HOUR_MS;

/** How long after an event a news story can still be threaded onto its warning. */
export const THREAD_WINDOW_MS = 36 * HOUR_MS;

/** Below this many days of dates left, the bot warns its owner. */
export const EXPIRY_WARN_DAYS = 30;

/** And it repeats that warning no more often than this. */
export const EXPIRY_REPEAT_MS = 7 * DAY_MS;

// ── time ───────────────────────────────────────────────────────────────────

const MONTHS_HY = [
  "հունվարի", "փետրվարի", "մարտի", "ապրիլի", "մայիսի", "հունիսի",
  "հուլիսի", "օգոստոսի", "սեպտեմբերի", "հոկտեմբերի", "նոյեմբերի", "դեկտեմբերի",
];

const WEEKDAYS_HY = [
  "կիրակի", "երկուշաբթի", "երեքշաբթի", "չորեքշաբթի", "հինգշաբթի", "ուրբաթ", "շաբաթ",
];

// Written out rather than taken from Intl. A Node build with a trimmed ICU
// returns English month names and no error, which would put "September" in the
// middle of an Armenian sentence and look like nobody had checked.

/** What the wall clock in `tz` reads at instant `ts`. */
export function partsInTz(ts, tz) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    weekday: "short",
  });
  const p = Object.fromEntries(fmt.formatToParts(ts).map((x) => [x.type, x.value]));
  // Intl with hour12:false can report midnight as hour "24" on some platforms.
  const hh = Number(p.hour) % 24;
  const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    y: Number(p.year), m: Number(p.month), d: Number(p.day),
    hh, mm: Number(p.minute), ss: Number(p.second),
    weekday: WD[p.weekday],
  };
}

/** The zone's offset from UTC, in ms, at instant `ts`. */
export function tzOffsetMs(ts, tz) {
  const p = partsInTz(ts, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - Math.floor(ts / 1000) * 1000;
}

/**
 * The instant at which the clock in `tz` reads this local date and time.
 *
 * Two passes, not one. The first guess uses the offset at the wrong instant,
 * which is off by an hour whenever the guess lands on the other side of a
 * daylight-saving change; feeding that corrected instant back fixes it. A third
 * pass never changes anything, because offsets shift by at most an hour or two
 * and the second pass is already inside the right zone rule.
 */
export function zonedToUtc(y, m, d, hh, mm, tz) {
  const wall = Date.UTC(y, m - 1, d, hh, mm, 0);
  let ts = wall;
  for (let i = 0; i < 2; i += 1) ts = wall - tzOffsetMs(ts, tz);
  return ts;
}

export function ymdInTz(ts, tz) {
  const p = partsInTz(ts, tz);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

export function parseYmd(ymd) {
  const [y, m, d] = String(ymd).split("-").map(Number);
  return { y, m, d };
}

/** Day of week for a calendar date, 0 = Sunday. No timezone involved. */
export function weekdayOfYmd(ymd) {
  const { y, m, d } = parseYmd(ymd);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function addDaysYmd(ymd, n) {
  const { y, m, d } = parseYmd(ymd);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

export function isLastFridayOfMonth(ymd) {
  const { y, m, d } = parseYmd(ymd);
  return weekdayOfYmd(ymd) === 5 && d + 7 > daysInMonth(y, m);
}

export function isQuarterEndMonth(m) {
  return m === 3 || m === 6 || m === 9 || m === 12;
}

// ── occurrences ────────────────────────────────────────────────────────────

/** Does this event happen on this local calendar date? */
export function occursOn(event, ymd) {
  const r = event.recur;
  switch (r.kind) {
    case "fixed":
      return r.dates.includes(ymd);
    case "weekly":
      return weekdayOfYmd(ymd) === r.weekday;
    case "monthlyLastFriday":
      if (!isLastFridayOfMonth(ymd)) return false;
      // The quarterly expiry is the same Friday four times a year, and it is
      // its own event with its own weight. Without this the channel would call
      // the same morning both "monthly" and "quarterly".
      return r.exceptQuarterEnd ? !isQuarterEndMonth(parseYmd(ymd).m) : true;
    case "quarterlyLastFriday":
      return isLastFridayOfMonth(ymd) && isQuarterEndMonth(parseYmd(ymd).m);
    default:
      return false;
  }
}

/** A stable identity for one occurrence — the same string on every run. */
export function occurrenceKey(event, ymd) {
  return `${event.id}@${ymd}`;
}

/**
 * Every occurrence of one event between two instants.
 *
 * Walks calendar dates in the EVENT's own zone, which is the only frame in
 * which "the CPI is released on the 14th at 08:30" is a true statement. The
 * extra day at each end covers the case where a local date's 08:00 falls
 * outside the window but its 23:00 falls inside.
 */
export function occurrences(event, fromTs, toTs) {
  const out = [];
  let ymd = ymdInTz(fromTs - DAY_MS, event.tz);
  const last = ymdInTz(toTs + DAY_MS, event.tz);
  const [hh, mm] = String(event.time).split(":").map(Number);
  // The guard follows the window rather than being a fixed number, so asking
  // for three years of calendar returns three years instead of silently
  // stopping at whatever the constant happened to be.
  const maxSteps = Math.ceil((toTs - fromTs) / DAY_MS) + 4;
  let guard = 0;
  while (ymd <= last && guard < maxSteps) {
    guard += 1;
    if (occursOn(event, ymd)) {
      const { y, m, d } = parseYmd(ymd);
      const ts = zonedToUtc(y, m, d, hh, mm, event.tz);
      if (ts >= fromTs && ts <= toTs) out.push({ event, ymd, ts, key: occurrenceKey(event, ymd) });
    }
    ymd = addDaysYmd(ymd, 1);
  }
  return out;
}

/**
 * Every occurrence of every event in a window, in time order.
 *
 * `skipIfAlso` is applied here rather than in occursOn, because an event can
 * only know it is being overshadowed once the other events' occurrences are
 * known. The weekly Deribit expiry uses it: on the last Friday of a quarter it
 * steps aside, and the channel announces one expiry that morning instead of
 * three.
 */
export function allOccurrences(fromTs, toTs, events = EVENTS) {
  const all = [];
  for (const e of events) all.push(...occurrences(e, fromTs, toTs));

  const byDate = new Map();
  for (const o of all) {
    const k = `${o.ymd}`;
    if (!byDate.has(k)) byDate.set(k, new Set());
    byDate.get(k).add(o.event.id);
  }

  return all
    .filter((o) => {
      const also = o.event.skipIfAlso ?? [];
      const sameDay = byDate.get(o.ymd) ?? new Set();
      return !also.some((id) => sameDay.has(id));
    })
    .sort((a, b) => a.ts - b.ts);
}

// ── warnings ───────────────────────────────────────────────────────────────

/**
 * The moments at which an occurrence should be announced.
 *
 * Each has a `kind`, which is also its state key suffix: "d1" for the notice
 * the day before, "soon" for the three-hour reminder. Two kinds means a state
 * file that can tell "already warned yesterday" from "already reminded today",
 * which is what stops a restart double-posting one and not the other.
 */
export function warningMoments(event, occTs) {
  const out = [];
  const localYmd = ymdInTz(occTs, CHANNEL_TZ);

  for (const daysBefore of event.warnDaysBefore ?? []) {
    const ymd = addDaysYmd(localYmd, -daysBefore);
    const { y, m, d } = parseYmd(ymd);
    const at = zonedToUtc(y, m, d, WARN_HOUR, 0, CHANNEL_TZ);
    if (at < occTs) out.push({ kind: `d${daysBefore}`, at, daysBefore });
  }

  if (event.sameDayHoursBefore) {
    let at = occTs - event.sameDayHoursBefore * HOUR_MS;
    const p = partsInTz(at, CHANNEL_TZ);
    // BOTH ENDS OF THE QUIET WINDOW, not just the early one.
    //
    // QUIET_FROM was declared, exported, and never read — the constant said
    // "nothing is posted between 23:00 and 09:00" and only the 09:00 half was
    // enforced. Harmless for every event in the file today, and a 23:30
    // notification the first time anyone adds a late-evening one.
    //
    // Early morning is pushed FORWARD to 09:00, because a 09:00 reminder about
    // a 10:00 release is still useful. Late night is dropped: pushing it
    // forward would land after the event, and pushing it back to 23:00 would
    // be a notification at bedtime about something already covered by the
    // notice sent the day before.
    if (p.hh < QUIET_UNTIL) {
      at = zonedToUtc(p.y, p.m, p.d, QUIET_UNTIL, 0, CHANNEL_TZ);
    } else if (p.hh >= QUIET_FROM) {
      return out.sort((a, b) => a.at - b.at);
    }
    const dayBefore = out.length ? Math.max(...out.map((w) => w.at)) : -Infinity;
    // Skip if it would land before — or within an hour of — the day-before
    // notice. Two posts about the same event in the same hour is noise.
    if (at < occTs && at > dayBefore + HOUR_MS) out.push({ kind: "soon", at, hours: event.sameDayHoursBefore });
  }

  return out.sort((a, b) => a.at - b.at);
}

/**
 * What should have gone out by `now` and has not.
 *
 * `sent` is a plain object of state keys, so this function still knows nothing
 * about files. Each result carries `stale`: true means the moment is more than
 * six hours gone, and the caller should record it as handled WITHOUT posting.
 *
 * When several moments for one occurrence come due together — which happens
 * after a failed run or a long outage — only the latest is returned. The
 * earlier ones are returned as stale, so they are recorded and never fire.
 */
export function dueWarnings(now, sent = {}, events = EVENTS) {
  // HOW FAR AHEAD TO LOOK, DERIVED RATHER THAN GUESSED.
  //
  // This was a hard-coded six days, which is correct for the current file and
  // silently wrong the first time anyone writes `warnDaysBefore: [7]`: the
  // occurrence would fall outside the horizon, no warning would ever be found,
  // and nothing would say so. Reading the number out of the events themselves
  // means the horizon follows the file.
  const maxDaysBefore = Math.max(1, ...events.flatMap((e) => e.warnDaysBefore ?? [1]));
  const horizon = now + (maxDaysBefore + 2) * DAY_MS;
  const due = [];

  // THE FULL EVENT LIST, THEN FILTERED.
  //
  // Not `events.filter(e => e.warn)` passed in. `skipIfAlso` can only see the
  // events it is handed, so filtering first would hide a silent event from the
  // one standing aside for it — set expiry-monthly to warn:false and the weekly
  // expiry would start announcing the monthly expiry's own Friday. The filter
  // belongs after the overshadowing is resolved, not before.
  for (const o of allOccurrences(now, horizon, events)) {
    if (!o.event.warn) continue;
    const moments = warningMoments(o.event, o.ts).filter((w) => w.at <= now);
    if (moments.length === 0) continue;

    const pending = moments.filter((w) => !sent[`${o.key}:${w.kind}`]);
    if (pending.length === 0) continue;

    const latest = pending[pending.length - 1];
    for (const w of pending) {
      const isLatest = w === latest;
      const tooLate = now - w.at > MAX_LATENESS_MS;
      due.push({
        ...o,
        kind: w.kind,
        at: w.at,
        daysBefore: w.daysBefore,
        hours: w.hours,
        stateKey: `${o.key}:${w.kind}`,
        stale: !isLatest || tooLate,
      });
    }
  }

  return due.sort((a, b) => a.ts - b.ts);
}

/**
 * ONE MOMENT, ONE POST.
 *
 * Karen chose "every event gets its own warning", and this keeps that promise
 * while fixing the thing it produces by accident. Three of the weekly events
 * happen on Friday, so all three are warned at 20:00 on Thursday — and the
 * channel fires three notifications inside one minute, every week, for ever.
 * Nobody asked for that; it is a side effect of a rule, not a decision.
 *
 * So warnings that come due at the SAME MOMENT are sent as one post listing
 * them. The information is identical. The notification count is not.
 *
 * WITH ONE EXCEPTION, AND IT IS THE POINT OF THE WHOLE FEATURE
 *
 *   A high-impact event always gets a post to itself. Putting "US jobs report"
 *   in a bulleted list between an oil inventory and a balance sheet is how a
 *   reader learns to swipe the list away, and the jobs report is the one thing
 *   in it they would have wanted to see.
 */
export function groupWarnings(due) {
  const groups = [];
  const byMoment = new Map();
  // Two rows with the same state key are the same warning, and sending it
  // twice is the worst thing this file can do. It happens when events.js ends
  // up with two entries sharing an `id` — which is a copy-paste away, and the
  // copy-paste is exactly what the expiry notice asks the owner to perform.
  const seen = new Set();

  for (const row of due) {
    if (row.stale) continue;
    if (seen.has(row.stateKey)) continue;
    seen.add(row.stateKey);
    if (row.event.impact === IMPACT.HIGH) {
      groups.push({ kind: row.kind, at: row.at, rows: [row] });
      continue;
    }
    const k = `${row.kind}@${row.at}`;
    if (!byMoment.has(k)) {
      const g = { kind: row.kind, at: row.at, rows: [] };
      byMoment.set(k, g);
      groups.push(g);
    }
    byMoment.get(k).rows.push(row);
  }

  for (const g of groups) g.rows.sort((a, b) => a.ts - b.ts);
  return groups.sort((a, b) => a.at - b.at || a.rows[0].ts - b.rows[0].ts);
}

// ── the weekly overview ────────────────────────────────────────────────────

/**
 * The Sunday 20:00 Yerevan that opens the week containing `now`'s overview.
 *
 * Returns the most recent such moment at or before `now`.
 */
export function lastDigestMoment(now) {
  const p = partsInTz(now, CHANNEL_TZ);
  let ymd = `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
  // Back up to Sunday.
  let back = p.weekday;
  // If it is Sunday but before 20:00, the digest moment is LAST Sunday.
  if (p.weekday === 0 && p.hh < WARN_HOUR) back = 7;
  ymd = addDaysYmd(ymd, -back);
  const { y, m, d } = parseYmd(ymd);
  return { ts: zonedToUtc(y, m, d, WARN_HOUR, 0, CHANNEL_TZ), ymd };
}

/**
 * Is the weekly overview due, and what week does it cover?
 *
 * The window is fourteen hours wide: Sunday 20:00 through Monday morning. Wide
 * enough that a failed Sunday-night run still publishes, narrow enough that a
 * bot switched back on midweek does not post a digest for a week already half
 * over.
 */
export function digestDue(now, sentWeek = null) {
  const moment = lastDigestMoment(now);
  if (now - moment.ts > 14 * HOUR_MS) return null;
  if (sentWeek === moment.ymd) return null;
  // Monday 00:00 Yerevan, four hours after the post goes out.
  const start = moment.ts + 4 * HOUR_MS;
  // `to` is a millisecond SHORT of the next Monday, because occurrences() is
  // inclusive at both ends. At exactly `start + 7 days` an event landing on the
  // boundary — midnight Monday, which the Fed balance sheet is within an hour
  // of — would be listed in this week's digest and again in next week's.
  return { week: moment.ymd, from: start, to: start + 7 * DAY_MS - 1 };
}

// ── the calendar's own expiry ──────────────────────────────────────────────

/**
 * How much calendar is left.
 *
 * Only the `fixed` lists can run out. The expiries are computed from a rule and
 * are good for ever, which is exactly why they were written as a rule.
 */
/**
 * EVERY WAY events.js CAN BE WRONG, CHECKED BEFORE IT IS USED.
 *
 * The owner of this bot is asked, by the bot itself, to edit that file twice a
 * year. Most mistakes there announce themselves — a bad timezone string throws,
 * a bad date produces an obvious NaN. One does not: a MISSING `tz` makes
 * Intl fall back to the machine's own zone, silently, so the same event resolves
 * to 08:30 in one place and 04:30 in another. It would differ between a check
 * run on her laptop and the real run on GitHub's servers, which is the hardest
 * possible bug to be told about.
 *
 * Returns a list of Armenian sentences, empty when the file is sound.
 */
export function validateEvents(events = EVENTS) {
  const problems = [];
  const ids = new Set();

  for (const e of events) {
    const where = e?.id ?? "(առանց id)";
    if (!e?.id) problems.push("իրադարձություն առանց id-ի");
    else if (ids.has(e.id)) problems.push(`կրկնվող id՝ «${e.id}» — երկու անգամ կհրապարակվի`);
    else ids.add(e.id);

    // THE TIME, AND THE RANGE, not just the shape.
    //
    // «99:99» passed the pattern, and Date.UTC quietly rolls it over: an event
    // declared for Monday fired the following Friday at 04:39, silently and for
    // ever. A regex that only checks punctuation is not a check.
    const t = String(e?.time).match(/^(\d{1,2}):(\d{2})$/);
    if (!t) {
      problems.push(`${where}՝ սխալ ժամ «${e?.time}» — պետք է լինի ՕՕ:ՐՐ, օրինակ 08:30`);
    } else if (Number(t[1]) > 23 || Number(t[2]) > 59) {
      problems.push(`${where}՝ «${e.time}» գոյություն չունեցող ժամ է`);
    }

    // THE RECURRENCE RULE — the omission that could kill the whole bot.
    //
    // Delete the `recur:` line by accident while adding dates, and this
    // function returned NO PROBLEMS. occursOn then threw on `undefined.kind`,
    // the throw escaped runCalendar, and the catch in main exited 1 — so the
    // news half never ran either. Every thirty minutes, for ever, with nothing
    // in the channel and a stack trace in a log nobody reads.
    //
    // A typo in the kind, a weekly rule with no weekday, or a weekday of 9 were
    // all quieter and almost as bad: zero occurrences, for ever, with no
    // complaint — which is the "silence that looks like no events this week"
    // that events.js's own header calls the worst failure this project can have.
    const KINDS = new Set(["fixed", "weekly", "monthlyLastFriday", "quarterlyLastFriday"]);
    const r = e?.recur;
    if (!r || typeof r !== "object") {
      problems.push(`${where}՝ recur դաշտը բացակայում է — առանց դրա բոտը կփլուզվի`);
    } else if (!KINDS.has(r.kind)) {
      problems.push(`${where}՝ անհայտ recur.kind «${r.kind}» — թույլատրելի են՝ ${[...KINDS].join(", ")}`);
    } else if (r.kind === "weekly" && !(Number.isInteger(r.weekday) && r.weekday >= 0 && r.weekday <= 6)) {
      problems.push(`${where}՝ weekly կանոնը պահանջում է weekday 0–6 (0՝ կիրակի), կա՝ «${r.weekday}»`);
    }

    if (!e?.tz) problems.push(`${where}՝ tz դաշտը բացակայում է — ժամը կստացվի սխալ և ոչինչ չի բողոքի`);
    else {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: e.tz });
      } catch {
        problems.push(`${where}՝ անհայտ ժամային գոտի «${e.tz}»`);
      }
    }

    if (e?.recur?.kind === "fixed") {
      const dates = e.recur.dates;
      if (!Array.isArray(dates) || dates.length === 0) {
        problems.push(`${where}՝ ամսաթվերի ցուցակը դատարկ է`);
      } else {
        for (const d of dates) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d))) {
            problems.push(`${where}՝ սխալ ամսաթիվ «${d}»`);
            continue;
          }
          // A DATE THAT EXISTS. «2026-02-31» matched the pattern perfectly and
          // never came round, so the event silently never fired — while
          // calendarHealth reported it as sixty-one days of healthy runway.
          // Two silent failures stacked on one typo.
          const { y, m, dd } = { ...parseYmd(d), dd: parseYmd(d).d };
          const probe = new Date(Date.UTC(y, m - 1, dd));
          if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== dd) {
            problems.push(`${where}՝ «${d}» գոյություն չունեցող ամսաթիվ է`);
          }
        }
      }
    }
  }

  return problems;
}

export function calendarHealth(now, events = EVENTS) {
  const rows = [];
  for (const e of events) {
    if (e.recur.kind !== "fixed") continue;
    const dates = [...(e.recur.dates ?? [])].sort();
    // An emptied list is not a reason to crash — it is the most extreme version
    // of the very thing this function measures, so it is reported as zero days
    // left rather than throwing on `undefined`.
    if (dates.length === 0) {
      rows.push({ event: e, lastYmd: null, daysLeft: -1, remaining: 0 });
      continue;
    }
    const lastYmd = dates[dates.length - 1];
    const { y, m, d } = parseYmd(lastYmd);
    const [hh, mm] = String(e.time).split(":").map(Number);
    const lastTs = zonedToUtc(y, m, d, hh, mm, e.tz);
    const remaining = dates.filter((ymd) => {
      const p = parseYmd(ymd);
      return zonedToUtc(p.y, p.m, p.d, hh, mm, e.tz) >= now;
    }).length;
    rows.push({
      event: e,
      lastYmd,
      daysLeft: Math.floor((lastTs - now) / DAY_MS),
      remaining,
    });
  }
  rows.sort((a, b) => a.daysLeft - b.daysLeft);
  const worst = rows[0] ?? null;
  return { ok: !worst || worst.daysLeft >= EXPIRY_WARN_DAYS, worst, rows };
}

export function expiryDue(now, lastNoticeAt = 0, events = EVENTS) {
  const health = calendarHealth(now, events);
  if (health.ok) return null;
  if (now - (lastNoticeAt ?? 0) < EXPIRY_REPEAT_MS) return null;
  return health;
}

// ── threading news onto its warning ────────────────────────────────────────

/**
 * Which event, if any, is this news story the result of?
 *
 * Two keyword hits, not one. "rate" alone appears in half the crypto headlines
 * ever written; "fed" plus "rate" is an FOMC story. The occurrence also has to
 * be in the recent past — a CPI story cannot be the result of a CPI release
 * that has not happened yet, and thirty-six hours later the reader has moved on.
 */
export function matchOccurrence(words, now, posted = {}, events = EVENTS) {
  const window = allOccurrences(now - THREAD_WINDOW_MS, now, events);
  let best = null;
  for (const o of window) {
    const entry = posted[o.key];
    if (!entry?.messageId) continue;
    let hits = 0;
    for (const k of o.event.keywords ?? []) if (words.has(k)) hits += 1;
    if (hits < 2) continue;
    // Most keyword hits wins; the later event only breaks a TIE. Written as
    // `hits > best.hits || o.ts > best.o.ts` this read "or is more recent",
    // which let a two-word match on last night's jobless claims displace a
    // six-word match on the FOMC decision — threading a Fed story onto the
    // wrong warning.
    const better = !best || hits > best.hits || (hits === best.hits && o.ts > best.o.ts);
    if (better) best = { o, hits, messageId: entry.messageId };
  }
  return best ? { ...best.o, messageId: best.messageId, hits: best.hits } : null;
}

// ── presentation helpers ───────────────────────────────────────────────────

export function yerevanClock(ts) {
  const p = partsInTz(ts, CHANNEL_TZ);
  return `${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`;
}

/**
 * "14 հոկտեմբերի", or "8 դեկտեմբերի 2027" when the year is asked for.
 *
 * The year is opt-in rather than automatic because on a weekly overview it is
 * noise — nobody wonders which year next Thursday is in. It is not noise in the
 * expiry notice, where "8 դեկտեմբերի" for a 2027 date sat directly beneath
 * "10 դեկտեմբերի" for a 2026 one and read as the same fortnight.
 */
export function yerevanDate(ts, { withYear = false } = {}) {
  const p = partsInTz(ts, CHANNEL_TZ);
  const base = `${p.d} ${MONTHS_HY[p.m - 1]}`;
  return withYear ? `${base} ${p.y}` : base;
}

export function yerevanWeekday(ts) {
  return WEEKDAYS_HY[partsInTz(ts, CHANNEL_TZ).weekday];
}

/** "վաղը 22:00" / "այսօր 17:30" / "ուրբաթ, 25 սեպտեմբերի, 12:00" */
export function whenPhrase(ts, now) {
  const today = ymdInTz(now, CHANNEL_TZ);
  const day = ymdInTz(ts, CHANNEL_TZ);
  if (day === today) return `այսօր ${yerevanClock(ts)}`;
  if (day === addDaysYmd(today, 1)) return `վաղը ${yerevanClock(ts)}`;
  return `${yerevanWeekday(ts)}, ${yerevanDate(ts)}, ${yerevanClock(ts)}`;
}

/**
 * The same three marks the news posts use — deliberately the same function's
 * worth of meaning, so a reader learns one scale and it works in both halves of
 * the channel. ●●● on a news item and ●●● on a calendar entry are the same
 * promise: this is the kind you stop for.
 *
 * Plain text characters, not emoji. See the long note in telegram.js for why
 * the traffic light was wrong.
 */
export function impactMark(impact) {
  // ONE DEFINITION, NOT TWO. These three glyphs were typed out here and again
  // in telegram.js. Nothing breaks today; the day someone changes one of them
  // the news half and the calendar half are marked differently on the same
  // screen, and the whole point of the scale is that it means one thing.
  return band(impact);
}

export { IMPACT, CHANNEL_TZ, EVENTS };
