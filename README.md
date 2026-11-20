# Salah OS Flasher — test build (v0.9.0)

A runnable Electron app wrapping the finalized UI, wired to real `adb`/`fastboot`.
**Ships in dry-run**, so it is safe to point at the new frame today: it really detects
the frame and runs preflight (read-only), and the flash button logs every command it
*would* run without changing anything on the device.

---

## Is this a portable app or does it need prerequisites?

**This test build needs prerequisites.** It is editable source so you can iterate on the
UI, not a packaged app yet. To run it you need:

1. **Node.js** (LTS) installed on the PC — https://nodejs.org . One-time.
2. **adb.exe / fastboot.exe** — the app uses your existing `C:\adb-tools\…` by default
   (set in `config.json`). It does *not* bundle them in this build.

**The shipping version will be fully portable, zero prerequisites.** Electron packages
into a standalone app (`electron-builder`) that bundles its own Chromium + Node runtime,
your UI, and the adb/fastboot binaries + images. You copy one folder (or run one
installer) to any Windows PC and launch it — no Node, no separate adb. See *Packaging*
below. (The only thing that can still need attention is the Windows **USB driver** for
certain modes, but adb and the Google-VID fastboot already work on your PC.)

---

## Run it (test build)

```
cd salahos-flasher
npm install        # one-time; downloads Electron (~200 MB)
npm start
```

A frameless 820×480 window opens with a **DRY RUN** pill in the header.

---

## What to test on the new frame

This is Phase A's safe surface — nothing is modified:

1. Plug the frame into the PC. With USB debugging **off** it won't appear (stays IDLE —
   that's the known gap). Enable USB debugging on the frame (Settings → Developer options).
2. When it connects but isn't authorized yet → **PREPARE** ("Turn on USB debugging"). Tap
   *Allow* on the frame.
3. It authorizes → **DETECTED** → preflight runs → **READY** (fingerprint + board match)
   or **BLOCKED** (mismatch, with the reason).
4. Click **Flash** → confirm → watch the progress and open **Logs** (footer). In dry-run it
   prints the exact command sequence it would run, then lands on **DONE**. The frame is
   untouched.

Open **Logs** to see the real preflight values read off your frame, and the technical
info (gear icon) to confirm the mode is *Dry run*.

---

## Config (`config.json`)

- `dryRun: true` — keep this until images exist AND unlock is proven on a throwaway unit
  (runbook Phase A). Live execution is intentionally not implemented in this build; setting
  `dryRun:false` now will stop at the unlock step by design.
- `tools.adb` / `tools.fastboot` — point at your binaries (forward slashes are fine).
- `images.*` — empty for now; fill once `build-salahos-product.sh` has produced them.
- `golden.fingerprint` — the verified build; a frame that doesn't match is BLOCKED.

---

## Files

| File | Role |
|---|---|
| `index.html` | the UI (your design, rewired to `window.flasherAPI`; simulator dock removed, PREPARE state added) |
| `main.js` | device core — polls adb/fastboot, preflight, dry-run flash runner, state machine |
| `preload.js` | the `window.flasherAPI` bridge (renderer gets no shell access) |
| `config.json` | golden fingerprint, tool paths, images, dryRun |

Only the wiring in `index.html` was touched per your handoff §5/§6 — the visual design is
unchanged. PREPARE's copy/icon are placeholders for you to tune.

---

## Packaging to a portable app (later)

```
npm i -D electron-builder
# package.json: add a "build" block (appId, win target: portable or nsis),
#   extraResources: bin/adb.exe, bin/fastboot.exe, img/*, config.json
npx electron-builder --win portable
```

Output is a single self-contained `.exe` (or folder) that runs on any Windows PC with no
Node and no separate adb install — the real bench tool.
