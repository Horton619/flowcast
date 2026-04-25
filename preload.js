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
  getAppVersion:    () => ipcRenderer.invoke('get-app-version'),
  checkForUpdates:  () => ipcRenderer.invoke('check-for-updates')
})
