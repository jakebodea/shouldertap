# Mac download flow demo

[Play or download the video demo](./mac-download-flow.mp4)

Recorded from the local production build of code revision `9b6a53068f64935900a4fc073f07b235c029a510`, using the real `https://download.shouldertap.app/Shouldertap.dmg` installer URL. The follow-up evidence commit adds only this note and the video; application code is unchanged.

The 14-second recording shows the home page, clicking **Download for Mac**, the installation instructions appearing automatically, and clicking the fallback **Download for Mac** link while staying on the instructions page. Browser chrome is outside the recorded viewport.

The browser's download handler confirmed both downloads completed successfully with filename `Shouldertap.dmg`. The downloaded files had identical SHA-256 hashes:

```text
3cccde8f106d3e4d86d33e21763b1c7a6bfe10224cf52cfe4307adb405a2eff4
```

Validation on the recorded code revision: web production build, TypeScript, changed-file Biome checks, and all 9 download tests passed in mobile WebKit (light/dark) and Chromium. The tests use a separate-origin local attachment server with a delayed response to verify the redirect cannot cancel the download.
