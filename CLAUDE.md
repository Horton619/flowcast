# FlowCast

Audio cue playback for live events. Electron renderer + Python audio backend (subprocess, line-delimited JSON over stdout/stdin). Distributed as signed + notarized DMG (macOS) and NSIS installer (Windows). Auto-updates via electron-updater + GitHub Releases. Mirrors QLab's v3/v4 OSC API so Bitfocus Companion works unchanged.

## ⚠ READ FIRST — load the right topic doc before writing code

| If your task touches… | Read first |
|---|---|
| `backend/main.py` `play_cue`, `_load_audio`, the playback callback, `sf.*` / `sd.*` calls, `set_volume`, `set_pan`, `duck_cue`, `fadeout_cue`, the `my_info` dict, gain/fade ramping, the `_sndfile_lock` | `docs/AUDIO_ENGINE.md` |
| `_device_poll`, `system_profiler`, `rescan_devices`, `sd._terminate/_initialize`, the device banners (red lost / blue added / amber default-changed), `handleDevicesChanged`, `triggerLiveRebind`, `fireCueAtPosition`, `playFrom`, the Settings → Output Device dropdown | `docs/DEVICE_CHANGES.md` |
| `state.playingCues`, `fireCue` / `fireCombo` / `fireCueAtPosition`, `stopCue` / `stopAll` / `panic`, `cueDone`, `pendingAutoFireTimers`, `scheduleAutoFire`, GO logic, Play With / Auto-Play Next, `preWaitTimer`, `clipTimers` | `docs/CUE_LIFECYCLE.md` |
| `renderer/lte.js`, any `lte*` function, the BEGIN EDIT button, combo cue authoring, trim handles, LTE waveform rendering, `lteState` | `docs/LTE.md` |
| `main.js` stdout/stdin handling, `preload.js`, `window.flowcast.*`, `sendToBackend`, `onBackendMessage`, JSON message types, `pendingBackendMessages`, `renderer-ready`, `readline.createInterface` | `docs/IPC.md` |
| OSC handlers, `start_osc_server`, SLIP framing, the Companion handshake (`/workspaces`, `/workspace/{id}/connect`), `_tcp_conn_local`, the OSC popover | `docs/OSC.md` |
| Settings → Updates UI, the restart-now banner, `paintUpdateStatus`, the `update-status` IPC channel, `autoUpdater.*` event handlers | `docs/AUTO_UPDATE.md` |
| Code signing, notarization, GitHub Releases CI, electron-builder config, `.p12` / `CSC_LINK` / `APPLE_*` secrets | `~/.claude/CLAUDE.md` § "Apple code signing" + § "In-app auto-update" |

## Universal rules (apply everywhere — no doc-load required)

- **Never use system `python3`.** Always `backend/venv/bin/python3` and `backend/venv/bin/pip`. The bundled binary in production uses PyInstaller — see `backend/main.spec`.
- **Backend ↔ main IPC is line-delimited JSON.** One JSON object per line, newline-terminated, no embedded newlines. `send()` in backend, `JSON.stringify(msg) + '\n'` in main.
- **Renderer can't access Node.** `contextIsolation: true, nodeIntegration: false`. All capabilities go through `preload.js` → `window.flowcast.*`.
- **Don't commit `BUGFIX_PLAN.md`.** It's a scratchpad from the combo-clip-duration session. Stays local. Not in `.gitignore` because it predates the convention, just don't `git add` it.
- **Don't push without explicit instruction.** Commits when asked, pushes when told to push.
- **Mac releases are arm64-only right now.** Intel was disabled in `release.yml` (queue too slow). If we re-enable, the `macos-13` job needs to publish its own DMG alongside the arm64 one.
- **Team ID `L5KZ5KGKXC`** is public (visible via `codesign -dv` on any signed build). Hardcoded in `package.json` notarize config. Not a secret.
- **Auto-update only works `/Applications` → `/Applications`.** Squirrel.Mac refuses to swap an app running from a DMG mount or `~/Downloads` (read-only volumes). README documents this for users.

