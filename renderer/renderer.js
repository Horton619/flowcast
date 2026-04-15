'use strict'

// ── STATE ──────────────────────────────────────────────────────────────────────
const state = {
  project: {
    name: 'Untitled',
    filePath: null,
    cues: [],
    settings: {
      oscPort: 53000,
      outputDevice: ''
    }
  },
  selectedCueId: null,
  playingCues: {},       // id -> { startedAt, duration, progressTimer }
  nextGoIndex: 0,        // index in cues[] that GO will fire next
  oscConnected: false,
  backendReady: false,
  dirty: false,          // unsaved changes
  inspectorTab: 'basics',
  inspectorResizing: false,
  inspectorH: 260
}

let idCounter = 1
function newId() { return `cue_${Date.now()}_${idCounter++}` }

// ── COLOUR MAP ─────────────────────────────────────────────────────────────────
const COLOR_MAP = {
  none: null, red: '#ff4757', orange: '#ff8c00',
  yellow: '#ffb800', green: '#00d97e', blue: '#3d7eff', purple: '#a855f7'
}

// ── CONTINUE MODE ICONS ────────────────────────────────────────────────────────
const CONTINUE_ICONS = {
  none: '',
  'auto-continue': '<span class="continue-icon-ac" title="Auto-Continue">↷</span>',
  'auto-follow':   '<span class="continue-icon-af" title="Auto-Follow">↪</span>'
}

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
function renderCueList() {
  const cues = state.project.cues
  emptyState.classList.toggle('visible', cues.length === 0)

  // Rebuild tbody
  tbody.innerHTML = ''
  cues.forEach((cue, idx) => {
    const tr = document.createElement('tr')
    tr.dataset.id = cue.id

    const isSelected = cue.id === state.selectedCueId
    const isPlaying  = !!state.playingCues[cue.id]
    const isNext     = idx === state.nextGoIndex

    if (isSelected) tr.classList.add('selected')
    if (isPlaying)  tr.classList.add('playing')

    const colorClass = cue.color && cue.color !== 'none' ? `stripe-${cue.color}` : ''

    tr.innerHTML = `
      <td class="td-color-stripe">
        <span class="color-stripe ${colorClass}"></span>
      </td>
      <td class="td-num">${isNext && !isPlaying ? '▶ ' : ''}${escHtml(cue.number)}</td>
      <td class="td-name">
        <span class="cue-name-text">${escHtml(cue.name || basename(cue.filePath) || 'Untitled Cue')}</span>
        ${!cue.filePath ? '<span class="no-file-badge">NO FILE</span>' : ''}
      </td>
      <td class="td-prewait">${formatPrewait(cue.preWait)}</td>
      <td class="td-duration">${formatTime(cue.outPoint != null ? (cue.outPoint - cue.inPoint) : cue.duration)}</td>
      <td class="td-continue">${CONTINUE_ICONS[cue.continueMode] || ''}</td>
    `

    // Progress bar for playing cue
    if (isPlaying) {
      const bar = document.createElement('div')
      bar.className = 'cue-progress-bar'
      bar.id = `progress-${cue.id}`
      tr.style.position = 'relative'
      tr.appendChild(bar)
    }

    tr.addEventListener('click', () => selectCue(cue.id))
    tr.addEventListener('dblclick', () => {
      selectCue(cue.id)
      startEditName(cue.id)
    })

    tbody.appendChild(tr)
  })

  btnDelete.disabled = !state.selectedCueId
  updateTitle()
}

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
}

