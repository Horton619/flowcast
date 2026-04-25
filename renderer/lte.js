'use strict'
// lte.js — Linear Timeline Editor (Combo Cue builder)

// ── CONSTANTS ──────────────────────────────────────────────────────────────────
const LTE_RULER_H = 32
const LTE_LANE_H  = 92   // taller lanes → more waveform detail
const LTE_FADE_PX = 16   // px hit zone for fade handles (inside trim zone)
const LTE_TRIM_PX = 10   // px hit zone for trim handles (outermost edge of clip)
const LTE_MIN_DUR = 0.1  // minimum clip duration in seconds
const LTE_SNAP_PX = 8    // snap threshold in screen px
const LTE_COLORS  = [
  [61,  126, 255],  // blue
  [0,   217, 126],  // green
  [255, 184, 0  ],  // yellow
  [168, 85,  247],  // purple
  [255, 71,  87 ],  // red
  [61,  200, 255],  // cyan
  [255, 130, 0  ],  // orange
]

// ── STATE ──────────────────────────────────────────────────────────────────────
const lteState = {
  clips:        [],
  playhead:     0,
  playing:      false,
  playWall:     0,   // Date.now() when playback started
  playPh:       0,   // playhead value when playback started
  totalDur:     0,
  zoom:         80,  // px per second
  selIdx:       null,
  drag:         null,
  rafId:        null,
  srcIds:       [],
  comboId:      null,
  comboName:    'Combo Cue',
  playTimers:   [],
  trimDragIdx:     null,  // index of clip currently being trim-dragged (null = none)
  trimDragAnchorX: null,  // canvas-x of audio file's t=0, frozen at drag-start
}

// ── COORDINATE HELPERS ─────────────────────────────────────────────────────────
function lteTX(t) { return t * lteState.zoom }
function lteXT(x) { return x / lteState.zoom }

function lteClipDur(clip) {
  const out = (clip.outPoint != null && clip.outPoint > 0) ? clip.outPoint
            : (clip.duration > 0)                          ? clip.duration
            : 30   // 30s visual placeholder until file loads — never saved as outPoint
  return Math.max(0, out - (clip.inPoint || 0))
}

// ── TOTAL DURATION ─────────────────────────────────────────────────────────────
function lteComputeTotal() {
  let max = 4
  lteState.clips.forEach(c => { max = Math.max(max, c.offset + lteClipDur(c)) })
  lteState.totalDur = max
}

// ── OPEN ───────────────────────────────────────────────────────────────────────
function lteOpen(srcIds) {
  stopAll()   // stop any main cue list playback before entering edit mode
  lteStop()
  lteState.srcIds   = [...srcIds]
  lteState.comboId  = null
  lteState.comboName = 'Combo Cue'

  // Build clip list — all start at offset 0; user drags to position
  lteState.clips = []
  srcIds.forEach((id, i) => {
    const cue = getCueById(id)
    if (!cue) return

    // Resolve the best available duration
    const rawDur = cue.duration > 0 ? cue.duration : null
    const inPt   = cue.inPoint  || 0
    const outPt  = cue.outPoint != null && cue.outPoint > inPt && cue.outPoint <= (rawDur || Infinity)
                   ? cue.outPoint
                   : (rawDur != null ? rawDur : null)  // null = unloaded; lteClipDur uses 30s placeholder

    const clip = {
      id:           cue.id,
      name:         cue.name || basename(cue.filePath) || ('Clip ' + (i + 1)),
      filePath:     cue.filePath,
      waveformData: cue.waveformData || null,
      duration:     rawDur || 0,
      inPoint:      inPt,
      outPoint:     outPt,
      offset:       0,   // all clips start at the zero line; user positions them
      volume:       cue.volume    || 0,
      pan:          cue.pan       || 0,
      fadeIn:       cue.fadeIn    || 0,
      fadeOut:      cue.fadeOut   || 0,
      duck:         cue.duck      || false,
      duckAmount:   cue.duckAmount   ?? -12,
      duckFadeIn:   cue.duckFadeIn   ?? 0.5,
      duckFadeOut:  cue.duckFadeOut  ?? 1.0,
      _previewId:   null,
    }
    lteState.clips.push(clip)
  })

  lteState.selIdx   = lteState.clips.length ? 0 : null
  lteState.playhead = 0
  lteState.zoom     = 80
  // Auto-name: "Combo Cue (Name1 + Name2)"
  if (lteState.clips.length) {
    lteState.comboName = `Combo Cue (${lteState.clips.map(c => c.name).join(' + ')})`
  }
  lteComputeTotal()
  // Request waveform data for any clip whose file hasn't loaded yet
  lteState.clips.forEach(clip => {
    if (clip.filePath && !(clip.duration > 0) && !clip.loadFailed) {
      window.flowcast.sendToBackend({ type: 'load_file', id: clip.id, filePath: clip.filePath })
    }
  })
  lteShow()
}

function lteOpenCombo(comboId) {
  const cue = getCueById(comboId)
  if (!cue || cue.type !== 'combo') return
  stopAll()   // stop any main cue list playback before entering edit mode
  lteStop()
  lteState.comboId   = comboId
  lteState.srcIds    = []
  lteState.comboName = cue.name || 'Combo Cue'
  // Deep-clone clips so we can cancel without mutating
  lteState.clips = (cue.clips || []).map(c => {
    const clip = { ...c, _previewId: null }
    // Heal stale outPoint: if duration is known and outPoint is suspiciously short,
    // restore to full duration. (Happens when outPoint was set to a placeholder.)
    if (clip.duration > 0 && (clip.outPoint == null || clip.outPoint <= 0 || clip.outPoint < clip.duration - 0.1)) {
      clip.outPoint = clip.duration
    }
    return clip
  })
  lteState.selIdx   = lteState.clips.length ? 0 : null
  lteState.playhead = 0
  lteState.zoom     = 80
  lteComputeTotal()
  // Request waveform data for any clip whose file hasn't loaded yet
  lteState.clips.forEach(clip => {
    if (clip.filePath && !(clip.duration > 0) && !clip.loadFailed) {
      window.flowcast.sendToBackend({ type: 'load_file', id: clip.id, filePath: clip.filePath })
    }
  })
  lteShow()
}

