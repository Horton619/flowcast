// ─────────────────────────────────────────────────────────────────────────────
// Preload — the security boundary between the (Node-less) renderer and main.
//
// ⚠ Before editing, load docs/IPC.md.
//
// Renderer runs with contextIsolation:true, nodeIntegration:false. This file
// is the ONLY surface the renderer can use to reach Electron / Node / the
// backend subprocess. Every capability is exposed via window.flowcast.*.
//
// To add a new capability:
//   1. ipcMain.handle('foo-bar', ...) in main.js
//   2. fooBar: (...args) => ipcRenderer.invoke('foo-bar', ...args)  here
//   3. window.flowcast.fooBar(...)  in renderer.js
//
// Use invoke (promise-returning) for both renderer→main calls AND main→renderer
// event subscriptions (via ipcRenderer.on inside a wrapper). Don't add raw
// `send` — promises keep the API uniform.
// ─────────────────────────────────────────────────────────────────────────────

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('flowcast', {
  // Backend IPC
  sendToBackend: (msg) => ipcRenderer.invoke('send-to-backend', msg),
  onBackendMessage: (cb) => ipcRenderer.on('backend-message', (_e, msg) => cb(msg)),

  // File dialogs
  openAudioDialog: () => ipcRenderer.invoke('open-audio-dialog'),
  openProjectDialog: () => ipcRenderer.invoke('open-project-dialog'),
  saveProjectDialog: (defaultName) => ipcRenderer.invoke('save-project-dialog', defaultName),

  // File system
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('write-file', filePath, content),
  showItemInFolder: (filePath) => ipcRenderer.invoke('show-item-in-folder', filePath),

  // App menu events
  onMenuEvent: (cb) => {
    const events = ['menu-new-project', 'menu-open-project', 'menu-save-project', 'menu-save-project-as', 'menu-save-and-quit']
    events.forEach(ev => ipcRenderer.on(ev, () => cb(ev)))
  },

  // Signal to main process that renderer is ready to receive backend messages
  rendererReady: () => ipcRenderer.invoke('renderer-ready'),

  // Push dirty-state changes so main.js can prompt before close
  setDirty: (dirty) => ipcRenderer.invoke('set-dirty', dirty),

  // Tell main to proceed with quit after a successful Save & Quit
  quitNow: () => ipcRenderer.invoke('quit-now'),

  // App / updates
  getAppVersion:     () => ipcRenderer.invoke('get-app-version'),
  checkForUpdates:   () => ipcRenderer.invoke('check-for-updates'),
  installUpdateNow:  () => ipcRenderer.invoke('install-update-now'),
  onUpdateStatus:    (cb) => ipcRenderer.on('update-status', (_e, msg) => cb(msg))
})
