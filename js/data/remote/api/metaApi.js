import { httpRequest } from "../../../core/network/httpClient.js";
import { proxifyAddonUrl } from "../../../core/network/addonProxy.js";

export const MetaApi = {
  async getMeta(url, options = {}) {
    return httpRequest(proxifyAddonUrl(url), {
      ...options,
      includeSessionAuth: false
    });
  }
};