function lteShow() {
  const overlay = document.getElementById('lte-overlay')
  if (!overlay) return
  overlay.style.display = ''
  const titleEl = document.getElementById('lte-title')
  if (titleEl) titleEl.textContent = lteState.comboName
  lteUpdatePlayheadTime()
  // Defer canvas draw one frame so the overlay has real layout dimensions
  requestAnimationFrame(() => {
    lteResizeCanvas()
    lteRender()
    lteUpdateInfoPanel()
  })
}

// ── CLOSE ──────────────────────────────────────────────────────────────────────
function lteClose() {
  lteStop()
  const overlay = document.getElementById('lte-overlay')
  if (overlay) overlay.style.display = 'none'
  state.comboSelected.clear()
  updateBeginEditBtn()
  renderCueList()
}

// ── SAVE ───────────────────────────────────────────────────────────────────────
function lteSave() {
  lteStop()
  lteComputeTotal()

  // Resolve final combo name from the editable title
  const titleEl = document.getElementById('lte-title')
  if (titleEl) lteState.comboName = titleEl.textContent.trim() || 'Combo Cue'

  const clips   = lteState.clips.map(c => { const { _previewId, ...rest } = c; return rest })
  const totDur  = lteState.totalDur

  if (lteState.comboId) {
    // Editing an existing combo — update in-place
    const cue = getCueById(lteState.comboId)
    if (cue) {
      cue.name     = lteState.comboName
      cue.clips    = clips
      cue.totalDur = totDur
      cue.duration = totDur
    }
  } else {
    // New combo — replace source cues with single combo row
    const indices = lteState.srcIds
      .map(id => getCueIndex(id))
      .filter(i => i >= 0)
    if (!indices.length) { lteClose(); return }

    const minIdx = Math.min(...indices)
    const firstCue = state.project.cues[minIdx]

    const comboCue = makeNewCue({
      type:     'combo',
      name:     lteState.comboName,
      number:   firstCue ? firstCue.number : String(minIdx + 1),
      clips,
      totalDur: totDur,
      duration: totDur,
      filePath: null,
    })

    // Remove source cues (highest index first to avoid shifting)
    indices.sort((a, b) => b - a).forEach(i => state.project.cues.splice(i, 1))
    // Insert combo at the original first position
    state.project.cues.splice(minIdx, 0, comboCue)

    state.selectedCueId = comboCue.id
  }

  markDirty()

  // For any clip that still has no duration data, request it now.
  // This covers the case where the user saved before the backend finished analysing the files.
  // The file_loaded response will arrive via handleFileLoaded → lteHandleWaveformLoaded
  // and update both the project's clip data and the NP waveform.
  clips.forEach(clip => {
    if (clip.filePath && !(clip.duration > 0) && !clip.loadFailed) {
      window.flowcast.sendToBackend({ type: 'load_file', id: clip.id, filePath: clip.filePath })
    }
  })

  lteClose()
}

// ── CANVAS RESIZE ──────────────────────────────────────────────────────────────
function lteResizeCanvas() {
  const canvas = document.getElementById('lte-canvas')
  const wrap   = document.getElementById('lte-canvas-wrap')
  if (!canvas || !wrap) return

  const minW = wrap.clientWidth || 600
  const W = Math.max(minW, lteTX(lteState.totalDur) + 300)
  const H = LTE_RULER_H + lteState.clips.length * LTE_LANE_H

  canvas.width  = W
  canvas.height = H
  canvas.style.width  = W + 'px'
  canvas.style.height = H + 'px'

  lteUpdateOverflowHint(wrap, W)
}

function lteUpdateOverflowHint(wrap, canvasW) {
  if (!wrap) wrap = document.getElementById('lte-canvas-wrap')
  if (!wrap) return
  const hasMore = (canvasW || wrap.scrollWidth) > wrap.clientWidth + wrap.scrollLeft + 8
  wrap.classList.toggle('has-overflow', hasMore)
}

// ── RENDER ─────────────────────────────────────────────────────────────────────
function lteRender() {
  const canvas = document.getElementById('lte-canvas')
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  const W   = canvas.width
  const H   = canvas.height

  ctx.clearRect(0, 0, W, H)
  ctx.fillStyle = '#0c0e14'
  ctx.fillRect(0, 0, W, H)

  lteDrawRuler(ctx, W)
  lteState.clips.forEach((clip, i) => lteDrawLane(ctx, clip, i, W))

  // Playhead
  const phX = lteTX(lteState.playhead)
  if (phX >= 0 && phX <= W) {
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'
    ctx.lineWidth   = 1.5
    ctx.setLineDash([4, 3])
    ctx.beginPath(); ctx.moveTo(phX, 0); ctx.lineTo(phX, H); ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = 'white'
    ctx.beginPath()
    ctx.moveTo(phX - 5, LTE_RULER_H - 8)
    ctx.lineTo(phX + 5, LTE_RULER_H - 8)
    ctx.lineTo(phX, LTE_RULER_H)
    ctx.closePath()
    ctx.fill()
  }
}

function lteDrawRuler(ctx, W) {
  ctx.fillStyle = '#13161f'
  ctx.fillRect(0, 0, W, LTE_RULER_H)

  ctx.strokeStyle = '#252a3d'
  ctx.lineWidth   = 1
  ctx.beginPath(); ctx.moveTo(0, LTE_RULER_H - 1); ctx.lineTo(W, LTE_RULER_H - 1); ctx.stroke()

  const zoom  = lteState.zoom
  const step  = zoom >= 160 ? 0.25 : zoom >= 80 ? 0.5 : zoom >= 40 ? 1 : zoom >= 20 ? 2 : 5
  const maxT  = lteXT(W) + step

  ctx.font      = '9px "IBM Plex Mono", monospace'
  ctx.textAlign = 'left'

  for (let t = 0; t <= maxT; t += step) {
    const x      = lteTX(t)
    if (x > W) break
    const major  = Math.abs(t - Math.round(t)) < 0.001
    ctx.strokeStyle = major ? '#2e3450' : '#1f2438'
    ctx.lineWidth   = 1
    ctx.beginPath()
    ctx.moveTo(x, major ? LTE_RULER_H - 10 : LTE_RULER_H - 5)
    ctx.lineTo(x, LTE_RULER_H)
    ctx.stroke()
    if (major && x > 2) {
      ctx.fillStyle = '#4a5068'
      const m = Math.floor(t / 60)
      const s = String(Math.round(t % 60)).padStart(2, '0')
      ctx.fillText(`${m}:${s}`, x + 3, LTE_RULER_H - 13)
    }
  }
}

