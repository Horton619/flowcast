'use strict'

// ── STATE ──────────────────────────────────────────────────────────────────────
const state = {
  project: {
    name: 'Untitled',
    filePath: null,
    cues: [],
    settings: {
      oscPort: 53000,
      outputDevice: '',
      goMode: 'stop',        // 'stop' | 'overlap' | 'fadeout'
      goFadeDuration: 2.0
    }
  },
  selectedCueId: null,
  playingCues: {},       // id -> { startedAt, duration, timer, clipIds? }
  playedCues: new Set(), // ids of cues that have completed at least once
  comboSelected: new Set(), // ids of cues checked for combo-cue building
  paused: false,
  oscConnected: false,
  oscError: null,
  backendReady: false,
  dirty: false,
  inspectorTab: 'basics',
  inspectorResizing: false,
  inspectorH: 260,
  nowPlayingH: 110
}

let rowDragSrcId = null
let goContinueDepth = 0   // auto-continue recursion guard — reset on each explicit go()

let idCounter = 1
function newId() { return `cue_${Date.now()}_${idCounter++}` }

const NPH_DEFAULT = 110
const NPH_MIN     = 72
const NPH_MAX     = 280

// ── COLOUR MAP ─────────────────────────────────────────────────────────────────
const COLOR_MAP = {
  none: null, red: '#ff4757', orange: '#ff8c00',
  yellow: '#ffb800', green: '#00d97e', blue: '#3d7eff', purple: '#a855f7'
}

// ── CONTINUE MODE ICONS ────────────────────────────────────────────────────────
const CONTINUE_ICONS = {
  none: '',
  'auto-continue': '<span class="continue-icon-ac" title="Play With — next cue starts when this one starts">↷</span>',
  'auto-follow':   '<span class="continue-icon-af" title="Auto-Play Next — next cue starts when this one ends">↪</span>'
}
const LOOP_ICON = '<span class="continue-icon-loop" title="Loops until stopped">↻</span>'

// ── HELPERS ────────────────────────────────────────────────────────────────────
function formatTime(secs) {
  if (secs == null || isNaN(secs)) return '—'
  const m = Math.floor(secs / 60)
  const s = (secs % 60).toFixed(3).padStart(6, '0')
  return `${m}:${s}`
}

function formatPrewait(secs) {
  if (!secs || secs === 0) return '—'
  return `${secs.toFixed(1)}s`
}

function basename(p) {
  return p ? p.replace(/\\/g, '/').split('/').pop() : ''
}

function getCueById(id) {
  return state.project.cues.find(c => c.id === id) || null
}

function getCueIndex(id) {
  return state.project.cues.findIndex(c => c.id === id)
}

// ── DOM REFS ───────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id)
const tbody      = $('cue-tbody')
const emptyState = $('cue-list-empty')
const dropOverlay= $('drop-overlay')
const oscDot     = $('osc-dot')
const oscStatus  = $('osc-status')
const oscLabel   = $('osc-label')
const projectNameDisplay = $('project-name-display')
const btnGo      = $('btn-go')
const btnStop    = $('btn-stop')
const btnPause   = $('btn-pause')
const btnPanic   = $('btn-panic')
const btnAddCue  = $('btn-add-cue')
const btnImport  = $('btn-import-audio')
const btnDelete  = $('btn-delete-cue')
const inspector  = $('inspector')
const inspectorLabel = $('inspector-cue-label')
const resizeHandle   = $('resize-handle')

// Inspector form refs
const basicsEmpty = $('basics-empty')
const basicsForm  = $('basics-form')
const timeEmpty   = $('time-empty')
const timeForm    = $('time-form')
const audioEmpty  = $('audio-empty')
const audioForm   = $('audio-form')

// ── RENDER CUE LIST ────────────────────────────────────────────────────────────
function computeLinkDepths(cues) {
  const depths = new Array(cues.length).fill(0)
  for (let i = 1; i < cues.length; i++) {
    if (cues[i - 1].continueMode !== 'none') {
      depths[i] = depths[i - 1] + 1
    }
  }
  return depths
}

function renderCueList() {
  const cues = state.project.cues
  emptyState.classList.toggle('visible', cues.length === 0)

  const depths = computeLinkDepths(cues)

  tbody.innerHTML = ''
  cues.forEach((cue, idx) => {
    const tr = document.createElement('tr')
    tr.dataset.id = cue.id

    const isSelected = cue.id === state.selectedCueId
    const isPlaying  = !!state.playingCues[cue.id]
    const isPlayed   = state.playedCues.has(cue.id)
    const isCombo    = cue.type === 'combo'
    const depth      = depths[idx]
    const linkedFrom = idx > 0 && depth > 0 ? cues[idx - 1].continueMode : null

    if (isCombo)              tr.classList.add('row-combo')
    if (isPlaying)            tr.classList.add('row-playing')
    else if (isSelected)      tr.classList.add('row-next')
    else if (isPlayed && !isCombo) tr.classList.add('row-played')

    if (linkedFrom === 'auto-continue') tr.classList.add('row-linked-ac')
    if (linkedFrom === 'auto-follow')   tr.classList.add('row-linked-af')

    const colorClass = cue.color && cue.color !== 'none' ? `stripe-${cue.color}` : ''
    const dur = isCombo
      ? (cue.totalDur || cue.duration)
      : (cue.outPoint != null ? (cue.outPoint - (cue.inPoint || 0)) : cue.duration)

    // State icon
    let stateIcon = ''
    if (isPlaying) {
      stateIcon = `<span class="state-playing"><span class="play-bar"></span><span class="play-bar"></span><span class="play-bar"></span></span>`
    } else if (isSelected) {
      stateIcon = `<span class="state-next"><svg width="8" height="10" viewBox="0 0 8 10"><path d="M1 1l6 4-6 4V1z" fill="white"/></svg></span>`
    } else if (isPlayed) {
      stateIcon = `<span class="state-played" title="Click to reset"><span class="done-check">✓</span><span class="done-clear">CLEAR</span></span>`
    }

    // Name cell
    const indentPx = depth * 22
    let linkConnector = ''
    if (linkedFrom) {
      const cls  = linkedFrom === 'auto-continue' ? 'link-branch-ac' : 'link-branch-af'
      const icon = linkedFrom === 'auto-continue' ? '↷' : '↪'
      linkConnector = `<span class="link-branch ${cls}">${icon}</span>`
    }
    const displayName = escHtml(cue.name || basename(cue.filePath) || 'Untitled Cue')
    const nameExtras  = isCombo
      ? `<span class="combo-badge">COMBO</span><span class="combo-thumb-wrap"></span><span class="combo-edit-btn">EDIT</span>`
      : (!cue.filePath ? '<span class="no-file-badge">NO FILE</span>' : '')

    const isChecked = state.comboSelected.has(cue.id)

    tr.setAttribute('draggable', 'true')
    tr.innerHTML = `
      <td class="td-color-stripe"><span class="color-stripe ${colorClass}"></span></td>
      <td class="td-num">${escHtml(cue.number)}</td>
      <td class="td-state">${stateIcon}</td>
      <td class="td-name" style="padding-left:${10 + indentPx}px">
        <div class="td-name-inner">
          ${linkConnector}
          <span class="td-name-text">${displayName}</span>
          ${nameExtras}
        </div>
      </td>
      <td class="td-combo"><input type="checkbox" class="combo-check" title="Select for Combo Cue" ${isChecked ? 'checked' : ''}></td>
      <td class="td-prewait">${formatPrewait(cue.preWait)}</td>
      <td class="td-postwait">${formatPrewait(cue.postWait)}</td>
      <td class="td-duration">${formatTime(dur)}</td>
      <td class="td-continue">${cue.loop ? LOOP_ICON : ''}${CONTINUE_ICONS[cue.continueMode] || ''}</td>
    `

    if (isPlaying) {
      const bar = document.createElement('div')
      bar.className = 'cue-progress-bar'
      bar.id = `progress-${cue.id}`
      tr.appendChild(bar)
    }

    // ── Combo thumbnail canvas ──
    if (isCombo) {
      const wrap = tr.querySelector('.combo-thumb-wrap')
      if (wrap) {
        const canvas = document.createElement('canvas')
        canvas.width  = 72
        canvas.height = 16
        canvas.className = 'combo-thumb'
        wrap.appendChild(canvas)
        drawComboThumbnail(canvas, cue)
      }
    }

    // ── Row click / dblclick ──
    tr.addEventListener('click', e => {
      if (e.target.closest('.drag-handle'))    return
      if (e.target.closest('.combo-check'))    return
      if (e.target.closest('.combo-edit-btn')) return
      selectCue(cue.id)
    })
    tr.addEventListener('dblclick', e => {
      if (e.target.closest('.drag-handle'))    return
      if (e.target.closest('.combo-edit-btn')) return
      if (isCombo) { lteOpenCombo(cue.id); return }
      selectCue(cue.id)
      startEditName(cue.id)
    })

    // ── DONE badge → click clears played state ──
    const doneBadge = tr.querySelector('.state-played')
    if (doneBadge) {
      doneBadge.addEventListener('click', e => {
        e.stopPropagation()
        state.playedCues.delete(cue.id)
        renderCueList()
      })
    }

    // ── Combo EDIT button ──
    const editBtn = tr.querySelector('.combo-edit-btn')
    if (editBtn) {
      editBtn.addEventListener('click', e => { e.stopPropagation(); lteOpenCombo(cue.id) })
    }

    // ── Combo checkbox ──
    const chk = tr.querySelector('.combo-check')
    if (chk) {
      chk.addEventListener('change', e => {
        e.stopPropagation()
        if (chk.checked) state.comboSelected.add(cue.id)
        else             state.comboSelected.delete(cue.id)
        updateBeginEditBtn()
      })
    }

    // ── Drag-to-reorder ──
    tr.addEventListener('dragstart', e => {
      // Don't initiate drag from interactive elements inside the row
      if (e.target.tagName === 'INPUT' || e.target.closest('.combo-edit-btn')) {
        e.preventDefault(); return
      }
      rowDragSrcId = cue.id
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', cue.id)
      tr.classList.add('dragging')
    })
    tr.addEventListener('dragend', () => {
      tr.classList.remove('dragging')
      document.querySelectorAll('.drag-over-top, .drag-over-bottom').forEach(el => {
        el.classList.remove('drag-over-top', 'drag-over-bottom')
      })
      rowDragSrcId = null
    })
    tr.addEventListener('dragover', e => {
      if (!e.dataTransfer.types.includes('text/plain')) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      document.querySelectorAll('.drag-over-top, .drag-over-bottom').forEach(el => {
        el.classList.remove('drag-over-top', 'drag-over-bottom')
      })
      const rect = tr.getBoundingClientRect()
      tr.classList.add(e.clientY < rect.top + rect.height / 2 ? 'drag-over-top' : 'drag-over-bottom')
    })
    tr.addEventListener('dragleave', e => {
      if (!tr.contains(e.relatedTarget)) {
        tr.classList.remove('drag-over-top', 'drag-over-bottom')
      }
    })
    tr.addEventListener('drop', e => {
      const srcId = e.dataTransfer.getData('text/plain')
      if (!srcId) return  // file drop — let it bubble
      e.preventDefault()
      e.stopPropagation()
      tr.classList.remove('drag-over-top', 'drag-over-bottom')
      if (srcId === cue.id) { rowDragSrcId = null; return }

      const before = e.clientY < tr.getBoundingClientRect().top + tr.getBoundingClientRect().height / 2
      const srcIdx = getCueIndex(srcId)
      const [moved] = state.project.cues.splice(srcIdx, 1)
      const dstIdx  = getCueIndex(cue.id)  // recalculate after splice
      state.project.cues.splice(before ? dstIdx : dstIdx + 1, 0, moved)
      markDirty()
      renderCueList()
      rowDragSrcId = null
    })

    tbody.appendChild(tr)
  })

  btnDelete.disabled = !state.selectedCueId
  updateBeginEditBtn()
  updateTitle()
  updateNowPlaying()
}

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
}

