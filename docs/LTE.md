# Linear Timeline Editor (Combo Cue authoring)

> Load this doc when working on: `renderer/lte.js`, anything `lte*` named, the BEGIN EDIT button, combo cue construction, the trim handles on clips, the LTE waveform rendering, `lteState`.

## TL;DR

The LTE is a self-contained canvas-based multi-clip timeline editor for authoring "Combo Cues" — single cue list rows that fire multiple audio clips at offset positions when GO is pressed. It opens as a full-screen overlay (not a separate window). State lives on a module-level `lteState` object — separate from `state.playingCues` etc. Clips are deep-cloned from the project cues at edit time so cancel doesn't mutate. The trim handle drag was re-litigated multiple times and the current implementation has a specific anchor invariant: during drag, `trimDragAnchorX = lteTX(clip.offset) - lteTX(clip.inPoint)` is FROZEN, and the full-file context waveform is drawn at that x, with markers moving as `inPoint`/`outPoint` change. On mouseup, `clip.offset` is committed to `startOff + (clip.inPoint - drag.startIn)` so the clip body lands exactly where the in-marker was — no visual snap.

## The decisions / invariants (what's locked in)

- **`lteState.clips` is a deep clone** of `cue.clips` (or constructed from source cues for new combos). Mutations to project cue clips do NOT affect `lteState.clips` and vice versa. Both must be updated independently on Save.
- **All `lte*` functions in `lte.js` must be declared before any `renderer.js` call into them.** `lte.js` is loaded AFTER `renderer.js` in `index.html`; renderer references LTE functions via `typeof` guards (`if (typeof lteHandleWaveformLoaded === 'function')`).
- **Trim drag uses a frozen anchor.** `lteState.trimDragAnchorX` is set at mousedown to `lteTX(clip.offset) - lteTX(clip.inPoint || 0)` and not touched again until mouseup. The full-file context waveform is drawn at `[anchorX, anchorX + lteTX(clip.duration)]`. In-marker is at `anchorX + lteTX(clip.inPoint)`; out-marker at `anchorX + lteTX(clip.outPoint)`. While dragging, only `clip.inPoint` (or `clip.outPoint`) changes — `clip.offset` does NOT.
- **On mouseup, `clip.offset` is committed** to `Math.max(0, drag.startOff + (clip.inPoint - drag.startIn))` for trimIn (and analogous for trimOut). This is the mathematical guarantee that the clip body lands at the same canvas-x position it had at the moment of release — no visual snap.
- **At-rest waveform shows only the trimmed slice** of the file's bars. Indices are computed from `inPt/fullDur * dLen` → `outPt/fullDur * dLen`. The expanded (drag) view shows the full file at low opacity with dark overlays on the excluded zones.
- **Fade gradients are drawn, not separate buttons.** Fade-in is a dark-to-transparent gradient on the left edge of the clip body; fade-out is transparent-to-dark on the right edge. No grip-zone coloured blocks (those were removed).
- **Combo cue type === 'combo'.** Top-level cues have `filePath` and no `clips`. Combo cues have `clips: [{ id, filePath, inPoint, outPoint, offset, volume, pan, fadeIn, fadeOut, duck, duckAmount, duckFadeIn, duckFadeOut, waveformData }]` and `type: 'combo'`, no top-level `filePath`.
- **Pinch-to-zoom is Ctrl+wheel** (also matches trackpad pinch on macOS). Plain wheel pans. The zoom recenters on the cursor's time-point.
- **Waveform fetch on open.** `lteOpen` and `lteOpenCombo` send `load_file` for any clip lacking `duration > 0` and not `loadFailed`. Responses arrive via `lteHandleWaveformLoaded`, called from `renderer.js`'s `handleFileLoaded`.
- **Save strips runtime fields** before persistence — `_previewId`, `waveformData`, `loadFailed`. Project files stay lean.

## Code references

| File | What it owns |
|---|---|
| `renderer/lte.js:22-39` | `lteState` — clips, playhead, zoom, drag, comboId, trimDragAnchorX |
| `renderer/lte.js:60-148` | `lteOpen` (new combo from selected cues) / `lteOpenCombo` (edit existing) |
| `renderer/lte.js:175-237` | `lteSave` — strips runtime fields, replaces source cues with combo row, dispatches load_file for unloaded clips |
| `renderer/lte.js:265-294` | `lteRender` — full redraw, called every animation frame during playback |
| `renderer/lte.js:331-519` | `lteDrawLane` — single clip render, includes both at-rest and trim-drag expanded views |
| `renderer/lte.js:523-545` | `lteHitTest` — clip body vs fade-grip vs trim-handle hit zones, trim wins when close |
| `renderer/lte.js:868-1061` | `lteBindCanvas` — mousedown / mousemove / mouseup / wheel handlers |
| `renderer/lte.js:1122-1136` | `lteHandleWaveformLoaded` — called from renderer.js when file_loaded arrives |

## What NOT to do

- ❌ **Don't update `clip.offset` during a trim drag.** It must stay frozen so the context waveform doesn't shift around. Only commit it on mouseup, computed from `startOff + (clip.inPoint - drag.startIn)`. This was the bug behind multiple rewrites of the trim handle interaction.
- ❌ **Don't fall through from the expanded (trim-drag) view to the normal draw path in `lteDrawLane`.** `return` early after drawing the expanded view. The normal-view code would overdraw the body at the wrong x.
- ❌ **Don't try to reassign `clipX` / `clipW` as `const`.** Earlier code did this and crashed silently with TypeError, blacking out the canvas. Use `let` if you need to reassign, or restructure into separate code paths.
- ❌ **Don't reference `lteState.clips` from renderer.js for project-cue updates.** They're deep clones. Project cues live in `state.project.cues`. The handoff happens in `lteSave`.
- ❌ **Don't add new `lte*` functions in `renderer.js`.** All LTE code lives in `lte.js`; renderer guards calls with `typeof` checks because of the script load order.
- ❌ **Don't compute waveform bar peaks across the FULL file array when drawing the at-rest body.** Slice the data array by `(inPoint, outPoint) / duration * dLen` first. Otherwise the visible waveform is the entire file compressed into the trim region — looks squashed and shifts mid-drag.
- ❌ **Don't snapshot combo cues into the device-swap rebind list.** Their offset choreography can't be reconstructed mid-stream. See `docs/CUE_LIFECYCLE.md` / `docs/DEVICE_CHANGES.md` — combos are explicitly filtered out.
- ❌ **Don't trust `clip.duration` until `lteHandleWaveformLoaded` fires.** `lteClipDur` falls back to a 30s visual placeholder for unloaded clips; this is for the visual only and never gets saved as `outPoint`.
