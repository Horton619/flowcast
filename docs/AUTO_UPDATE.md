# Auto-update UX (FlowCast-specific bits)

> Load this doc when working on: the Settings → Updates section, the update-ready banner, `paintUpdateStatus`, the `update-status` IPC channel, `autoUpdater.*` event handlers in `main.js`. For the full electron-updater / signing / packaging recipe see `~/.claude/CLAUDE.md` § "In-app auto-update via electron-updater".

## TL;DR

electron-updater + GitHub Releases. The cross-app pattern (DMG+ZIP both required, signed-to-signed only, hardened-runtime + entitlements, the read-only-volume Squirrel error, the macOS `--body` gh secret bug) all live in the global `~/.claude/CLAUDE.md`. **This doc only covers FlowCast's specific surface:** the in-app progress bar UX, the `update-status` event channel, the restart-now banner. If you're setting up signing for the first time or troubleshooting a CI release, start at the global doc — that's where the gotchas live.

## The decisions / invariants (what's locked in)

- **One `update-status` IPC channel** for all electron-updater events. `main.js` forwards `checking-for-update`, `update-available`, `update-not-available`, `download-progress`, `update-downloaded`, `error` as `{type, ...}` payloads. Renderer's `paintUpdateStatus(msg)` is the single handler.
- **Settings popover shows live progress.** Format is `42%  ·  44.1 / 104.8 MB  ·  3.2 MB/s  ·  ~19s left` (text + thin accent-blue bar). `fmtSpeed`: >1MB/s shows `X.X MB/s`, else `XXX KB/s`. `fmtETA`: <60s shows `~Ns left`, else `~Nm Ss left`. ETA skipped when `bytesPerSecond == 0` (just-started state).
- **Restart-now banner** appears top-of-window when `update-downloaded` fires. Click → `autoUpdater.quitAndInstall()` (the only reliable apply path on macOS). Dismiss × → banner hides; staged update still applies on next quit via `autoInstallOnAppQuit`.
- **The settings line "Update available: vX.Y.Z — downloading…"** updates to "vX.Y.Z ready — see banner above." once download completes. State table:

  | event | settings line | progress bar | banner |
  |---|---|---|---|
  | `checking` | "Checking GitHub Releases…" | hidden | hidden |
  | `not-available` | "You have the latest version." | hidden | hidden |
  | `available` | "Update available: vX.Y.Z — downloading…" | 0%, "Starting…" | hidden |
  | `progress` | unchanged | live % | hidden |
  | `downloaded` | "vX.Y.Z ready — see banner above." | 100%, "Download complete" | shown |
  | `error` | "Update error: \<msg\>" | hidden | hidden |

- **Error messages are shown verbatim.** When electron-updater says "ZIP file not provided" or "Cannot update while running on a read-only volume" we surface those strings to the user. Both messages directly explain real install problems — masking them with "Update failed" loses the diagnostic. See the global doc for what each one means.
- **Launch-time auto-check is delayed 60s.** `setTimeout(() => autoUpdater.checkForUpdates(), 60_000)` in `main.js`. GitHub's `releases.atom` is cached for several minutes; firing the check immediately after launch often misses a release published within the last 5 min.
- **Banners (including update-ready) need `recalcBannerHeight()`** when shown/hidden, because `.main-area { position: fixed }` covers static-positioned siblings. The CSS var `--banner-h` shifts main content down by the active banners' total height. See `docs/DEVICE_CHANGES.md`.

## Code references

| File | What it owns |
|---|---|
| `main.js` `autoUpdater.on(...)` handlers | event → `update-status` forwarding |
| `main.js` `install-update-now` IPC | calls `autoUpdater.quitAndInstall()` |
| `preload.js` `onUpdateStatus`, `checkForUpdates`, `installUpdateNow` | renderer surface |
| `renderer/renderer.js` `paintUpdateStatus` | per-event UI painter |
| `renderer/renderer.js` `fmtSpeed` / `fmtETA` | progress text helpers |
| `renderer/index.html` `#update-ready-banner` | restart-now banner markup |
| `renderer/index.html` Settings popover Updates section | inline progress UI |
| `package.json` `build.mac` | `notarize: { teamId: "L5KZ5KGKXC" }`, DMG + ZIP targets |
| `~/.claude/CLAUDE.md` § "In-app auto-update via electron-updater" | full cross-app recipe (signing, hardened runtime, CI workflow, common failures) |

## What NOT to do

- ❌ **Don't drop the ZIP target from `build.mac.target`.** electron-updater downloads `.zip` for in-place app swaps on macOS; the `.dmg` is for manual installs only. Without the ZIP, every update fails with "ZIP file not provided" — and the fix is forward-only (you can't retroactively add it to a published release).
- ❌ **Don't swallow electron-updater error messages.** They tell users specifically why the update failed — `read-only volume` means the app is running from a DMG mount or Downloads folder and they need to move it to `/Applications`. Wrap with anything more generic and you lose the actionable info.
- ❌ **Don't call `quitAndInstall()` without showing the banner first.** Users in the middle of a live show shouldn't have the app silently restart. The button is an explicit affordance.
- ❌ **Don't fire `checkForUpdatesAndNotify` immediately at launch.** Atom-feed cache lag means newly-published releases are often missed for ~5 min. The 60s delay is intentional. (Manual Check For Updates uses a fresher endpoint and is fine.)
- ❌ **Don't add a second IPC channel for an update event.** All events route through `update-status`. Adding a side channel risks the renderer missing one path or the banner / settings UI drifting out of sync.
- ❌ **Don't subscribe to `autoUpdater` events in the renderer.** They live in the main process. main.js fans-in, renderer fans-out via the single channel.
- ❌ **Don't bother adding Windows code signing right now.** Documented in the global doc — no EV cert, SmartScreen warning is acceptable cost for the current user base. Revisit when needed.