// ── SELECTION ─────────────────────────────────────────────────────────────────
function selectCue(id) {
  if (id !== state.selectedCueId) {
    stopTrimPreview()
    waveformState.playheadTime = 0
  }
  state.selectedCueId = id
  renderCueList()
  updateInspector()
  scrollSelectedIntoView()
}

function scrollSelectedIntoView() {
  const tr = tbody.querySelector('tr.selected')
  if (tr) tr.scrollIntoView({ block: 'nearest' })
}

function selectNext() {
  const cues = state.project.cues
  if (!cues.length) return
  const idx = getCueIndex(state.selectedCueId)
  const next = cues[Math.min(idx + 1, cues.length - 1)]
  if (next) selectCue(next.id)
}

function selectPrev() {
  const cues = state.project.cues
  if (!cues.length) return
  const idx = getCueIndex(state.selectedCueId)
  const prev = cues[Math.max(idx - 1, 0)]
  if (prev) selectCue(prev.id)
}

// ── INSPECTOR ─────────────────────────────────────────────────────────────────
function updateInspector() {
  const cue = getCueById(state.selectedCueId)
  const tabs = ['basics', 'time', 'audio']

  inspectorLabel.textContent = cue
    ? `Cue ${cue.number} — ${cue.name || basename(cue.filePath) || 'Untitled'}`
    : 'No cue selected'

  tabs.forEach(tab => {
    const empty = $(`${tab}-empty`)
    const form  = $(`${tab}-form`)
    if (!cue) {
      empty.style.display = ''
      if (form) form.style.display = 'none'
    } else {
      empty.style.display = 'none'
      if (form) form.style.display = ''
    }
  })

  if (!cue) return

  // ── Basics ──
  $('inp-cue-number').value = cue.number
  $('inp-cue-name').value   = cue.name || ''
  $('inp-prewait').value    = cue.preWait  || 0
  $('inp-postwait').value   = cue.postWait || 0
  $('cue-file-path').textContent = cue.filePath || '— no file —'

  // go override
  $('sel-go-override').value = cue.goModeOverride || ''
  $('inp-cue-fade-dur').value = cue.cueFadeDuration || 2.0
  $('row-cue-fade-dur').style.display = cue.goModeOverride === 'fadeout' ? '' : 'none'

  // loop
  $('chk-loop').checked = !!cue.loop

  // duck
  $('chk-duck').checked = !!cue.duck
  $('duck-settings').style.display = cue.duck ? '' : 'none'
  $('inp-duck-amount').value   = cue.duckAmount  ?? -12
  $('inp-duck-fade-in').value  = cue.duckFadeIn  ?? 0.5
  $('inp-duck-fade-out').value = cue.duckFadeOut ?? 1.0

  // Color picker
  document.querySelectorAll('.color-swatch').forEach(sw => {
    sw.classList.toggle('selected', sw.dataset.color === (cue.color || 'none'))
  })

  // Continue mode
  document.querySelectorAll('.seg-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === (cue.continueMode || 'none'))
  })

  // ── Time ──
  $('inp-in-point').value  = cue.inPoint  != null ? cue.inPoint.toFixed(3)  : '0.000'
  $('inp-out-point').value = cue.outPoint != null ? cue.outPoint.toFixed(3) : (cue.duration ? cue.duration.toFixed(3) : '')
  $('waveform-playhead-time').textContent = formatTime(waveformState.playheadTime)
  const dur = cue.outPoint != null && cue.inPoint != null
    ? (cue.outPoint - cue.inPoint)
    : cue.duration
  $('disp-duration').textContent = dur != null ? formatTime(dur) : '—'
  $('inp-fade-in').value  = cue.fadeIn  || 0
  $('inp-fade-out').value = cue.fadeOut || 0

  drawWaveform(cue)

  // ── Audio ──
  $('slider-volume').value = cue.volume || 0
  $('inp-volume').value    = cue.volume || 0
  $('slider-pan').value    = cue.pan    || 0
  $('inp-pan').value       = cue.pan    || 0
}

// ── WAVEFORM ───────────────────────────────────────────────────────────────────
// playhead position in seconds for the selected cue (Time tab scrubber only)
const waveformState = { playheadTime: 0, previewId: null, previewTimer: null }

// ── COMBO THUMBNAIL ────────────────────────────────────────────────────────────
const THUMB_COLORS = [
  [61,126,255],[0,217,126],[255,184,0],[168,85,247],[255,71,87],[61,200,255],[255,130,0]
]
function drawComboThumbnail(canvas, cue) {
  const W = canvas.width
  const H = canvas.height
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, W, H)

  const total = cue.totalDur || cue.duration || 1
  const clips = cue.clips || []

  // Shorter clips get a luminosity boost so overlapping tracks are visually distinct
  const maxClipDur = clips.reduce((m, c) => {
    const d = Math.max(0, (c.outPoint != null ? c.outPoint : (c.duration || 0)) - (c.inPoint || 0))
    return d > m ? d : m
  }, 0)

  clips.forEach((clip, i) => {
    const [r, g, b] = THUMB_COLORS[i % THUMB_COLORS.length]
    const clipDur = Math.max(0,
      (clip.outPoint != null ? clip.outPoint : (clip.duration || 0)) - (clip.inPoint || 0))
    if (clipDur <= 0) return

    // ratio 0 = shortest clip, 1 = longest — boost shorter clips
    const ratio   = maxClipDur > 0 ? clipDur / maxClipDur : 1
    const bodyA   = 0.25 + (1 - ratio) * 0.30   // 0.25 → 0.55
    const waveA   = 0.70 + (1 - ratio) * 0.28   // 0.70 → 0.98
    const borderA = 0.50 + (1 - ratio) * 0.40   // 0.50 → 0.90

    const x = (clip.offset / total) * W
    const w = Math.max(2, (clipDur / total) * W)

    // Lane band
    ctx.fillStyle = `rgba(${r},${g},${b},${bodyA.toFixed(2)})`
    ctx.fillRect(x, 1, w, H - 2)

    // Mini waveform if available
    if (clip.waveformData && clip.waveformData.length && w > 4) {
      const data = clip.waveformData
      const bars = Math.max(1, Math.floor(w))
      const step = data.length / bars
      ctx.fillStyle = `rgba(${r},${g},${b},${waveA.toFixed(2)})`
      for (let j = 0; j < bars; j++) {
        const s = Math.floor(j * step)
        const e = Math.min(Math.ceil((j + 1) * step), data.length)
        let peak = 0
        for (let k = s; k < e; k++) if (data[k] > peak) peak = data[k]
        const bh = Math.max(1, peak * (H - 4))
        ctx.fillRect(x + j, H / 2 - bh / 2, 1, bh)
      }
    }

    // Lane border
    ctx.strokeStyle = `rgba(${r},${g},${b},${borderA.toFixed(2)})`
    ctx.lineWidth = 1
    ctx.strokeRect(x + 0.5, 1.5, w - 1, H - 3)
  })
}

function drawWaveform(cue, playheadOverride) {
  const canvas = $('waveform-canvas')
  const noFile = $('waveform-no-file')
  const ctx    = canvas.getContext('2d')

  const rect = canvas.getBoundingClientRect()
  const W = rect.width  || canvas.parentElement?.offsetWidth  || 600
  const H = rect.height || canvas.parentElement?.offsetHeight || 96
  if (W === 0) return
  canvas.width  = W
  canvas.height = H

  ctx.clearRect(0, 0, W, H)

  if (!cue || !cue.waveformData || !cue.waveformData.length) {
    noFile.style.display = ''
    return
  }
  noFile.style.display = 'none'

  const data     = cue.waveformData
  const dur      = cue.duration || 1
  const inPct    = (cue.inPoint  || 0) / dur
  const outPct   = (cue.outPoint != null ? cue.outPoint : dur) / dur
  const phTime   = playheadOverride != null ? playheadOverride : waveformState.playheadTime
  const phPct    = Math.max(0, Math.min(phTime / dur, 1))
  const mid      = H / 2
  const barW     = W / data.length

  // ── Bars ──
  data.forEach((amp, i) => {
    const x    = i * barW
    const pct  = x / W
    const barH = amp * mid * 0.88

    // inside trim region → full blue; outside → very dim
    const inside = pct >= inPct && pct <= outPct
    ctx.globalAlpha = inside ? (0.45 + amp * 0.55) : 0.12
    ctx.fillStyle   = inside ? '#3d7eff' : '#3d7eff'
    ctx.fillRect(x, mid - barH, Math.max(barW - 1, 1), barH * 2)
  })
  ctx.globalAlpha = 1

  // ── Trim shade overlays (semi-transparent dark fill outside region) ──
  ctx.fillStyle = 'rgba(12,14,20,0.52)'
  ctx.fillRect(0, 0, inPct * W, H)
  ctx.fillRect(outPct * W, 0, W - outPct * W, H)

  // ── In marker (green) ──
  const inX = inPct * W
  ctx.strokeStyle = '#00d97e'
  ctx.lineWidth   = 2
  ctx.beginPath(); ctx.moveTo(inX, 0); ctx.lineTo(inX, H); ctx.stroke()
  // small flag
  ctx.fillStyle = '#00d97e'
  ctx.beginPath(); ctx.moveTo(inX, 0); ctx.lineTo(inX + 8, 0); ctx.lineTo(inX, 10); ctx.closePath(); ctx.fill()

  // ── Out marker (red) ──
  const outX = outPct * W
  ctx.strokeStyle = '#ff4757'
  ctx.lineWidth   = 2
  ctx.beginPath(); ctx.moveTo(outX, 0); ctx.lineTo(outX, H); ctx.stroke()
  // small flag (left-pointing)
  ctx.fillStyle = '#ff4757'
  ctx.beginPath(); ctx.moveTo(outX, 0); ctx.lineTo(outX - 8, 0); ctx.lineTo(outX, 10); ctx.closePath(); ctx.fill()

  // ── Playhead (white vertical line) ──
  const phX = phPct * W
  ctx.strokeStyle = 'rgba(255,255,255,0.9)'
  ctx.lineWidth   = 1.5
  ctx.setLineDash([4, 3])
  ctx.beginPath(); ctx.moveTo(phX, 0); ctx.lineTo(phX, H); ctx.stroke()
  ctx.setLineDash([])
  // small triangle at top
  ctx.fillStyle = 'white'
  ctx.beginPath(); ctx.moveTo(phX - 5, 0); ctx.lineTo(phX + 5, 0); ctx.lineTo(phX, 8); ctx.closePath(); ctx.fill()

  // update playhead time display
  $('waveform-playhead-time').textContent = formatTime(phTime)
}

// ── ADD / IMPORT CUES ──────────────────────────────────────────────────────────
// Lowest positive integer not already used as a cue number — avoids collisions
// after deletions while preserving any custom numbers the user has assigned.
function nextAvailableCueNumber() {
  const used = new Set(state.project.cues.map(c => c.number))
  let n = 1
  while (used.has(String(n))) n++
  return String(n)
}

function makeNewCue(overrides = {}) {
  return {
    id:           newId(),
    number:       nextAvailableCueNumber(),
    name:         '',
    filePath:     null,
    duration:     null,
    waveformData: null,
    inPoint:      0,
    outPoint:     null,
    fadeIn:       0,
    fadeOut:      0,
    volume:       0,
    pan:          0,
    continueMode:    'none',
    preWait:         0,
    postWait:        0,
    goModeOverride:  '',       // '' = use global | 'stop' | 'overlap' | 'fadeout'
    cueFadeDuration: 2.0,
    loop:            false,
    duck:            false,
    duckAmount:      -12,
    duckFadeIn:      0.5,
    duckFadeOut:     1.0,
    color:           'none',
    ...overrides
  }
}