function lteDrawLane(ctx, clip, idx, W) {
  const laneY = LTE_RULER_H + idx * LTE_LANE_H
  const isSel = idx === lteState.selIdx

  // Lane background
  ctx.fillStyle = idx % 2 === 0 ? '#111420' : '#0f1219'
  ctx.fillRect(0, laneY, W, LTE_LANE_H)

  // Lane separator
  ctx.strokeStyle = '#1f2438'
  ctx.lineWidth   = 1
  ctx.beginPath(); ctx.moveTo(0, laneY + LTE_LANE_H - 1); ctx.lineTo(W, laneY + LTE_LANE_H - 1); ctx.stroke()

  const dur  = lteClipDur(clip)
  if (dur <= 0) return

  const PAD     = 5
  const clipTop = laneY + PAD
  const clipH   = LTE_LANE_H - PAD * 2
  const [r, g, b] = LTE_COLORS[idx % LTE_COLORS.length]

  // ── Expanded view during trim drag ─────────────────────────────────────────
  if (lteState.trimDragIdx === idx && clip.duration > 0 && lteState.trimDragAnchorX != null) {
    const fullX      = lteState.trimDragAnchorX
    const fullW      = lteTX(clip.duration)
    const inPt       = clip.inPoint || 0
    const outPt      = clip.outPoint != null ? clip.outPoint : clip.duration
    const inMarkerX  = fullX + lteTX(inPt)
    const outMarkerX = fullX + lteTX(outPt)
    const bodyW      = Math.max(0, outMarkerX - inMarkerX)

    // Full-file context waveform (low opacity) across [fullX, fullX+fullW]
    if (clip.waveformData && clip.waveformData.length > 0 && fullW > 4) {
      const data     = clip.waveformData
      const dLen     = data.length
      const mid      = clipTop + clipH / 2
      const maxHalf  = (clipH / 2) - 3
      const targetBW = Math.max(1, fullW / dLen)
      const numBars  = Math.floor(fullW / targetBW)
      const step     = dLen / numBars
      const peaks    = new Float32Array(numBars)
      for (let i = 0; i < numBars; i++) {
        const s = i * step, e = Math.min((i + 1) * step, dLen)
        let m = 0
        for (let j = Math.floor(s), end = Math.ceil(e); j < end && j < dLen; j++) {
          if (data[j] > m) m = data[j]
        }
        peaks[i] = m
      }
      const clipL = Math.max(fullX, 0)
      const clipR = Math.min(fullX + fullW, W)
      if (clipR > clipL) {
        ctx.save()
        ctx.beginPath(); ctx.rect(clipL, clipTop, clipR - clipL, clipH); ctx.clip()
        ctx.globalAlpha = 0.30
        ctx.fillStyle   = `rgb(${r},${g},${b})`
        for (let i = 0; i < numBars; i++) {
          const barH = peaks[i] * maxHalf
          ctx.fillRect(fullX + i * targetBW, mid - barH, Math.max(targetBW - 0.5, 1), barH * 2)
        }
        ctx.globalAlpha = 0.45
        ctx.fillStyle   = 'white'
        for (let i = 0; i < numBars; i++) {
          const barH = peaks[i] * maxHalf * 0.60
          ctx.fillRect(fullX + i * targetBW, mid - barH, Math.max(targetBW * 0.5, 0.75), barH * 2)
        }
        ctx.restore()
        ctx.globalAlpha = 1
      }
    }

    // Dark overlay on excluded zones (left of inMarker, right of outMarker)
    ctx.fillStyle = 'rgba(12,14,20,0.60)'
    if (inMarkerX > fullX) ctx.fillRect(fullX, clipTop, inMarkerX - fullX, clipH)
    if (outMarkerX < fullX + fullW) ctx.fillRect(outMarkerX, clipTop, (fullX + fullW) - outMarkerX, clipH)

    // Clip body fill (active zone) — context waveform shows through
    if (bodyW > 0) {
      ctx.globalAlpha = isSel ? 0.75 : 0.45
      ctx.fillStyle   = `rgb(${r},${g},${b})`
      lteRoundRect(ctx, inMarkerX, clipTop, bodyW, clipH, 4, true, false)
      ctx.globalAlpha = 1

      // Clip border
      ctx.strokeStyle = isSel ? `rgba(${r},${g},${b},0.95)` : `rgba(${r},${g},${b},0.40)`
      ctx.lineWidth   = isSel ? 1.5 : 1
      lteRoundRect(ctx, inMarkerX, clipTop, bodyW, clipH, 4, false, true)
    }

    // White trim handle lines at in/out markers
    ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.lineWidth = 1.5
    ctx.beginPath(); ctx.moveTo(inMarkerX,  clipTop); ctx.lineTo(inMarkerX,  clipTop + clipH); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(outMarkerX, clipTop); ctx.lineTo(outMarkerX, clipTop + clipH); ctx.stroke()

    return
  }

  // ── Normal view (at rest) ──────────────────────────────────────────────────
  const clipX = lteTX(clip.offset)
  const clipW = lteTX(dur)

  if (clipX + clipW < 0 || clipX > W) return

  const bodyAlpha = isSel ? 0.75 : 0.45

  // Clip body
  ctx.globalAlpha = bodyAlpha
  ctx.fillStyle   = `rgb(${r},${g},${b})`
  lteRoundRect(ctx, clipX, clipTop, clipW, clipH, 4, true, false)

  // Peak-envelope waveform — only the [inPoint, outPoint] slice of the file
  if (clip.waveformData && clip.waveformData.length > 0 && clipW > 4) {
    const data     = clip.waveformData
    const dLen     = data.length
    const mid      = clipTop + clipH / 2
    const maxHalf  = (clipH / 2) - 3
    const inPt     = clip.inPoint  || 0
    const outPt    = clip.outPoint != null ? clip.outPoint : (clip.duration || 0)
    const fullDur  = clip.duration > 0 ? clip.duration : (outPt > 0 ? outPt : dur)
    const sStart   = fullDur > 0 ? (inPt  / fullDur) * dLen : 0
    const sEnd     = fullDur > 0 ? (outPt / fullDur) * dLen : dLen
    const sliceLen = Math.max(1, sEnd - sStart)
    const targetBW = Math.max(1, clipW / sliceLen)
    const numBars  = Math.max(1, Math.floor(clipW / targetBW))
    const step     = sliceLen / numBars
    const peaks    = new Float32Array(numBars)
    for (let i = 0; i < numBars; i++) {
      const s = sStart + i * step
      const e = Math.min(sStart + (i + 1) * step, sEnd)
      let m = 0
      for (let j = Math.floor(s), end = Math.ceil(e); j < end && j < dLen; j++) {
        if (data[j] > m) m = data[j]
      }
      peaks[i] = m
    }
    ctx.save()
    ctx.beginPath(); ctx.rect(clipX, clipTop, clipW, clipH); ctx.clip()
    ctx.globalAlpha = isSel ? 0.38 : 0.24
    ctx.fillStyle   = `rgb(${r},${g},${b})`
    for (let i = 0; i < numBars; i++) {
      const barH = peaks[i] * maxHalf
      ctx.fillRect(clipX + i * targetBW, mid - barH, Math.max(targetBW - 0.5, 1), barH * 2)
    }
    ctx.globalAlpha = isSel ? 0.75 : 0.55
    ctx.fillStyle   = 'white'
    for (let i = 0; i < numBars; i++) {
      const barH = peaks[i] * maxHalf * 0.60
      ctx.fillRect(clipX + i * targetBW, mid - barH, Math.max(targetBW * 0.5, 0.75), barH * 2)
    }
    ctx.restore()
    ctx.globalAlpha = 1
  }

  ctx.globalAlpha = 1

  // Fade-in gradient overlay
  if (clip.fadeIn > 0) {
    const fiW  = Math.min(lteTX(clip.fadeIn), clipW)
    const grad = ctx.createLinearGradient(clipX, 0, clipX + fiW, 0)
    grad.addColorStop(0, 'rgba(0,0,0,0.45)')
    grad.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = grad
    ctx.fillRect(clipX, clipTop, fiW, clipH)
  }

  // Fade-out gradient overlay
  if (clip.fadeOut > 0) {
    const foW  = Math.min(lteTX(clip.fadeOut), clipW)
    const grad = ctx.createLinearGradient(clipX + clipW - foW, 0, clipX + clipW, 0)
    grad.addColorStop(0, 'rgba(0,0,0,0)')
    grad.addColorStop(1, 'rgba(0,0,0,0.45)')
    ctx.fillStyle = grad
    ctx.fillRect(clipX + clipW - foW, clipTop, foW, clipH)
  }

  // Clip border
  ctx.strokeStyle = isSel ? `rgba(${r},${g},${b},0.95)` : `rgba(${r},${g},${b},0.40)`
  ctx.lineWidth   = isSel ? 1.5 : 1
  lteRoundRect(ctx, clipX, clipTop, clipW, clipH, 4, false, true)

  // Trim handles — thin white lines at in/out edges
  ctx.strokeStyle = 'rgba(255,255,255,0.80)'; ctx.lineWidth = 1.5
  ctx.beginPath(); ctx.moveTo(clipX,         clipTop); ctx.lineTo(clipX,         clipTop + clipH); ctx.stroke()
  ctx.beginPath(); ctx.moveTo(clipX + clipW, clipTop); ctx.lineTo(clipX + clipW, clipTop + clipH); ctx.stroke()

  // Clip name
  if (clipW > 24) {
    ctx.fillStyle = 'rgba(255,255,255,0.88)'
    ctx.font      = '600 11px "DM Sans", sans-serif'
    ctx.textAlign = 'left'
    ctx.save()
    ctx.beginPath(); ctx.rect(clipX + 8, clipTop, clipW - 16, clipH); ctx.clip()
    ctx.fillText(clip.name || 'Clip', clipX + 8, laneY + LTE_LANE_H / 2 + 4)
    ctx.restore()
  }
}

