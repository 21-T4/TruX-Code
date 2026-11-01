# TruX Code v3 — drop-in files

Copy these into the repo root, keeping the folders (they overwrite server.js and package.json):

    server.js                      (changed)
    package.json                   (changed: new "bake" script, new files in "check")
    functions/html-patches.js      (new)
    functions/api/tts.js           (new)
    public/trux-v3.css             (new)
    public/trux-v3.js              (new)
    scripts/bake.js                (new)

public/index.html is NOT replaced. functions/html-patches.js applies nine exact-match edits to it when it is
served. Optional: run `npm run bake` once to write those edits into public/index.html for good.

Optional env vars: TTS_MODEL (default gemini-3.8-flash-tts), TTS_VOICE (default Kore).
