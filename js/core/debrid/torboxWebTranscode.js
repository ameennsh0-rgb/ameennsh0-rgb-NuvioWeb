import { Platform } from "../../platform/index.js";

// A TorBox download or CDN link (what Torrentio+TorBox hands the player).
const TORBOX_URL_RE = /torbox|tb-cdn\./i;

// On the web build, browsers can't play the MKV/HEVC/AC3/DTS files TorBox
// returns. The worker's /__tbxhls endpoint turns a TorBox link into a
// transcoded HLS URL (H.264 + AAC) that the browser can play — doing the
// TorBox API work server-side, since those calls have no CORS and the file
// name only comes back from the download host. Returns the HLS URL, or null
// when it doesn't apply (not a TorBox link, already playable, or any failure),
// in which case the caller plays the original URL.
export async function maybeTorboxWebTranscode(url, _hint = {}) {
  try {
    if (!Platform.isBrowser()) return null;
    const requested = String(url || "");
    if (!TORBOX_URL_RE.test(requested)) return null;
    // Already a transcoded HLS stream (e.g. a retry re-playing the output) —
    // don't try to transcode it again; just let the player play it.
    if (/playlist\.m3u8|\.m3u8(\?|$)|\/stream\/[0-9a-f-]{20,}\//i.test(requested)) {
      return null;
    }

    const location = globalThis.location;
    if (!location || !location.origin) return null;

    const endpoint = `${location.origin}/__tbxhls?src=${encodeURIComponent(requested)}`;
    const res = await fetch(endpoint, { headers: { accept: "application/json" } });
    if (!res.ok) {
      console.info("[TBX] worker status:", res.status);
      return null;
    }
    const data = await res.json();
    console.info("[TBX] worker hls:", data?.hls_url ? "yes" : "no", "needs_transcoding:", data?.needs_transcoding);
    if (data?.hls_url && data?.needs_transcoding) {
      return data.hls_url;
    }
    return null;
  } catch (error) {
    console.warn("[TBX] transcode error:", error?.message || error);
    return null;
  }
}