function lteRoundRect(ctx, x, y, w, h, r, fill, stroke) {
  if (w < r * 2) r = w / 2
  if (h < r * 2) r = h / 2
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
  if (fill)   ctx.fill()
  if (stroke) ctx.stroke()
}

// ── HIT TEST ───────────────────────────────────────────────────────────────────
function lteHitTest(cx, cy) {
  if (cy < LTE_RULER_H) return { type: 'ruler' }

  const idx = Math.floor((cy - LTE_RULER_H) / LTE_LANE_H)
  if (idx < 0 || idx >= lteState.clips.length) return null

  const clip  = lteState.clips[idx]
  const dur   = lteClipDur(clip)
  const clipX = lteTX(clip.offset)
  const clipW = lteTX(dur)
  const gripW = Math.min(LTE_FADE_PX, clipW / 2)

  // Trim markers sit exactly at clipX (in) and clipX+clipW (out), ±LTE_TRIM_PX hit zone.
  // Check trim before clip-body and fade zones so the marker always wins when close.
  if (Math.abs(cx - clipX)          <= LTE_TRIM_PX) return { type: 'trimIn',  idx }
  if (Math.abs(cx - (clipX + clipW)) <= LTE_TRIM_PX) return { type: 'trimOut', idx }

  if (cx < clipX || cx > clipX + clipW) return { type: 'empty', idx }
  if (cx < clipX + gripW)               return { type: 'fadeIn',  idx }
  if (cx > clipX + clipW - gripW)       return { type: 'fadeOut', idx }
  return { type: 'clip', idx }
}