function addBlankCue() {
  const cue = makeNewCue()
  state.project.cues.push(cue)
  markDirty()
  renderCueList()
  selectCue(cue.id)
  startEditName(cue.id)
}

async function importAudioFiles() {
  const result = await window.flowcast.openAudioDialog()
  if (result.canceled || !result.filePaths.length) return

  const newCues = []
  result.filePaths.forEach(fp => {
    const c = makeNewCue({
      filePath: fp,
      name:     basename(fp).replace(/\.[^.]+$/, ''),
    })
    state.project.cues.push(c)   // push first so the next nextAvailableCueNumber skips it
    newCues.push(c)
  })
  markDirty()
  renderCueList()
  selectCue(newCues[0].id)

  // Ask backend to load waveform + duration for each file
  newCues.forEach(c => {
    window.flowcast.sendToBackend({ type: 'load_file', id: c.id, filePath: c.filePath })
  })
}

function deleteSelectedCue() {
  if (!state.selectedCueId) return
  const idx = getCueIndex(state.selectedCueId)
  if (idx === -1) return

  // Confirmation prompt — single-key Delete is fast but there's no undo
  const cue = getCueById(state.selectedCueId)
  if (localStorage.getItem('fc_confirmDelete') !== '0') {
    const label = cue ? `cue ${cue.number}${cue.name ? ': ' + cue.name : ''}` : 'this cue'
    if (!confirm(`Delete ${label}?`)) return
  }

  // Stop it if playing
  stopCue(state.selectedCueId)

  state.project.cues.splice(idx, 1)
  markDirty()

  // Select adjacent cue
  const newSel = state.project.cues[Math.min(idx, state.project.cues.length - 1)]
  state.selectedCueId = newSel ? newSel.id : null

  renderCueList()
  updateInspector()
}

// ── INLINE NAME EDIT ───────────────────────────────────────────────────────────
function startEditName(id) {
  const tr = tbody.querySelector(`tr[data-id="${id}"]`)
  if (!tr) return
  const cell = tr.querySelector('.td-name-text')
  if (!cell) return

  const cue   = getCueById(id)
  const input = document.createElement('input')
  input.className = 'form-input'
  input.style.cssText = 'height:22px;padding:0 6px;font-size:13px;width:100%'
  input.value = cue.name || ''

  cell.replaceWith(input)
  input.focus()
  input.select()

  const commit = () => {
    cue.name = input.value.trim()
    markDirty()
    renderCueList()
    updateInspector()
  }
  input.addEventListener('blur', commit)
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); input.blur() }
    if (e.key === 'Escape') { input.value = cue.name || ''; input.blur() }
    e.stopPropagation()
  })
}

// ── COMBO CUE HELPERS ─────────────────────────────────────────────────────────
function updateBeginEditBtn() {
  const btn = $('btn-begin-edit')
  const sep = $('sep-begin-edit')
  const show = state.comboSelected.size >= 2
  if (btn) btn.style.display = show ? '' : 'none'
  if (sep) sep.style.display = show ? '' : 'none'
}

function fireCombo(cue) {
  const totalDur = cue.totalDur || cue.duration || 0

  // Pre-build all entries so duck logic can reference sibling clip IDs
  const clipEntries = (cue.clips || []).map((clip, i) => {
    const clipDur = Math.max(0, (clip.outPoint ?? clip.duration ?? 0) - (clip.inPoint || 0))
    return { playId: `combo_${cue.id}_${i}_${Date.now()}`, offset: clip.offset || 0, clipDur, clip }
  })

  // Register in state BEFORE firing — immediate clips (offset=0) check this guard
  state.playingCues[cue.id] = {
    startedAt:  Date.now(),
    duration:   totalDur,
    clipIds:    clipEntries.map(e => ({ id: e.playId, offset: e.offset })),
    clipTimers: [],   // all setTimeout IDs — cancelled by stopCue
  }

  clipEntries.forEach(({ playId, offset, clipDur, clip }) => {
    if (!clip.filePath) return

    const fn = () => {
      if (!state.playingCues[cue.id]) return  // was stopped
      if (state.paused) return                // don't start new streams while paused

      window.flowcast.sendToBackend({
        type:     'play', id: playId,
        filePath: clip.filePath,
        inPoint:  clip.inPoint  || 0,
        outPoint: clip.outPoint,
        volume:   clip.volume   || 0,
        pan:      clip.pan      || 0,
        fadeIn:   clip.fadeIn   || 0,
        fadeOut:  clip.fadeOut  || 0,
        device:   state.project.settings.outputDevice || null,
      })

      // Duck other combo clips that are currently playing
      if (clip.duck) {
        const elapsed = (Date.now() - state.playingCues[cue.id].startedAt) / 1000
        clipEntries.forEach(other => {
          if (other.playId === playId) return
          if (other.offset <= elapsed && (other.offset + other.clipDur) > elapsed) {
            window.flowcast.sendToBackend({
              type: 'duck_start', id: other.playId,
              amount: clip.duckAmount ?? -12,
              fadeIn: clip.duckFadeIn ?? 0.5,
            })
          }
        })
        // Restore when this clip ends
        if (clipDur > 0) {
          const duckRestoreTimer = setTimeout(() => {
            if (!state.playingCues[cue.id]) return
            clipEntries.forEach(other => {
              if (other.playId === playId) return
              window.flowcast.sendToBackend({
                type: 'duck_end', id: other.playId,
                fadeOut: clip.duckFadeOut ?? 1.0,
              })
            })
          }, clipDur * 1000)
          state.playingCues[cue.id]?.clipTimers.push(duckRestoreTimer)
        }
      }
    }

    const delay = offset * 1000
    if (delay <= 0) {
      fn()
    } else {
      const t = setTimeout(fn, delay)
      state.playingCues[cue.id].clipTimers.push(t)
    }
  })

  // Schedule cueDone so auto-follow/auto-continue chains work for combo cues.
  // The backend only knows individual clip IDs; it never sends cue_done for the
  // combo parent, so we drive completion from JS.
  if (totalDur > 0) {
    const doneTimer = setTimeout(() => {
      if (state.playingCues[cue.id]) cueDone(cue.id)
    }, totalDur * 1000)
    state.playingCues[cue.id].clipTimers.push(doneTimer)
  }

  renderCueList()
  startNpLoop()
  startProgressTimer(cue.id, totalDur)
}

// ── GO / PLAYBACK ──────────────────────────────────────────────────────────────
function go(fromAutoContinue = false) {
  if (fromAutoContinue) {
    goContinueDepth++
    if (goContinueDepth > 500) {
      console.warn('[FlowCast] auto-continue chain exceeded 500 steps — stopping to prevent loop')
      return
    }
  } else {
    goContinueDepth = 0   // explicit user press resets the counter
  }

  const cues = state.project.cues
  if (!cues.length) return

  // If nothing selected, select first cue and fire it
  if (!state.selectedCueId) {
    selectCue(cues[0].id)
  }

  const cue = getCueById(state.selectedCueId)
  if (!cue) return

  btnGo.classList.add('firing')
  setTimeout(() => btnGo.classList.remove('firing'), 200)

  // Resolve effective GO mode for this cue (per-cue override beats global).
  // Auto-fire chains (Play With / Play After) force overlap so the parent cue
  // keeps playing — without this, the chained call's default 'stop' mode kills
  // the parent and Escape only finds the child to stop.
  const effectiveMode = fromAutoContinue
    ? 'overlap'
    : (cue.goModeOverride || state.project.settings.goMode || 'stop')
  const fadeDur = cue.goModeOverride === 'fadeout'
    ? (cue.cueFadeDuration || 2.0)
    : (state.project.settings.goFadeDuration || 2.0)

  const playingIds = Object.keys(state.playingCues)

  const fireAndAdvance = () => {
    fireCue(cue.id)
    // Ducking: ramp down all other active cues
    if (cue.duck) {
      Object.keys(state.playingCues).filter(id => id !== cue.id).forEach(id => {
        window.flowcast.sendToBackend({
          type: 'duck_start', id,
          amount: cue.duckAmount ?? -12,
          fadeIn: cue.duckFadeIn ?? 0.5
        })
      })
    }
    const idx  = getCueIndex(cue.id)
    const next = cues[idx + 1]
    if (next) selectCue(next.id)
  }

  if (!playingIds.length || effectiveMode === 'overlap') {
    fireAndAdvance()
  } else if (effectiveMode === 'stop') {
    playingIds.forEach(id => stopCue(id))
    fireAndAdvance()
  } else if (effectiveMode === 'fadeout') {
    // Sequential: fade out all playing cues, then fire when done
    playingIds.forEach(id => {
      window.flowcast.sendToBackend({ type: 'fadeout', id, duration: fadeDur })
      const info = state.playingCues[id]
      if (info?.timer) cancelAnimationFrame(info.timer)
      setTimeout(() => {
        delete state.playingCues[id]
        state.playedCues.add(id)
        renderCueList()
      }, fadeDur * 1000)
    })
    setTimeout(fireAndAdvance, fadeDur * 1000)
  }

  // Play With (auto-continue): fire next cue at postWait seconds AFTER this cue
  // actually starts playing — i.e. preWait + postWait from GO press.
  // Honour the global Pause flag — a paused show shouldn't silently advance.
  if (cue.continueMode === 'auto-continue') {
    const delay = ((cue.preWait || 0) + (cue.postWait || 0)) * 1000
    setTimeout(() => { if (!state.paused) go(true) }, delay)
  }
}

function flashCueRow(id) {
  const tr = tbody.querySelector(`tr[data-id="${id}"]`)
  if (!tr) return
  tr.classList.add('row-load-failed')
  setTimeout(() => tr.classList.remove('row-load-failed'), 500)
}

function fireCue(id) {
  const cue = getCueById(id)
  if (!cue) return

  // Refuse to play a cue whose file failed to load — flash the row red
  if (cue.loadFailed) { flashCueRow(id); return }

  // Combo cues fire all their clips at timeline offsets
  if (cue.type === 'combo') {
    fireCombo(cue)
    return
  }

  const dur       = cue.outPoint != null ? (cue.outPoint - (cue.inPoint || 0)) : cue.duration
  const preWaitMs = Math.max(0, (cue.preWait || 0) * 1000)

  // Reserve the slot immediately so Stop/Panic/Escape during pre-wait can cancel it
  const slot = { startedAt: null, duration: dur || 0, preWaitTimer: null }
  state.playingCues[id] = slot

  const sendPlay = () => {
    if (state.playingCues[id] !== slot) return  // cancelled during pre-wait
    slot.preWaitTimer = null
    slot.startedAt    = Date.now()

    window.flowcast.sendToBackend({
      type: 'play',
      id:   cue.id,
      filePath: cue.filePath,
      inPoint:  cue.inPoint  || 0,
      outPoint: cue.outPoint,
      volume:   cue.volume   || 0,
      pan:      cue.pan      || 0,
      fadeIn:   cue.fadeIn   || 0,
      fadeOut:  cue.fadeOut  || 0,
      loop:     !!cue.loop,
      device:   state.project.settings.outputDevice || null,
    })

    renderCueList()
    startNpLoop()
    startProgressTimer(id, dur)
  }

  if (preWaitMs > 0) {
    slot.preWaitTimer = setTimeout(sendPlay, preWaitMs)
    renderCueList()   // show row state immediately so user sees the cue is queued
  } else {
    sendPlay()
  }
}

