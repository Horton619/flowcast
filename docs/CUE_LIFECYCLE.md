# Cue lifecycle (renderer side)

> Load this doc when working on: `state.playingCues`, `fireCue`, `fireCombo`, `fireCueAtPosition`, `stopCue`, `stopAll`, `panic`, `cueDone`, `pendingAutoFireTimers`, `scheduleAutoFire`, the GO button, Play With / Auto-Play Next continue-mode logic.

## TL;DR

`state.playingCues` is the renderer's source of truth for "what's currently making sound." Each entry is a plain object on the dict, keyed by cue id. Simple cues, combo cues, and resume-after-device-swap all touch the same dict. Several timers can be attached to each entry (`preWaitTimer`, `clipTimers`, `timer` for the progress animation). Auto-fire chains (Play With → next cue when this starts; Auto-Play Next → next cue when this ends) are tracked in a module-level `pendingAutoFireTimers` Set so Stop / Panic can actually cancel them — fire-and-forget setTimeouts were silently re-firing the chain after Stop. `cueDone` is called both from the JS progress timer (when elapsed hits 100%) and from the backend's `cue_done` message; the function is idempotent (early returns if the cue is no longer in `playingCues`) so auto-follow doesn't schedule the next cue twice.

## The decisions / invariants (what's locked in)

- **`state.playingCues[id]` is the only "is this cue playing?" check.** No other state. Existence in the dict = playing or scheduled. Removal = done or stopped.
- **Entry shape** for simple cues (from `fireCue`):
  ```js
  { startedAt: number|null, duration: number, preWaitTimer: timerId|null, playFrom: number }
  ```
  `startedAt` is `null` during preWait, set to `Date.now()` when the actual `play` message is sent. `playFrom` is the file position playback started from (in seconds, file-absolute) — used by the UI to draw the playhead correctly after a device-swap re-fire (see `docs/DEVICE_CHANGES.md`).
- **Combo cues** (from `fireCombo`) add `clipIds` and `clipTimers`. `clipTimers` is an array of `setTimeout` IDs for offset-deferred clip launches and duck-restore callbacks. `stopCue` must `clearTimeout` each one or deferred clips fire after stop.
- **`fireCueAtPosition`** is the single resume-at-offset entry point. Sets `startedAt: Date.now()`, `playFrom: resumeAtSec`, sends `play` with `inPoint: resumeAtSec`. Backend slices the buffer at that sample offset.
- **Auto-fire chains route through `scheduleAutoFire(delayMs)`**, which registers the timer in `pendingAutoFireTimers` and clears the entry on fire. `stopAll()` and `panic()` call `clearPendingAutoFires()` first — otherwise a chained next cue would launch seconds after the user already pressed Stop.
- **`cueDone(id)` is idempotent.** Early return if `!state.playingCues[id]`. This matters because both paths fire it: the JS-side progress `tick()` calls cueDone when `pct >= 1`, and the backend sends a `cue_done` JSON message when its worker thread exits. Without the guard, auto-follow would call `go(true)` twice — firing both the immediate-next AND the cue-after-that.
- **`fromAutoContinue=true` forces overlap mode.** When `go(true)` is called from a chained auto-fire, `effectiveMode` is hardcoded to `'overlap'` regardless of project settings. Without this, the default `'stop'` mode would kill the parent that fired the chain before the child plays — Escape would only find the child to stop.
- **Pre-wait reserves a `state.playingCues` slot immediately** with `startedAt: null`. This is so Stop/Escape during pre-wait actually cancels the pending play (otherwise the timer fires and starts audio that the user thought they cancelled).
- **`panic()` is the one place that hard-clears everything**: `clearPendingAutoFires()`, plus per-entry `cancelAnimationFrame(info.timer)`, `clearTimeout(info.preWaitTimer)`, `info.clipTimers.forEach(clearTimeout)`, then `state.playingCues = {}`. Then it sends the backend `panic` message to mark all `active_cues` as stopped. The renderer-side teardown has to happen even if the backend message lags.

## Code references

| File | What it owns |
|---|---|
| `renderer/renderer.js` `fireCue` | Simple-cue path. Reserves slot, optionally pre-waits, sends `play`. |
| `renderer/renderer.js` `fireCombo` | Combo-cue path. Spawns deferred `setTimeout`s per clip offset. |
| `renderer/renderer.js` `fireCueAtPosition` | Resume helper (device swap). |
| `renderer/renderer.js` `cueDone` | Idempotent cleanup + auto-follow chain trigger. |
| `renderer/renderer.js` `stopCue` / `stopAll` | Per-cue teardown; stopAll also `clearPendingAutoFires`. |
| `renderer/renderer.js` `panic` | Hard reset. |
| `renderer/renderer.js` `scheduleAutoFire` / `clearPendingAutoFires` | Tracked auto-fire timers. |
| `renderer/renderer.js` `go` | Top-level GO handler. Picks effective mode, dispatches fire-and-advance, schedules Play-With chain. |
| `renderer/renderer.js` `startProgressTimer` | Per-cue requestAnimationFrame tick. Reads `info.playFrom` + elapsed for playhead. |

## What NOT to do

- ❌ **Don't `setTimeout(() => go(true), delay)` directly.** Use `scheduleAutoFire(delay)`. Without it the chained cue cannot be cancelled by Stop / Panic and will fire after the user thought they killed playback.
- ❌ **Don't compute the visual playhead as `cue.inPoint + elapsed`.** Use `info.playFrom + elapsed`. After a device-swap re-fire, playFrom is the position in the file the cue picked back up at; falling back to inPoint resets the visual playhead to the start of the trim region on every swap.
- ❌ **Don't remove the `if (!state.playingCues[id]) return` guard at the top of `cueDone`.** Auto-follow chains will double-fire. This bit hard — caused Play After to launch two cues instead of one.
- ❌ **Don't send a fresh `play` message without registering the slot first.** The slot's `state.playingCues[id]` is the only thing the renderer checks for "is this playing?" — if you skip it, the UI lies and Stop has nothing to clear.
- ❌ **Don't snapshot combo cues into a rebind resume list.** Their offset choreography (clipTimers, duck_restore, per-clip play messages) can't be cleanly reconstructed at an arbitrary position. The rebind code explicitly filters combos.
- ❌ **Don't add new "playing" state outside `state.playingCues`.** Selection state, played-cue tracking, etc. all live elsewhere. If you find yourself adding `state.somethingElsePlaying`, you're forking the source of truth and Stop/Panic will miss your cue.
- ❌ **Don't trust `startedAt` to be non-null.** During preWait it's null. Snapshots / playhead math must handle that or fall back gracefully.
- ❌ **Don't fire auto-follow from inside `panic()`.** Panic explicitly bypasses the auto-fire chain by clearing pendingAutoFireTimers BEFORE the loop that tears down `state.playingCues`. Don't reorder.