// ── SNAP ───────────────────────────────────────────────────────────────────────
function lteSnapTime(t, excludeIdx) {
  const snapDist = LTE_SNAP_PX / lteState.zoom
  const cands = [0, lteState.totalDur]
  lteState.clips.forEach((c, i) => {
    if (i === excludeIdx) return
    cands.push(c.offset, c.offset + lteClipDur(c))
  })
  for (const s of cands) {
    if (Math.abs(t - s) <= snapDist) return s
  }
  return t
}

// ── PLAYBACK ───────────────────────────────────────────────────────────────────
function ltePlay() {
  if (lteState.playing) return
  lteState.playing  = true
  lteState.playWall = Date.now()
  lteState.playPh   = lteState.playhead

  // Clear any stale timers
  lteState.playTimers.forEach(clearTimeout)
  lteState.playTimers = []

  const ph = lteState.playhead

  // Pre-assign all previewIds so duck logic can reference sibling IDs immediately
  lteState.clips.forEach((clip, i) => {
    const dur = lteClipDur(clip)
    clip._previewId = (clip.offset + dur > ph) ? `lte_preview_${i}_${Date.now()}` : null
  })

  lteState.clips.forEach((clip, i) => {
    const dur     = lteClipDur(clip)
    const clipEnd = clip.offset + dur
    if (ph >= clipEnd || !clip._previewId) return

    const previewId = clip._previewId

    // remaining is computed at fire time (inside fireDuck) so deferred clips
    // use the correct anchor — when the clip actually starts, not ltePlay() time
    const fireDuck = (phNow, clipRemaining) => {
      if (!clip.duck) return
      lteState.clips.forEach(other => {
        if (!other._previewId || other._previewId === previewId) return
        const otherEnd = other.offset + lteClipDur(other)
        if (other.offset <= phNow && otherEnd > phNow) {
          window.flowcast.sendToBackend({
            type: 'duck_start', id: other._previewId,
            amount: clip.duckAmount ?? -12,
            fadeIn: clip.duckFadeIn ?? 0.5,
          })
        }
      })
      setTimeout(() => {
        if (!lteState.playing) return
        lteState.clips.forEach(other => {
          if (!other._previewId || other._previewId === previewId) return
          window.flowcast.sendToBackend({
            type: 'duck_end', id: other._previewId,
            fadeOut: clip.duckFadeOut ?? 1.0,
          })
        })
      }, clipRemaining * 1000)
    }

    if (ph >= clip.offset) {
      // Start mid-clip — remaining is from current playhead to clip end
      const elapsed       = ph - clip.offset
      const midRemaining  = clipEnd - ph
      window.flowcast.sendToBackend({
        type:     'play', id: previewId,
        filePath: clip.filePath,
        inPoint:  (clip.inPoint || 0) + elapsed,
        outPoint: clip.outPoint,
        volume:   clip.volume  || 0,
        pan:      clip.pan     || 0,
        fadeIn:   0,
        fadeOut:  clip.fadeOut || 0,
      })
      fireDuck(ph, midRemaining)
    } else {
      const delay = (clip.offset - ph) * 1000
      const t = setTimeout(() => {
        if (!lteState.playing) return
        window.flowcast.sendToBackend({
          type:     'play', id: previewId,
          filePath: clip.filePath,
          inPoint:  clip.inPoint  || 0,
          outPoint: clip.outPoint,
          volume:   clip.volume   || 0,
          pan:      clip.pan      || 0,
          fadeIn:   clip.fadeIn   || 0,
          fadeOut:  clip.fadeOut  || 0,
        })
        // remaining = full clip duration (fires from clip start, not ltePlay time)
        fireDuck(clip.offset, dur)
      }, delay)
      lteState.playTimers.push(t)
    }
  })

  const btnPlay = document.getElementById('lte-btn-play')
  if (btnPlay) btnPlay.textContent = '⏸ Pause'

  const tick = () => {
    if (!lteState.playing) return
    const elapsed    = (Date.now() - lteState.playWall) / 1000
    lteState.playhead = Math.min(lteState.playPh + elapsed, lteState.totalDur)
    lteRender()
    lteUpdatePlayheadTime()
    if (lteState.playhead >= lteState.totalDur) { lteStopPlayback(); return }
    lteState.rafId = requestAnimationFrame(tick)
  }
  lteState.rafId = requestAnimationFrame(tick)
}

function ltePause() {
  if (!lteState.playing) return
  lteState.playing = false
  if (lteState.rafId) { cancelAnimationFrame(lteState.rafId); lteState.rafId = null }
  lteState.playTimers.forEach(clearTimeout)
  lteState.playTimers = []
  lteState.clips.forEach(clip => {
    if (clip._previewId) {
      window.flowcast.sendToBackend({ type: 'stop', id: clip._previewId })
      clip._previewId = null
    }
  })
  const btnPlay = document.getElementById('lte-btn-play')
  if (btnPlay) btnPlay.textContent = '▶ Play'
}

function lteStopPlayback() {
  ltePause()
  lteRender()
  lteUpdatePlayheadTime()
}

function lteStop() {
  ltePause()
  lteState.playhead = 0
  lteRender()
  lteUpdatePlayheadTime()
}

function lteRewind() {
  const wasPlaying = lteState.playing
  if (wasPlaying) ltePause()
  lteState.playhead = 0
  lteRender()
  lteUpdatePlayheadTime()
  if (wasPlaying) ltePlay()
}

function lteUpdatePlayheadTime() {
  const el = document.getElementById('lte-playhead-time')
  if (el) el.textContent = formatTime(lteState.playhead)
}

