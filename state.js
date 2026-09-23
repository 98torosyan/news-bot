// WHAT HAS ALREADY BEEN POSTED.
//
// WHY A FILE IN THE REPOSITORY
//
//   Every GitHub Actions run starts on a clean machine with no memory of the
//   last one. Something has to carry "we already posted this" across runs, and
//   the options were a cache (which GitHub evicts without warning — and an
//   evicted cache means the channel reposts a day of news), an artifact
//   (awkward to read back), or a small file committed to the repo.
//
//   The file wins on a second count: GitHub disables scheduled workflows in a
//   repository that has seen no activity for sixty days. A bot that commits its
//   own memory keeps itself alive as a side effect of working.
//
//   It sits at the repository root rather than in a state/ folder because the
//   whole project is flat: GitHub's web uploader flattens dragged folders, and
//   a layout that survives the way the files actually get there is worth more
//   than a tidier one that has to be rebuilt by hand every time.
//
// WHAT IS STORED
//
//   A fingerprint per posted story and when it went out. Not the text — the
//   channel already has that, and a state file that grows without bound turns
//   every run into a large checkout.

import { readFile, writeFile, mkdir, rename } from "fs/promises";
import { dirname } from "path";
import { createHash } from "crypto";

export const STATE_PATH = "posted.json";

/** Long enough that a slow-moving story cannot come round again as "new". */
export const KEEP_DAYS = 10;

/**
 * A story's identity.
 *
 * Deliberately NOT the URL. The same story arrives under a different URL from
 * every outlet, and a URL-keyed memory would repost the same event ten times.
 * The key is the ranking's own notion of the story: its significant words, in
 * a fixed order.
 */
export function storyKey(words) {
  const sorted = Array.from(words).sort().join(" ");
  return createHash("sha1").update(sorted).digest("hex").slice(0, 16);
}

/**
 * How long a SUBJECT blocks another post about the same thing.
 *
 * Separate from KEEP_DAYS, which stops an identical story reposting. This is
 * the softer guard: the channel published "Crypto stocks slide after CLARITY
 * Act fails" at 01:06 and "CLARITY Act's odds of passing plunge" at 06:07. Two
 * genuinely different reports, five hours apart, and to a reader one subject
 * twice. The per-run diversity rule could not see it, because they were
 * different runs.
 *
 * Twelve hours, not days: a developing story deserves a follow-up eventually,
 * and blocking a subject for a week would silence the channel on whatever
 * actually matters that week.
 */
export const SUBJECT_COOLDOWN_MS = 12 * 3_600_000;

/**
 * THE CALENDAR'S CORNER OF THE STATE FILE.
 *
 *   warned      state key -> when it went out. Stops a warning repeating on the
 *               next run half an hour later, which is the whole reason this
 *               exists: the calendar is a pure function of the clock and would
 *               otherwise re-announce the same event forty-eight times.
 *   posts       occurrence key -> the Telegram message id of its warning, so a
 *               news story about the result can be sent as a reply to it.
 *   digestWeek  which Sunday's overview has already gone out.
 *   expiryAt    when the bot last said its own date list is running low.
 *
 * Kept in the same file as the posted stories rather than a second one: two
 * files mean two commits, two chances to conflict, and no benefit.
 */
function emptyCal() {
  return { warned: {}, posts: {}, digestWeek: null, expiryAt: 0 };
}

/**
 * A DICTIONARY, not merely "an object".
 *
 * `typeof null === "object"` and `typeof [] === "object"` are both true, and
 * both were accepted by the first version of the check below. Each produced a
 * different silent disaster:
 *
 *   null   — every read of state.posted threw, the throw happened inside the
 *            run's `finally` before saveState, and so a run that had already
 *            posted warnings recorded none of them. Repeating every thirty
 *            minutes, for ever, with nothing in the log to say why.
 *
 *   []     — writes appeared to work, because a JavaScript array will happily
 *            take a named property. JSON.stringify then drops every one of
 *            them, so the file saved as `[]`, reloaded as empty, and the
 *            channel reposted everything. No error at any point.
 *
 * Both are exactly the failure this file's header says it exists to prevent, so
 * the test is now for the shape actually required.
 */
