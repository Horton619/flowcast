# FlowCast

**Audio cue playback for live events.** A QLab-compatible alternative for techs already running QLab + Bitfocus Companion / Stream Deck — same hotkeys, same OSC API, fraction of the footprint, no Mac-only lock-in.

Built for theatre, dance, AV, and corporate event use. Free.

— Visual Entropy Productions / [veproductions.net](https://veproductions.net)

---

## Download

Latest builds are on the [Releases page](https://github.com/Horton619/flowcast/releases/latest).

- **macOS (Apple Silicon)** — `FlowCast-x.y.z-arm64.dmg`
- **macOS (Intel)** — `FlowCast-x.y.z-x64.dmg`
- **Windows 10/11 (64-bit)** — `FlowCast-Setup-x.y.z.exe`

The app updates itself in the background when a new release is published — or click *Settings → ↑ Check for updates* to check on demand.

### macOS first-launch

Builds are **ad-hoc signed**, not signed with an Apple Developer ID. The first time you launch FlowCast, macOS will block it and say "FlowCast cannot be opened because the developer cannot be verified" or "FlowCast is damaged".

**Fix once, never again:**

1. Try to open the app → dismiss the warning.
2. Open *System Settings → Privacy & Security*.
3. Scroll down to the message about FlowCast and click **Open Anyway**.
4. Confirm in the prompt.

If the app appears "damaged" instead, run `xattr -cr /Applications/FlowCast.app` from Terminal once and try again.

---

## Features

- **Cue list** — drag-to-reorder, color-coded, MIX checkbox to fold cues into a Combo
- **Transport** — GO / Stop / Pause / Panic with QLab-matching hotkeys
- **Trim editor** — visual waveform with draggable in/out markers, scrubbing playhead, click-to-place cursor, and live preview
- **Fades & Duck** — sample-accurate fade-in / fade-out, side-chain ducking with configurable amount and ramp
- **Continue modes**
  - *Play With* — fires the next cue when this one starts (parallel)
  - *Auto-Play Next* — fires the next cue when this one ends (sequential)
  - *Do Nothing* — manual GO each time
- **Loop** — seamless single-cue loop until stopped
- **Combo Cues** — multi-clip cues built in a Linear Timeline Editor; drag clips to position, trim handles, per-clip fade and duck
- **Now Playing strip** — live waveform, playhead, elapsed/remaining, NEXT UP panel with auto-fire badge
- **OSC remote control** — speaks the QLab v3/v4 OSC API on port 53000 (TCP + UDP, SLIP-framed). Bitfocus Companion's QLab module connects without configuration.
- **Project files** — `.flowcast` JSON
- **Auto-save** — every 10 minutes by default (configurable in Settings)
- **Auto-update** — checks GitHub Releases on launch and on demand

## Hotkeys

| Key                  | Action                                              |
|----------------------|-----------------------------------------------------|
| `Space`              | GO — fire the selected cue (or play from playhead in the Time tab) |
| `Esc`                | Stop all                                            |
| `Cmd .` / `Ctrl .`   | Panic — kill audio immediately                      |
| `↑` / `↓`            | Move selection                                      |
| `Enter`              | Rename selected cue (preview trim in Time tab)      |
| `I` / `O`            | Set in / out at playhead (Time tab)                 |
| `Cmd N` / `Ctrl N`   | Add cue (file picker by default; configurable)     |
| `Cmd D` / `Ctrl D`   | Duplicate selected cue                              |
| `Delete`             | Remove selected cue (confirmation by default)       |

## OSC Remote Control

FlowCast listens on `:53000` by default (TCP + UDP). Mirrors the QLab v3/v4 API surface, so any QLab-aware controller works.

Verified clients:

- **Bitfocus Companion** (QLab module, TCP mode) — full command surface and feedback

Supported addresses include `/go`, `/stop`, `/pause`, `/resume`, `/playhead/next`, `/playhead/previous`, `/cue/{N}/start`, plus the workspace handshake (`/workspaces`, `/workspace/{id}/connect`).

Set the listen port and an optional passcode by clicking the OSC status dot in the header.

---

## Building from Source

### Prerequisites

- **Node.js 20+**
- **Python 3.11+** (3.14 fine; `sounddevice`, `soundfile`, `numpy`, `python-osc`)
- **macOS** or **Windows** (Linux untested)

### Dev loop

```bash
git clone https://github.com/Horton619/flowcast.git
cd flowcast
npm install

# Set up Python venv
python3 -m venv backend/venv
backend/venv/bin/pip install sounddevice soundfile numpy python-osc

# Run
npm start
```

### Building a release locally (for testing)

```bash
backend/venv/bin/pip install pyinstaller
npm run backend:build         # produces backend/dist/flowcast_backend
npm run dist:mac              # writes a DMG to dist/
```

### Cutting a release

CI does the cross-platform builds. To trigger:

```bash
# Bump the version in package.json, commit, then:
git tag v1.2.3
git push origin v1.2.3
```

`.github/workflows/release.yml` then builds:

- macOS arm64 DMG (on `macos-latest`)
- macOS x64 DMG (on `macos-13`)
- Windows x64 NSIS installer (on `windows-latest`)

…ad-hoc signs the macOS apps, uploads everything to a GitHub Release, and marks it `latest`. The in-app updater finds it from there.

---

## Project Layout

```
backend/
  main.py            Python audio engine + OSC server
  main.spec          PyInstaller build spec
main.js              Electron main process (spawns backend, IPC, menu)
preload.js           contextBridge for window.flowcast.*
renderer/
  index.html         App shell, settings/help overlays
  renderer.js        Cue list, transport, inspector, hotkeys
  lte.js             Linear Timeline Editor (Combo Cue builder)
  style.css
.github/workflows/
  release.yml        Cross-platform CI release build
```

## License

All rights reserved © 2026 Visual Entropy Productions. Personal and small-venue production use is welcome — please reach out for redistribution or commercial bundling.