function startProgressTimer(id, duration) {
  const info = state.playingCues[id]
  if (!info) return

  const bar   = document.getElementById(`progress-${id}`)
  const inPt  = getCueById(id)?.inPoint || 0

  const tick = () => {
    const elapsed = (Date.now() - info.startedAt) / 1000
    const pct     = duration > 0 ? Math.min(elapsed / duration, 1) : 0

    if (bar) bar.style.width = `${pct * 100}%`

    // Live waveform playhead while cue plays
    if (id === state.selectedCueId && state.inspectorTab === 'time') {
      const cue = getCueById(id)
      if (cue) {
        waveformState.playheadTime = inPt + elapsed
        drawWaveform(cue)
      }
    }

    if (pct >= 1) {
      const cue = getCueById(id)
      if (cue?.loop) {
        info.startedAt = Date.now()   // reset for next loop pass
        info.timer = requestAnimationFrame(tick)
      } else {
        cueDone(id)
      }
    } else {
      info.timer = requestAnimationFrame(tick)
    }
  }
  info.timer = requestAnimationFrame(tick)
}

function cueDone(id) {
  // Idempotent: cueDone fires both from the JS progress timer (100%) and the
  // backend's cue_done message. Without this guard, auto-follow would schedule
  // go(true) twice and fire the next cue plus the cue after that.
  if (!state.playingCues[id]) return
  const cue  = getCueById(id)
  const info = state.playingCues[id]
  if (info?.timer) cancelAnimationFrame(info.timer)
  delete state.playingCues[id]
  state.playedCues.add(id)
  renderCueList()

  // If this was a ducking cue, restore all other active cues
  if (cue?.duck) {
    Object.keys(state.playingCues).forEach(otherId => {
      window.flowcast.sendToBackend({
        type: 'duck_end', id: otherId,
        fadeOut: cue.duckFadeOut ?? 1.0
      })
    })
  }

  // auto-follow: fire next cue after postWait when this one ends.
  // Skip the auto-fire if the show is paused.
  if (cue && cue.continueMode === 'auto-follow') {
    const delay = (cue.postWait || 0) * 1000
    setTimeout(() => { if (!state.paused) go(true) }, delay)
  }
}

function stopCue(id) {
  const info = state.playingCues[id]
  if (info?.timer) cancelAnimationFrame(info.timer)
  // Cancel any pending pre-wait so Stop/Escape during the wait actually cancels the cue
  if (info?.preWaitTimer) clearTimeout(info.preWaitTimer)
  // Cancel any deferred clip-launch or duck-restore timers (combo cues)
  if (info?.clipTimers) info.clipTimers.forEach(t => clearTimeout(t))
  // Stop individual clips if this was a combo cue
  if (info?.clipIds) {
    info.clipIds.forEach(({ id: clipId }) => {
      window.flowcast.sendToBackend({ type: 'stop', id: clipId })
    })
  }
  delete state.playingCues[id]
  window.flowcast.sendToBackend({ type: 'stop', id })
}

function stopAll() {
  Object.keys(state.playingCues).forEach(id => stopCue(id))
  if (state.paused) {
    state.paused = false
    btnPause.textContent = 'Pause'
    btnPause.classList.remove('active')
  }
  renderCueList()
}

function pauseAll() {
  if (state.paused) {
    state.paused = false
    window.flowcast.sendToBackend({ type: 'resume_all' })
    btnPause.textContent = 'Pause'
    btnPause.classList.remove('active')
  } else {
    state.paused = true
    window.flowcast.sendToBackend({ type: 'pause_all' })
    btnPause.textContent = 'Resume'
    btnPause.classList.add('active')
  }
}

function resumeAll() {
  if (!state.paused) return
  state.paused = false
  window.flowcast.sendToBackend({ type: 'resume_all' })
  btnPause.textContent = 'Pause'
  btnPause.classList.remove('active')
}

function panic() {
  window.flowcast.sendToBackend({ type: 'panic' })
  // Hard stop — cancel all timers immediately
  Object.keys(state.playingCues).forEach(id => {
    const info = state.playingCues[id]
    if (info?.timer) cancelAnimationFrame(info.timer)
  })
  state.playingCues = {}
  renderCueList()
}

// ── BACKEND MESSAGES ───────────────────────────────────────────────────────────
window.flowcast.onBackendMessage((msg) => {
  switch (msg.type) {
    case 'ready':
      state.backendReady = true
      populateOutputDevices(msg.outputDevices || [])
      break

    case 'devices_updated': {
      populateOutputDevices(msg.outputDevices || [])
      // Restore the saved selection if it still exists
      const devSel = $('select-output-device')
      if (devSel) devSel.value = state.project.settings.outputDevice || ''
      if (msg.warning) alert(msg.warning)
      break
    }

    case 'osc_started':
      state.oscConnected = true
      state.oscError     = null
      oscDot.className   = 'osc-dot connected'
      oscLabel.textContent = `OSC :${msg.port}`
      updateOscPopover()
      break

    case 'osc_error':
      state.oscConnected = false
      state.oscError     = msg.error
      oscDot.className   = 'osc-dot error'
      oscLabel.textContent = 'OSC error'
      updateOscPopover()
      break

    case 'file_loaded':
      handleFileLoaded(msg)
      break

    case 'load_file_failed':
      handleLoadFileFailed(msg)
      break

    case 'cue_done':
      cueDone(msg.id)
      break

    case 'osc_command':
      handleOscCommand(msg)
      break

    case 'backend_exited':
      // Python process died — disable all transport, show non-dismissable banner
      ;[btnGo, btnStop, btnPause, btnPanic].forEach(b => { b.disabled = true })
      oscDot.className = 'osc-dot error'
      oscLabel.textContent = 'OSC offline'
      const crashBanner = $('backend-crash-banner')
      if (crashBanner) crashBanner.style.display = 'flex'
      console.error('[backend] exited with code', msg.code)
      break

    case 'log':
      console.log(`[backend ${msg.level || 'info'}]`, msg.text)
      break
  }
})

function startOscServer() {
  window.flowcast.sendToBackend({
    type: 'start_osc',
    port: state.project.settings.oscPort || 53000
  })
}

function handleFileLoaded(msg) {
  // Check top-level cues first — but skip if it's a combo (combos have no own filePath/waveform)
  let cue = getCueById(msg.id)
  if (cue && cue.type !== 'combo') {
    cue.duration     = msg.duration
    cue.outPoint     = cue.outPoint != null ? cue.outPoint : msg.duration
    cue.waveformData = msg.waveformData || null
    markDirty()
    renderCueList()
    if (state.selectedCueId === msg.id) {
      updateInspector()
      if (state.inspectorTab === 'time') requestAnimationFrame(() => drawWaveform(cue))
    }
    // Also update LTE if this top-level cue is currently open as a clip
    // (lteOpen new-combo case: source cues still live in the top-level list)
    if (typeof lteHandleWaveformLoaded === 'function') lteHandleWaveformLoaded(msg.id, msg.waveformData, msg.duration)
    return
  }
  // Search combo sub-clips
  for (const c of state.project.cues) {
    if (c.type !== 'combo') continue
    const clip = (c.clips || []).find(cl => cl.id === msg.id)
    if (clip) {
      clip.duration     = msg.duration
      clip.waveformData = msg.waveformData || null
      if (clip.outPoint == null || clip.outPoint <= 0) clip.outPoint = msg.duration
      // Recompute combo totalDur now that we have real clip durations
      const maxEnd = (c.clips || []).reduce((m, cl) => {
        const d = (cl.outPoint != null ? cl.outPoint : cl.duration) - (cl.inPoint || 0)
        return Math.max(m, (cl.offset || 0) + Math.max(0, d || 0))
      }, 4)
      if (maxEnd > (c.totalDur || 0)) {
        c.totalDur = maxEnd
        c.duration = maxEnd
      }
      // If LTE is open and this clip is in it, update lteState too
      if (typeof lteHandleWaveformLoaded === 'function') lteHandleWaveformLoaded(msg.id, msg.waveformData, msg.duration)
      renderCueList()
      updateNowPlaying()
      return
    }
  }
}

function handleLoadFileFailed(msg) {
  // Mark the clip as permanently failed so we stop retrying
  const topCue = getCueById(msg.id)
  if (topCue && topCue.type !== 'combo') {
    topCue.loadFailed = true
    renderCueList()
    return
  }
  for (const c of state.project.cues) {
    if (c.type !== 'combo') continue
    const clip = (c.clips || []).find(cl => cl.id === msg.id)
    if (clip) {
      clip.loadFailed = true
      renderCueList()
      updateNowPlaying()
      return
    }
  }
}

function populateOutputDevices(devices) {
  const sel = $('select-output-device')
  sel.innerHTML = '<option value="">System Default</option>'
  devices.forEach(d => {
    const opt = document.createElement('option')
    opt.value       = d.id
    opt.textContent = d.name
    sel.appendChild(opt)
  })
}

function handleOscCommand(msg) {
  // OSC commands forwarded from backend — mirror QLab OSC API
  switch (msg.command) {
    case 'go':    go();    break
    case 'stop':  stopAll(); break
    case 'pause': pauseAll(); break
    case 'resume':
      resumeAll()
      break
    case 'cue_start':
      fireCueByNumber(msg.cueNumber)
      break
    case 'cue_stop':
      stopCueByNumber(msg.cueNumber)
      break
    case 'cue_select':
      selectCueByNumber(msg.cueNumber)
      break
    case 'next_cue':
      selectNext()
      break
    case 'prev_cue':
      selectPrev()
      break
  }
}

function fireCueByNumber(num) {
  const cue = state.project.cues.find(c => c.number === String(num))
  if (cue) fireCue(cue.id)
}

function stopCueByNumber(num) {
  const cue = state.project.cues.find(c => c.number === String(num))
  if (cue) stopCue(cue.id)
}

function selectCueByNumber(num) {
  const cue = state.project.cues.find(c => c.number === String(num))
  if (cue) selectCue(cue.id)
}

// ── INSPECTOR FIELD CHANGES ────────────────────────────────────────────────────
function onFieldChange(fieldId, apply) {
  const el = $(fieldId)
  if (!el) return
  el.addEventListener('input', () => {
    const cue = getCueById(state.selectedCueId)
    if (!cue) return
    apply(cue, el)
    markDirty()
    renderCueList()
  })
  el.addEventListener('change', () => {
    const cue = getCueById(state.selectedCueId)
    if (!cue) return
    apply(cue, el)
    markDirty()
    renderCueList()
  })
}

