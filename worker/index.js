// Cloudflare Worker entry for the Nuvio web app.
//
// It serves the built static site (dist/) AND exposes a small same-origin
// proxy at /__addon so the browser can reach Stremio-style addons that do not
// send CORS headers (e.g. anything hosted on ElfHosted: Comet, Torrentio-on-
// ElfHosted, etc.). Native builds (Android/webOS/Tizen) don't enforce CORS, so
// only the browser build rewrites addon requests through this proxy.

const ADDON_PROXY_PATH = "/__addon";

// Hosts we must never let the proxy reach (SSRF guard). Addon servers are
// public domains, so blocking loopback / private / link-local space costs us
// nothing and stops the proxy being used to probe internal services.
function isBlockedHost(hostname) {
  const host = String(hostname || "")
    .toLowerCase()
    .replace(/\.$/, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;
  // Bare IPv4
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // loopback
    if (a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  // IPv6 loopback / unique-local / link-local
  if (host === "::1" || host === "[::1]") return true;
  if (/^\[?(fc|fd)[0-9a-f]{2}:/i.test(host)) return true;
  if (/^\[?fe80:/i.test(host)) return true;
  return false;
}

async function handleAddonProxy(request, url) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": "content-type, range",
        "access-control-max-age": "86400"
      }
    });
  }
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const raw = url.searchParams.get("u");
  if (!raw) {
    return new Response("Missing target", { status: 400 });
  }

  let target;
  try {
    target = new URL(raw);
  } catch {
    return new Response("Bad target", { status: 400 });
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    return new Response("Unsupported scheme", { status: 400 });
  }
  if (isBlockedHost(target.hostname)) {
    return new Response("Blocked host", { status: 403 });
  }

  const controller = new AbortController();
  // Debrid addons (Comet + TorBox/RealDebrid) can take 20-40s to resolve, and
  // the app waits up to 60s per source, so keep the proxy just under that.
  const timeout = setTimeout(() => controller.abort(), 55000);
  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      method: "GET",
      headers: {
        // Some addons reject an empty UA; forward a plain one.
        "user-agent": request.headers.get("user-agent") || "Nuvio-Web/1.0",
        accept: "application/json, text/plain, */*"
      },
      redirect: "follow",
      signal: controller.signal
    });
  } catch (error) {
    clearTimeout(timeout);
    const reason = error?.name === "AbortError" ? "Upstream timed out" : "Upstream fetch failed";
    return new Response(reason, {
      status: 502,
      headers: { "access-control-allow-origin": "*" }
    });
  }
  clearTimeout(timeout);

  const headers = new Headers();
  headers.set("access-control-allow-origin", "*");
  const contentType = upstream.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  // Addon manifests/streams change rarely; a short cache keeps the proxy cheap.
  headers.set("cache-control", "public, max-age=60");

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers
  });
}

const TBX_HLS_PATH = "/__tbxhls";
const TORBOX_API = "https://api.torbox.app";

function jsonResponse(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" }
  });
}

function filenameFromContentDisposition(cd) {
  if (!cd) return "";
  // Prefer RFC 5987 filename* (UTF-8), else plain filename.
  const star = cd.match(/filename\*=(?:UTF-8'')?([^;]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      /* fall through */
    }
  }
  const plain = cd.match(/filename="?([^";]+)"?/i);
  return plain ? plain[1].trim() : "";
}

// Resolve a TorBox download/CDN link into a browser-playable transcoded HLS
// URL. The browser can't do this itself (TorBox's API sends no CORS headers and
// the file name only comes back on the download host), so the worker does it:
// read the file name from the download link, find that file in the user's
// TorBox library, and ask TorBox to create a transcoded stream for it.
async function handleTbxHls(request, url) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": "content-type"
      }
    });
  }
  const src = url.searchParams.get("src");
  if (!src) return jsonResponse(400, { error: "missing src" });

  let target;
  try {
    target = new URL(src);
  } catch {
    return jsonResponse(400, { error: "bad src" });
  }
  if (!/(^|\.)tb-cdn\.|torbox/i.test(target.hostname + target.pathname)) {
    return jsonResponse(400, { error: "not a torbox url" });
  }
  const token = target.searchParams.get("token") || url.searchParams.get("token");
  if (!token) return jsonResponse(400, { error: "no token" });
  const auth = { Authorization: `Bearer ${token}` };

  // 1. Get the exact file name from the download link (a 1-byte range request
  //    is enough to read the Content-Disposition header).
  let filename = "";
  try {
    const head = await fetch(target.toString(), { headers: { Range: "bytes=0-0" } });
    filename = filenameFromContentDisposition(head.headers.get("content-disposition"));
  } catch {
    /* ignore */
  }
  if (!filename) return jsonResponse(502, { error: "could not read filename" });

  // 2. Find that file in the user's TorBox library.
  let list;
  try {
    const res = await fetch(`${TORBOX_API}/v1/api/torrents/mylist?bypass_cache=false`, { headers: auth });
    list = await res.json();
  } catch {
    return jsonResponse(502, { error: "mylist failed" });
  }
  const torrents = Array.isArray(list?.data) ? list.data : [];
  const wanted = filename.toLowerCase();
  let foundId = null;
  let foundFileId = null;
  for (const t of torrents) {
    const files = Array.isArray(t?.files) ? t.files : [];
    for (const f of files) {
      const short = String(f.short_name || "").toLowerCase();
      const name = String(f.name || "").toLowerCase();
      if (short === wanted || name.endsWith(wanted) || (short && wanted.includes(short)) || (name && name.includes(wanted))) {
        foundId = t.id;
        foundFileId = f.id;
        break;
      }
    }
    if (foundId != null) break;
  }
  if (foundId == null || foundFileId == null) {
    return jsonResponse(404, { error: "file not found in torbox library" });
  }

  // 3. Create a transcoded stream for it.
  let cs;
  try {
    const q = new URLSearchParams({
      token,
      id: String(foundId),
      file_id: String(foundFileId),
      type: "torrent"
    });
    const res = await fetch(`${TORBOX_API}/v1/api/stream/createstream?${q.toString()}`, { headers: auth });
    cs = await res.json();
  } catch {
    return jsonResponse(502, { error: "createstream failed" });
  }
  const data = cs?.data || {};
  if (!data.hls_url) return jsonResponse(502, { error: "no hls_url" });
  return jsonResponse(200, { hls_url: data.hls_url, needs_transcoding: Boolean(data.needs_transcoding) });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === ADDON_PROXY_PATH) {
      return handleAddonProxy(request, url);
    }
    if (url.pathname === TBX_HLS_PATH) {
      return handleTbxHls(request, url);
    }
    // Everything else is a static asset (SPA fallback handled by the binding).
    return env.ASSETS.fetch(request);
  }
};

// Exported for local tests.
export { handleAddonProxy, isBlockedHost, handleTbxHls };
