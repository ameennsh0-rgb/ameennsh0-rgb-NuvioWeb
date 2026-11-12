import { httpRequest } from "../../../core/network/httpClient.js";
import { proxifyAddonUrl } from "../../../core/network/addonProxy.js";

export const AddonApi = {
  async getManifest(url, options = {}) {
    return httpRequest(proxifyAddonUrl(url), {
      ...options,
      includeSessionAuth: false
    });
  },

  async getMeta(url) {
    return httpRequest(proxifyAddonUrl(url), {
      includeSessionAuth: false
    });
  },

  async getStreams(url) {
    return httpRequest(proxifyAddonUrl(url), {
      includeSessionAuth: false
    });
  },

  async getSubtitles(url) {
    return httpRequest(proxifyAddonUrl(url), {
      includeSessionAuth: false
    });
  }
};