function bindInspectorFields() {
  onFieldChange('inp-cue-number', (c,el) => { c.number = el.value })
  onFieldChange('inp-cue-name',   (c,el) => { c.name   = el.value })
  onFieldChange('inp-prewait',    (c,el) => { c.preWait  = parseFloat(el.value) || 0 })
  onFieldChange('inp-postwait',   (c,el) => { c.postWait = parseFloat(el.value) || 0 })
  onFieldChange('inp-cue-fade-dur', (c,el) => { c.cueFadeDuration = parseFloat(el.value) || 2.0 })
  onFieldChange('inp-duck-amount',  (c,el) => { c.duckAmount  = parseFloat(el.value) ?? -12 })
  onFieldChange('inp-duck-fade-in', (c,el) => { c.duckFadeIn  = parseFloat(el.value) || 0.5 })
  onFieldChange('inp-duck-fade-out',(c,el) => { c.duckFadeOut = parseFloat(el.value) || 1.0 })

  $('sel-go-override').addEventListener('change', () => {
    const cue = getCueById(state.selectedCueId); if (!cue) return
    cue.goModeOverride = $('sel-go-override').value
    $('row-cue-fade-dur').style.display = cue.goModeOverride === 'fadeout' ? '' : 'none'
    markDirty()
  })

  $('chk-loop').addEventListener('change', () => {
    const cue = getCueById(state.selectedCueId); if (!cue) return
    cue.loop = $('chk-loop').checked
    markDirty()
  })

  $('chk-duck').addEventListener('change', () => {
    const cue = getCueById(state.selectedCueId); if (!cue) return
    cue.duck = $('chk-duck').checked
    $('duck-settings').style.display = cue.duck ? '' : 'none'
    markDirty()
  })

  onFieldChange('inp-in-point', (c, el) => {
    const v = parseFloat(el.value)
    c.inPoint = isNaN(v) ? 0 : Math.max(0, v)
    updateDurationDisplay(c)
    drawWaveform(c)
  })
  onFieldChange('inp-out-point', (c, el) => {
    const v = parseFloat(el.value)
    c.outPoint = isNaN(v) ? null : Math.max(c.inPoint || 0, v)
    updateDurationDisplay(c)
    drawWaveform(c)
  })
  onFieldChange('inp-fade-in',  (c,el) => { c.fadeIn  = parseFloat(el.value) || 0 })
  onFieldChange('inp-fade-out', (c,el) => { c.fadeOut = parseFloat(el.value) || 0 })

  // Volume — keep slider and number input in sync
  $('slider-volume').addEventListener('input', () => {
    const cue = getCueById(state.selectedCueId); if (!cue) return
    cue.volume = parseFloat($('slider-volume').value)
    $('inp-volume').value = cue.volume
    markDirty()
    window.flowcast.sendToBackend({ type: 'set_volume', id: cue.id, value: cue.volume })
  })
  $('inp-volume').addEventListener('change', () => {
    const cue = getCueById(state.selectedCueId); if (!cue) return
    cue.volume = parseFloat($('inp-volume').value) || 0
    $('slider-volume').value = cue.volume
    markDirty()
  })

  // Pan
  $('slider-pan').addEventListener('input', () => {
    const cue = getCueById(state.selectedCueId); if (!cue) return
    cue.pan = parseFloat($('slider-pan').value)
    $('inp-pan').value = cue.pan.toFixed(2)
    markDirty()
    window.flowcast.sendToBackend({ type: 'set_pan', id: cue.id, value: cue.pan })
  })
  $('inp-pan').addEventListener('change', () => {
    const cue = getCueById(state.selectedCueId); if (!cue) return
    cue.pan = parseFloat($('inp-pan').value) || 0
    $('slider-pan').value = cue.pan
    markDirty()
  })

  // Output device
  $('select-output-device').addEventListener('change', (e) => {
    state.project.settings.outputDevice = e.target.value
    markDirty()
    window.flowcast.sendToBackend({ type: 'set_output_device', deviceId: e.target.value })
  })

  // Rescan devices — re-initialise PortAudio in the backend and refresh the dropdown
  const rescanBtn = $('btn-rescan-devices')
  if (rescanBtn) {
    rescanBtn.addEventListener('click', () => {
      rescanBtn.disabled = true
      rescanBtn.classList.add('spinning')
      window.flowcast.sendToBackend({ type: 'rescan_devices' })
      setTimeout(() => { rescanBtn.disabled = false; rescanBtn.classList.remove('spinning') }, 800)
    })
  }

  // Color swatches
  document.querySelectorAll('.color-swatch').forEach(sw => {
    sw.addEventListener('click', () => {
      const cue = getCueById(state.selectedCueId); if (!cue) return
      cue.color = sw.dataset.color
      markDirty()
      renderCueList()
      updateInspector()
    })
  })

  // Continue mode
  document.querySelectorAll('.seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const cue = getCueById(state.selectedCueId); if (!cue) return
      const prev = cue.continueMode
      cue.continueMode = btn.dataset.mode
      // Leaving Play With clears pre-wait — that delay was being used to position
      // the linked track and is no longer meaningful when the cue isn't auto-firing
      // alongside another one.
      if (prev === 'auto-continue' && cue.continueMode !== 'auto-continue') {
        cue.preWait = 0
      }
      markDirty()
      renderCueList()
      updateInspector()
    })
  })
}

function updateDurationDisplay(cue) {
  const dur = cue.outPoint != null ? (cue.outPoint - (cue.inPoint || 0)) : cue.duration
  $('disp-duration').textContent = dur != null ? formatTime(dur) : '—'
}

// ── WAVEFORM INTERACTION (bound in init) ──────────────────────────────────────
const MARKER_HIT_PX = 8  // px either side of marker line counts as a hit

function getMarkerHit(x, canvasW, cue) {
  if (!cue || !cue.duration) return null
  const inX  = (cue.inPoint  || 0) / cue.duration * canvasW
  const outX = (cue.outPoint != null ? cue.outPoint : cue.duration) / cue.duration * canvasW
  if (Math.abs(x - inX)  <= MARKER_HIT_PX) return 'in'
  if (Math.abs(x - outX) <= MARKER_HIT_PX) return 'out'
  return null
}

function bindWaveformListeners() {
  const canvas  = $('waveform-canvas')
  const tooltip = $('waveform-tooltip')
  if (!canvas) return

  let dragging = null  // 'in' | 'out' | null

  canvas.addEventListener('mousedown', (e) => {
    const cue = getCueById(state.selectedCueId)
    if (!cue || !cue.duration) return
    const rect = canvas.getBoundingClientRect()
    const x    = e.clientX - rect.left
    const hit  = getMarkerHit(x, rect.width, cue)
    if (hit) {
      dragging = hit
      e.preventDefault()  // don't trigger click
    }
  })

  canvas.addEventListener('mousemove', (e) => {
    const cue = getCueById(state.selectedCueId)
    if (!cue || !cue.duration) return
    const rect = canvas.getBoundingClientRect()
    const x    = e.clientX - rect.left
    const pct  = Math.max(0, Math.min(x / rect.width, 1))
    const time = parseFloat((pct * cue.duration).toFixed(3))

    if (dragging) {
      // Drag in progress — update the marker
      if (dragging === 'in') {
        cue.inPoint = Math.max(0, Math.min(time, cue.outPoint != null ? cue.outPoint : cue.duration))
        $('inp-in-point').value = cue.inPoint.toFixed(3)
      } else {
        cue.outPoint = Math.max(cue.inPoint || 0, Math.min(time, cue.duration))
        $('inp-out-point').value = cue.outPoint.toFixed(3)
      }
      updateDurationDisplay(cue)
      drawWaveform(cue)
      if (tooltip) {
        tooltip.style.display = 'block'
        tooltip.style.left    = `${x}px`
        tooltip.textContent   = (dragging === 'in' ? 'In: ' : 'Out: ') + formatTime(time)
      }
      return
    }

    // Hover — check proximity to markers and update cursor
    const hit = getMarkerHit(x, rect.width, cue)
    canvas.style.cursor = hit ? 'ew-resize' : 'col-resize'

    // Tooltip
    if (tooltip) {
      tooltip.style.display = 'block'
      tooltip.style.left    = `${x}px`
      tooltip.textContent   = hit ? (hit === 'in' ? 'In: ' : 'Out: ') + formatTime(time) : formatTime(time)
    }
  })

  document.addEventListener('mouseup', (e) => {
    if (!dragging) return
    const cue = getCueById(state.selectedCueId)
    if (cue) markDirty()
    dragging = null
    canvas.style.cursor = 'col-resize'
  })

  canvas.addEventListener('click', (e) => {
    // Only move playhead if we didn't just finish a drag
    if (dragging) return
    const cue = getCueById(state.selectedCueId)
    if (!cue || !cue.duration) return
    const rect = canvas.getBoundingClientRect()
    const x    = e.clientX - rect.left
    // Don't move playhead if clicking near a marker
    if (getMarkerHit(x, rect.width, cue)) return
    const pct  = Math.max(0, Math.min(x / rect.width, 1))
    waveformState.playheadTime = parseFloat((pct * cue.duration).toFixed(3))
    drawWaveform(cue)
    // If a preview is currently playing, jump it to the new playhead and keep going
    if (waveformState.previewId) startTrimPreview(cue, waveformState.playheadTime)
  })

  canvas.addEventListener('mouseleave', () => {
    if (!dragging) {
      if (tooltip) tooltip.style.display = 'none'
      canvas.style.cursor = 'col-resize'
    }
  })

  const btnPlay = $('btn-preview-trim')
  const btnStop = $('btn-preview-stop')
  if (btnPlay) btnPlay.addEventListener('click', () => {
    const cue = getCueById(state.selectedCueId)
    if (!cue || !cue.filePath) return
    startTrimPreview(cue)
  })
  if (btnStop) btnStop.addEventListener('click', () => stopTrimPreview())

  const btnReset = $('btn-reset-trim')
  if (btnReset) btnReset.addEventListener('click', () => {
    const cue = getCueById(state.selectedCueId)
    if (!cue || !cue.duration) return
    cue.inPoint  = 0
    cue.outPoint = cue.duration
    $('inp-in-point').value  = '0.000'
    $('inp-out-point').value = cue.duration.toFixed(3)
    updateDurationDisplay(cue)
    drawWaveform(cue)
    markDirty()
  })
}

// fromTime null = preview the trim region (Enter / button) — plays inPoint→outPoint with fades.
// fromTime set  = play from that point to the end of the file (Space / click-during-preview) —
//                 used to audition arbitrary positions, no fades, ignores trim boundaries.
function startTrimPreview(cue, fromTime) {
  stopTrimPreview()

  const inT  = cue.inPoint  || 0
  const outT = cue.outPoint != null ? cue.outPoint : cue.duration

  const startT = fromTime != null
    ? Math.max(0, Math.min(fromTime, (cue.duration || 0) - 0.05))
    : inT
  const endT   = fromTime != null ? (cue.duration || outT) : outT
  if (endT <= startT + 0.01) return

  const previewId = `preview_${cue.id}`
  waveformState.previewId = previewId

  window.flowcast.sendToBackend({
    type:     'play',
    id:       previewId,
    filePath: cue.filePath,
    inPoint:  startT,
    outPoint: endT,
    volume:   cue.volume   || 0,
    pan:      cue.pan      || 0,
    fadeIn:   fromTime != null ? 0 : (cue.fadeIn  || 0),
    fadeOut:  fromTime != null ? 0 : (cue.fadeOut || 0),
  })

  const startMs = Date.now()

  $('btn-preview-trim').style.display = 'none'
  $('btn-preview-stop').style.display = ''

  function tick() {
    const elapsed = (Date.now() - startMs) / 1000
    const t       = startT + elapsed
    if (t >= endT) {
      stopTrimPreview()
      return
    }
    waveformState.playheadTime = t
    drawWaveform(cue)
    waveformState.previewTimer = requestAnimationFrame(tick)
  }
  waveformState.previewTimer = requestAnimationFrame(tick)
}

function stopTrimPreview() {
  if (waveformState.previewTimer) {
    cancelAnimationFrame(waveformState.previewTimer)
    waveformState.previewTimer = null
  }
  if (waveformState.previewId) {
    window.flowcast.sendToBackend({ type: 'stop', id: waveformState.previewId })
    waveformState.previewId = null
  }
  const btnPlay = $('btn-preview-trim')
  const btnStop = $('btn-preview-stop')
  if (btnPlay) btnPlay.style.display = ''
  if (btnStop) btnStop.style.display = 'none'
}

// ── NOW PLAYING ────────────────────────────────────────────────────────────────
let npRafId = null

function getActivePlayback() {
  const ids = Object.keys(state.playingCues)
  if (!ids.length) return { cue: null, info: null }
  const id = ids.reduce((best, cur) =>
    !best || state.playingCues[cur].startedAt > state.playingCues[best].startedAt ? cur : best, null)
  return { cue: getCueById(id), info: state.playingCues[id] }
}