// ── SELECTION ─────────────────────────────────────────────────────────────────
function selectCue(id) {
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
  $('inp-prewait').value    = cue.preWait || 0
  $('cue-file-path').textContent = cue.filePath || '— no file —'

  // Color picker
  document.querySelectorAll('.color-swatch').forEach(sw => {
    sw.classList.toggle('selected', sw.dataset.color === (cue.color || 'none'))
  })

  // Continue mode
  document.querySelectorAll('.seg-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === (cue.continueMode || 'none'))
  })

  // ── Time ──
  $('inp-in-point').value  = cue.inPoint != null ? cue.inPoint.toFixed(3) : '0.000'
  $('inp-out-point').value = cue.outPoint != null ? cue.outPoint.toFixed(3) : (cue.duration ? cue.duration.toFixed(3) : '')
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
function drawWaveform(cue) {
  const canvas = $('waveform-canvas')
  const noFile = $('waveform-no-file')
  const ctx    = canvas.getContext('2d')

  const W = canvas.offsetWidth || 600
  const H = canvas.offsetHeight || 80
  canvas.width  = W
  canvas.height = H

  ctx.clearRect(0, 0, W, H)

  if (!cue || !cue.waveformData || !cue.waveformData.length) {
    noFile.style.display = ''
    return
  }

  noFile.style.display = 'none'
  const data  = cue.waveformData
  const mid   = H / 2
  const color = '#3d7eff'

  // Background
  ctx.fillStyle = 'rgba(61,126,255,0.04)'
  ctx.fillRect(0, 0, W, H)

  // Draw bars
  const barW  = W / data.length
  ctx.fillStyle = color
  data.forEach((amp, i) => {
    const barH  = amp * mid * 0.9
    const x     = i * barW
    ctx.globalAlpha = 0.5 + amp * 0.5
    ctx.fillRect(x, mid - barH, Math.max(barW - 1, 1), barH * 2)
  })
  ctx.globalAlpha = 1

  // In/out markers
  const duration = cue.duration || 1
  const inPct  = ((cue.inPoint  || 0) / duration)
  const outPct = ((cue.outPoint != null ? cue.outPoint : duration) / duration)

  // Shaded out-of-range region
  ctx.fillStyle = 'rgba(12,14,20,0.55)'
  ctx.fillRect(0, 0, inPct * W, H)
  ctx.fillRect(outPct * W, 0, W - outPct * W, H)

  // In marker
  ctx.strokeStyle = '#00d97e'
  ctx.lineWidth   = 1.5
  ctx.beginPath()
  ctx.moveTo(inPct * W, 0)
  ctx.lineTo(inPct * W, H)
  ctx.stroke()

  // Out marker
  ctx.strokeStyle = '#ff4757'
  ctx.lineWidth   = 1.5
  ctx.beginPath()
  ctx.moveTo(outPct * W, 0)
  ctx.lineTo(outPct * W, H)
  ctx.stroke()
}

// ── ADD / IMPORT CUES ──────────────────────────────────────────────────────────
function makeNewCue(overrides = {}) {
  const num = state.project.cues.length + 1
  return {
    id:           newId(),
    number:       String(num),
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
    continueMode: 'none',
    preWait:      0,
    color:        'none',
    ...overrides
  }
}

function addBlankCue() {
  const cue = makeNewCue()
  state.project.cues.push(cue)
  state.nextGoIndex = 0
  markDirty()
  renderCueList()
  selectCue(cue.id)
  startEditName(cue.id)
}

async function importAudioFiles() {
  const result = await window.flowcast.openAudioDialog()
  if (result.canceled || !result.filePaths.length) return

  const newCues = result.filePaths.map(fp => makeNewCue({
    filePath: fp,
    name:     basename(fp).replace(/\.[^.]+$/, '')
  }))

  newCues.forEach(c => state.project.cues.push(c))
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

  // Stop it if playing
  stopCue(state.selectedCueId)

  state.project.cues.splice(idx, 1)
  markDirty()

  // Select adjacent cue
  const newSel = state.project.cues[Math.min(idx, state.project.cues.length - 1)]
  state.selectedCueId = newSel ? newSel.id : null
  state.nextGoIndex   = Math.min(state.nextGoIndex, Math.max(0, state.project.cues.length - 1))

  renderCueList()
  updateInspector()
}

