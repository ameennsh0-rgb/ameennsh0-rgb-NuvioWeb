import { httpRequest } from "../../../core/network/httpClient.js";
import { proxifyAddonUrl } from "../../../core/network/addonProxy.js";

export const StreamApi = {
  async getStreams(url, options = {}) {
    return httpRequest(proxifyAddonUrl(url), {
      ...options,
      includeSessionAuth: false
    });
  }
};
