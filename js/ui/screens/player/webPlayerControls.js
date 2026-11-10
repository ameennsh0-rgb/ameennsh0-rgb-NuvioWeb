// A mouse-first player control bar for the web build.
//
// The built-in player controls are designed for a TV remote (focus + Enter) and
// are awkward with a mouse. This module renders its own control bar over the
// real <video id="videoPlayer"> element and drives playback through the existing
// player screen methods (performControlAction / seekPlaybackSeconds), so all the
// real functionality — play/pause, seek, subtitles, audio, sources, speed,
// episodes, watch party — keeps working, just with proper mouse interactions.
//
// It activates only in a browser, polls for the player being on screen, hides
// the native control bar while active, and cleans up when the player closes.

import { Router } from "../../navigation/router.js";

function isBrowserRuntime() {
  try {
    return typeof window !== "undefined" && typeof document !== "undefined" && !globalThis.tizen && !globalThis.webOS;
  } catch (_) {
    return false;
  }
}

const SVG = {
  play: '<svg viewBox="0 0 24 24" width="26" height="26"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="26" height="26"><path fill="currentColor" d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>',
  back10: '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"/></svg>',
  fwd10: '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M12 5V1l5 5-5 5V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8z"/></svg>',
  vol: '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"/></svg>',
  mute: '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3zm13 .5L14.5 11 16 12.5 14.5 14 16 15.5 17.5 14 19 15.5 20.5 14 19 12.5 20.5 11 19 9.5 17.5 11z"/></svg>',
  full: '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M7 14H5v5h5v-2H7zm-2-4h2V7h3V5H5zm12 7h-3v2h5v-5h-2zM14 5v2h3v3h2V5z"/></svg>',
  cc: '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M19 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zM9 11H7.5v-.5h-2v3h2V13H9v1a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1zm7 0h-1.5v-.5h-2v3h2V13H16v1a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1z"/></svg>',
};

function icon(name, label) {
  return SVG[name] || label || "";
}

