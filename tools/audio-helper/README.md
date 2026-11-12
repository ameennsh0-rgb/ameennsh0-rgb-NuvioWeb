# Nuvio audio helper

Some movies use audio the browser cannot decode (Dolby AC3/EAC3, DTS, TrueHD):
picture, no sound. This helper runs on **your own computer**, the same idea as
Stremio's streaming server. The web player detects a silent movie and asks the
helper for a stream where the video is copied untouched and only the audio is
converted to AAC. Nothing runs on Render or any server.

## Mac setup

```
brew install ffmpeg node
node tools/audio-helper/helper.mjs
```

Leave it running while you watch. It listens on `127.0.0.1:11471` only.

Start automatically at login (optional): create
`~/Library/LaunchAgents/nuvio.audio-helper.plist` with `ProgramArguments`
pointing to `node` and the full path of `helper.mjs`, `RunAtLoad` true,
`KeepAlive` true, then `launchctl load` it.

## Notes

- Works with Chrome, Edge and Firefox. Safari plays AC3/EAC3 natively and
  usually does not need it (it also blocks pages from calling `http://127.0.0.1`).
- Only pages from `*.workers.dev`, `localhost` and `127.0.0.1` may use it. Set
  `NUVIO_ORIGINS=my.site.com,*.example.com` to change that.
- Addresses on your private network and `localhost` are refused as sources.
- Video is copied, so HEVC/H.264 must already be playable in your browser.
- Seeking far ahead restarts the conversion at that point (a few seconds).
