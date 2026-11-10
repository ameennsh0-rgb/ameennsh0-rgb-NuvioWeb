// A mouse-first player control bar for the web build.
//
// The built-in player controls are designed for a TV remote. This module renders
// its own control bar over the real <video id="videoPlayer"> and drives the core
// transport (play/pause, seek, volume, fullscreen) DIRECTLY on the video element
// so it can't fail, while advanced buttons (subtitles, audio, sources, speed,
// episodes, party) reuse the existing player screen methods.
//
// Only the bottom bar and the center button capture clicks; the rest is
// pass-through so native panels (sources/subtitles) aren't blocked.

import { Router } from "../../navigation/router.js";

function isBrowserRuntime() {
  try {
    return typeof window !== "undefined" && typeof document !== "undefined" && !globalThis.tizen && !globalThis.webOS;
  } catch (_) {
    return false;
  }
}

const S = (w, d) => `<svg viewBox="0 0 24 24" width="${w}" height="${w}"><path fill="currentColor" d="${d}"/></svg>`;
const SVG = {
  play: (w) => S(w, "M8 5v14l11-7z"),
  pause: (w) => S(w, "M6 5h4v14H6zm8 0h4v14h-4z"),
  back10: (w) => S(w, "M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"),
  fwd10: (w) => S(w, "M12 5V1l5 5-5 5V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8z"),
  vol: (w) => S(w, "M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"),
  mute: (w) => S(w, "M3 9v6h4l5 5V4L7 9H3zm13 .5L14.5 11 16 12.5 14.5 14 16 15.5 17.5 14 19 15.5 20.5 14 19 12.5 20.5 11 19 9.5 17.5 11z"),
  full: (w) => S(w, "M7 14H5v5h5v-2H7zm-2-4h2V7h3V5H5zm12 7h-3v2h5v-5h-2zM14 5v2h3v3h2V5z"),
  cc: (w) => S(w, "M19 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zM11 10H6v4h5v-1.5H7.5v-1H11zm7 0h-5v4h5v-1.5h-3.5v-1H18z"),
};

