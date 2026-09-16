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

import { readFile, writeFile, mkdir } from "fs/promises";
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

export async function loadState() {
  const empty = { posted: {}, topics: [], recovered: false };
  try {
    const raw = await readFile(STATE_PATH, "utf8");
    const json = JSON.parse(raw);
    if (!json || typeof json !== "object" || typeof json.posted !== "object") {
      // A corrupt file must not stop the bot posting, but it must also not be
      // silently treated as "nothing was ever posted" without saying so.
      return { ...empty, recovered: true };
    }
    return { posted: json.posted, topics: Array.isArray(json.topics) ? json.topics : [], recovered: false };
  } catch (e) {
    if (e?.code === "ENOENT") return empty;
    return { ...empty, recovered: true };
  }
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
  for (const [key, value] of Object.entries(state.posted)) {
    if ((value?.postedAt ?? 0) < cutoff) {
      delete state.posted[key];
      dropped += 1;
    }
  }
  // Topics expire much sooner than posted keys — they only exist to space out
  // coverage of one subject, not to remember it for ever.
  const before = (state.topics ?? []).length;
  state.topics = (state.topics ?? []).filter((t) => now - (t.at ?? 0) <= SUBJECT_COOLDOWN_MS);
  dropped += before - state.topics.length;
  return dropped;
}

export async function saveState(state) {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  const body = JSON.stringify(
    { updatedAt: new Date().toISOString(), posted: state.posted, topics: state.topics ?? [] },
    null,
    2
  );
  await writeFile(STATE_PATH, `${body}\n`, "utf8");
}