// ── INFO PANEL ─────────────────────────────────────────────────────────────────
function lteUpdateInfoPanel() {
  const panel = document.getElementById('lte-info-panel')
  if (!panel) return

  const idx  = lteState.selIdx
  const clip = idx != null ? lteState.clips[idx] : null

  if (!clip) {
    panel.innerHTML = '<div class="lte-info-empty">Select a clip to edit</div>'
    return
  }

  const dur         = lteClipDur(clip)
  const [r, g, b]   = LTE_COLORS[idx % LTE_COLORS.length]
  const accentColor = `rgb(${r},${g},${b})`

  panel.innerHTML = `
    <div class="lte-clip-header" style="border-left-color:${accentColor}">
      <span class="lte-clip-name" contenteditable="true" spellcheck="false"
            id="lte-clip-name-edit">${escHtml(clip.name || 'Clip')}</span>
      <span class="lte-clip-dur">${formatTime(dur)}</span>
    </div>
    <div class="lte-info-row">
      <label class="lte-info-label">Offset</label>
      <div class="input-with-unit">
        <input class="form-input form-input-mono lte-inp" id="lte-inp-offset"
          type="number" min="0" step="0.001" value="${clip.offset.toFixed(3)}">
        <span class="input-unit">s</span>
      </div>
    </div>
    <div class="lte-info-row">
      <label class="lte-info-label">Volume</label>
      <div class="input-with-unit">
        <input class="form-input form-input-mono lte-inp" id="lte-inp-volume"
          type="number" min="-60" max="12" step="0.5" value="${clip.volume || 0}">
        <span class="input-unit">dB</span>
      </div>
    </div>
    <div class="lte-info-row">
      <label class="lte-info-label">Fade In</label>
      <div class="input-with-unit">
        <input class="form-input form-input-mono lte-inp" id="lte-inp-fadein"
          type="number" min="0" step="0.1" value="${clip.fadeIn || 0}">
        <span class="input-unit">s</span>
      </div>
    </div>
    <div class="lte-info-row">
      <label class="lte-info-label">Fade Out</label>
      <div class="input-with-unit">
        <input class="form-input form-input-mono lte-inp" id="lte-inp-fadeout"
          type="number" min="0" step="0.1" value="${clip.fadeOut || 0}">
        <span class="input-unit">s</span>
      </div>
    </div>
    <div class="lte-duck-section">
      <label class="duck-toggle">
        <input type="checkbox" id="lte-chk-duck" ${clip.duck ? 'checked' : ''}>
        <span class="duck-toggle-label">Duck other tracks</span>
      </label>
      <div id="lte-duck-settings" ${clip.duck ? '' : 'style="display:none"'}>
        <div class="lte-info-row">
          <label class="lte-info-label">Amount</label>
          <div class="input-with-unit">
            <input class="form-input form-input-mono lte-inp" id="lte-inp-duck-amount"
              type="number" min="-60" max="-1" step="1" value="${clip.duckAmount ?? -12}">
            <span class="input-unit">dB</span>
          </div>
        </div>
        <div class="lte-info-row">
          <label class="lte-info-label">Duck In</label>
          <div class="input-with-unit">
            <input class="form-input form-input-mono lte-inp" id="lte-inp-duck-fi"
              type="number" min="0" step="0.1" value="${clip.duckFadeIn ?? 0.5}">
            <span class="input-unit">s</span>
          </div>
        </div>
        <div class="lte-info-row">
          <label class="lte-info-label">Duck Out</label>
          <div class="input-with-unit">
            <input class="form-input form-input-mono lte-inp" id="lte-inp-duck-fo"
              type="number" min="0" step="0.1" value="${clip.duckFadeOut ?? 1.0}">
            <span class="input-unit">s</span>
          </div>
        </div>
      </div>
    </div>
  `

  // Bind info inputs
  function bindLte(id, apply) {
    const el = document.getElementById(id)
    if (!el) return
    el.addEventListener('change', () => {
      const c = lteState.clips[lteState.selIdx]
      if (!c) return
      apply(c, el.value)
      lteComputeTotal()
      lteResizeCanvas()
      lteRender()
    })
  }

  bindLte('lte-inp-offset',       (c, v) => { c.offset  = Math.max(0, parseFloat(v) || 0) })
  bindLte('lte-inp-volume',       (c, v) => { c.volume  = parseFloat(v) || 0 })
  bindLte('lte-inp-fadein',       (c, v) => { c.fadeIn  = Math.max(0, parseFloat(v) || 0) })
  bindLte('lte-inp-fadeout',      (c, v) => { c.fadeOut = Math.max(0, parseFloat(v) || 0) })
  bindLte('lte-inp-duck-amount',  (c, v) => { c.duckAmount  = parseFloat(v) || -12 })
  bindLte('lte-inp-duck-fi',      (c, v) => { c.duckFadeIn  = Math.max(0, parseFloat(v) || 0.5) })
  bindLte('lte-inp-duck-fo',      (c, v) => { c.duckFadeOut = Math.max(0, parseFloat(v) || 1.0) })

  const duckChk = document.getElementById('lte-chk-duck')
  if (duckChk) {
    duckChk.addEventListener('change', () => {
      const c = lteState.clips[lteState.selIdx]; if (!c) return
      c.duck = duckChk.checked
      const ds = document.getElementById('lte-duck-settings')
      if (ds) ds.style.display = c.duck ? '' : 'none'
    })
  }

  // Clip name edit
  const nameEl = document.getElementById('lte-clip-name-edit')
  if (nameEl) {
    const commitName = () => {
      const c = lteState.clips[lteState.selIdx]; if (!c) return
      c.name = nameEl.textContent.trim() || 'Clip'
      lteRender()  // update the name label drawn on the clip body
    }
    nameEl.addEventListener('blur', commitName)
    nameEl.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); nameEl.blur() }
      if (e.key === 'Escape') {
        const c = lteState.clips[lteState.selIdx]
        nameEl.textContent = c ? (c.name || 'Clip') : 'Clip'
        nameEl.blur()
      }
      e.stopPropagation()  // don't let Space/Escape trigger LTE transport
    })
  }
}