// ── INLINE NAME EDIT ───────────────────────────────────────────────────────────
function startEditName(id) {
  const tr = tbody.querySelector(`tr[data-id="${id}"]`)
  if (!tr) return
  const cell = tr.querySelector('.cue-name-text')
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

// ── GO / PLAYBACK ──────────────────────────────────────────────────────────────
function go() {
  const cues = state.project.cues
  if (!cues.length) return

  btnGo.classList.add('firing')
  setTimeout(() => btnGo.classList.remove('firing'), 200)

  const idx = state.nextGoIndex
  if (idx >= cues.length) return

  const cue = cues[idx]
  fireCue(cue.id)

  // Advance next pointer
  state.nextGoIndex = Math.min(idx + 1, cues.length)
  selectCue(cue.id)

  // Handle auto-continue on the CURRENT cue: next fires immediately
  if (cue.continueMode === 'auto-continue') {
    const delay = (cue.preWait || 0) * 1000
    setTimeout(() => go(), delay)
  }
}

function fireCue(id) {
  const cue = getCueById(id)
  if (!cue) return

  window.flowcast.sendToBackend({
    type: 'play',
    id:   cue.id,
    filePath: cue.filePath,
    inPoint:  cue.inPoint  || 0,
    outPoint: cue.outPoint,
    volume:   cue.volume   || 0,
    pan:      cue.pan      || 0,
    fadeIn:   cue.fadeIn   || 0,
    fadeOut:  cue.fadeOut  || 0
  })

  // Optimistic UI — show playing state
  const dur = cue.outPoint != null ? (cue.outPoint - (cue.inPoint || 0)) : cue.duration
  state.playingCues[id] = { startedAt: Date.now(), duration: dur || 0 }

  renderCueList()
  startProgressTimer(id, dur)
}

function startProgressTimer(id, duration) {
  const info = state.playingCues[id]
  if (!info) return

  const bar = document.getElementById(`progress-${id}`)

  const tick = () => {
    const elapsed = (Date.now() - info.startedAt) / 1000
    const pct     = duration > 0 ? Math.min(elapsed / duration, 1) : 0

    if (bar) bar.style.width = `${pct * 100}%`

    if (pct >= 1) {
      cueDone(id)
    } else {
      info.timer = requestAnimationFrame(tick)
    }
  }
  info.timer = requestAnimationFrame(tick)
}

function cueDone(id) {
  const cue  = getCueById(id)
  const info = state.playingCues[id]
  if (info?.timer) cancelAnimationFrame(info.timer)
  delete state.playingCues[id]
  renderCueList()

  // Handle auto-follow: next cue fires when this one ends
  if (cue && cue.continueMode === 'auto-follow') {
    const delay = (cue.preWait || 0) * 1000
    setTimeout(() => go(), delay)
  }
}

function stopCue(id) {
  const info = state.playingCues[id]
  if (info?.timer) cancelAnimationFrame(info.timer)
  delete state.playingCues[id]
  window.flowcast.sendToBackend({ type: 'stop', id })
}

function stopAll() {
  Object.keys(state.playingCues).forEach(id => stopCue(id))
  renderCueList()
}

function pauseAll() {
  window.flowcast.sendToBackend({ type: 'pause_all' })
  // UI update handled by backend message
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
      startOscServer()
      populateOutputDevices(msg.outputDevices || [])
      break

    case 'osc_started':
      state.oscConnected = true
      oscDot.className   = 'osc-dot connected'
      oscStatus.title    = `OSC listening on port ${msg.port}`
      break

    case 'osc_error':
      oscDot.className = 'osc-dot error'
      oscStatus.title  = `OSC error: ${msg.error}`
      break

    case 'file_loaded':
      handleFileLoaded(msg)
      break

    case 'cue_done':
      cueDone(msg.id)
      break

    case 'osc_command':
      handleOscCommand(msg)
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
  const cue = getCueById(msg.id)
  if (!cue) return
  cue.duration     = msg.duration
  cue.outPoint     = cue.outPoint != null ? cue.outPoint : msg.duration
  cue.waveformData = msg.waveformData || null
  markDirty()
  renderCueList()
  if (state.selectedCueId === msg.id) updateInspector()
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
      window.flowcast.sendToBackend({ type: 'resume_all' })
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
  if (cue) {
    selectCue(cue.id)
    state.nextGoIndex = getCueIndex(cue.id)
    renderCueList()
  }
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
  onFieldChange('inp-prewait',    (c,el) => { c.preWait = parseFloat(el.value) || 0 })

  onFieldChange('inp-in-point',  (c,el) => {
    c.inPoint = parseFloat(el.value) || 0
    updateDurationDisplay(c)
    drawWaveform(c)
  })
  onFieldChange('inp-out-point', (c,el) => {
    c.outPoint = parseFloat(el.value) || null
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
      cue.continueMode = btn.dataset.mode
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

// ── WAVEFORM CLICK → SET SCRUB ─────────────────────────────────────────────────
$('waveform-canvas').addEventListener('click', (e) => {
  const cue = getCueById(state.selectedCueId)
  if (!cue || !cue.duration) return
  const rect = e.currentTarget.getBoundingClientRect()
  const pct  = (e.clientX - rect.left) / rect.width
  const time = pct * cue.duration
  window.flowcast.sendToBackend({ type: 'seek', id: cue.id, time })
})

// ── INSPECTOR TABS ─────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'))
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'))
    btn.classList.add('active')
    $(`tab-${tab}`).classList.add('active')
    state.inspectorTab = tab
    if (tab === 'time') {
      const cue = getCueById(state.selectedCueId)
      if (cue) drawWaveform(cue)
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
  }
})

// ── DRAG & DROP ────────────────────────────────────────────────────────────────
const cueListScroll = $('cue-list-scroll')

cueListScroll.addEventListener('dragover', (e) => {
  e.preventDefault()
  dropOverlay.classList.add('active')
})
cueListScroll.addEventListener('dragleave', (e) => {
  if (!cueListScroll.contains(e.relatedTarget)) dropOverlay.classList.remove('active')
})
cueListScroll.addEventListener('drop', (e) => {
  e.preventDefault()
  dropOverlay.classList.remove('active')
  const files = [...e.dataTransfer.files].filter(f => /\.(wav|mp3|aiff?|flac|ogg|m4a|aac)$/i.test(f.name))
  if (!files.length) return

  const newCues = files.map(f => makeNewCue({
    filePath: f.path,
    name:     f.name.replace(/\.[^.]+$/, '')
  }))
  newCues.forEach(c => state.project.cues.push(c))
  markDirty()
  renderCueList()
  selectCue(newCues[0].id)
  newCues.forEach(c => window.flowcast.sendToBackend({ type: 'load_file', id: c.id, filePath: c.filePath }))
})

// ── HOTKEYS ────────────────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  // Don't intercept when typing in an input
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return

  const isMac  = navigator.platform.includes('Mac')
  const mod    = isMac ? e.metaKey : e.ctrlKey

  switch (e.key) {
    case ' ':
      e.preventDefault()
      go()
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
      if (mod && !e.shiftKey) { e.preventDefault(); addBlankCue() }
      break
    case 'Enter':
      if (state.selectedCueId) { e.preventDefault(); startEditName(state.selectedCueId) }
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

function duplicateSelectedCue() {
  if (!state.selectedCueId) return
  const src = getCueById(state.selectedCueId)
  if (!src) return
  const copy = { ...src, id: newId(), number: String(state.project.cues.length + 1) }
  const idx  = getCueIndex(src.id)
  state.project.cues.splice(idx + 1, 0, copy)
  markDirty()
  renderCueList()
  selectCue(copy.id)
}

function setInPointAtPlayhead() {
  const cue = getCueById(state.selectedCueId)
  if (!cue || !cue.duration) return
  // Use playhead position if playing, else set to 0
  const info = state.playingCues[cue.id]
  const time = info ? (Date.now() - info.startedAt) / 1000 + (cue.inPoint || 0) : 0
  cue.inPoint = Math.max(0, Math.min(time, cue.duration))
  markDirty()
  updateInspector()
}

function setOutPointAtPlayhead() {
  const cue = getCueById(state.selectedCueId)
  if (!cue || !cue.duration) return
  const info = state.playingCues[cue.id]
  const time = info ? (Date.now() - info.startedAt) / 1000 + (cue.inPoint || 0) : cue.duration
  cue.outPoint = Math.max(cue.inPoint || 0, Math.min(time, cue.duration))
  markDirty()
  updateInspector()
}

// ── PROJECT SAVE / LOAD ────────────────────────────────────────────────────────
function markDirty() {
  state.dirty = true
  updateTitle()
}

function updateTitle() {
  const name = state.project.name || 'Untitled'
  projectNameDisplay.textContent = name + (state.dirty ? ' •' : '')
  document.title = `FlowCast — ${name}${state.dirty ? ' •' : ''}`
}

async function saveProject(forceDialog = false) {
  let filePath = state.project.filePath
  if (!filePath || forceDialog) {
    const result = await window.flowcast.saveProjectDialog(`${state.project.name || 'Untitled'}.flowcast`)
    if (result.canceled) return
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
      return rest
    })
  }, null, 2)

  await window.flowcast.writeFile(filePath, payload)
  state.dirty = false
  updateTitle()
}

