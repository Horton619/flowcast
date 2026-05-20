# Audio engine

> Load this doc when working on: `backend/main.py` `play_cue`, `_load_audio`, the playback callback, `set_volume`, `set_pan`, `duck_cue`, `fadeout_cue`, anything that calls into `sounddevice` / `soundfile`.

## TL;DR

A single Python backend process owns all audio. Each cue gets one daemon thread that loads the file, registers state in `active_cues[cue_id]`, opens a `sd.OutputStream`, runs the playback callback until done or stopped. The callback is closure-captured per playback — it does NOT look up `active_cues[cue_id]` on every frame, because a second `play` for the same id would race the dict and double-count `pos`. All gain/fade ramping is sample-accurate, computed inside the callback. libsndfile (especially MP3) is **not** thread-safe; all `sf.*` calls are serialized via `_sndfile_lock`. M4A/AAC fall back to `audioread` (CoreAudio on macOS).

## The decisions / invariants (what's locked in)

- **Each playback owns its own `my_info` dict.** The callback captures it in closure, never re-reads from `active_cues[cue_id]`. When `play_cue` is called for a cue id that's already active, the OLD `my_info` gets `stopped=True` set on it before the NEW one is registered. The old callback exits; the new one runs cleanly.
- **Cleanup uses identity check, not key check.** `finally:` block only pops `active_cues[cue_id]` and emits `cue_done` if `active_cues.get(cue_id) is my_info`. Otherwise we were superseded and the new playback owns the slot.
- **`_sndfile_lock` is required around every `sf.read` / `sf.info` call.** libsndfile's MP3 decoder (`mpeg_init` in `libsndfile_arm64.dylib`) crashes with EXC_BAD_ACCESS / SIGBUS when called concurrently from multiple threads. This bit hard on initial m4a support work — LTE opens fire `load_file` for every clip in parallel.
- **`_load_audio` dispatches by extension.** `.m4a / .aac / .mp4 / .m4b` skip libsndfile entirely and go straight to `audioread` (which uses CoreAudio on macOS, no extra binary). Everything else tries `sf.read` first with an audioread fallback on failure.
- **Gain ramping is per-frame, inside the callback.** `volume_db`, `pan`, `duck_gain`, `fade_gain` are all stored on `my_info`. The callback computes target coefficients (`tgt_l`, `tgt_r`) from these, plus `prev_l`/`prev_r` from last frame; if they differ it `np.linspace`s across the frame to absorb the step. This is what killed zipper-noise / clicks during slider drags and duck ramps.
- **Fade-gain has its own per-sample ramp** separate from the prev→target absorb. `fade_gain_step` is set by `fadeout_cue` (or fade-in logic at file load); the callback runs the ramp sample-by-sample. `stop_when_faded=True` plus `fade_gain_target=0` makes the callback set `info['stopped'] = True` when the ramp reaches zero.
- **Pre-cue PortAudio refresh.** Before opening the stream, if `device_id is None` and no other cues are active, `play_cue` does `sd._terminate(); sd._initialize()` so PortAudio sees the current OS default rather than its startup-time cache. This is what makes "headphones plugged in after launch" route correctly on the next cue.
- **Stale device ID falls back to default.** If `_open_and_run(device_id)` raises `PortAudioError`, we retry with `device=None` (System Default) and emit `output_device_lost` with `fellBackToDefault: true`. Cue keeps playing instead of dying.

## Code references

| File | What it owns |
|---|---|
| `backend/main.py:40-260` | `play_cue` — file load, dispatch, stream open, cleanup |
| `backend/main.py:36-78` | `_sndfile_lock`, `_load_audio`, `_load_via_audioread` |
| `backend/main.py:218-227` | `stop_cue`, `stop_all`, `pause_all`, `resume_all` — flag mutators only |
| `backend/main.py:239-251` | `set_volume`, `set_pan` — write fields on info; callback reads them |
| `backend/main.py:253-271` | `duck_cue` — stepped duck_gain ramp from a worker thread (smoothed by callback's prev→target absorb) |
| `backend/main.py:273-289` | `fadeout_cue` — sets fade_gain_step + stop_when_faded; callback runs the ramp |

## What NOT to do

- ❌ **Don't make the callback re-read `active_cues[cue_id]` per frame.** The closure capture is intentional. Concurrent `play_cue` for the same id would have both callbacks pointing at the same dict, incrementing `pos` twice as fast — audio appears to play at double speed with phasing. This was a real bug.
- ❌ **Don't skip `_sndfile_lock` on a "fast" sf call.** Even `sf.info(file_path)` reads the codec header and can crash MP3 decoding from another thread. There is no "quick peek" that's safe.
- ❌ **Don't call `sd._terminate(); sd._initialize()` from a worker thread on a recurring schedule.** macOS CoreAudio backend returns `-10851 "Invalid Property Value"` after a few cycles and the backend process dies. One-off reinit at known-idle moments is fine (rescan handler, pre-cue refresh); a polling loop is not. See `docs/DEVICE_CHANGES.md` for the system_profiler-based detection that replaced it.
- ❌ **Don't add fade/duck logic that mutates the `data` buffer in place.** Earlier `fadeout_cue` did this and caused zipper noise + cumulative-multiplication bugs. The ramps live in the callback now; the source buffer is read-only after load.
- ❌ **Don't `np.linspace` with `endpoint=True` on per-frame ramps.** Use `endpoint=False` so consecutive frames concatenate without a duplicated sample at the boundary.
- ❌ **Don't trust `device_id=0` as "default."** Renderer sends `device: null` for System Default. The play handler's parse guards against `(None, '', 0, 'undefined', 'null', 'NaN')` all collapsing to `device_id = None`.
- ❌ **Don't add a synchronous `sf.read` call outside `_load_audio`.** It bypasses the m4a fallback and the lock.