export const WebPlayerControls = {
  started: false,
  root: null,
  uiRoot: null,
  video: null,
  els: {},
  hideTimer: null,
  rafBound: null,

  init() {
    if (this.started || !isBrowserRuntime()) return;
    this.started = true;
    this.injectStyles();
    setInterval(() => this.tick(), 500);
  },

  tick() {
    const video = document.getElementById("videoPlayer");
    const uiRoot = document.getElementById("playerUiRoot");
    if (video && uiRoot) {
      if (!this.root || !uiRoot.contains(this.root)) this.mount(uiRoot, video);
      this.video = video;
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
    this.uiRoot = uiRoot;
    this.video = video;
    const root = document.createElement("div");
    root.id = "webplayer-controls";
    root.innerHTML = `
      <button class="wp-center" id="wpCenter" title="Play/Pause">${SVG.play(52)}</button>
      <div class="wp-bar">
        <div class="wp-seek" id="wpSeek">
          <div class="wp-seek-track">
            <div class="wp-buffered" id="wpBuffered"></div>
            <div class="wp-played" id="wpPlayed"></div>
          </div>
          <div class="wp-thumb" id="wpThumb"></div>
        </div>
        <div class="wp-row">
          <button class="wp-btn" data-wp="playPause" id="wpPlay" title="Play/Pause">${SVG.play(32)}</button>
          <button class="wp-btn" data-wp="rewind" title="Back 10s">${SVG.back10(30)}</button>
          <button class="wp-btn" data-wp="forward" title="Forward 10s">${SVG.fwd10(30)}</button>
          <div class="wp-vol">
            <button class="wp-btn" data-wp="mute" id="wpMute" title="Mute">${SVG.vol(30)}</button>
            <input type="range" id="wpVol" class="wp-vol-range" min="0" max="1" step="0.01" value="1">
          </div>
          <div class="wp-time" id="wpTime">0:00 / 0:00</div>
          <div class="wp-spacer"></div>
          <button class="wp-btn wp-txt" data-wp="party" title="Watch party">Party</button>
          <button class="wp-btn" data-wp="subtitleDialog" title="Subtitles">${SVG.cc(30)}</button>
          <button class="wp-btn wp-txt" data-wp="audioTrack" title="Audio">Audio</button>
          <button class="wp-btn wp-txt" data-wp="source" title="Sources">Sources</button>
          <button class="wp-btn wp-txt" data-wp="speed" title="Speed">Speed</button>
          <button class="wp-btn wp-txt" data-wp="episodes" title="Episodes">Episodes</button>
          <button class="wp-btn" data-wp="fullscreen" id="wpFull" title="Fullscreen">${SVG.full(30)}</button>
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
      center: root.querySelector("#wpCenter"),
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
    this.uiRoot?.classList.remove("webplayer-active");
    if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
    this.root = null;
  },

  bind() {
    const r = this.root;
    r.querySelectorAll("[data-wp]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.onAction(btn.getAttribute("data-wp"));
        this.reveal();
      });
    });
    this.els.center.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.togglePlay();
      this.reveal();
    });

    // Seek (click + drag)
    let dragging = false;
    const seekTo = (clientX) => {
      const rect = this.els.seek.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const dur = this.duration();
      if (dur > 0 && this.video) {
        this.video.currentTime = dur * ratio;
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

    this.els.vol.addEventListener("input", () => {
      if (!this.video) return;
      this.video.volume = Number(this.els.vol.value);
      this.video.muted = this.video.volume === 0;
      this.updateVolIcon();
    });

    // Reveal on movement over the player; click on the video toggles play.
    this.uiRoot.addEventListener("mousemove", () => this.reveal());
    this.uiRoot.addEventListener("click", (e) => {
      if (e.target === this.video) {
        this.togglePlay();
        this.reveal();
      }
    });
  },

  togglePlay() {
    const v = this.video;
    if (!v) return;
    if (v.paused || v.ended) v.play().catch(() => {});
    else v.pause();
  },

  onAction(action) {
    const v = this.video;
    if (action === "playPause") return this.togglePlay();
    if (action === "fullscreen") return this.toggleFullscreen();
    if (action === "mute") {
      if (v) {
        v.muted = !v.muted;
        this.els.vol.value = v.muted ? 0 : v.volume || 1;
        this.updateVolIcon();
      }
      return;
    }
    if (action === "rewind") return this.seekRelative(-10);
    if (action === "forward") return this.seekRelative(10);
    const screen = this.screen();
    if (screen) {
      try {
        screen.performControlAction(action);
      } catch (e) {
        console.warn("webplayer action failed", action, e);
      }
    }
  },

  seekRelative(delta) {
    if (!this.video) return;
    const dur = this.duration();
    const target = Math.max(0, Math.min(dur || this.video.currentTime + delta, this.video.currentTime + delta));
    this.video.currentTime = target;
  },

  toggleFullscreen() {
    const el = this.uiRoot || document.getElementById("playerUiRoot") || document.documentElement;
    try {
      if (document.fullscreenElement) document.exitFullscreen();
      else el.requestFullscreen?.();
    } catch (_) {}
  },

  duration() {
    const vd = this.video?.duration;
    if (Number.isFinite(vd) && vd > 0) return vd;
    const screen = this.screen();
    if (screen?.getPlaybackDurationSeconds) {
      const d = screen.getPlaybackDurationSeconds();
      if (Number.isFinite(d) && d > 0) return d;
    }
    return 0;
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
    this.els.play.innerHTML = playing ? SVG.pause(32) : SVG.play(32);
    if (this.els.center) {
      this.els.center.innerHTML = playing ? SVG.pause(52) : SVG.play(52);
      this.els.center.classList.toggle("hidden", playing);
    }
  },

  updateVolIcon() {
    if (!this.video || !this.els.mute) return;
    const muted = this.video.muted || this.video.volume === 0;
    this.els.mute.innerHTML = muted ? SVG.mute(30) : SVG.vol(30);
  },

  reveal() {
    if (!this.root) return;
    this.root.classList.add("show");
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      if (this.video && this.video.paused) return;
      this.root?.classList.remove("show");
    }, 3500);
  },

  injectStyles() {
    if (document.getElementById("webplayer-styles")) return;
    const css = `
.webplayer-active #playerControlsOverlay{display:none!important}
#webplayer-controls{position:absolute;inset:0;z-index:60;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;pointer-events:none}
#webplayer-controls .wp-center{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:96px;height:96px;border:0;border-radius:50%;background:rgba(0,0,0,.55);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;opacity:0;transition:opacity .18s;pointer-events:none}
#webplayer-controls.show .wp-center:not(.hidden){opacity:1;pointer-events:auto}
#webplayer-controls .wp-center:hover{background:rgba(0,0,0,.7)}
#webplayer-controls .wp-bar{position:absolute;left:0;right:0;bottom:0;padding:24px 34px 24px;background:linear-gradient(to top,rgba(0,0,0,.92),rgba(0,0,0,.5) 55%,transparent);opacity:0;transform:translateY(12px);transition:opacity .2s,transform .2s;pointer-events:none}
#webplayer-controls.show .wp-bar{opacity:1;transform:none;pointer-events:auto}
#webplayer-controls .wp-seek{position:relative;height:30px;display:flex;align-items:center;cursor:pointer;margin-bottom:12px}
#webplayer-controls .wp-seek-track{position:relative;width:100%;height:8px;border-radius:5px;background:rgba(255,255,255,.3);overflow:hidden}
#webplayer-controls .wp-seek:hover .wp-seek-track{height:12px}
#webplayer-controls .wp-buffered{position:absolute;left:0;top:0;bottom:0;background:rgba(255,255,255,.45);width:0}
#webplayer-controls .wp-played{position:absolute;left:0;top:0;bottom:0;background:#3dd68c;width:0}
#webplayer-controls .wp-thumb{position:absolute;top:50%;left:0;width:22px;height:22px;border-radius:50%;background:#3dd68c;transform:translate(-50%,-50%);box-shadow:0 1px 6px rgba(0,0,0,.6);opacity:0;transition:opacity .15s}
#webplayer-controls .wp-seek:hover .wp-thumb{opacity:1}
#webplayer-controls .wp-row{display:flex;align-items:center;gap:12px}
#webplayer-controls .wp-btn{display:flex;align-items:center;justify-content:center;min-width:60px;height:60px;padding:0 16px;border:0;border-radius:12px;background:transparent;color:#fff;cursor:pointer;font-size:18px;font-weight:600;line-height:1}
#webplayer-controls .wp-btn:hover{background:rgba(255,255,255,.2)}
#webplayer-controls .wp-txt{letter-spacing:.01em;font-size:18px}
#webplayer-controls .wp-time{color:#fff;font-size:18px;margin:0 12px;white-space:nowrap;font-variant-numeric:tabular-nums}
#webplayer-controls .wp-spacer{flex:1}
#webplayer-controls .wp-vol{display:flex;align-items:center}
#webplayer-controls .wp-vol-range{width:0;opacity:0;transition:width .2s,opacity .2s;accent-color:#3dd68c;cursor:pointer;height:7px}
#webplayer-controls .wp-vol:hover .wp-vol-range{width:120px;opacity:1;margin-left:6px}
@media(max-width:820px){#webplayer-controls .wp-txt{display:none}#webplayer-controls .wp-bar{padding:18px 18px 20px}#webplayer-controls .wp-btn{min-width:52px;height:52px}}`;
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
