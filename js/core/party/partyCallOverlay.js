// Watch-party video call overlay for the web app.
//
// A self-contained floating bubble that appears while a watch party is active,
// letting everyone turn their camera/mic on and see each other. It joins the
// same Cloudflare SFU rooms (keyed by the party id) as the phone app, so web
// and phone callers share one call. It is decoupled from the party panel DOM:
// its own buttons are plain clickable elements.

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
    return typeof window !== "undefined" && typeof document !== "undefined" && !globalThis.tizen && !globalThis.webOS;
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
    this.show();
    this.render();
  },

  // ---- WebRTC ----
  withLock(fn) {
    const run = this.lock.then(fn, fn);
    this.lock = run.then(
      () => {},
      () => {},
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
    } catch (e) {
      console.warn("PartyCallOverlay: start failed", e);
      this.phase = "idle";
      this.showError(e && e.message ? e.message : "Couldn't start the call");
      this.cleanup();
    }
    this.render();
  },

  async startMedia() {
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: true });
    } catch (e) {
      this.localStream = new MediaStream();
      this.camOn = false;
      this.micOn = false;
    }
  },

  async connectSfu() {
    this.pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
      bundlePolicy: "max-bundle",
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
      tracks,
    });
    await this.pc.setRemoteDescription({ type: "answer", sdp: res.sessionDescription.sdp });
  },

  pullPeer(peer) {
    return this.withLock(async () => {
      const names = ["a", "v"];
      const res = await this.api("POST", "/sfu/sessions/" + this.sessionId + "/tracks/new", {
        tracks: names.map((n) => ({ location: "remote", sessionId: peer.sessionId, trackName: n })),
      });
      if (res.requiresImmediateRenegotiation && res.sessionDescription) {
        await this.pc.setRemoteDescription({ type: "offer", sdp: res.sessionDescription.sdp });
        await this.pc.setLocalDescription(await this.pc.createAnswer());
        await this.api("PUT", "/sfu/sessions/" + this.sessionId + "/renegotiate", {
          sessionDescription: { type: "answer", sdp: this.pc.localDescription.sdp },
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
        sessionId: this.sessionId,
        tracks: ["a", "v"],
        camera: this.camOn,
        mic: this.micOn,
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
      if (!this.remotes[p.memberId]) {
        this.remotes[p.memberId] = { info: p };
        try {
          this.remotes[p.memberId].stream = await this.pullPeer(p);
        } catch (e) {
          console.warn("pull", e.message);
        }
      } else {
        this.remotes[p.memberId].info = p;
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
          keepalive: true,
        }).catch(() => {});
      } catch (_) {}
    }
    this.cleanup();
    this.phase = "idle";
    this.render();
  },

  cleanup() {
    this.remotes = {};
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
#nuvio-call{position:fixed;right:18px;top:84px;z-index:2147483000;display:none;flex-direction:column;align-items:flex-end;gap:8px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
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
  },

  show() {
    if (this.els.root) this.els.root.style.display = "flex";
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
    if (this._error) {
      const e = document.createElement("div");
      e.className = "ncerr";
      e.textContent = this._error;
      root.appendChild(e);
    }
    if (this.phase === "idle") {
      const b = document.createElement("button");
      b.className = "ncbtn";
      b.innerHTML = "\u{1F4F9} Start video call";
      b.onclick = () => this.start();
      root.appendChild(b);
      return;
    }
    if (this.phase === "connecting") {
      const b = document.createElement("div");
      b.className = "ncbtn";
      b.innerHTML = '<span class="ncspin"></span> Connecting…';
      root.appendChild(b);
      return;
    }
    // connected: tiles + controls
    const tiles = document.createElement("div");
    tiles.className = "nctiles";
    Object.values(this.remotes).forEach((r) => {
      const hasVideo = r.info.camera !== false && r.stream && r.stream.getVideoTracks().length > 0;
      tiles.appendChild(this.tile(r.info.name || "Guest", hasVideo ? r.stream : null, r.info.mic === false, false));
    });
    // self
    const selfVideo = this.camOn && this.localStream && this.localStream.getVideoTracks().length ? this.localStream : null;
    tiles.appendChild(this.tile("You", selfVideo, !this.micOn, true));
    root.appendChild(tiles);

    const ctrls = document.createElement("div");
    ctrls.className = "ncctrls";
    ctrls.appendChild(this.ctl(this.micOn ? "\u{1F3A4}" : "\u{1F507}", !this.micOn, () => this.setMic(!this.micOn)));
    ctrls.appendChild(this.ctl(this.camOn ? "\u{1F4F7}" : "\u{1F6AB}", !this.camOn, () => this.setCam(!this.camOn)));
    const end = this.ctl("\u{1F4DE}", false, () => this.leave());
    end.classList.add("end");
    ctrls.appendChild(end);
    root.appendChild(ctrls);
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
  },
};

function escapeHtml(t) {
  const d = document.createElement("div");
  d.textContent = t == null ? "" : String(t);
  return d.innerHTML;
}