export const WebPlayerControls = {
  started: false,
  root: null,
  els: {},
  hideTimer: null,
  rafBound: null,

  init() {
    if (this.started || !isBrowserRuntime()) return;
    this.started = true;
    this.injectStyles();
    // Watch for the player mounting/unmounting.
    setInterval(() => this.tick(), 500);
  },

  tick() {
    const video = document.getElementById("videoPlayer");
    const uiRoot = document.getElementById("playerUiRoot");
    if (video && uiRoot) {
      if (!this.root || !uiRoot.contains(this.root)) this.mount(uiRoot, video);
      // Keep native controls hidden while ours is active.
      uiRoot.classList.add("webplayer-active");
    } else if (this.root) {
      this.unmount();
    }
  },

  screen() {
    const s = Router.getCurrentScreen?.();
    return s && typeof s.performControlAction === "function" ? s : null;
  },

  mount(uiRoot, video) {
    this.unmount();
    this.video = video;
    const root = document.createElement("div");
    root.id = "webplayer-controls";
    root.innerHTML = `
      <div class="wp-tap"></div>
      <div class="wp-bar">
        <div class="wp-seek" id="wpSeek">
          <div class="wp-seek-track">
            <div class="wp-buffered" id="wpBuffered"></div>
            <div class="wp-played" id="wpPlayed"></div>
          </div>
          <div class="wp-thumb" id="wpThumb"></div>
        </div>
        <div class="wp-row">
          <button class="wp-btn" data-wp="playPause" id="wpPlay" title="Play/Pause">${icon("play")}</button>
          <button class="wp-btn" data-wp="rewind" title="Back 10s">${icon("back10")}</button>
          <button class="wp-btn" data-wp="forward" title="Forward 10s">${icon("fwd10")}</button>
          <div class="wp-vol">
            <button class="wp-btn" data-wp="mute" id="wpMute" title="Mute">${icon("vol")}</button>
            <input type="range" id="wpVol" class="wp-vol-range" min="0" max="1" step="0.01" value="1">
          </div>
          <div class="wp-time" id="wpTime">0:00 / 0:00</div>
          <div class="wp-spacer"></div>
          <button class="wp-btn wp-txt" data-wp="party" title="Watch party">Party</button>
          <button class="wp-btn" data-wp="subtitleDialog" title="Subtitles">${icon("cc")}</button>
          <button class="wp-btn wp-txt" data-wp="audioTrack" title="Audio">Audio</button>
          <button class="wp-btn wp-txt" data-wp="source" title="Sources">Sources</button>
          <button class="wp-btn wp-txt" data-wp="speed" title="Speed">Speed</button>
          <button class="wp-btn wp-txt" data-wp="episodes" title="Episodes">Episodes</button>
          <button class="wp-btn" data-wp="fullscreen" id="wpFull" title="Fullscreen">${icon("full")}</button>
        </div>
      </div>`;
    uiRoot.appendChild(root);
    this.root = root;
    this.els = {
      seek: root.querySelector("#wpSeek"),
      buffered: root.querySelector("#wpBuffered"),
      played: root.querySelector("#wpPlayed"),
      thumb: root.querySelector("#wpThumb"),
      play: root.querySelector("#wpPlay"),
      time: root.querySelector("#wpTime"),
      mute: root.querySelector("#wpMute"),
      vol: root.querySelector("#wpVol"),
      tap: root.querySelector(".wp-tap"),
    };
    this.bind();
    this.reveal();
    this.loop();
  },

  unmount() {
    if (this.rafBound) {
      cancelAnimationFrame(this.rafBound);
      this.rafBound = null;
    }
    document.getElementById("playerUiRoot")?.classList.remove("webplayer-active");
    if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
    this.root = null;
    this.video = null;
  },

  bind() {
    const r = this.root;
    // Button actions
    r.querySelectorAll("[data-wp]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.onAction(btn.getAttribute("data-wp"));
        this.reveal();
      });
    });
    // Seek (click + drag)
    let dragging = false;
    const seekTo = (clientX) => {
      const rect = this.els.seek.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const dur = this.duration();
      if (dur > 0) {
        const screen = this.screen();
        if (screen?.seekPlaybackSeconds) screen.seekPlaybackSeconds(dur * ratio);
        else if (this.video) this.video.currentTime = dur * ratio;
        this.setPlayed(ratio);
      }
    };
    this.els.seek.addEventListener("pointerdown", (e) => {
      dragging = true;
      try {
        this.els.seek.setPointerCapture(e.pointerId);
      } catch (_) {}
      seekTo(e.clientX);
      e.preventDefault();
      e.stopPropagation();
    });
    this.els.seek.addEventListener("pointermove", (e) => {
      if (dragging) seekTo(e.clientX);
      this.reveal();
    });
    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      try {
        this.els.seek.releasePointerCapture(e.pointerId);
      } catch (_) {}
    };
    this.els.seek.addEventListener("pointerup", endDrag);
    this.els.seek.addEventListener("pointercancel", endDrag);

    // Volume
    this.els.vol.addEventListener("input", () => {
      if (!this.video) return;
      this.video.volume = Number(this.els.vol.value);
      this.video.muted = this.video.volume === 0;
      this.updateVolIcon();
    });

    // Tap video area: toggle play/pause. Mouse move: reveal controls.
    this.els.tap.addEventListener("click", (e) => {
      e.stopPropagation();
      this.onAction("playPause");
      this.reveal();
    });
    this.els.tap.addEventListener("dblclick", () => this.onAction("fullscreen"));
    this.root.addEventListener("mousemove", () => this.reveal());
  },

  onAction(action) {
    const screen = this.screen();
    const video = this.video;
    if (action === "fullscreen") {
      this.toggleFullscreen();
      return;
    }
    if (action === "mute") {
      if (video) {
        video.muted = !video.muted;
        this.els.vol.value = video.muted ? 0 : video.volume || 1;
        this.updateVolIcon();
      }
      return;
    }
    if (action === "rewind") {
      if (video) this.seekRelative(-10);
      return;
    }
    if (action === "forward") {
      if (video) this.seekRelative(10);
      return;
    }
    if (screen) {
      try {
        screen.performControlAction(action);
      } catch (e) {
        console.warn("webplayer action failed", action, e);
      }
    }
  },

  seekRelative(delta) {
    const screen = this.screen();
    const cur = this.video ? this.video.currentTime : 0;
    const dur = this.duration();
    const target = Math.max(0, Math.min(dur || cur + delta, cur + delta));
    if (screen?.seekPlaybackSeconds) screen.seekPlaybackSeconds(target);
    else if (this.video) this.video.currentTime = target;
  },

  toggleFullscreen() {
    const el = document.getElementById("playerUiRoot") || document.documentElement;
    try {
      if (document.fullscreenElement) document.exitFullscreen();
      else el.requestFullscreen?.();
    } catch (_) {}
  },

  duration() {
    const screen = this.screen();
    if (screen?.getPlaybackDurationSeconds) {
      const d = screen.getPlaybackDurationSeconds();
      if (Number.isFinite(d) && d > 0) return d;
    }
    const vd = this.video?.duration;
    return Number.isFinite(vd) && vd > 0 ? vd : 0;
  },

  setPlayed(ratio) {
    if (this.els.played) this.els.played.style.width = ratio * 100 + "%";
    if (this.els.thumb) this.els.thumb.style.left = ratio * 100 + "%";
  },

  loop() {
    const step = () => {
      this.update();
      this.rafBound = requestAnimationFrame(step);
    };
    this.rafBound = requestAnimationFrame(step);
  },

  update() {
    const v = this.video;
    if (!v || !this.root) return;
    const dur = this.duration();
    const cur = v.currentTime || 0;
    const ratio = dur > 0 ? Math.max(0, Math.min(1, cur / dur)) : 0;
    this.setPlayed(ratio);
    try {
      if (v.buffered && v.buffered.length && dur > 0) {
        const end = v.buffered.end(v.buffered.length - 1);
        this.els.buffered.style.width = Math.min(100, (end / dur) * 100) + "%";
      }
    } catch (_) {}
    this.els.time.textContent = fmt(cur) + " / " + (dur ? fmt(dur) : "0:00");
    const playing = !v.paused && !v.ended;
    this.els.play.innerHTML = playing ? icon("pause") : icon("play");
  },

  updateVolIcon() {
    if (!this.video || !this.els.mute) return;
    const muted = this.video.muted || this.video.volume === 0;
    this.els.mute.innerHTML = muted ? icon("mute") : icon("vol");
  },

  reveal() {
    if (!this.root) return;
    this.root.classList.add("show");
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      // Don't hide while paused.
      if (this.video && this.video.paused) return;
      this.root?.classList.remove("show");
    }, 3200);
  },

  injectStyles() {
    if (document.getElementById("webplayer-styles")) return;
    const css = `
.webplayer-active #playerControlsOverlay{display:none!important}
#webplayer-controls{position:absolute;inset:0;z-index:40;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;pointer-events:none}
#webplayer-controls .wp-tap{position:absolute;inset:0;pointer-events:auto;cursor:pointer}
#webplayer-controls .wp-bar{position:absolute;left:0;right:0;bottom:0;padding:16px 22px 18px;background:linear-gradient(to top,rgba(0,0,0,.85),rgba(0,0,0,.45) 55%,transparent);opacity:0;transform:translateY(8px);transition:opacity .18s,transform .18s;pointer-events:none}
#webplayer-controls.show .wp-bar{opacity:1;transform:none;pointer-events:auto}
#webplayer-controls.show .wp-tap{cursor:default}
#webplayer-controls .wp-seek{position:relative;height:16px;display:flex;align-items:center;cursor:pointer;margin-bottom:6px}
#webplayer-controls .wp-seek-track{position:relative;width:100%;height:5px;border-radius:3px;background:rgba(255,255,255,.28);overflow:hidden}
#webplayer-controls .wp-seek:hover .wp-seek-track{height:7px}
#webplayer-controls .wp-buffered{position:absolute;left:0;top:0;bottom:0;background:rgba(255,255,255,.4);width:0}
#webplayer-controls .wp-played{position:absolute;left:0;top:0;bottom:0;background:#3dd68c;width:0}
#webplayer-controls .wp-thumb{position:absolute;top:50%;left:0;width:13px;height:13px;border-radius:50%;background:#3dd68c;transform:translate(-50%,-50%);box-shadow:0 1px 4px rgba(0,0,0,.5);opacity:0;transition:opacity .15s}
#webplayer-controls .wp-seek:hover .wp-thumb{opacity:1}
#webplayer-controls .wp-row{display:flex;align-items:center;gap:6px}
#webplayer-controls .wp-btn{display:flex;align-items:center;justify-content:center;min-width:38px;height:38px;padding:0 10px;border:0;border-radius:9px;background:transparent;color:#fff;cursor:pointer;font-size:13px;font-weight:600;line-height:1}
#webplayer-controls .wp-btn:hover{background:rgba(255,255,255,.16)}
#webplayer-controls .wp-txt{letter-spacing:.01em}
#webplayer-controls .wp-time{color:#eee;font-size:13px;margin:0 8px;white-space:nowrap}
#webplayer-controls .wp-spacer{flex:1}
#webplayer-controls .wp-vol{display:flex;align-items:center}
#webplayer-controls .wp-vol-range{width:0;opacity:0;transition:width .18s,opacity .18s;accent-color:#3dd68c;cursor:pointer}
#webplayer-controls .wp-vol:hover .wp-vol-range{width:84px;opacity:1;margin-left:2px}
@media(max-width:640px){#webplayer-controls .wp-txt{display:none}}`;
    const style = document.createElement("style");
    style.id = "webplayer-styles";
    style.textContent = css;
    document.head.appendChild(style);
  },
};

function fmt(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
