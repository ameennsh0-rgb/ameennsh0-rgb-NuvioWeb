// Watch-party video call overlay for the web app.
//
// A self-contained floating bubble that appears while a watch party is active,
// letting everyone turn their camera/mic on and see each other. It joins the
// same Cloudflare SFU rooms (keyed by the party id) as the phone app, so web
// and phone callers share one call. It is decoupled from the party panel DOM:
// its own buttons are plain clickable elements.

import { ProfileManager } from "../profile/profileManager.js";
import { PartyRepository } from "./partyRepository.js";

const CALL_SERVER = (() => {
  try {
    if (typeof globalThis !== "undefined" && globalThis.NUVIO_CALL_SERVER_URL) {
      return String(globalThis.NUVIO_CALL_SERVER_URL).replace(/\/+$/, "");
    }
  } catch (_) {}
  return "https://nuvio-call.ameennsh0.workers.dev";
})();

const HEARTBEAT_MS = 4000;

function isBrowserRuntime() {
  try {
    return (
      typeof window !== "undefined" &&
      typeof document !== "undefined" &&
      !globalThis.tizen &&
      !globalThis.webOS
    );
  } catch (_) {
    return false;
  }
}

export const PartyCallOverlay = {
  started: false,
  room: null,
  memberId: null,
  myName: "Guest",
  pc: null,
  localStream: null,
  sessionId: null,
  camOn: true,
  micOn: true,
  phase: "idle", // idle | connecting | connected
  remotes: {},
  presenceTimer: null,
  lock: Promise.resolve(),
  els: {},

  init() {
    if (this.started || !isBrowserRuntime()) return;
    this.started = true;
    this.injectStyles();
    this.buildUi();
    try {
      PartyRepository.subscribeState((state) => this.onParty(state && state.party));
      this.onParty(PartyRepository.getState && PartyRepository.getState().party);
    } catch (e) {
      console.warn("PartyCallOverlay: subscribe failed", e);
    }
    // Keep the bubble attached to the player controls (so it hides/shows with
    // them) when in the player, otherwise floating.
    setInterval(() => {
      if (this.room) this.ensureMount();
    }, 1000);
  },

  ensureMount() {
    if (!this.els.root) return;
    // Mount inside the player UI (above the custom controls) when in the player
    // so the call button and tiles are visible and clickable; otherwise float.
    const player = document.getElementById("playerUiRoot");
    const parent = player || document.body;
    if (this.els.root.parentNode !== parent) parent.appendChild(this.els.root);
    this.els.root.classList.toggle("in-player", !!player);
    this.applyWin();
  },

  onParty(party) {
    const id = party && party.id ? String(party.id) : null;
    if (!id) {
      if (this.room) this.leave();
      this.hide();
      return;
    }
    if (this.room && this.room !== id) this.leave();
    this.room = id;
    this.memberId = String(party.memberId || "");
    const me = (party.members || []).find((m) => (m.member_id || m.memberId) === party.memberId);
    this.myName = (me && (me.display_name || me.displayName)) || party.displayName || "Guest";
    this._media = party.media || null;
    this.useProfileName();
    this.show();
    this.render();
  },

  // The party often only knows "Guest"/"You" on the web; the signed-in Nuvio
  // profile has the real name, so prefer it.
  useProfileName() {
    try {
      Promise.resolve(ProfileManager.getProfiles())
        .then((profiles) => {
          const activeId = String(ProfileManager.getActiveProfileId() || "");
          const list = Array.isArray(profiles) ? profiles : [];
          const active =
            list.find((p) => String(p.id || p.profileIndex || "1") === activeId) || list[0];
          const name = String((active && active.name) || "").trim();
          if (name && (!this.myName || /^(guest|you)$/i.test(String(this.myName).trim())))
            this.myName = name;
        })
        .catch(() => {});
    } catch (_) {
      // keep the name we have
    }
  },

  // What is being watched right now, e.g. "Bee Movie" or "Show S1E2".
  movieLabel() {
    const m = this._media;
    if (!m) return "";
    const title = String(m.title || "").trim();
    if (!title) return "";
    const ep = m.season != null && m.episode != null ? " S" + m.season + "E" + m.episode : "";
    return (title + ep).slice(0, 120);
  },

  // ---- WebRTC ----
  withLock(fn) {
    const run = this.lock.then(fn, fn);
    this.lock = run.then(
      () => {},
      () => {}
    );
    return run;
  },

  async api(method, path, body) {
    const opt = { method, headers: { "content-type": "application/json" } };
    if (body !== undefined) opt.body = JSON.stringify(body);
    const r = await fetch(CALL_SERVER + path, opt);
    const t = await r.text();
    if (!r.ok) throw new Error(path + " -> " + r.status + " " + t.slice(0, 120));
    return t ? JSON.parse(t) : {};
  },

  async start() {
    if (this.phase !== "idle") return;
    this.phase = "connecting";
    this.render();
    try {
      await this.startMedia();
      await this.withLock(() => this.connectSfu());
      this.phase = "connected";
      await this.heartbeat();
      this.presenceTimer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
      if (this._mediaNote) this.showError(this._mediaNote);
    } catch (e) {
      console.warn("PartyCallOverlay: start failed", e);
      this.phase = "idle";
      this.showError(e && e.message ? e.message : "Couldn't start the call");
      this.cleanup();
    }
    this.render();
  },

  async startMedia() {
    // Mic audio without the browser's call processing. echoCancellation (on by
    // default) marks the whole session as a "communication" stream, which makes
    // Chrome/Windows duck and low-pass everything else playing — that's what
    // muffles the movie while a call is open. Turning the three processors off
    // keeps the movie full-fidelity. Trade-off: on open speakers the other side
    // may hear a faint echo of your movie, so headphones are ideal.
    const micAudio = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    };
    // Try camera+mic, then mic only, then camera only, so a PC without a
    // camera still sends audio instead of silently sending nothing.
    const attempts = [
      { video: { width: 640, height: 480 }, audio: micAudio },
      { audio: micAudio },
      { video: { width: 640, height: 480 } }
    ];
    const isPermissionError = (e) =>
      e &&
      (e.name === "NotAllowedError" ||
        e.name === "SecurityError" ||
        e.name === "PermissionDeniedError");
    let lastErr = null;
    this.localStream = null;
    this._mediaNote = "";
    for (let i = 0; i < attempts.length && !this.localStream; i++) {
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)
          throw new Error("getUserMedia unavailable (needs a secure https page)");
        this.localStream = await navigator.mediaDevices.getUserMedia(attempts[i]);
      } catch (e) {
        lastErr = e;
        // A blocked permission won't change across the other attempts, so stop
        // early and tell the user exactly how to unblock it.
        if (isPermissionError(e)) break;
      }
    }
    if (!this.localStream) {
      this.localStream = new MediaStream();
      this.camOn = false;
      this.micOn = false;
      const name = lastErr && lastErr.name;
      if (isPermissionError(lastErr)) {
        this._mediaNote =
          "Camera/mic is blocked. Click the camera icon in your browser's address bar, set it to Allow, then start the call again.";
      } else if (name === "NotReadableError" || name === "TrackStartError") {
        this._mediaNote = "Your camera/mic is in use by another app. Close it and try again.";
      } else {
        this._mediaNote =
          "No mic/camera found (" +
          (name || (lastErr && lastErr.message) || "unknown") +
          "). Joined without sending audio/video.";
      }
    } else {
      this.micOn = this.localStream.getAudioTracks().length > 0;
      this.camOn = this.localStream.getVideoTracks().length > 0;
      if (!this.camOn && this.micOn)
        this._mediaNote = "No camera found. Joined with microphone only.";
      else if (!this.micOn && this.camOn)
        this._mediaNote = "No microphone found. Joined with camera only.";
    }
  },

  async connectSfu() {
    this.pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
      bundlePolicy: "max-bundle"
    });
    const audioTrack = this.localStream.getAudioTracks()[0];
    const videoTrack = this.localStream.getVideoTracks()[0];
    const txA = this.pc.addTransceiver(audioTrack || "audio", { direction: "sendonly" });
    const txV = this.pc.addTransceiver(videoTrack || "video", { direction: "sendonly" });
    const s = await this.api("POST", "/sfu/sessions/new", {});
    this.sessionId = s.sessionId;
    await this.pc.setLocalDescription(await this.pc.createOffer());
    const tracks = [];
    if (txA.mid != null) tracks.push({ location: "local", mid: txA.mid, trackName: "a" });
    if (txV.mid != null) tracks.push({ location: "local", mid: txV.mid, trackName: "v" });
    const res = await this.api("POST", "/sfu/sessions/" + this.sessionId + "/tracks/new", {
      sessionDescription: { type: "offer", sdp: this.pc.localDescription.sdp },
      tracks
    });
    await this.pc.setRemoteDescription({ type: "answer", sdp: res.sessionDescription.sdp });
  },

  // The SFU rejects pulls ("Session is not ready yet", 425) until the local
  // PeerConnection has actually finished connecting, so wait for that first.
  waitForConnected(timeoutMs = 12000) {
    const pc = this.pc;
    return new Promise((resolve, reject) => {
      if (!pc) return reject(new Error("no peer connection"));
      const ok = () =>
        pc.connectionState === "connected" ||
        pc.iceConnectionState === "connected" ||
        pc.iceConnectionState === "completed";
      if (ok()) return resolve();
      const timer = setTimeout(() => done(new Error("peer connection not ready")), timeoutMs);
      const check = () => {
        if (ok()) done();
      };
      const done = (err) => {
        clearTimeout(timer);
        pc.removeEventListener("connectionstatechange", check);
        pc.removeEventListener("iceconnectionstatechange", check);
        err ? reject(err) : resolve();
      };
      pc.addEventListener("connectionstatechange", check);
      pc.addEventListener("iceconnectionstatechange", check);
    });
  },

  pullPeer(peer) {
    return this.withLock(async () => {
      await this.waitForConnected();
      const names = ["a", "v"];
      const res = await this.api("POST", "/sfu/sessions/" + this.sessionId + "/tracks/new", {
        tracks: names.map((n) => ({ location: "remote", sessionId: peer.sessionId, trackName: n }))
      });
      if (res.requiresImmediateRenegotiation && res.sessionDescription) {
        await this.pc.setRemoteDescription({ type: "offer", sdp: res.sessionDescription.sdp });
        await this.pc.setLocalDescription(await this.pc.createAnswer());
        await this.api("PUT", "/sfu/sessions/" + this.sessionId + "/renegotiate", {
          sessionDescription: { type: "answer", sdp: this.pc.localDescription.sdp }
        });
      }
      const stream = new MediaStream();
      (res.tracks || []).forEach((t) => {
        if (t.errorCode || !t.mid) return;
        const tx = this.pc.getTransceivers().find((x) => x.mid === t.mid);
        if (tx && tx.receiver && tx.receiver.track) stream.addTrack(tx.receiver.track);
      });
      return stream;
    });
  },

  async heartbeat() {
    if (this.phase !== "connected") return;
    try {
      const res = await this.api("POST", "/rooms/" + encodeURIComponent(this.room) + "/join", {
        memberId: this.memberId,
        name: this.myName,
        movie: this.movieLabel(),
        sessionId: this.sessionId,
        tracks: ["a", "v"],
        camera: this.camOn,
        mic: this.micOn
      });
      await this.reconcile(res.peers || []);
    } catch (e) {
      console.warn("PartyCallOverlay: heartbeat", e.message);
    }
  },

  async reconcile(peers) {
    const seen = {};
    for (const p of peers) {
      if (!p || p.memberId === this.memberId) continue;
      seen[p.memberId] = true;
      let remote = this.remotes[p.memberId];
      if (!remote) remote = this.remotes[p.memberId] = { info: p };
      else remote.info = p;
      // Pull when we have no tracks for this peer yet. A failed or empty pull is
      // retried on the next heartbeat instead of leaving the peer silent forever.
      if (!remote.stream || remote.stream.getTracks().length === 0) {
        try {
          remote.stream = await this.pullPeer(p);
        } catch (e) {
          console.warn("pull", e.message);
        }
      }
    }
    Object.keys(this.remotes).forEach((id) => {
      if (!seen[id]) delete this.remotes[id];
    });
    this.render();
  },

  setMic(on) {
    this.micOn = on;
    this.localStream.getAudioTracks().forEach((t) => (t.enabled = on));
    this.render();
  },
  setCam(on) {
    this.camOn = on;
    this.localStream.getVideoTracks().forEach((t) => (t.enabled = on));
    this.render();
  },

  leave() {
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.presenceTimer = null;
    const room = this.room;
    const me = this.memberId;
    if (room && me) {
      try {
        fetch(CALL_SERVER + "/rooms/" + encodeURIComponent(room) + "/leave", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ memberId: me }),
          keepalive: true
        }).catch(() => {});
      } catch (_) {}
    }
    this.cleanup();
    this.phase = "idle";
    this.render();
  },

  // The tile <video> elements are muted (they only show picture), so each
  // remote's voice is played through its own persistent <audio> element that
  // lives outside the re-rendered overlay root.
  syncRemoteAudio() {
    if (!this.audioEls) this.audioEls = {};
    const live = {};
    Object.entries(this.remotes || {}).forEach(([id, r]) => {
      const stream = r && r.stream;
      if (!stream || !stream.getAudioTracks().length) return;
      live[id] = true;
      let el = this.audioEls[id];
      if (!el) {
        el = document.createElement("audio");
        el.autoplay = true;
        el.setAttribute("data-nuvio-call-audio", id);
        el.style.display = "none";
        document.body.appendChild(el);
        this.audioEls[id] = el;
      }
      if (el.srcObject !== stream) el.srcObject = stream;
      if (el.paused) el.play().catch(() => {});
    });
    Object.keys(this.audioEls).forEach((id) => {
      if (live[id]) return;
      const el = this.audioEls[id];
      try {
        el.pause();
        el.srcObject = null;
        el.remove();
      } catch (_) {}
      delete this.audioEls[id];
    });
  },

  cleanup() {
    this.remotes = {};
    this.syncRemoteAudio();
    this.sessionId = null;
    try {
      if (this.pc) this.pc.close();
    } catch (_) {}
    this.pc = null;
    try {
      if (this.localStream) this.localStream.getTracks().forEach((t) => t.stop());
    } catch (_) {}
    this.localStream = null;
  },

  // ---- UI ----
  injectStyles() {
    if (document.getElementById("nuvio-call-styles")) return;
    const css = `
#nuvio-call{position:fixed;right:18px;top:84px;z-index:2147483000;display:none;flex-direction:column;align-items:flex-end;gap:8px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;pointer-events:none}
#nuvio-call>*{pointer-events:auto}
#nuvio-call.in-player{position:absolute;right:18px;top:18px}
#nuvio-call .ncbtn{display:flex;align-items:center;gap:8px;background:rgba(16,16,22,.9);color:#fff;border:0;border-radius:999px;padding:10px 16px;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 4px 18px rgba(0,0,0,.4)}
#nuvio-call .nctiles{display:flex;flex-direction:column;gap:8px}
#nuvio-call .nctile{position:relative;width:150px;height:110px;border-radius:14px;overflow:hidden;background:#20202a;box-shadow:0 6px 20px rgba(0,0,0,.45)}
#nuvio-call .nctile.self{width:92px;height:68px}
#nuvio-call .nctile video{width:100%;height:100%;object-fit:cover}
#nuvio-call .ncav{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:30px;font-weight:700;color:#cfcfd6}
#nuvio-call .ncname{position:absolute;left:6px;bottom:6px;right:6px;font-size:11px;color:#fff;background:rgba(0,0,0,.55);border-radius:7px;padding:2px 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#nuvio-call .ncname .m{color:#e5484d;margin-right:3px}
#nuvio-call .ncctrls{display:flex;gap:6px;background:rgba(16,16,22,.9);border-radius:999px;padding:6px;box-shadow:0 4px 18px rgba(0,0,0,.4)}
#nuvio-call .ncc{width:38px;height:38px;border-radius:50%;border:0;background:#2a2a33;color:#fff;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center}
#nuvio-call .ncc.off{background:#e5484d}
#nuvio-call .ncc.end{background:#e5484d}
#nuvio-call .ncerr{max-width:220px;background:rgba(229,72,77,.92);color:#fff;font-size:12px;border-radius:10px;padding:6px 10px}
#nuvio-call .ncspin{width:16px;height:16px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:ncspin 1s linear infinite}
/* ---- call window (connected): glass panel, draggable + resizable ---- */
#nuvio-call.nc-win{pointer-events:auto;align-items:stretch;gap:0;padding:0;min-width:200px;min-height:150px;box-sizing:border-box;border-radius:18px;overflow:hidden;color:#fff;background:rgba(16,16,22,.74);-webkit-backdrop-filter:blur(18px) saturate(1.3);backdrop-filter:blur(18px) saturate(1.3);border:1px solid rgba(255,255,255,.1);box-shadow:0 14px 44px rgba(0,0,0,.55),0 0 0 .5px rgba(0,0,0,.6)}
#nuvio-call.nc-win.nc-min{min-height:0}
#nuvio-call.nc-win>*{pointer-events:auto}
#nuvio-call .nchead{display:flex;align-items:center;gap:8px;flex:0 0 auto;height:34px;padding:0 6px 0 12px;cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none}
#nuvio-call .nchead:active{cursor:grabbing}
#nuvio-call .ncgrip{display:flex;flex-direction:column;gap:3px;opacity:.45}
#nuvio-call .ncgrip i{display:block;width:16px;height:2px;border-radius:2px;background:#fff}
#nuvio-call .nctitle{flex:1;min-width:0;font-size:12px;font-weight:600;letter-spacing:.2px;color:rgba(255,255,255,.88);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#nuvio-call .nclive{display:inline-block;width:7px;height:7px;border-radius:50%;background:#3ddc84;margin-right:7px;box-shadow:0 0 8px #3ddc84}
#nuvio-call .ncmin{width:26px;height:26px;border:0;border-radius:8px;background:transparent;color:rgba(255,255,255,.7);font-size:15px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center}
#nuvio-call .ncmin:hover{background:rgba(255,255,255,.12);color:#fff}
#nuvio-call .ncbody{position:relative;flex:1 1 auto;min-height:0;padding:0 8px}
#nuvio-call.nc-min .ncbody{display:none}
#nuvio-call.nc-win .nctiles{position:relative;display:grid;gap:6px;width:100%;height:100%;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));grid-auto-rows:minmax(0,1fr)}
#nuvio-call.nc-win .nctile{width:auto;height:auto;min-height:0;border-radius:12px;background:#1b1b24;box-shadow:none}
#nuvio-call.nc-win .nctiles.has-remote .nctile.self{position:absolute;right:8px;bottom:8px;width:30%;max-width:120px;min-width:56px;height:auto;aspect-ratio:4/3;z-index:2;border-radius:10px;box-shadow:0 4px 14px rgba(0,0,0,.55);outline:2px solid rgba(255,255,255,.2)}
#nuvio-call .nctile.self video{transform:scaleX(-1)}
#nuvio-call.nc-win .ncname{font-size:11px;background:rgba(0,0,0,.5);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}
#nuvio-call.nc-win .ncctrls{flex:0 0 auto;justify-content:center;align-self:center;margin:8px 0 10px;background:rgba(255,255,255,.08);box-shadow:none;border:1px solid rgba(255,255,255,.08)}
#nuvio-call.nc-win .ncc{width:34px;height:34px;background:rgba(255,255,255,.12);transition:background .15s,transform .1s}
#nuvio-call.nc-win .ncc:hover{background:rgba(255,255,255,.22)}
#nuvio-call.nc-win .ncc:active{transform:scale(.92)}
#nuvio-call.nc-win .ncc.off,#nuvio-call.nc-win .ncc.end{background:#e5484d}
#nuvio-call.nc-win .ncc.off:hover,#nuvio-call.nc-win .ncc.end:hover{background:#f0595d}
#nuvio-call.nc-win .ncerr{max-width:none;margin:0 8px 6px;border-radius:9px}
#nuvio-call .ncresize{position:absolute;right:0;bottom:0;width:22px;height:22px;cursor:nwse-resize;touch-action:none;z-index:3;background:linear-gradient(135deg,transparent 52%,rgba(255,255,255,.35) 52%,rgba(255,255,255,.35) 58%,transparent 58%,transparent 70%,rgba(255,255,255,.35) 70%,rgba(255,255,255,.35) 76%,transparent 76%)}
#nuvio-call.nc-min .ncresize{display:none}
@keyframes ncspin{to{transform:rotate(360deg)}}`;
    const style = document.createElement("style");
    style.id = "nuvio-call-styles";
    style.textContent = css;
    document.head.appendChild(style);
  },

  buildUi() {
    const root = document.createElement("div");
    root.id = "nuvio-call";
    document.body.appendChild(root);
    this.els.root = root;
    this.loadWin();
    // Drag / resize are handled once on the root (children are re-rendered).
    root.addEventListener("pointerdown", (e) => this.onWinPointerDown(e));
    root.addEventListener("pointermove", (e) => this.onWinPointerMove(e));
    root.addEventListener("pointerup", (e) => this.onWinPointerUp(e));
    root.addEventListener("pointercancel", (e) => this.onWinPointerUp(e));
    // Swallow the click that ends a drag so the player underneath doesn't react.
    root.addEventListener(
      "click",
      (e) => {
        if (this._winJustDragged) {
          e.stopPropagation();
          e.preventDefault();
        }
      },
      true
    );
    window.addEventListener("resize", () => this.applyWin());
  },

  // ---- call window: position / size (web only), remembered between sessions ----
  loadWin() {
    this.win = { w: 264, h: 290, fx: null, fy: null, min: false };
    try {
      const saved = JSON.parse(localStorage.getItem("nuvio-call-win-v1") || "null");
      if (saved && typeof saved === "object") {
        ["w", "h"].forEach((k) => {
          if (Number.isFinite(saved[k])) this.win[k] = saved[k];
        });
        ["fx", "fy"].forEach((k) => {
          if (Number.isFinite(saved[k])) this.win[k] = saved[k];
        });
        this.win.min = !!saved.min;
      }
    } catch (_) {
      // storage unavailable: use defaults
    }
  },
  saveWin() {
    try {
      localStorage.setItem("nuvio-call-win-v1", JSON.stringify(this.win));
    } catch (_) {
      // best effort
    }
  },
  winParentBox() {
    const par = this.els.root && this.els.root.parentNode;
    if (!par || par === document.body)
      return { w: window.innerWidth, h: window.innerHeight, left: 0, top: 0 };
    const r = par.getBoundingClientRect();
    return { w: r.width, h: r.height, left: r.left, top: r.top };
  },
  applyWin() {
    const root = this.els.root;
    if (!root || !this.win) return;
    if (!root.classList.contains("nc-win")) {
      ["width", "height", "left", "top", "right"].forEach((p) => (root.style[p] = ""));
      return;
    }
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
    const b = this.winParentBox();
    const w = this.win;
    w.w = clamp(w.w, 200, b.w - 16);
    w.h = clamp(w.h, 150, b.h - 16);
    root.classList.toggle("nc-min", !!w.min);
    root.style.width = w.w + "px";
    root.style.height = w.min ? "auto" : w.h + "px";
    if (w.fx == null || w.fy == null) {
      // never moved: keep the default top-right anchor from the stylesheet
      ["left", "top", "right"].forEach((p) => (root.style[p] = ""));
      return;
    }
    const hh = w.min ? root.offsetHeight : w.h;
    root.style.left = clamp(w.fx * b.w, 0, b.w - w.w) + "px";
    root.style.top = clamp(w.fy * b.h, 0, b.h - hh) + "px";
    root.style.right = "auto";
  },
  onWinPointerDown(e) {
    const root = this.els.root;
    if (!root || !root.classList.contains("nc-win")) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (e.target.closest && e.target.closest("button")) return;
    const handle = e.target.closest && e.target.closest(".ncresize");
    const head = e.target.closest && e.target.closest(".nchead");
    if (!handle && !head) return;
    e.preventDefault();
    e.stopPropagation();
    const b = this.winParentBox();
    const rr = root.getBoundingClientRect();
    // Pin to explicit coordinates so a right-anchored window can be dragged/resized.
    const x = rr.left - b.left;
    const y = rr.top - b.top;
    this.win.fx = x / b.w;
    this.win.fy = y / b.h;
    this.applyWin();
    this._winDrag = {
      mode: handle ? "resize" : "move",
      id: e.pointerId,
      sx: e.clientX,
      sy: e.clientY,
      x,
      y,
      w: this.win.w,
      h: this.win.h,
      moved: false
    };
    try {
      root.setPointerCapture(e.pointerId);
    } catch (_) {}
  },
  onWinPointerMove(e) {
    const d = this._winDrag;
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    d.moved = true;
    const b = this.winParentBox();
    if (d.mode === "move") {
      const hh = this.win.min ? this.els.root.offsetHeight : this.win.h;
      this.win.fx = Math.min(Math.max(d.x + dx, 0), Math.max(0, b.w - this.win.w)) / b.w;
      this.win.fy = Math.min(Math.max(d.y + dy, 0), Math.max(0, b.h - hh)) / b.h;
    } else if (!this.win.min) {
      // grow/shrink from the bottom-right corner, never past the parent's edge
      this.win.w = Math.min(Math.max(d.w + dx, 200), Math.max(200, b.w - d.x));
      this.win.h = Math.min(Math.max(d.h + dy, 150), Math.max(150, b.h - d.y));
    }
    this.applyWin();
  },
  onWinPointerUp(e) {
    const d = this._winDrag;
    if (!d || e.pointerId !== d.id) return;
    this._winDrag = null;
    try {
      this.els.root.releasePointerCapture(e.pointerId);
    } catch (_) {}
    if (d.moved) {
      this._winJustDragged = true;
      setTimeout(() => (this._winJustDragged = false), 0);
    }
    this.saveWin();
  },

  show() {
    if (this.els.root) this.els.root.style.display = "flex";
    this.ensureMount();
  },
  hide() {
    if (this.els.root) this.els.root.style.display = "none";
  },
  showError(msg) {
    this._error = msg;
    this.render();
    setTimeout(() => {
      this._error = null;
      this.render();
    }, 5000);
  },

  render() {
    const root = this.els.root;
    if (!root) return;
    root.textContent = "";
    root.classList.remove("nc-win", "nc-min");
    const connected = this.phase === "connected";
    if (this._error) {
      const e = document.createElement("div");
      e.className = "ncerr";
      e.textContent = this._error;
      if (!connected) root.appendChild(e);
      else this._errEl = e;
    }
    if (this.phase === "idle") {
      const b = document.createElement("button");
      b.className = "ncbtn";
      b.innerHTML = "\u{1F4F9} Start video call";
      b.onclick = () => this.start();
      root.appendChild(b);
      this.applyWin();
      return;
    }
    if (this.phase === "connecting") {
      const b = document.createElement("div");
      b.className = "ncbtn";
      b.innerHTML = '<span class="ncspin"></span> Connecting…';
      root.appendChild(b);
      this.applyWin();
      return;
    }
    // connected: a draggable / resizable glass window (title bar, tiles, controls)
    this.syncRemoteAudio();
    root.classList.add("nc-win");
    const head = document.createElement("div");
    head.className = "nchead";
    head.title = "Drag to move";
    head.innerHTML =
      '<span class="ncgrip"><i></i><i></i></span><span class="nctitle"><span class="nclive"></span>Call' +
      (Object.keys(this.remotes).length ? " · " + (Object.keys(this.remotes).length + 1) : "") +
      "</span>";
    const minBtn = document.createElement("button");
    minBtn.className = "ncmin";
    minBtn.title = this.win.min ? "Expand" : "Minimize";
    minBtn.textContent = this.win.min ? "▢" : "–";
    minBtn.onclick = () => {
      this.win.min = !this.win.min;
      this.saveWin();
      this.render();
    };
    head.appendChild(minBtn);
    root.appendChild(head);
    if (this._errEl) root.appendChild(this._errEl);
    const body = document.createElement("div");
    body.className = "ncbody";
    const tiles = document.createElement("div");
    tiles.className = "nctiles" + (Object.keys(this.remotes).length ? " has-remote" : "");
    Object.values(this.remotes).forEach((r) => {
      const hasVideo = r.info.camera !== false && r.stream && r.stream.getVideoTracks().length > 0;
      tiles.appendChild(
        this.tile(r.info.name || "Guest", hasVideo ? r.stream : null, r.info.mic === false, false)
      );
    });
    // self
    const selfVideo =
      this.camOn && this.localStream && this.localStream.getVideoTracks().length
        ? this.localStream
        : null;
    tiles.appendChild(this.tile("You", selfVideo, !this.micOn, true));
    body.appendChild(tiles);
    root.appendChild(body);

    const ctrls = document.createElement("div");
    ctrls.className = "ncctrls";
    ctrls.appendChild(
      this.ctl(this.micOn ? "\u{1F3A4}" : "\u{1F507}", !this.micOn, () => this.setMic(!this.micOn))
    );
    ctrls.appendChild(
      this.ctl(this.camOn ? "\u{1F4F7}" : "\u{1F6AB}", !this.camOn, () => this.setCam(!this.camOn))
    );
    const end = this.ctl("\u{1F4DE}", false, () => this.leave());
    end.classList.add("end");
    ctrls.appendChild(end);
    root.appendChild(ctrls);
    const grip = document.createElement("div");
    grip.className = "ncresize";
    grip.title = "Drag to resize";
    root.appendChild(grip);
    this._errEl = null;
    this.applyWin();
  },

  tile(name, stream, muted, isSelf) {
    const el = document.createElement("div");
    el.className = "nctile" + (isSelf ? " self" : "");
    if (stream) {
      const v = document.createElement("video");
      v.autoplay = true;
      v.playsInline = true;
      v.muted = true;
      v.srcObject = stream;
      el.appendChild(v);
      v.play().catch(() => {});
    } else {
      const av = document.createElement("div");
      av.className = "ncav";
      av.textContent = (name || "?").trim().charAt(0).toUpperCase();
      el.appendChild(av);
    }
    const nm = document.createElement("div");
    nm.className = "ncname";
    nm.innerHTML = (muted ? '<span class="m">\u{1F507}</span>' : "") + escapeHtml(name);
    el.appendChild(nm);
    return el;
  },

  ctl(label, off, onClick) {
    const b = document.createElement("button");
    b.className = "ncc" + (off ? " off" : "");
    b.innerHTML = label;
    b.onclick = onClick;
    return b;
  }
};

function escapeHtml(t) {
  const d = document.createElement("div");
  d.textContent = t == null ? "" : String(t);
  return d.innerHTML;
}