function isDict(x) {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

/** Accepts a state file written before the calendar existed. */
function readCal(json) {
  const c = json?.cal;
  if (!isDict(c)) return emptyCal();
  return {
    warned: isDict(c.warned) ? c.warned : {},
    posts: isDict(c.posts) ? c.posts : {},
    digestWeek: typeof c.digestWeek === "string" ? c.digestWeek : null,
    expiryAt: Number(c.expiryAt) || 0,
  };
}

export async function loadState() {
  const empty = { posted: {}, topics: [], cal: emptyCal(), outcomes: [], outcomeHistory: [], outcomeDigestWeek: null, recovered: false };
  try {
    const raw = await readFile(STATE_PATH, "utf8");
    const json = JSON.parse(raw);
    if (!isDict(json) || !isDict(json.posted)) {
      // A corrupt file must not stop the bot posting, but it must also not be
      // silently treated as "nothing was ever posted" without saying so.
      return { ...empty, recovered: true };
    }
    return {
      posted: json.posted,
      topics: Array.isArray(json.topics) ? json.topics : [],
      cal: readCal(json),
      // Accepts a state file written before the accountability loop existed,
      // the same way readCal() accepts one written before the calendar did.
      outcomes: Array.isArray(json.outcomes) ? json.outcomes : [],
      outcomeHistory: Array.isArray(json.outcomeHistory) ? json.outcomeHistory : [],
      outcomeDigestWeek: typeof json.outcomeDigestWeek === "string" ? json.outcomeDigestWeek : null,
      recovered: false,
    };
  } catch (e) {
    if (e?.code === "ENOENT") return empty;
    return { ...empty, recovered: true };
  }
}

/** A warning has gone out (or been deliberately skipped as stale). */
export function rememberWarning(state, stateKey, at = Date.now()) {
  state.cal = state.cal ?? emptyCal();
  state.cal.warned[stateKey] = at;
}

export function warningSent(state) {
  return state.cal?.warned ?? {};
}

/** Where a warning landed, so the result can be threaded onto it. */
export function rememberWarningPost(state, occurrenceKey, messageId, at = Date.now()) {
  state.cal = state.cal ?? emptyCal();
  if (!messageId) return;
  // The FIRST warning wins. An event warned twice — the day before and three
  // hours before — should have its result threaded onto the top of that
  // conversation, not onto the short reminder at the bottom of it.
  if (state.cal.posts[occurrenceKey]?.messageId) return;
  state.cal.posts[occurrenceKey] = { messageId, at };
}

export function warningPosts(state) {
  return state.cal?.posts ?? {};
}

/** Record what a post was ABOUT, so the next run can avoid repeating it. */
export function rememberTopic(state, words, at = Date.now()) {
  state.topics = state.topics ?? [];
  state.topics.push({ w: Array.from(words).sort(), at });
}

/** Subjects still inside the cooldown, as word sets ready to compare. */
export function recentTopics(state, now = Date.now()) {
  return (state.topics ?? [])
    .filter((t) => now - (t.at ?? 0) <= SUBJECT_COOLDOWN_MS)
    .map((t) => new Set(t.w ?? []));
}

/**
 * A cap on how many wordings of one story are fingerprinted.
 *
 * Only a bound on the state file's size — NOT the duplicate guard. That job
 * belongs to seenAnyWording() below, which reads every item.
 *
 * The comment here used to claim "a cluster cannot be larger than the number of
 * feeds". Measured, that is false: a cluster holds items, not sources, and one
 * story drew sixty-six of them across eleven outlets in eighteen hours. Any cap
 * is therefore a wall the right story can walk through, which is why the check
 * no longer uses one.
 */
export const MAX_KEYS_PER_STORY = 40;

/**
 * Every fingerprint a story should be remembered under.
 *
 * Lives here, and is exported, so the rule can be tested. It used to be four
 * lines inside run.js, where nothing could reach it, and the bug in it survived
 * two rounds of tests for exactly that reason.
 */
export function storyKeys(items, wordsOf) {
  return items.slice(0, MAX_KEYS_PER_STORY).map((i) => storyKey(wordsOf(i.title)));
}

/**
 * CHECK AGAINST EVERY WORDING. STORE ONLY THE FIRST FORTY.
 *
 * The cap was raised from 8 to 40 with the comment "a cluster cannot be larger
 * than the number of feeds". That was simply wrong, and measuring it said so: a
 * cluster holds ITEMS, not sources, and eleven outlets filing six follow-ups
 * each over an eighteen-hour window produced a single cluster of sixty-six.
 * Past forty distinctly-worded fresher reports — an ETF approval, a court
 * ruling, the exact profile of a story people keep writing about — every stored
 * fingerprint falls out of the window again and the story reposts. Same bug at
 * 8, five times harder to reach.
 *
 * Raising the cap further would only move the wall. So the CHECK reads every
 * item and the STORE keeps forty: the file stays bounded, and a story cannot
 * outrun its own memory however many outlets pile onto it.
 */
export function seenAnyWording(state, items, wordsOf) {
  for (const i of items) if (alreadyPosted(state, storyKey(wordsOf(i.title)))) return true;
  return false;
}

export function alreadyPosted(state, key) {
  return Object.prototype.hasOwnProperty.call(state.posted, key);
}

export function remember(state, key, { title, at }) {
  state.posted[key] = { title: String(title).slice(0, 140), postedAt: Date.now(), storyAt: at ?? null };
}

/** Drop entries older than KEEP_DAYS so the file cannot grow for ever. */
export function prune(state, now = Date.now()) {
  const cutoff = now - KEEP_DAYS * 86_400_000;
  let dropped = 0;
  // Defensive, because this runs inside the run's `finally`. A throw here would
  // skip saveState and lose the record of everything already posted — the one
  // place in the program where an exception costs more than the bug that caused
  // it.
  if (!isDict(state.posted)) state.posted = {};
  for (const [key, value] of Object.entries(state.posted)) {
    if ((value?.postedAt ?? 0) < cutoff) {
      delete state.posted[key];
      dropped += 1;
    }
  }
  // Topics expire much sooner than posted keys — they only exist to space out
  // coverage of one subject, not to remember it for ever.
  // topics too. The guard below covered posted and cal and skipped this one,
  // so a topics field that was an object rather than an array still threw —
  // and the throw skipped the calendar pruning underneath it.
  if (!Array.isArray(state.topics)) state.topics = [];
  const before = state.topics.length;
  state.topics = state.topics.filter((t) => now - (t.at ?? 0) <= SUBJECT_COOLDOWN_MS);
  dropped += before - state.topics.length;

  // The calendar's own bookkeeping.
  //
  // Warnings are kept much longer than stories: a warning sent on Monday for a
  // Friday event must still be remembered on Thursday, and forgetting it early
  // means announcing the same FOMC meeting twice. Thirty days is comfortably
  // longer than the furthest-out warning this calendar can issue.
  if (!isDict(state.cal)) state.cal = emptyCal();
  if (!isDict(state.cal.warned)) state.cal.warned = {};
  if (!isDict(state.cal.posts)) state.cal.posts = {};
  const cal = state.cal;
  const warnCutoff = now - 30 * 86_400_000;
  for (const [k, at] of Object.entries(cal.warned)) {
    if ((Number(at) || 0) < warnCutoff) { delete cal.warned[k]; dropped += 1; }
  }
  // Message ids die with the thread window — after thirty-six hours nothing can
  // be threaded onto them, so keeping them only grows the file.
  const postCutoff = now - 3 * 86_400_000;
  for (const [k, v] of Object.entries(cal.posts)) {
    if ((Number(v?.at) || 0) < postCutoff) { delete cal.posts[k]; dropped += 1; }
  }

  // The accountability loop's own bookkeeping — same defensive shape as
  // everything above it: a stuck pending check-back or a state file written
  // before this feature existed must not throw here, because a throw in this
  // function skips saveState for everything else too.
  if (!Array.isArray(state.outcomes)) state.outcomes = [];
  const outcomesBefore = state.outcomes.length;
  state.outcomes = state.outcomes.filter((o) => now - (o.postedAt ?? 0) <= OUTCOME_MAX_AGE_MS);
  dropped += outcomesBefore - state.outcomes.length;

  if (!Array.isArray(state.outcomeHistory)) state.outcomeHistory = [];
  const historyBefore = state.outcomeHistory.length;
  const historyCutoff = now - OUTCOME_HISTORY_KEEP_DAYS * 86_400_000;
  state.outcomeHistory = state.outcomeHistory.filter((h) => (h.postedAt ?? 0) >= historyCutoff);
  dropped += historyBefore - state.outcomeHistory.length;

  return dropped;
}

/**
 * OUTCOME TRACKING — the accountability loop.
 *
 * For a HIGH-importance, coin-resolved story, the channel checks back later
 * how the price actually moved and posts that as a reply to the original —
 * see outcomepost.js. `outcomes` holds what is still waiting to be checked;
 * `outcomeHistory` holds what has already been checked and resolved, kept
 * only long enough for the weekly recap (renderWeeklyOutcomes) to read it.
 *
 * The reply this produces is a FACT — a price delta — never a verdict on
 * whether the channel "called it right". A self-graded scorecard is a
 * different, larger claim than the one this project has ever made about
 * itself, and this file only ever stores the numbers, not a verdict on them.
 */

/** Long enough to see whether a HIGH-importance move held, short enough that
 * the reply still reads as a follow-up rather than old news. */
export const ACCOUNTABILITY_DELAY_MS = 8 * 3_600_000;

/** A pending check-back stuck this long — a coin whose price API kept
 * failing, say — is dropped rather than retried forever. */
export const OUTCOME_MAX_AGE_MS = 3 * 86_400_000;

/** Comfortably longer than a week, so the Sunday recap always finds the week
 * that just finished even if that run is itself a little late. */
export const OUTCOME_HISTORY_KEEP_DAYS = 8;

/** A story worth checking back on later. `id` is the Telegram message id of
 * the original post — already unique per chat, so nothing new is minted. */
export function rememberOutcome(state, entry) {
  state.outcomes = Array.isArray(state.outcomes) ? state.outcomes : [];
  state.outcomes.push(entry);
}

/** Everything due to be checked right now. */
export function dueOutcomes(state, now = Date.now()) {
  return (state.outcomes ?? []).filter((o) => now >= o.dueAt);
}

/** A checked-back entry leaves the pending queue and enters history. */
export function resolveOutcome(state, id, result) {
  state.outcomes = (state.outcomes ?? []).filter((o) => o.id !== id);
  state.outcomeHistory = Array.isArray(state.outcomeHistory) ? state.outcomeHistory : [];
  state.outcomeHistory.push(result);
}

/** History inside a window, for the weekly recap — `postedAt`-keyed like the
 * calendar's own digest window, so both read "what happened this week" the
 * same way. */
export function outcomeHistoryInWindow(state, { from, to }) {
  return (state.outcomeHistory ?? []).filter((h) => h.postedAt >= from && h.postedAt < to);
}

/**
 * WRITE TO A TEMPORARY FILE, THEN RENAME.
 *
 * A plain writeFile to posted.json is not atomic. If the job is killed
 * mid-write — GitHub's ten-minute timeout, a cancelled run — the file on disk
 * is half a JSON document, and the workflow's `if: always()` step commits it.
 * The next run then takes the `recovered` path, which is the forget-everything
 * path: it reposts up to ten days of news.
 *
 * rename() within the same directory is atomic on every filesystem this runs
 * on, so the file is either the old complete one or the new complete one, and
 * never a truncated one.
 */
export async function saveState(state) {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  const body = JSON.stringify(
    {
      updatedAt: new Date().toISOString(),
      posted: state.posted,
      topics: state.topics ?? [],
      cal: state.cal ?? emptyCal(),
      outcomes: state.outcomes ?? [],
      outcomeHistory: state.outcomeHistory ?? [],
      outcomeDigestWeek: state.outcomeDigestWeek ?? null,
    },
    null,
    2
  );
  const tmp = `${STATE_PATH}.tmp`;
  await writeFile(tmp, `${body}\n`, "utf8");
  await rename(tmp, STATE_PATH);
}
