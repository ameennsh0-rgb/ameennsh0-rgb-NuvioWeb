// Web-only "resume playback after a page refresh" helper.
//
// On the web the player lives only in memory, so a browser refresh drops the
// user back to Home and forces them to re-open the title and re-pick a stream.
// We remember the stream screen's params while playback is active; on the next
// app entry to Home we reopen that title's stream screen, where "reuse last
// link" auto-resumes the same stream at its saved position — no re-selecting.
//
// The record is written when playback starts and cleared when the player is
// exited normally (Back/finish). A refresh skips that cleanup, so the record
// survives only across a true mid-watch refresh, never a deliberate exit.

import { Platform } from "../../platform/index.js";
import { Router } from "../../ui/navigation/router.js";
import { LocalStore } from "../storage/localStore.js";

const KEY = "webResumeStreamRoute";
const TTL_MS = 3 * 60 * 60 * 1000;

function isWeb() {
  try {
    return Boolean(Platform.isBrowser?.());
  } catch (_) {
    return false;
  }
}

export function saveWebPlaybackResume(streamParams) {
  if (!isWeb() || !streamParams) return;
  try {
    LocalStore.set(KEY, { params: { ...streamParams }, savedAt: Date.now() });
  } catch (_) {}
}

export function clearWebPlaybackResume() {
  try {
    LocalStore.remove(KEY);
  } catch (_) {}
}

// Called once Home has been reached on a fresh app load. If a live resume
// record exists, reopen the stream screen for that title (over Home, so Back
// returns to Home). Returns true if a restore navigation was started.
export function restoreWebPlaybackAfterRefresh() {
  if (!isWeb()) return false;
  try {
    if (globalThis.__webPlaybackResumeConsumed) return false;
    const snapshot = LocalStore.get(KEY, null);
    if (!snapshot || typeof snapshot !== "object" || !snapshot.params) return false;
    const savedAt = Number(snapshot.savedAt || 0);
    if (!Number.isFinite(savedAt) || Date.now() - savedAt > TTL_MS) {
      LocalStore.remove(KEY);
      return false;
    }
    // Only restore from Home, and only once per page load.
    if (Router.getCurrent?.() !== "home") return false;
    globalThis.__webPlaybackResumeConsumed = true;
    void Router.navigate("stream", snapshot.params || {});
    return true;
  } catch (error) {
    console.warn("Web playback resume failed", error);
    return false;
  }
}
