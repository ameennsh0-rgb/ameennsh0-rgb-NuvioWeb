// Silent-movie fallback, the same idea as Stremio's streaming server.
//
// Browsers cannot decode some audio formats (Dolby AC3/EAC3, DTS, TrueHD), so
// such a movie plays with picture and no sound. When that happens we ask the
// "Nuvio audio helper" running on the user's own computer (tools/audio-helper)
// for an HLS stream where the video is copied untouched and the audio is
// converted to AAC, and play that on the same <video> element.
//
// Nothing here runs unless a movie is actually silent.

import { loadStreamingLibs } from "../../runtime/loadStreamingLibs.js";

const HELPER = "http://127.0.0.1:11471";
const CHECK_AFTER_MS = 4000;

let installed = false;
let active = null; // { hls, src, blob }
let toastTimer = null;

export function audioLooksSilent(video) {
  if (!video || video.muted || video.volume === 0) {
    return false;
  }
  if (typeof video.webkitAudioDecodedByteCount === "number") {
    return video.webkitAudioDecodedByteCount === 0; // Chrome / Edge / Safari
  }
  if (typeof video.mozHasAudio === "boolean") {
    return video.mozHasAudio === false; // Firefox
  }
  return false;
}

function toast(text) {
  try {
    let el = document.getElementById("nuvioAudioHelperToast");
    if (!el) {
      el = document.createElement("div");
      el.id = "nuvioAudioHelperToast";
      el.style.cssText =
        "position:fixed;left:50%;bottom:90px;transform:translateX(-50%);max-width:80vw;padding:10px 16px;" +
        "border-radius:10px;background:rgba(20,20,24,.92);color:#fff;font:14px system-ui;z-index:2147483647;" +
        "box-shadow:0 4px 18px rgba(0,0,0,.5);text-align:center";
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.style.display = "block";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.style.display = "none";
    }, 9000);
  } catch (_) {
    // A toast must never break playback.
  }
}