## Stack

- **Electron 29** (renderer) — Chromium frontend with `contextIsolation: true`
- **Python 3.11+** (subprocess) — `sounddevice`, `soundfile`, `numpy`, `python-osc`, `audioread`
- **PyInstaller** bundles the backend as `flowcast_backend` (Mach-O / .exe) into the .app via electron-builder `extraResources`
- **electron-builder 24** for packaging + signing + notarytool + GitHub publish
- **electron-updater 6** for in-app auto-update (DMG + ZIP both required on macOS)
- **macOS arm64 + Windows x64.** Linux untested. Intel Mac CI job currently disabled.

## Current state

v1.0.8 is the latest release (May 2026). Core feature surface is stable: cue list, transport (GO/Stop/Pause/Panic), trim/fade/duck inspector, Combo Cues via the LTE, OSC remote control with verified Bitfocus Companion compatibility, signed + notarized auto-updates with live progress UI, M4A/AAC support via audioread fallback, live audio device handling (auto-rebind on plug-in for System Default users). Settings panel covers GO mode, output device + test tone + rescan, auto-save interval, confirm-before-delete, Cmd+N behaviour, check-for-updates. Help overlay opens on first launch.

## Project structure

```
backend/
  main.py          Python audio engine + OSC server.  See docs/AUDIO_ENGINE.md, docs/DEVICE_CHANGES.md, docs/OSC.md
  main.spec        PyInstaller spec — produces backend/dist/flowcast_backend
  requirements.txt sounddevice / soundfile / numpy / python-osc / audioread
  venv/            local dev venv (gitignored)
main.js            Electron main: spawns backend, IPC, menu, autoUpdater wiring.  See docs/IPC.md, docs/AUTO_UPDATE.md
preload.js         contextBridge surface — every renderer→main / event channel.  See docs/IPC.md
renderer/
  index.html       app shell + all overlays (LTE, help, settings popover, banners)
  renderer.js      cue list, transport, inspector, hotkeys, device handling, update UI.  See docs/CUE_LIFECYCLE.md, docs/DEVICE_CHANGES.md, docs/AUTO_UPDATE.md
  lte.js           Linear Timeline Editor (combo cue builder).  See docs/LTE.md
  style.css        all CSS
build/
  entitlements.mac.plist  hardened-runtime entitlements (incl. disable-library-validation for PyInstaller dylibs)
  icon-source.svg / icon.icns / icon.ico / icon.png       app icon assets
  dmg-bg-source.svg / dmg-bg.png / dmg-bg@2x.png          DMG window background
.github/workflows/
  release.yml      builds on v* tag push: PyInstaller backend → electron-builder → signed DMG + ZIP + NSIS exe → GitHub Release
package.json       build config (electron-builder), version, scripts.  Note: there's also a legacy `electron-builder.yml` that should be ignored — package.json `build` field wins.
docs/              See "router table" above
```

## Data model

**Cue object** (lives in `state.project.cues[]`):
```js
{
  id, number, name, color,
  // simple cue:
  filePath, duration, waveformData, inPoint, outPoint, fadeIn, fadeOut, volume, pan, loop, loadFailed,
  // combo cue (filePath null, type='combo'):
  type: 'combo', clips: [...same fields, plus offset...], totalDur,
  // continue:
  continueMode: 'none' | 'auto-continue' | 'auto-follow',
  preWait, postWait, goModeOverride, cueFadeDuration,
  // duck:
  duck, duckAmount, duckFadeIn, duckFadeOut,
}
```