function updateNowPlaying() {
  const npEl = $('now-playing')
  if (!npEl) return

  const { cue: activeCue, info: activeInfo } = getActivePlayback()
  const isPlaying  = !!activeCue
  const displayCue = activeCue || getCueById(state.selectedCueId)
  const isStandby  = !isPlaying && !!displayCue

  // Badge
  const badgeEl = $('np-badge')
  if (isPlaying) {
    badgeEl.textContent = 'PLAYING'
    badgeEl.className   = 'np-badge np-badge-playing'
  } else if (isStandby) {
    badgeEl.textContent = 'READY'
    badgeEl.className   = 'np-badge np-badge-ready'
  } else {
    badgeEl.textContent = 'STANDBY'
    badgeEl.className   = 'np-badge np-badge-idle'
  }

  // Cue identity
  const numEl   = $('np-cue-number')
  const nameEl  = $('np-cue-name')
  const comboEl = $('np-combo-info')

  if (displayCue) {
    numEl.textContent = `CUE ${displayCue.number}`
    numEl.className   = 'np-cue-id' + (isPlaying ? ' is-playing' : isStandby ? ' is-ready' : '')
    nameEl.textContent = displayCue.name || basename(displayCue.filePath) || 'Untitled'

    if (isPlaying && displayCue.type === 'combo' && activeInfo) {
      const elapsed  = (Date.now() - activeInfo.startedAt) / 1000
      const clips    = (displayCue.clips || []).slice().sort((a, b) => a.offset - b.offset)
      const nextClip = clips.find(c => c.offset > elapsed)
      if (nextClip) {
        const until = Math.max(0, nextClip.offset - elapsed)
        comboEl.innerHTML = `▶ ${escHtml(nextClip.name || 'next clip')} <span style="color:var(--muted)">in</span> ${formatTime(until)}`
        comboEl.style.display = ''
      } else {
        comboEl.style.display = 'none'
      }
    } else {
      comboEl.style.display = 'none'
    }
  } else {
    numEl.textContent  = '—'
    numEl.className    = 'np-cue-id'
    nameEl.textContent = 'No cue selected'
    comboEl.style.display = 'none'
  }

  // Times
  const elapsed  = isPlaying && activeInfo ? (Date.now() - activeInfo.startedAt) / 1000 : 0
  const duration = isPlaying && activeInfo ? activeInfo.duration
                 : (displayCue ? (displayCue.totalDur || displayCue.duration || 0) : 0)
  const remaining = Math.max(0, duration - elapsed)

  $('np-elapsed').textContent   = isPlaying ? formatTime(elapsed)           : (displayCue ? formatTime(0) : '—')
  $('np-remaining').textContent = isPlaying ? '-' + formatTime(remaining)   : (displayCue ? '-' + formatTime(duration || 0) : '—')

  drawNpWaveform(displayCue, isPlaying ? elapsed : -1, duration)
  updateNpNextCue(displayCue)
}

function drawNpWaveform(cue, elapsed, duration) {
  const canvas = $('np-waveform')
  const wrap   = $('np-waveform-wrap')
  if (!canvas || !wrap) return
  const W = wrap.clientWidth
  const H = wrap.clientHeight
  if (!W || !H) return
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width  = W
    canvas.height = H
  }
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, W, H)
  if (!cue) return

  const phPct = elapsed >= 0 && duration > 0 ? Math.min(elapsed / duration, 1) : -1
  const phX   = phPct >= 0 ? phPct * W : -1

  if (cue.type === 'combo') {
    ctx.fillStyle = '#13161f'
    ctx.fillRect(0, 0, W, H)

    // Draw per-clip waveforms at their offset positions — each clip gets its accent color
    const mid = H / 2;
    (cue.clips || []).forEach((clip, clipIdx) => {
      const [cr, cg, cb] = THUMB_COLORS[clipIdx % THUMB_COLORS.length]
      if (!duration) return
      if (!clip.waveformData || !clip.waveformData.length) {
        const clipDur = (clip.outPoint ?? clip.duration ?? 0) - (clip.inPoint || 0)
        if (clipDur <= 0) {
          if (clip.filePath) {
            const startX = ((clip.offset || 0) / duration) * W
            ctx.globalAlpha = 0.15
            ctx.fillStyle   = clip.loadFailed ? '#ff4455' : `rgb(${cr},${cg},${cb})`
            ctx.fillRect(startX, 0, 4, H)
            ctx.globalAlpha = 1
          }
          return
        }
        const startX  = (clip.offset / duration) * W
        const clipPxW = (clipDur / duration) * W
        ctx.globalAlpha = 0.10
        ctx.fillStyle   = `rgb(${cr},${cg},${cb})`
        ctx.fillRect(startX, 0, Math.max(clipPxW, 2), H)
        ctx.globalAlpha = 1
        return
      }
      const clipDur  = (clip.outPoint != null ? clip.outPoint : clip.duration) - (clip.inPoint || 0)
      const startX   = (clip.offset / duration) * W
      const clipPxW  = (clipDur / duration) * W
      if (clipPxW < 2) return
      const data     = clip.waveformData
      const dLen     = data.length
      const targetBW = Math.max(1, clipPxW / dLen)
      const numBars  = Math.floor(clipPxW / targetBW)
      const step     = dLen / numBars
      for (let i = 0; i < numBars; i++) {
        const s = i * step, e = Math.min((i + 1) * step, dLen)
        let peak = 0
        for (let j = Math.floor(s), end = Math.ceil(e); j < end && j < dLen; j++) {
          if (data[j] > peak) peak = data[j]
        }
        const x    = startX + i * targetBW
        const past = phX >= 0 && x <= phX
        const barH = peak * mid * 0.85
        ctx.globalAlpha = past ? (0.50 + peak * 0.45) : (0.15 + peak * 0.20)
        ctx.fillStyle   = past ? `rgb(${cr},${cg},${cb})` : `rgba(${cr},${cg},${cb},0.6)`
        ctx.fillRect(x, mid - barH, Math.max(targetBW - 0.5, 1), barH * 2)
      }
    })
    ctx.globalAlpha = 1

    // Progress fill overlay (subtle)
    if (phPct > 0) {
      const grad = ctx.createLinearGradient(0, 0, phPct * W, 0)
      grad.addColorStop(0, 'rgba(255,184,0,0.06)')
      grad.addColorStop(1, 'rgba(255,184,0,0.14)')
      ctx.fillStyle = grad
      ctx.fillRect(0, 0, phPct * W, H)
    }

    // Clip offset markers
    ;(cue.clips || []).filter(c => c.offset > 0).forEach(clip => {
      if (!duration) return
      const x = (clip.offset / duration) * W
      ctx.strokeStyle = 'rgba(255,184,0,0.45)'
      ctx.lineWidth   = 1
      ctx.setLineDash([3, 4])
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke()
      ctx.setLineDash([])
    })

    // Playhead
    if (phX >= 0 && phX <= W) {
      ctx.strokeStyle = 'rgba(255,255,255,0.18)'
      ctx.lineWidth   = 5
      ctx.beginPath(); ctx.moveTo(phX, 0); ctx.lineTo(phX, H); ctx.stroke()
      ctx.strokeStyle = 'rgba(255,184,0,0.92)'
      ctx.lineWidth   = 1.5
      ctx.beginPath(); ctx.moveTo(phX, 0); ctx.lineTo(phX, H); ctx.stroke()
    }
    return
  }

  if (!cue.waveformData || !cue.waveformData.length) return

  const data = cue.waveformData
  const dLen = data.length
  const mid  = H / 2
  const barW = W / dLen

  for (let i = 0; i < dLen; i++) {
    const x    = i * barW
    const past = phX >= 0 && x <= phX
    const barH = data[i] * mid * 0.85
    ctx.globalAlpha = past ? (0.45 + data[i] * 0.55) : (0.12 + data[i] * 0.15)
    ctx.fillStyle   = past ? '#3d7eff' : '#4a5068'
    ctx.fillRect(x, mid - barH, Math.max(barW - 0.5, 1), barH * 2)
  }
  ctx.globalAlpha = 1

  // Play With marker — dotted vertical line at the moment audio from the next
  // cue is actually heard. That's postWait (auto-fire delay) plus the next cue's
  // own preWait, both measured from when THIS cue starts playing.
  if (cue.continueMode === 'auto-continue' && duration > 0) {
    const idx     = getCueIndex(cue.id)
    const nextCue = idx >= 0 ? state.project.cues[idx + 1] : null
    if (nextCue) {
      const triggerSec = Math.max(0, (cue.postWait || 0) + (nextCue.preWait || 0))
      const triggerX   = (triggerSec / duration) * W
      if (triggerX <= W) {
        ctx.strokeStyle = 'rgba(61,126,255,0.75)'
        ctx.lineWidth   = 1.5
        ctx.setLineDash([4, 4])
        ctx.beginPath(); ctx.moveTo(triggerX, 0); ctx.lineTo(triggerX, H); ctx.stroke()
        ctx.setLineDash([])
        ctx.fillStyle = 'rgba(61,126,255,0.95)'
        ctx.font      = '600 10px "IBM Plex Mono", monospace'
        const labelX  = Math.min(triggerX + 5, W - 30)
        ctx.fillText(`→ ${nextCue.number || ''}`, labelX, 11)
      }
    }
  }

  if (phX >= 0 && phX <= W) {
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'
    ctx.lineWidth   = 5
    ctx.beginPath(); ctx.moveTo(phX, 0); ctx.lineTo(phX, H); ctx.stroke()
    ctx.strokeStyle = 'rgba(255,255,255,0.92)'
    ctx.lineWidth   = 1.5
    ctx.beginPath(); ctx.moveTo(phX, 0); ctx.lineTo(phX, H); ctx.stroke()
  }
}

function updateNpNextCue(currentCue) {
  const rightEl = $('np-right')
  const badgeEl = $('np-auto-badge')
  if (!rightEl || !badgeEl) return

  if (!currentCue) {
    $('np-next-number').textContent = '—'
    $('np-next-name').textContent   = '—'
    badgeEl.style.display = 'none'
    rightEl.className = 'np-right'
    return
  }

  const idx     = getCueIndex(currentCue.id)
  const nextCue = idx >= 0 ? state.project.cues[idx + 1] : null
  const mode    = currentCue.continueMode || 'none'

  $('np-next-number').textContent = nextCue ? `CUE ${nextCue.number}` : '—'
  $('np-next-name').textContent   = nextCue
    ? (nextCue.name || basename(nextCue.filePath) || 'Untitled')
    : 'End of list'

  if (mode === 'auto-follow' && nextCue) {
    badgeEl.textContent   = '↪  AUTO-PLAY NEXT'
    badgeEl.className     = 'np-auto-badge np-auto-af'
    badgeEl.style.display = ''
    rightEl.className = 'np-right np-right-af'
  } else if (mode === 'auto-continue' && nextCue) {
    badgeEl.textContent   = '↷  PLAY WITH'
    badgeEl.className     = 'np-auto-badge np-auto-ac'
    badgeEl.style.display = ''
    rightEl.className = 'np-right np-right-ac'
  } else {
    badgeEl.style.display = 'none'
    rightEl.className = 'np-right'
  }
}

function startNpLoop() {
  if (npRafId) return
  const tick = () => {
    updateNowPlaying()
    if (Object.keys(state.playingCues).length > 0) {
      npRafId = requestAnimationFrame(tick)
    } else {
      npRafId = null
      updateNowPlaying() // one final repaint in idle state
    }
  }
  npRafId = requestAnimationFrame(tick)
}

function bindNpResize() {
  const handle = $('np-resize-handle')
  const npEl   = $('now-playing')
  if (!handle || !npEl) return

  handle.addEventListener('mousedown', e => {
    e.preventDefault()
    const startY = e.clientY
    const startH = state.nowPlayingH
    document.body.style.cursor     = 'ns-resize'
    document.body.style.userSelect = 'none'

    function onMove(e) {
      const newH = Math.max(NPH_MIN, Math.min(NPH_MAX, startH + (e.clientY - startY)))
      state.nowPlayingH = newH
      npEl.style.height = newH + 'px'
      npEl.style.setProperty('--np-scale', (newH / NPH_DEFAULT).toFixed(3))
      updateNowPlaying()
    }
    function onUp() {
      document.body.style.cursor     = ''
      document.body.style.userSelect = ''
      localStorage.setItem('fc_nowPlayingH', state.nowPlayingH)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup',   onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup',   onUp)
  })
}

