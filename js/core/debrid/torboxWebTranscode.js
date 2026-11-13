import { DebridApi } from "../../data/remote/api/debridApi.js";
import { DebridProviders, DEBRID_PROVIDER_IDS } from "./debridProviders.js";
import { DebridSettingsStore } from "../../data/local/debridSettingsStore.js";
import { Platform } from "../../platform/index.js";

// Matches a TorBox-resolved addon URL, e.g. from Torrentio:
//   https://torrentio.strem.fun/resolve/torbox/<apikey>/<infohash>/<idx>/<name>
const TORBOX_RESOLVE_RE = /\/resolve\/torbox\/([^/]+)\/([a-fA-F0-9]{40})(?:\/(\d+))?(?:\/([^?#]*))?/;

const VIDEO_EXT_RE = /\.(mkv|mp4|avi|m4v|ts|webm|mov|wmv|flv|mpg|mpeg)$/i;

function pickVideoFile(files, wantedName) {
  if (!Array.isArray(files) || files.length === 0) return null;
  const videos = files.filter(
    (f) => /video\//i.test(f.mimetype || "") || VIDEO_EXT_RE.test(String(f.short_name || f.name || ""))
  );
  const pool = videos.length ? videos : files;
  if (wantedName) {
    const base = decodeURIComponent(wantedName).split("/").pop().toLowerCase();
    const match = pool.find((f) => {
      const n = String(f.short_name || f.name || "").toLowerCase();
      return n && base && (n.includes(base) || base.includes(n));
    });
    if (match) return match;
  }
  // Otherwise the largest file (the feature, not a sample).
  return pool.reduce((a, b) => (Number(b.size || 0) > Number(a.size || 0) ? b : a));
}

// On the web build, turn a TorBox-resolved stream URL into a TorBox transcoded
// HLS URL (H.264 + AAC) the browser can actually play, so HEVC/MKV/AC3/DTS files
// get sound and picture instead of a silent or stalled video. Returns null when
// it doesn't apply: not a TorBox URL, no API key, the file is already
// browser-compatible, or any error (caller then plays the original URL).
export async function maybeTorboxWebTranscode(url) {
  try {
    if (!Platform.isBrowser()) return null;
    const requested = String(url || "");
    const m = requested.match(TORBOX_RESOLVE_RE);
    console.info("[TBX] play url:", requested.slice(0, 120), "match:", Boolean(m));
    if (!m) return null;

    const hash = m[2];
    const filename = m[4] || "";

    const settings = DebridSettingsStore.get();
    // Prefer the key the user configured in Nuvio; fall back to the one in the
    // addon URL if the app doesn't have TorBox set up.
    let apiKey = DebridProviders.apiKeyFor?.(settings, DEBRID_PROVIDER_IDS.TORBOX) || "";
    if (!apiKey && m[1]) apiKey = decodeURIComponent(m[1]);
    console.info("[TBX] hash:", hash, "apiKey:", apiKey ? "present" : "MISSING");
    if (!apiKey) return null;

    const magnet = `magnet:?xt=urn:btih:${hash}`;
    const create = await DebridApi.torboxCreateTorrent(apiKey, magnet);
    const id = create.data?.data?.torrent_id ?? create.data?.data?.id;
    console.info("[TBX] createtorrent ok:", create.ok, "status:", create.status, "id:", id);
    if (!create.ok || !id) return null;

    const torrent = await DebridApi.torboxGetTorrent(apiKey, id);
    const files = torrent.data?.data?.files || [];
    const file = pickVideoFile(files, filename);
    console.info("[TBX] files:", files.length, "picked file id:", file?.id);
    if (!file || file.id == null) return null;

    const stream = await DebridApi.torboxCreateStream(apiKey, id, file.id, "torrent");
    const data = stream.data?.data || {};
    console.info("[TBX] createstream ok:", stream.ok, "needs_transcoding:", data.needs_transcoding, "hls:", data.hls_url ? "yes" : "no");
    // Only swap in the transcoded stream when the file actually needs it; a
    // browser-compatible file keeps its direct link (faster, no transcode load).
    if (stream.ok && data.hls_url && data.needs_transcoding) {
      return data.hls_url;
    }
    return null;
  } catch (error) {
    console.warn("[TBX] transcode error:", error?.message || error);
    return null;
  }
}