**`state.playingCues[id]`** (renderer's source-of-truth for active playback):
```js
{
  startedAt: number|null,    // Date.now() when play sent; null during preWait
  duration: number,          // total time for the progress bar
  playFrom: number,          // file-absolute position playback started from (for UI playhead)
  preWaitTimer: timerId|null,
  // combo additions:
  clipIds, clipTimers,
  // progress animation:
  timer,
}
```

**`.flowcast` project file** is JSON: `{ version: 1, name, settings: { goMode, goFadeDuration, oscPort, oscPasscode, outputDevice }, cues: [...] }`. Save strips `waveformData` and `loadFailed` from every cue and sub-clip — those get re-fetched on load.

## Environment & credentials

- **GitHub:** `Horton619/flowcast`, public repo, `gh` CLI authenticated with `repo` scope.
- **Apple Developer:** VEP S-Corp LLC, Team ID `L5KZ5KGKXC`, Apple ID `dave@veproductions.net`.
- **GitHub repo Secrets (all five required for signed CI releases):** `CSC_LINK` (base64 of `.p12`), `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. See `~/.claude/CLAUDE.md` § "Apple code signing" for the full setup recipe.
- **No Windows code signing yet** — SmartScreen warning on first launch is the documented cost.

## Running locally

```bash
npm install
python3 -m venv backend/venv
backend/venv/bin/pip install -r backend/requirements.txt
npm start
```

Auto-updater is a no-op in `npm start` (only fires when `app.isPackaged`). To exercise the update flow end-to-end you must build, install to `/Applications`, and run from there.

```bash
backend/venv/bin/pip install pyinstaller
npm run backend:build      # → backend/dist/flowcast_backend
npm run dist:mac           # → dist/FlowCast-X.Y.Z-arm64.dmg
```

**Cutting a release:** bump `version` in `package.json`, commit, `git tag vX.Y.Z && git push origin vX.Y.Z`. CI handles the rest. See `~/.claude/CLAUDE.md` for the full CI workflow shape and common failures.

## Universal quirks (cross-cutting, not big enough to be topic docs)

- **Banners need `recalcBannerHeight()` on show/hide.** `.main-area { position: fixed; top: calc(var(--header-h) + var(--banner-h, 0px)) }` — banners are static-positioned siblings of `.main-area`, so they'd be hidden behind it without the CSS variable shifting it down. The helper sums all visible banners and updates the var. See `docs/DEVICE_CHANGES.md` for the full list of banner IDs.
- **`document.title` is mutated for diagnostics** during dev (search for it in `renderer.js`) — strip before commit.
- **Help overlay auto-opens on first launch only.** `localStorage['fc_helpSeen']` flag. After that it's behind the `?` button in the header.
- **`gh secret set` doesn't take stdin via `--body -`.** That sets the literal dash. Use `cmd | gh secret set NAME --repo OWNER/REPO` with no `--body`. Documented in global file but worth knowing for anyone touching CI secrets.
- **Two electron-builder configs exist** — `electron-builder.yml` (older, points at non-existent `assets/icon.icns`) and the `build` field in `package.json` (current, canonical). package.json wins. The .yml file should be deleted but isn't because no one's gotten around to it; don't be misled by it.

## Branding / design

VEP house style — accent blue `#3d7eff`, dark navy background, DM Sans + IBM Plex Mono. Status colors (emerald = success, amber = warning, rose = error) follow the cross-app convention in `~/.claude/CLAUDE.md` § "Visual language & UX patterns". App icon is the 13-bar A1 diamond mark; DMG installer has a custom background showing drag-to-Applications arrow + "delete this disk image after install" footer.

## Open work

- **Intel Mac CI job re-enable** — currently disabled in `release.yml`, queue was too slow during initial setup. Two-Mac-runner setup is in git history.
- **Windows code signing** — punted. No EV cert. Users see SmartScreen on first launch.
- **Combo cue device-swap rebind** — currently combos skip the snapshot, so a combo playing through headphones at unplug just continues on whatever macOS reroutes to. Could be added but the multi-clip offset choreography is awkward.

## Reference paths

- **Repo:** https://github.com/Horton619/flowcast
- **Releases:** https://github.com/Horton619/flowcast/releases
- **Local working copy:** `/Users/horton/FlowCast/`
- **Per-project memory:** `/Users/horton/.claude/projects/-Users-horton-FlowCast/memory/`
- **Global Claude rules + cross-app recipes:** `/Users/horton/.claude/CLAUDE.md`
- **Pattern peer (same VEP stack):** `/Users/horton/slidefluid/`
