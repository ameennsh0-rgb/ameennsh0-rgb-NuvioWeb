import { httpRequest } from "../../../core/network/httpClient.js";
import { requestAddonWithFallback } from "../../../core/network/addonProxy.js";

export const StreamApi = {
  async getStreams(url, options = {}) {
    return requestAddonWithFallback(httpRequest, url, {
      ...options,
      includeSessionAuth: false
    });
  }
};