function lteUpdateInfoInputs(idx) {
  const clip = lteState.clips[idx]
  if (!clip) return
  const setV = (id, v) => {
    const el = document.getElementById(id)
    if (el && document.activeElement !== el) el.value = typeof v === 'number' ? v.toFixed(3) : v
  }
  setV('lte-inp-offset',  clip.offset)
  setV('lte-inp-fadein',  clip.fadeIn  || 0)
  setV('lte-inp-fadeout', clip.fadeOut || 0)
  // Update duration display when trim changes in/outPoint
  const dur = lteState.selIdx === idx ? lteClipDur(clip) : null
  if (dur !== null) {
    const durEl = document.querySelector('.lte-clip-dur')
    if (durEl) durEl.textContent = formatTime(dur)
  }
}

// ── CANVAS MOUSE EVENTS ────────────────────────────────────────────────────────
function lteBindCanvas() {
  const canvas = document.getElementById('lte-canvas')
  const wrap   = document.getElementById('lte-canvas-wrap')
  if (!canvas) return

  let drag = null  // {type, idx, startX, startOff, startFade}

  // Use the WRAPPER rect (not canvas) so scroll offset isn't double-counted
  function canvasX(clientX) {
    const r = wrap ? wrap.getBoundingClientRect() : canvas.getBoundingClientRect()
    return clientX - r.left + (wrap ? wrap.scrollLeft : 0)
  }
  function canvasY(clientY) {
    const r = wrap ? wrap.getBoundingClientRect() : canvas.getBoundingClientRect()
    return clientY - r.top
  }

  canvas.addEventListener('mousedown', e => {
    const cx = canvasX(e.clientX)
    const cy = canvasY(e.clientY)

    const hit = lteHitTest(cx, cy)
    if (!hit) return

    if (hit.type === 'ruler') {
      lteState.playhead = Math.max(0, Math.min(lteXT(cx), lteState.totalDur))
      lteRender()
      lteUpdatePlayheadTime()
      drag = { type: 'playhead' }
      e.preventDefault()
      return
    }

    if (hit.type === 'empty') return

    // Select clip and update info panel
    if (lteState.selIdx !== hit.idx) {
      lteState.selIdx = hit.idx
      lteRender()
      lteUpdateInfoPanel()
    }

    const clip = lteState.clips[hit.idx]
    if (hit.type === 'trimIn') {
      lteState.trimDragIdx     = hit.idx
      lteState.trimDragAnchorX = lteTX(clip.offset) - lteTX(clip.inPoint || 0)
      drag = { type: 'trimIn',  idx: hit.idx, startX: cx, startIn: clip.inPoint || 0, startOff: clip.offset }
    } else if (hit.type === 'trimOut') {
      lteState.trimDragIdx     = hit.idx
      lteState.trimDragAnchorX = lteTX(clip.offset) - lteTX(clip.inPoint || 0)
      drag = { type: 'trimOut', idx: hit.idx, startX: cx, startOut: clip.outPoint ?? clip.duration ?? lteClipDur(clip) }
    } else if (hit.type === 'fadeIn') {
      drag = { type: 'fadeIn',  idx: hit.idx, startX: cx, startFade: clip.fadeIn  || 0 }
    } else if (hit.type === 'fadeOut') {
      drag = { type: 'fadeOut', idx: hit.idx, startX: cx, startFade: clip.fadeOut || 0 }
    } else {
      drag = { type: 'clip',    idx: hit.idx, startX: cx, startOff: clip.offset }
    }
    e.preventDefault()
  })

  function onMove(e) {
    const cx = canvasX(e.clientX)

    // Cursor + tooltip feedback when not dragging
    if (!drag) {
      const cy  = canvasY(e.clientY)
      const hit = lteHitTest(cx, cy)
      const tooltip = document.getElementById('lte-canvas-tooltip')

      if (hit && (hit.type === 'trimIn' || hit.type === 'trimOut')) {
        canvas.style.cursor = 'ew-resize'
        const clip = lteState.clips[hit.idx]
        if (tooltip && clip) {
          const t = hit.type === 'trimIn' ? (clip.inPoint || 0) : (clip.outPoint ?? clip.duration ?? 0)
          const label = hit.type === 'trimIn' ? 'In' : 'Out'
          tooltip.textContent   = `${label}: ${formatTime(t)}`
          tooltip.style.display = 'block'
          tooltip.style.left    = `${e.clientX}px`
          tooltip.style.top     = `${e.clientY - 28}px`
        }
      } else if (hit && (hit.type === 'fadeIn' || hit.type === 'fadeOut')) {
        canvas.style.cursor = 'ew-resize'
        if (tooltip) tooltip.style.display = 'none'
      } else if (hit && hit.type === 'clip') {
        canvas.style.cursor = 'grab'
        if (tooltip) tooltip.style.display = 'none'
      } else {
        canvas.style.cursor = ''
        if (tooltip) tooltip.style.display = 'none'
      }
      return
    }

    const dt   = lteXT(cx - drag.startX)
    const clip = lteState.clips[drag.idx]

    if (drag.type === 'playhead') {
      lteState.playhead = Math.max(0, Math.min(lteXT(cx), lteState.totalDur))
      lteRender()
      lteUpdatePlayheadTime()
      return
    }

    if (drag.type === 'trimIn') {
      const maxIn  = (clip.outPoint ?? clip.duration ?? lteClipDur(clip)) - LTE_MIN_DUR
      clip.inPoint = Math.max(0, Math.min(drag.startIn + dt, maxIn))
      const tooltip = document.getElementById('lte-canvas-tooltip')
      if (tooltip) {
        tooltip.textContent   = `In: ${formatTime(clip.inPoint)}`
        tooltip.style.display = 'block'
        tooltip.style.left    = `${e.clientX}px`
        tooltip.style.top     = `${e.clientY - 28}px`
      }
    } else if (drag.type === 'trimOut') {
      const minOut = (clip.inPoint || 0) + LTE_MIN_DUR
      const maxOut = clip.duration || Infinity
      clip.outPoint = Math.max(minOut, Math.min(drag.startOut + dt, maxOut))
      const tooltip = document.getElementById('lte-canvas-tooltip')
      if (tooltip) {
        tooltip.textContent   = `Out: ${formatTime(clip.outPoint)}`
        tooltip.style.display = 'block'
        tooltip.style.left    = `${e.clientX}px`
        tooltip.style.top     = `${e.clientY - 28}px`
      }
    } else if (drag.type === 'clip') {
      let newOff = Math.max(0, drag.startOff + dt)
      // Try snapping left edge
      newOff = lteSnapTime(newOff, drag.idx)
      // Also try snapping right edge
      const dur     = lteClipDur(clip)
      const snappedR = lteSnapTime(newOff + dur, drag.idx)
      if (snappedR !== newOff + dur) newOff = snappedR - dur
      clip.offset = Math.max(0, newOff)
      lteComputeTotal()
      lteResizeCanvas()
    } else if (drag.type === 'fadeIn') {
      const maxFade = lteClipDur(clip)
      clip.fadeIn   = Math.max(0, Math.min(drag.startFade + dt, maxFade))
    } else if (drag.type === 'fadeOut') {
      const maxFade = lteClipDur(clip)
      clip.fadeOut  = Math.max(0, Math.min(drag.startFade - dt, maxFade))
    }

    lteRender()
    if (drag.type !== 'playhead') lteUpdateInfoInputs(drag.idx)
  }

  function onUp() {
    if (lteState.trimDragIdx !== null) {
      // Commit the offset so the clip body lands exactly where the in-marker was
      if (drag && drag.type === 'trimIn') {
        const clip = lteState.clips[drag.idx]
        if (clip) clip.offset = Math.max(0, drag.startOff + (clip.inPoint - drag.startIn))
      }
      lteState.trimDragIdx     = null
      lteState.trimDragAnchorX = null
      lteComputeTotal()
      lteResizeCanvas()
      lteRender()
    }
    drag = null
    canvas.style.cursor = ''
    const tooltip = document.getElementById('lte-canvas-tooltip')
    if (tooltip) tooltip.style.display = 'none'
  }

  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup',   onUp)

  // Update overflow hint when user scrolls
  if (wrap) {
    wrap.addEventListener('scroll', () => lteUpdateOverflowHint(wrap, null), { passive: true })
  }

  // ── Scroll-wheel zoom (Ctrl+wheel) / trackpad pinch (Ctrl+wheel on Mac) ──
  if (wrap) {
    wrap.addEventListener('wheel', e => {
      if (!e.ctrlKey && !e.metaKey) return   // plain scroll = pan, not zoom
      e.preventDefault()
      const factor    = e.deltaY < 0 ? 1.12 : 0.89
      const rect      = wrap.getBoundingClientRect()
      const cx        = e.clientX - rect.left + wrap.scrollLeft
      const tAtCursor = lteXT(cx)
      lteState.zoom = Math.max(8, Math.min(600, lteState.zoom * factor))
      lteResizeCanvas()
      lteRender()
      // Keep the time-point under the cursor in place
      const newCx = lteTX(tAtCursor)
      wrap.scrollLeft = newCx - (e.clientX - rect.left)
    }, { passive: false })
  }
}

