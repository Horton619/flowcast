# Audio device changes (plug / unplug / default switch)

> Load this doc when working on: device polling, the Settings → Output Device dropdown, `rescan_devices`, the device banners (red lost / blue added / amber default-changed), `handleDevicesChanged`, `fireCueAtPosition`, anything touching `playFrom`.

## TL;DR

PortAudio caches its device list and "default device" at init time. macOS's CoreAudio updates live, but PortAudio doesn't follow without `sd._terminate(); sd._initialize()` — which crashes when called from a worker thread. We detect changes via a 2-second `system_profiler SPAudioDataType -json` poll thread (reads CoreAudio directly), surface them as three banner types, and only re-init PortAudio at known-idle moments (Settings → Rescan, pre-cue refresh, post-stopAll rescan during auto-rebind). For a System Default user with a live cue, plugging in headphones automatically snapshots + stops + rescans + re-fires at the saved playhead position — a ~200ms gap is irreducible because PortAudio streams are bound to a device at open time.

## The decisions / invariants (what's locked in)

- **Detection uses `system_profiler`, not `sd.query_devices()`.** Without a re-init, sd's device list is whatever was attached at backend startup. system_profiler reads CoreAudio's live state directly (~230ms per call, fine for 2s polling). The poll is macOS-only; Windows users use the Settings → Rescan button manually.
- **The poll thread does NOT call `sd._terminate()`.** Worker-thread reinit cycling SIGSEGV'd the backend with CoreAudio `-10851 Invalid Property Value`. Earlier versions tried this; it broke audio entirely. The poll only emits a `devices_changed` event — the actual PortAudio refresh happens elsewhere, at safe moments.
- **Pre-cue refresh, when idle.** `play_cue`'s worker does `sd._terminate(); sd._initialize()` BEFORE registering its `my_info` slot, but only if `device_id is None` and `active_cues` is empty. This is how a freshly-attached device shows up for the next cue's stream, without ever doing it during playback.
- **The `playFrom` field is the file position playback started from**, stored on each `state.playingCues[id]` entry. UI uses `playFrom + (now - startedAt)/1000` to draw the playhead — this is what makes the Now Playing strip survive a mid-cue rebind without visually resetting to time 0.
- **`fireCueAtPosition(cue, resumeAtSec, deviceId)`** is the single re-entry point for resume-at-position. It sets `state.playingCues[cue.id] = { startedAt: now, duration: remaining, playFrom: resumeAtSec, ... }` and sends `play` with `inPoint: resumeAtSec`. Backend's `int(in_point * samplerate)` slices the buffer correctly.
- **Three banner types, three triggers:**
  - **Red** (`device-lost-banner`): user had an explicitly-bound device that disappeared. Auto-fall-back to System Default + visible warning.
  - **Blue** (`device-added-banner`): user is on a specific device AND a new device appeared. Offers "Switch" — triggers rescan, resolves the new device's PortAudio index by name, binds settings.outputDevice to that ID. **Only shown when `prevSelectedId` is truthy** — System Default users get no Switch button because binding would actively sabotage macOS's own routing.
  - **Amber** (`device-default-banner`): the system default changed. Informational. If the new default is a freshly-added device AND a simple cue is currently playing, we auto-trigger the live rebind (snapshot → stopAll → rescan → re-fire). No "Switch" button — the action is automatic.
- **Auto-rebind is ONLY on plug-in events**, never on unplug. macOS already handles unplug transparently at its own level — open streams on the default device get rerouted to the next-available device without us doing anything. Triggering a rebind on unplug would add a pointless ~200ms gap.
- **Combo cues are skipped from the rebind snapshot.** Their multi-clip offset choreography doesn't reconstruct cleanly mid-stream. A combo playing through headphones when headphones unplug will continue through whatever macOS reroutes to; a combo when a new device plugs in continues on the old device for the rest of its life.
- **Banners shift the main area down via `--banner-h` CSS variable.** `.main-area { top: calc(var(--header-h) + var(--banner-h, 0px)); }`. `recalcBannerHeight()` is called whenever any banner shows or hides. Without this, banners are rendered in document flow below the header but hidden by the `position: fixed` main area on top.

## Code references

| File | What it owns |
|---|---|
| `backend/main.py:910–960` | `_device_poll` thread (system_profiler-based) |
| `backend/main.py:895–921` | `_list_output_devices_macos` |
| `backend/main.py:55–73` | `play_cue`'s pre-stream PortAudio refresh |
| `backend/main.py:735–752` | `rescan_devices` handler (refused while playing) |
| `renderer/renderer.js` `handleDevicesChanged` | Detects + routes the change to the right banner |
| `renderer/renderer.js` `fireCueAtPosition` | Resume helper used by rebind |
| `renderer/renderer.js` `triggerLiveRebind` | Snapshot + stopAll + rescan + re-fire chain |
| `renderer/renderer.js` `recalcBannerHeight` | Layout fix for banners + `--banner-h` |

## What NOT to do

- ❌ **Don't call `sd._terminate(); sd._initialize()` from any thread that could be alive while audio is playing.** Active streams hold C-state references; reinit frees them. Crashes the backend.
- ❌ **Don't store device selection by PortAudio integer index across reinit cycles.** Indices reshuffle. Track by name (`state.lastKnownDeviceName`) and re-resolve to ID after any rescan.
- ❌ **Don't auto-rebind on unplug events.** macOS handles it. Adding a rebind would only insert a ~200ms gap for no benefit. Auto-rebind triggers on `added.some(d => d.name === defaultName)` — the new default is a device that JUST appeared.
- ❌ **Don't show the blue "Switch" banner when user is on System Default** (`!prevSelectedId`). Binding to a specific device ID undoes the auto-routing they actually want.
- ❌ **Don't try to mid-stream-redirect a `sd.OutputStream` to a different device.** There is no such API in sounddevice/PortAudio. The stream is bound at `__enter__` time; any swap requires close + reopen. We accepted the ~200ms gap and built `triggerLiveRebind` to handle it cleanly.
- ❌ **Don't snapshot `info.startedAt` without folding in `info.playFrom`.** Naïve `(c.inPoint || 0) + elapsed` resets each re-fire to inPoint — multiple swaps will appear to restart from the top of the track. Use `(info.playFrom != null ? info.playFrom : c.inPoint) + elapsed`.
- ❌ **Don't poll faster than ~2s.** `system_profiler` is ~230ms; tighter polling wastes CPU and gets you nothing — macOS device-change events propagate to it in well under a second already.
- ❌ **Don't trust `gh secret set --body -`** when re-uploading any secret values (irrelevant to this file, but learned during this work and recorded in `~/.claude/CLAUDE.md`).
