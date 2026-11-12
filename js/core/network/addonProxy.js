import { Platform } from "../../platform/index.js";

// Stremio-style addons are fetched directly from the browser. Many popular
// hosts (anything on ElfHosted: Comet, Torrentio-on-ElfHosted, …) do not send
// CORS headers, so the browser blocks the request and the stream list comes
// back empty. The web build therefore routes cross-origin addon requests
// through the worker's same-origin /__addon proxy, which adds CORS server-side.
//
// Native builds (Android/webOS/Tizen) don't enforce CORS and have no such
// origin, so this is a no-op there — the URL is returned unchanged.
export function proxifyAddonUrl(url) {
  const original = String(url || "");
  if (!original) return original;
  try {
    if (!Platform.isBrowser()) return original;
    const location = globalThis.location;
    if (!location || !location.origin) return original;

    const target = new URL(original, location.href);
    if (target.protocol !== "https:" && target.protocol !== "http:") return original;
    // Already same-origin (relative paths, or an addon served from our own
    // origin) — no proxy needed.
    if (target.origin === location.origin) return original;

    return `${location.origin}/__addon?u=${encodeURIComponent(target.toString())}`;
  } catch {
    return original;
  }
}

// Try the addon directly from the browser first. Many addons (Torrentio,
// MediaFusion, ...) allow cross-origin requests but refuse traffic that comes
// from Cloudflare's servers, so going through the proxy gets them blocked. If
// the direct request fails before the addon answers (blocked by CORS, network
// error), fall back to the same-origin proxy.
export async function requestAddonWithFallback(request, url, options = {}) {
  const proxied = proxifyAddonUrl(url);
  if (proxied === url) return request(url, options);
  try {
    return await request(url, options);
  } catch (error) {
    const aborted = error?.name === "AbortError" || options?.signal?.aborted;
    if (aborted || Number(error?.status || 0) > 0) throw error;
    return request(proxied, options);
  }
}