// ── INSPECTOR TABS ─────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'))
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'))
    btn.classList.add('active')
    $(`tab-${tab}`).classList.add('active')
    state.inspectorTab = tab
    btnGo.textContent = tab === 'time' ? '▶ CUE' : 'GO'
    if (tab !== 'time') { stopTrimPreview(); btnGo.textContent = 'GO' }
    if (tab === 'time') {
      // defer one frame so the canvas has layout dimensions before drawing
      requestAnimationFrame(() => {
        const cue = getCueById(state.selectedCueId)
        if (cue) drawWaveform(cue)
      })
    }
  })
})

// ── INSPECTOR RESIZE ───────────────────────────────────────────────────────────
resizeHandle.addEventListener('mousedown', (e) => {
  e.preventDefault()
  state.inspectorResizing = true
  document.body.style.cursor = 'ns-resize'
  document.body.style.userSelect = 'none'
})

document.addEventListener('mousemove', (e) => {
  if (!state.inspectorResizing) return
  const mainArea   = $('main-area')
  const mainRect   = mainArea.getBoundingClientRect()
  const fromBottom = mainRect.bottom - e.clientY
  const clamped    = Math.max(100, Math.min(fromBottom, mainRect.height - 120))
  inspector.style.height = `${clamped}px`
  state.inspectorH = clamped
})

document.addEventListener('mouseup', () => {
  if (state.inspectorResizing) {
    state.inspectorResizing = false
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    localStorage.setItem('fc_inspectorH', state.inspectorH)
  }
})

// ── DRAG & DROP ────────────────────────────────────────────────────────────────
const cueListSection = $('cue-list-section')

cueListSection.addEventListener('dragover', (e) => {
  if (!e.dataTransfer.types.includes('Files')) return
  e.preventDefault()
  dropOverlay.classList.add('active')
})
cueListSection.addEventListener('dragleave', (e) => {
  if (!cueListSection.contains(e.relatedTarget)) dropOverlay.classList.remove('active')
})
cueListSection.addEventListener('drop', (e) => {
  if (!e.dataTransfer.types.includes('Files')) return
  e.preventDefault()
  dropOverlay.classList.remove('active')
  const files = [...e.dataTransfer.files].filter(f => /\.(wav|mp3|aiff?|flac|ogg|m4a|aac)$/i.test(f.name))
  if (!files.length) return

  const newCues = []
  files.forEach(f => {
    const c = makeNewCue({
      filePath: f.path,
      name:     f.name.replace(/\.[^.]+$/, ''),
    })
    state.project.cues.push(c)   // push first so the next nextAvailableCueNumber skips it
    newCues.push(c)
  })
  markDirty()
  renderCueList()
  selectCue(newCues[0].id)
  newCues.forEach(c => window.flowcast.sendToBackend({ type: 'load_file', id: c.id, filePath: c.filePath }))
})

// ── HOTKEYS ────────────────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  // Don't intercept when typing in an input
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return
  // Let the LTE handle all keys while it's open
  const lteOverlay = $('lte-overlay')
  if (lteOverlay && lteOverlay.style.display !== 'none') return

  const isMac  = navigator.platform.includes('Mac')
  const mod    = isMac ? e.metaKey : e.ctrlKey

  switch (e.key) {
    case ' ':
      e.preventDefault()
      if (state.inspectorTab === 'time' && state.selectedCueId) {
        // Time tab: Space plays from the current playhead to the end of the file
        if (waveformState.previewId) stopTrimPreview()
        else {
          const cue = getCueById(state.selectedCueId)
          if (cue) startTrimPreview(cue, waveformState.playheadTime)
        }
      } else {
        go()
      }
      break
    case 'Enter':
      if (state.inspectorTab === 'time' && state.selectedCueId) {
        e.preventDefault()
        // Time tab: Enter previews the trimmed region (inPoint→outPoint)
        if (waveformState.previewId) stopTrimPreview()
        else {
          const cue = getCueById(state.selectedCueId)
          if (cue) startTrimPreview(cue)
        }
      } else if (state.selectedCueId) {
        // Otherwise: inline-rename the selected cue
        e.preventDefault()
        startEditName(state.selectedCueId)
      }
      break
    case 'Escape':
      e.preventDefault()
      stopAll()
      break
    case '.':
      if (mod) { e.preventDefault(); panic() }
      break
    case 'ArrowDown':
      e.preventDefault()
      selectNext()
      break
    case 'ArrowUp':
      e.preventDefault()
      selectPrev()
      break
    case 'Delete':
    case 'Backspace':
      if (!mod) { e.preventDefault(); deleteSelectedCue() }
      break
    case 'd':
      if (mod) { e.preventDefault(); duplicateSelectedCue() }
      break
    case 'n':
      if (mod && !e.shiftKey) {
        e.preventDefault()
        // Default matches the toolbar Add Cue button (file picker). User can switch
        // to "blank cue" in Settings for QLab-style hotkey behaviour.
        if (localStorage.getItem('fc_cmdNAction') === 'blank') addBlankCue()
        else importAudioFiles()
      }
      break
    case 'i':
    case 'I':
      setInPointAtPlayhead()
      break
    case 'o':
    case 'O':
      setOutPointAtPlayhead()
      break
  }
})

// ── AUTO-SAVE ─────────────────────────────────────────────────────────────────
let autoSaveTimer = null
function applyAutoSaveSetting() {
  if (autoSaveTimer) { clearInterval(autoSaveTimer); autoSaveTimer = null }
  const stored = localStorage.getItem('fc_autoSaveMinutes')
  const minutes = stored == null ? 10 : parseInt(stored, 10) || 0
  if (!minutes || minutes <= 0) return
  autoSaveTimer = setInterval(() => {
    // Only auto-save if there's a file path (so we don't pop the Save As dialog)
    // and there are unsaved changes.
    if (state.dirty && state.project.filePath) saveProject(false)
  }, minutes * 60 * 1000)
}

function duplicateSelectedCue() {
  if (!state.selectedCueId) return
  const src = getCueById(state.selectedCueId)
  if (!src) return
  const copy = { ...src, id: newId(), number: nextAvailableCueNumber(),
                 clips: (src.clips || []).map(cl => ({ ...cl })) }
  const idx  = getCueIndex(src.id)
  state.project.cues.splice(idx + 1, 0, copy)
  markDirty()
  renderCueList()
  selectCue(copy.id)
}

function setInPointAtPlayhead() {
  const cue = getCueById(state.selectedCueId)
  if (!cue || !cue.duration) return
  const time = waveformState.playheadTime
  cue.inPoint = parseFloat(Math.max(0, Math.min(time, cue.outPoint != null ? cue.outPoint : cue.duration)).toFixed(3))
  $('inp-in-point').value = cue.inPoint.toFixed(3)
  updateDurationDisplay(cue)
  drawWaveform(cue)
  markDirty()
}

function setOutPointAtPlayhead() {
  const cue = getCueById(state.selectedCueId)
  if (!cue || !cue.duration) return
  const time = waveformState.playheadTime
  cue.outPoint = parseFloat(Math.max(cue.inPoint || 0, Math.min(time, cue.duration)).toFixed(3))
  $('inp-out-point').value = cue.outPoint.toFixed(3)
  updateDurationDisplay(cue)
  drawWaveform(cue)
  markDirty()
}

// ── PROJECT SAVE / LOAD ────────────────────────────────────────────────────────
function setDirty(dirty) {
  state.dirty = !!dirty
  updateTitle()
  // Mirror to main process so the close-window prompt knows whether to fire
  if (window.flowcast && window.flowcast.setDirty) window.flowcast.setDirty(state.dirty)
}

function markDirty() { setDirty(true) }
function markClean() { setDirty(false) }

function updateTitle() {
  const name = state.project.name || 'Untitled'
  projectNameDisplay.textContent = name + (state.dirty ? ' •' : '')
  document.title = `FlowCast — ${name}${state.dirty ? ' •' : ''}`
}

async function saveProject(forceDialog = false) {
  let filePath = state.project.filePath
  if (!filePath || forceDialog) {
    const result = await window.flowcast.saveProjectDialog(`${state.project.name || 'Untitled'}.flowcast`)
    if (result.canceled) return false
    filePath = result.filePath
    if (!filePath.endsWith('.flowcast')) filePath += '.flowcast'
    state.project.filePath = filePath
    state.project.name = basename(filePath).replace('.flowcast', '')
  }

  const payload = JSON.stringify({
    version: 1,
    name:    state.project.name,
    settings: state.project.settings,
    cues:    state.project.cues.map(c => {
      // Don't persist waveform data — regenerated on load
      const { waveformData, ...rest } = c
      if (rest.clips) {
        rest.clips = rest.clips.map(({ waveformData: _w, loadFailed: _f, ...cl }) => cl)
      }
      return rest
    })
  }, null, 2)

  try {
    await window.flowcast.writeFile(filePath, payload)
  } catch (err) {
    alert(`Save failed: ${err.message}`)
    return false
  }
  markClean()
  return true
}

async function openProject() {
  if (state.dirty && !confirm('Discard unsaved changes and open another project?')) return
  const result = await window.flowcast.openProjectDialog()
  if (result.canceled || !result.filePaths.length) return
  const filePath = result.filePaths[0]

  // Snapshot OSC config before any state mutation so we can restart only if it changed
  const prevPort     = state.project.settings.oscPort     || 53000
  const prevPasscode = state.project.settings.oscPasscode || ''

  try {
    const raw  = await window.flowcast.readFile(filePath)
    const data = JSON.parse(raw)

    // Schema validation — bail before mutating any state if the file is malformed
    if (typeof data !== 'object' || data === null) throw new Error('not a JSON object')
    if (data.cues != null && !Array.isArray(data.cues)) throw new Error('cues must be an array')
    if (data.settings != null && typeof data.settings !== 'object') throw new Error('settings must be an object')

    // Stop in-flight playback before we discard the cue list it's keyed against
    Object.keys(state.playingCues).forEach(id => stopCue(id))

    state.project = {
      name:     data.name || basename(filePath).replace('.flowcast', ''),
      filePath,
      cues:     (data.cues || []).map(c => ({ waveformData: null, ...c })),
      settings: { oscPort: 53000, outputDevice: '', goMode: 'stop', goFadeDuration: 2.0, ...(data.settings || {}) }
    }
    state.selectedCueId = null
    state.playedCues    = new Set()
    state.playingCues   = {}

    // H2 migration: ensure every combo sub-clip has a stable id
    let migrated = false
    state.project.cues.forEach(c => {
      if (c.type !== 'combo') return
      ;(c.clips || []).forEach(clip => {
        if (!clip.id) { clip.id = newId(); migrated = true }
      })
    })
    setDirty(migrated)

    // Restore the output device dropdown to the saved selection
    const devSel = $('select-output-device')
    if (devSel) devSel.value = state.project.settings.outputDevice || ''

    renderCueList()
    updateInspector()
    updateTitle()

    // Restart OSC if the loaded project uses a different port or passcode
    const newPort     = state.project.settings.oscPort     || 53000
    const newPasscode = state.project.settings.oscPasscode || ''
    if (newPort !== prevPort || newPasscode !== prevPasscode) {
      state.oscConnected = false
      state.oscError     = null
      oscDot.className   = 'osc-dot'
      oscLabel.textContent = `OSC :${newPort}`
      window.flowcast.sendToBackend({ type: 'start_osc', port: newPort, passcode: newPasscode })
      updateOscPopover()
    }

    // Reload waveforms for all cues (including sub-clips of combo cues)
    state.project.cues.forEach(c => {
      if (c.type === 'combo') {
        (c.clips || []).forEach(clip => {
          if (clip.filePath && !clip.loadFailed) {
            window.flowcast.sendToBackend({ type: 'load_file', id: clip.id, filePath: clip.filePath })
          }
        })
      } else if (c.filePath) {
        window.flowcast.sendToBackend({ type: 'load_file', id: c.id, filePath: c.filePath })
      }
    })
  } catch (err) {
    alert(`Could not open project: ${err.message}`)
  }
}

