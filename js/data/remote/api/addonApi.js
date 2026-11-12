import { httpRequest } from "../../../core/network/httpClient.js";
import { requestAddonWithFallback } from "../../../core/network/addonProxy.js";

export const AddonApi = {
  async getManifest(url, options = {}) {
    return requestAddonWithFallback(httpRequest, url, {
      ...options,
      includeSessionAuth: false
    });
  },

  async getMeta(url) {
    return requestAddonWithFallback(httpRequest, url, {
      includeSessionAuth: false
    });
  },

  async getStreams(url) {
    return requestAddonWithFallback(httpRequest, url, {
      includeSessionAuth: false
    });
  },

  async getSubtitles(url) {
    return requestAddonWithFallback(httpRequest, url, {
      includeSessionAuth: false
    });
  }
};
