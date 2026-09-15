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
// WHAT IS STORED
//
//   A fingerprint per posted story and when it went out. Not the text — the
//   channel already has that, and a state file that grows without bound turns
//   every run into a large checkout.

import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname } from "path";
import { createHash } from "crypto";

export const STATE_PATH = "state/posted.json";

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

export async function loadState() {
  try {
    const raw = await readFile(STATE_PATH, "utf8");
    const json = JSON.parse(raw);
    if (!json || typeof json !== "object" || typeof json.posted !== "object") {
      // A corrupt file must not stop the bot posting, but it must also not be
      // silently treated as "nothing was ever posted" without saying so.
      return { posted: {}, recovered: true };
    }
    return { posted: json.posted, recovered: false };
  } catch (e) {
    if (e?.code === "ENOENT") return { posted: {}, recovered: false };
    return { posted: {}, recovered: true };
  }
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
  return dropped;
}

export async function saveState(state) {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  const body = JSON.stringify({ updatedAt: new Date().toISOString(), posted: state.posted }, null, 2);
  await writeFile(STATE_PATH, `${body}\n`, "utf8");
}