function newProject() {
  if (state.dirty && !confirm('Discard unsaved changes and start a new project?')) return
  stopAll()
  state.project = {
    name: 'Untitled',
    filePath: null,
    cues: [],
    settings: { oscPort: 53000, outputDevice: '' }
  }
  state.selectedCueId = null

  setDirty(false)
  state.playedCues    = new Set()
  state.playingCues   = {}
  renderCueList()
  updateInspector()
  updateTitle()
}

function renumberCues() {
  state.project.cues.forEach((c, i) => { c.number = String(i + 1) })
  markDirty()
  renderCueList()
  updateInspector()
}

// ── APP MENU EVENTS ─────────────────────────────────────────────────────────────
window.flowcast.onMenuEvent((ev) => {
  switch (ev) {
    case 'menu-new-project':       newProject();            break
    case 'menu-open-project':      openProject();           break
    case 'menu-save-project':      saveProject(false);      break
    case 'menu-save-project-as':   saveProject(true);       break
    case 'menu-renumber-cues':     renumberCues();          break
    case 'menu-save-and-quit': {
      // Triggered by main when the user picks "Save" in the unsaved-changes dialog.
      // Run a normal save; only quit if it succeeds (cancelled save dialog or write
      // error keeps the window open so the user doesn't lose their work).
      saveProject(false).then(ok => { if (ok) window.flowcast.quitNow() })
      break
    }
  }
})

// ── BUTTON BINDINGS ────────────────────────────────────────────────────────────
btnGo.addEventListener('click', () => {
  if (state.inspectorTab === 'time' && state.selectedCueId) {
    if (waveformState.previewId) stopTrimPreview()
    else {
      const cue = getCueById(state.selectedCueId)
      if (cue) startTrimPreview(cue)
    }
  } else {
    go()
  }
})
btnStop.addEventListener('click',  stopAll)
btnPause.addEventListener('click', pauseAll)
btnPanic.addEventListener('click', panic)
btnAddCue.addEventListener('click', importAudioFiles)
btnImport.addEventListener('click', importAudioFiles)
btnDelete.addEventListener('click', deleteSelectedCue)

$('btn-begin-edit').addEventListener('click', () => {
  if (state.comboSelected.size < 2) return
  // Sort selected ids by their position in the cue list
  const orderedIds = state.project.cues
    .filter(c => state.comboSelected.has(c.id))
    .map(c => c.id)
  lteOpen(orderedIds)
})

$('footer-link').addEventListener('click', (e) => {
  e.preventDefault()
  // Opens in default browser via main process if needed
})

// ── OSC POPOVER ───────────────────────────────────────────────────────────────
function updateOscPopover() {
  const dot     = $('osc-pop-dot')
  const text    = $('osc-pop-status-text')
  if (!dot || !text) return
  if (state.oscConnected) {
    dot.className  = 'osc-pop-dot connected'
    text.textContent = `Listening on :${state.project.settings.oscPort || 53000}`
  } else if (state.oscError) {
    dot.className  = 'osc-pop-dot error'
    text.textContent = state.oscError
  } else {
    dot.className  = 'osc-pop-dot'
    text.textContent = 'Not started'
  }
  const portEl = $('osc-inp-port')
  if (portEl) portEl.value = state.project.settings.oscPort || 53000
  const passEl = $('osc-inp-passcode')
  if (passEl) passEl.value = state.project.settings.oscPasscode || ''
}

function bindOscPopover() {
  const trigger = $('osc-status')
  const popover = $('osc-popover')
  const settingsPop = $('settings-popover')
  if (!trigger || !popover) return

  trigger.addEventListener('click', (e) => {
    e.stopPropagation()
    const open = popover.style.display === 'none' || !popover.style.display
    popover.style.display = open ? '' : 'none'
    if (open) {
      // Close settings popover if open
      if (settingsPop) settingsPop.style.display = 'none'
      $('btn-settings')?.classList.remove('active')
      updateOscPopover()
    }
  })

  document.addEventListener('click', (e) => {
    if (!popover.contains(e.target) && e.target !== trigger && !trigger.contains(e.target)) {
      popover.style.display = 'none'
    }
  })

  $('btn-osc-restart')?.addEventListener('click', () => {
    // Save current port/passcode first, then restart
    const portEl = $('osc-inp-port')
    const passEl = $('osc-inp-passcode')
    if (portEl) state.project.settings.oscPort = parseInt(portEl.value) || 53000
    if (passEl) state.project.settings.oscPasscode = passEl.value.trim()
    state.oscConnected = false
    state.oscError = null
    oscDot.className = 'osc-dot'
    oscLabel.textContent = `OSC :${state.project.settings.oscPort}`
    updateOscPopover()
    window.flowcast.sendToBackend({
      type:     'start_osc',
      port:     state.project.settings.oscPort || 53000,
      passcode: state.project.settings.oscPasscode || ''
    })
    markDirty()
  })

  $('osc-inp-port')?.addEventListener('change', (e) => {
    const p = parseInt(e.target.value) || 53000
    state.project.settings.oscPort = p
    oscLabel.textContent = `OSC :${p}`
    markDirty()
  })

  $('osc-inp-passcode')?.addEventListener('change', (e) => {
    state.project.settings.oscPasscode = e.target.value.trim()
    markDirty()
  })
}

// ── HELP OVERLAY ──────────────────────────────────────────────────────────────
function bindHelpOverlay() {
  const overlay  = $('help-overlay')
  const btnOpen  = $('btn-help')
  const btnClose = $('help-btn-close')
  if (!overlay || !btnOpen) return

  const open  = () => { overlay.style.display = '' }
  const close = () => { overlay.style.display = 'none' }

  btnOpen.addEventListener('click', open)
  if (btnClose) btnClose.addEventListener('click', close)

  // Esc closes the overlay (capture-phase so it wins over the global Esc-stop)
  document.addEventListener('keydown', e => {
    if (overlay.style.display !== 'none' && e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
    }
  }, true)

  // Auto-open the help panel ONCE — the first time the app ever launches on
  // this machine. After that, the user finds it via the ? button.
  if (localStorage.getItem('fc_helpSeen') !== '1') {
    open()
    localStorage.setItem('fc_helpSeen', '1')
  }
}

// ── SETTINGS POPOVER ──────────────────────────────────────────────────────────
function bindSettingsListeners() {
  const btn     = $('btn-settings')
  const popover = $('settings-popover')
  if (!btn || !popover) return

  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    const open = popover.style.display === 'none' || !popover.style.display
    popover.style.display = open ? '' : 'none'
    btn.classList.toggle('active', open)
    if (open) syncSettingsUI()
  })

  document.addEventListener('click', (e) => {
    if (!popover.contains(e.target) && e.target !== btn) {
      popover.style.display = 'none'
      btn.classList.remove('active')
    }
  })

  document.querySelectorAll('input[name="go-mode"]').forEach(radio => {
    radio.addEventListener('change', () => {
      state.project.settings.goMode = radio.value
      $('settings-fade-row').style.display = radio.value === 'fadeout' ? '' : 'none'
      markDirty()
    })
  })

  const fadeDurInput = $('inp-go-fade-duration')
  if (fadeDurInput) {
    fadeDurInput.addEventListener('change', () => {
      state.project.settings.goFadeDuration = parseFloat(fadeDurInput.value) || 2.0
      markDirty()
    })
  }

  // Test tone
  const btnTest = $('btn-test-output')
  if (btnTest) {
    btnTest.addEventListener('click', () => {
      btnTest.disabled = true
      window.flowcast.sendToBackend({
        type: 'test_tone',
        device: state.project.settings.outputDevice || null
      })
      setTimeout(() => { btnTest.disabled = false }, 1100)
    })
  }

  // Confirm Before Delete toggle (default ON)
  const chkConfirm = $('chk-confirm-delete')
  if (chkConfirm) {
    chkConfirm.checked = localStorage.getItem('fc_confirmDelete') !== '0'
    chkConfirm.addEventListener('change', () => {
      localStorage.setItem('fc_confirmDelete', chkConfirm.checked ? '1' : '0')
    })
  }

  // Cmd+N adds blank cue toggle (default OFF — file picker)
  const chkCmdN = $('chk-cmdn-blank')
  if (chkCmdN) {
    chkCmdN.checked = localStorage.getItem('fc_cmdNAction') === 'blank'
    chkCmdN.addEventListener('change', () => {
      localStorage.setItem('fc_cmdNAction', chkCmdN.checked ? 'blank' : 'import')
    })
  }

  // Auto-save interval input (0 = off, default 10 min)
  const inpAutoSave = $('inp-autosave-min')
  if (inpAutoSave) {
    const stored = localStorage.getItem('fc_autoSaveMinutes')
    const initial = stored == null ? 10 : parseInt(stored, 10) || 0
    inpAutoSave.value = initial
    if (stored == null) localStorage.setItem('fc_autoSaveMinutes', '10')
    inpAutoSave.addEventListener('change', () => {
      const v = Math.max(0, Math.min(60, parseInt(inpAutoSave.value, 10) || 0))
      inpAutoSave.value = v
      localStorage.setItem('fc_autoSaveMinutes', String(v))
      applyAutoSaveSetting()
    })
  }

  // App version + update check
  const versionEl = $('settings-app-version')
  if (versionEl && window.flowcast.getAppVersion) {
    window.flowcast.getAppVersion().then(v => { versionEl.textContent = v || '—' }).catch(() => {})
  }
  const btnUpdate    = $('btn-check-updates')
  const updateStatus = $('settings-update-status')
  if (btnUpdate && window.flowcast.checkForUpdates) {
    btnUpdate.addEventListener('click', () => {
      btnUpdate.disabled = true
      if (updateStatus) updateStatus.textContent = 'Checking…'
      window.flowcast.checkForUpdates().then(r => {
        btnUpdate.disabled = false
        if (!updateStatus) return
        if (!r || !r.ok) updateStatus.textContent = `Could not check: ${r?.error || 'unknown error'}`
        else if (r.available) updateStatus.textContent = `Update available: v${r.version} (downloading in background)`
        else updateStatus.textContent = 'You have the latest version.'
      })
    })
  }
}

function syncSettingsUI() {
  const s = state.project.settings
  document.querySelectorAll('input[name="go-mode"]').forEach(r => {
    r.checked = r.value === (s.goMode || 'stop')
  })
  const fadeDurInput = $('inp-go-fade-duration')
  if (fadeDurInput) fadeDurInput.value = s.goFadeDuration || 2.0
  const fadeRow = $('settings-fade-row')
  if (fadeRow) fadeRow.style.display = (s.goMode === 'fadeout') ? '' : 'none'
}

// ── INIT ───────────────────────────────────────────────────────────────────────

// Restore persisted panel sizes
;(function restorePanelSizes() {
  const savedNp  = parseInt(localStorage.getItem('fc_nowPlayingH'))
  const savedIns = parseInt(localStorage.getItem('fc_inspectorH'))
  if (!isNaN(savedNp))  {
    state.nowPlayingH = Math.max(NPH_MIN, Math.min(NPH_MAX, savedNp))
    const npEl = $('now-playing')
    if (npEl) {
      npEl.style.height = state.nowPlayingH + 'px'
      npEl.style.setProperty('--np-scale', (state.nowPlayingH / NPH_DEFAULT).toFixed(3))
    }
  }
  if (!isNaN(savedIns)) {
    state.inspectorH = Math.max(100, savedIns)
    if (inspector) inspector.style.height = `${state.inspectorH}px`
  }
})()

bindInspectorFields()
bindWaveformListeners()
bindSettingsListeners()
bindOscPopover()
bindNpResize()
bindHelpOverlay()
applyAutoSaveSetting()
renderCueList()
updateInspector()
updateTitle()
updateNowPlaying()
// Signal main process that we're ready to receive backend messages
window.flowcast.rendererReady()