async function openProject() {
  const result = await window.flowcast.openProjectDialog()
  if (result.canceled || !result.filePaths.length) return
  const filePath = result.filePaths[0]
  const raw      = await window.flowcast.readFile(filePath)
  const data     = JSON.parse(raw)

  state.project = {
    name:     data.name || basename(filePath).replace('.flowcast', ''),
    filePath,
    cues:     (data.cues || []).map(c => ({ waveformData: null, ...c })),
    settings: { oscPort: 53000, outputDevice: '', ...(data.settings || {}) }
  }
  state.selectedCueId = null
  state.nextGoIndex   = 0
  state.dirty         = false
  Object.keys(state.playingCues).forEach(id => stopCue(id))

  renderCueList()
  updateInspector()
  updateTitle()

  // Reload waveforms
  state.project.cues.forEach(c => {
    if (c.filePath) window.flowcast.sendToBackend({ type: 'load_file', id: c.id, filePath: c.filePath })
  })
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
  state.nextGoIndex   = 0
  state.dirty         = false
  renderCueList()
  updateInspector()
  updateTitle()
}

// ── APP MENU EVENTS ─────────────────────────────────────────────────────────────
window.flowcast.onMenuEvent((ev) => {
  switch (ev) {
    case 'menu-new-project':       newProject();            break
    case 'menu-open-project':      openProject();           break
    case 'menu-save-project':      saveProject(false);      break
    case 'menu-save-project-as':   saveProject(true);       break
  }
})

// ── BUTTON BINDINGS ────────────────────────────────────────────────────────────
btnGo.addEventListener('click',    go)
btnStop.addEventListener('click',  stopAll)
btnPause.addEventListener('click', pauseAll)
btnPanic.addEventListener('click', panic)
btnAddCue.addEventListener('click', addBlankCue)
btnImport.addEventListener('click', importAudioFiles)
btnDelete.addEventListener('click', deleteSelectedCue)

$('footer-link').addEventListener('click', (e) => {
  e.preventDefault()
  // Opens in default browser via main process if needed
})

// ── INIT ───────────────────────────────────────────────────────────────────────
bindInspectorFields()
renderCueList()
updateInspector()
updateTitle()
