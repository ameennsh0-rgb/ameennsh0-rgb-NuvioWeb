import { httpRequest } from "../../../core/network/httpClient.js";
import { proxifyAddonUrl } from "../../../core/network/addonProxy.js";

export const SubtitleApi = {
  async getSubtitles(url) {
    return httpRequest(proxifyAddonUrl(url), {
      includeSessionAuth: false
    });
  }
};