async function helperAvailable() {
  try {
    const res = await fetch(`${HELPER}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch (_) {
    return false;
  }
}

function teardown(video) {
  if (!active) {
    return;
  }
  try {
    active.hls.destroy();
  } catch (_) {
    // already gone
  }
  active = null;
  if (video) {
    delete video.dataset.nuvioAudioHelper;
  }
}

async function engage(video, src, startAt) {
  const t = Math.max(0, Math.floor(startAt));
  const res = await fetch(`${HELPER}/start?url=${encodeURIComponent(src)}&t=${t}`, { signal: AbortSignal.timeout(40000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.playlist) {
    throw new Error(body.detail || body.error || "helper failed");
  }
  await loadStreamingLibs({ dash: false });
  const Hls = globalThis.Hls;
  if (!Hls || !Hls.isSupported()) {
    throw new Error("hls.js unavailable");
  }
  teardown(video);
  const hls = new Hls({ enableWorker: true, startPosition: t, lowLatencyMode: false });
  active = { hls, src, blob: null };
  video.dataset.nuvioAudioHelper = "1";
  const resume = !video.paused;
  hls.attachMedia(video);
  hls.on(Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(HELPER + body.playlist));
  hls.on(Hls.Events.MANIFEST_PARSED, () => {
    if (resume) {
      video.play().catch(() => {});
    }
  });
  hls.on(Hls.Events.ERROR, (_e, data) => {
    if (data && data.fatal) {
      toast("Audio helper stream stopped. Restart the helper and reopen the movie.");
      teardown(video);
    }
  });
}

async function checkSilent(video) {
  const src = video.currentSrc || video.src || "";
  if (!src || src.startsWith("blob:") || src.startsWith("data:") || src.includes("assets/demo/")) {
    return;
  }
  if (video.dataset.nuvioAudioChecked === src) {
    return;
  }
  if (video.paused || video.currentTime < 2) {
    return setTimeout(() => void checkSilent(video), 1500);
  }
  video.dataset.nuvioAudioChecked = src;
  if (!audioLooksSilent(video)) {
    return;
  }
  if (!(await helperAvailable())) {
    toast("No sound: this movie's audio format isn't supported by the browser. Start the Nuvio audio helper on this computer to fix it.");
    return;
  }
  toast("Converting audio for this movie...");
  try {
    await engage(video, src, video.currentTime);
  } catch (error) {
    console.warn("Audio helper failed", error);
    toast("Audio helper could not convert this movie.");
  }
}

// The browser cannot start this file at all (for example HEVC video inside an
// MKV container): nothing loads, or the element reports an error. The helper
// can repackage it into HLS, which the browser does understand.
async function rescueStuck(video, src) {
  if (!src || video.dataset.nuvioAudioHelper === "1" || video.dataset.nuvioStuckTried === src) {
    return;
  }
  const current = video.currentSrc || video.src || "";
  if (current !== src || src.startsWith("blob:") || src.startsWith("data:") || src.includes("assets/demo/")) {
    return;
  }
  video.dataset.nuvioStuckTried = src;
  if (!(await helperAvailable())) {
    return;
  }
  toast("This movie can't start in the browser. Converting it with the audio helper...");
  try {
    await engage(video, src, 0);
    video.play().catch(() => {});
  } catch (error) {
    console.warn("Audio helper could not rescue this movie", error);
    toast("Audio helper could not convert this movie.");
  }
}

export function installLocalAudioHelper() {
  if (installed || typeof document === "undefined") {
    return;
  }
  installed = true;
  const isPlayer = (el) => el && el.tagName === "VIDEO" && el.id === "videoPlayer";

  // Media events do not bubble, so listen in the capture phase.
  document.addEventListener(
    "playing",
    (event) => {
      const video = event.target;
      if (!isPlayer(video) || video.dataset.nuvioAudioHelper === "1") {
        return;
      }
      setTimeout(() => void checkSilent(video), CHECK_AFTER_MS);
    },
    true
  );

  // Nothing loaded after a while, or a decode/format error: let the helper try.
  document.addEventListener(
    "loadstart",
    (event) => {
      const video = event.target;
      if (!isPlayer(video) || video.dataset.nuvioAudioHelper === "1") {
        return;
      }
      const src = video.currentSrc || video.src || "";
      setTimeout(() => {
        if (video.readyState === 0 && !video.error) {
          void rescueStuck(video, src);
        }
      }, 8000);
    },
    true
  );
  document.addEventListener(
    "error",
    (event) => {
      const video = event.target;
      if (!isPlayer(video) || video.dataset.nuvioAudioHelper === "1") {
        return;
      }
      void rescueStuck(video, video.currentSrc || video.src || "");
    },
    true
  );

  // A different source loaded into the player: stop converting the old one.
  document.addEventListener(
    "loadstart",
    (event) => {
      const video = event.target;
      if (!isPlayer(video) || !active) {
        return;
      }
      const now = video.currentSrc || "";
      if (!active.blob) {
        active.blob = now; // our own MediaSource
      } else if (now !== active.blob) {
        teardown(video);
      }
    },
    true
  );

  // Seeking outside what has been converted: restart the conversion there.
  document.addEventListener(
    "seeking",
    (event) => {
      const video = event.target;
      if (!isPlayer(video) || !active) {
        return;
      }
      const frags = active.hls.levels?.[active.hls.currentLevel >= 0 ? active.hls.currentLevel : 0]?.details?.fragments;
      if (!frags || !frags.length) {
        return;
      }
      const first = frags[0].start;
      const last = frags[frags.length - 1];
      const edge = last.start + last.duration;
      const target = video.currentTime;
      if (target < first - 0.5 || target > edge + 30) {
        const src = active.src;
        engage(video, src, target).catch((error) => {
          console.warn("Audio helper seek restart failed", error);
          toast("Audio helper could not jump there.");
        });
      }
    },
    true
  );
}