// ── ZOOM ───────────────────────────────────────────────────────────────────────
function lteZoomIn()  {
  lteState.zoom = Math.min(lteState.zoom * 1.5, 600)
  lteResizeCanvas(); lteRender()
}
function lteZoomOut() {
  lteState.zoom = Math.max(lteState.zoom / 1.5, 8)
  lteResizeCanvas(); lteRender()
}

// ── KEYBOARD ───────────────────────────────────────────────────────────────────
function lteHandleKey(e) {
  const overlay = document.getElementById('lte-overlay')
  if (!overlay || overlay.style.display === 'none') return
  if (e.target.isContentEditable) return
  if (e.target.tagName === 'TEXTAREA') return
  if (e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') return

  if (e.key === ' ') {
    e.preventDefault()
    e.stopPropagation()
    lteState.playing ? ltePause() : ltePlay()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    lteRewind()
  }
}

// ── INIT ───────────────────────────────────────────────────────────────────────
function lteInit() {
  if (!document.getElementById('lte-overlay')) return

  lteBindCanvas()

  document.getElementById('lte-btn-play').addEventListener('click', () => {
    lteState.playing ? ltePause() : ltePlay()
  })
  document.getElementById('lte-btn-rewind').addEventListener('click', lteRewind)
  document.getElementById('lte-btn-cancel').addEventListener('click', lteClose)
  document.getElementById('lte-btn-save').addEventListener('click',   lteSave)
  document.getElementById('lte-btn-zoom-in').addEventListener('click',  lteZoomIn)
  document.getElementById('lte-btn-zoom-out').addEventListener('click', lteZoomOut)

  const titleEl = document.getElementById('lte-title')
  if (titleEl) {
    titleEl.addEventListener('blur',    () => { lteState.comboName = titleEl.textContent.trim() || 'Combo Cue' })
    titleEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); titleEl.blur() } })
  }

  document.addEventListener('keydown', lteHandleKey)
}

// Auto-init once DOM is ready
lteInit()

// Called by renderer.js when a clip's waveform finishes loading.
// Works for both lteOpen (source cues still in top-level list) and
// lteOpenCombo (sub-clips of an existing combo).
function lteHandleWaveformLoaded(clipId, waveformData, duration) {
  const clip = lteState.clips.find(c => c.id === clipId)
  if (!clip) return
  // If duration was unknown before, ANY outPoint we had was a placeholder (null or 30s fallback).
  // In that case always reset to the real duration.
  const wasUnloaded = !(clip.duration > 0)
  clip.waveformData = waveformData || null
  clip.duration     = duration
  if (wasUnloaded || clip.outPoint == null || clip.outPoint <= 0 || clip.outPoint > duration) {
    clip.outPoint = duration
  }
  lteComputeTotal()
  lteResizeCanvas()
  lteRender()
}
