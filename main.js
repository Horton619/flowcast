const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn, execSync } = require('child_process')
const readline = require('readline')
const { autoUpdater } = require('electron-updater')

let mainWindow
let backendProcess
let pendingBackendMessages = []   // buffer msgs that arrive before the window is ready
let projectDirty = false          // mirrored from renderer via 'set-dirty' IPC
let userConfirmedQuit = false     // set after the Save/Don't-Save dialog so we don't re-prompt

function getBackendExecutable() {
  if (app.isPackaged) {
    const ext = process.platform === 'win32' ? '.exe' : ''
    return path.join(process.resourcesPath, 'backend', `flowcast_backend${ext}`)
  }
  const venvPython = path.join(
    __dirname, 'backend', 'venv', 'bin', 'python3'
  )
  if (fs.existsSync(venvPython)) return venvPython
  return 'python3'
}

function killOrphanedBackends() {
  // Kill any lingering FlowCast backend processes from previous sessions
  try {
    if (process.platform === 'win32') {
      // Windows: WMIC matches on the command line so we target python processes
      // running our backend script. Escape backslashes for the WMIC like-pattern.
      const scriptPath = path.join(__dirname, 'backend', 'main.py').replace(/\\/g, '\\\\')
      execSync(
        `wmic process where "CommandLine like '%${scriptPath}%' and not (CommandLine like '%wmic%')" call terminate`,
        { stdio: 'ignore' }
      )
      execSync('ping -n 1 -w 300 127.0.0.1 > NUL', { stdio: 'ignore' })
    } else {
      const scriptPath = path.join(__dirname, 'backend', 'main.py')
      execSync(`pkill -f "${scriptPath}" 2>/dev/null || true`)
      execSync('sleep 0.3')
    }
  } catch (_) { /* ignore */ }
}

function startBackend() {
  const exe = getBackendExecutable()
  const args = app.isPackaged ? [] : [path.join(__dirname, 'backend', 'main.py')]

  backendProcess = spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'] })

  const rl = readline.createInterface({ input: backendProcess.stdout })
  rl.on('line', (line) => {
    if (!line.trim()) return
    try {
      const msg = JSON.parse(line)
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('backend-message', msg)
      } else {
        pendingBackendMessages.push(msg)   // window not ready yet — buffer it
      }
    } catch {
      console.log('[backend]', line)
    }
  })

  backendProcess.stderr.on('data', (data) => {
    console.error('[backend stderr]', data.toString())
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('backend-message', {
        type: 'log',
        level: 'error',
        text: data.toString()
      })
    }
  })

  backendProcess.on('exit', (code) => {
    console.log('[backend] exited with code', code)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('backend-message', {
        type: 'backend_exited',
        code
      })
    }
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0c0e14',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.loadFile('renderer/index.html')

  // Flush any backend messages that arrived before the window was ready
  mainWindow.webContents.on('did-finish-load', () => {
    // Short delay so renderer JS finishes executing and registers its IPC listeners
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        for (const msg of pendingBackendMessages) {
          mainWindow.webContents.send('backend-message', msg)
        }
        pendingBackendMessages = []
      }
    }, 300)
  })

  // Block window close if there are unsaved changes — show Save / Don't Save / Cancel
  mainWindow.on('close', (e) => {
    if (userConfirmedQuit || !projectDirty) return
    e.preventDefault()
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type:      'warning',
      buttons:   ['Save', "Don't Save", 'Cancel'],
      defaultId: 0,
      cancelId:  2,
      message:   'You have unsaved changes.',
      detail:    'Save them before quitting?'
    })
    if (choice === 0) {
      // Save & Quit: renderer runs saveProject; on success it calls flowcast.quitNow()
      mainWindow.webContents.send('menu-save-and-quit')
    } else if (choice === 1) {
      userConfirmedQuit = true
      mainWindow.close()
    }
    // choice === 2 (Cancel) → do nothing, window stays open
  })

  // Minimal app menu (keeps Cmd+Q, Cmd+W, copy/paste working)
  const template = [
    {
      label: 'FlowCast',
      submenu: [
        { label: 'About FlowCast', role: 'about' },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'CmdOrCtrl+Q', role: 'quit' }
      ]
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Project', accelerator: 'CmdOrCtrl+Shift+N', click: () => mainWindow.webContents.send('menu-new-project') },
        { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: () => mainWindow.webContents.send('menu-open-project') },
        { label: 'Save Project', accelerator: 'CmdOrCtrl+S', click: () => mainWindow.webContents.send('menu-save-project') },
        { label: 'Save Project As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => mainWindow.webContents.send('menu-save-project-as') }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', role: 'undo' },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', role: 'redo' },
        { type: 'separator' },
        { label: 'Cut', role: 'cut' },
        { label: 'Copy', role: 'copy' },
        { label: 'Paste', role: 'paste' },
        { label: 'Select All', role: 'selectAll' },
        { type: 'separator' },
        { label: 'Renumber Cues', click: () => mainWindow.webContents.send('menu-renumber-cues') }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Developer Tools', accelerator: 'F12', click: () => mainWindow.webContents.toggleDevTools() }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(() => {
  killOrphanedBackends()
  startBackend()
  createWindow()
  autoUpdater.checkForUpdatesAndNotify().catch(() => {})
})

app.on('before-quit', () => {
  if (backendProcess) backendProcess.kill()
})

app.on('window-all-closed', () => {
  // FlowCast is a single-window live tool — quit fully on all platforms when the window closes
  app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

// ── IPC handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('renderer-ready', () => {
  // Renderer has registered its IPC listeners — flush any buffered backend messages now
  if (mainWindow && !mainWindow.isDestroyed()) {
    for (const msg of pendingBackendMessages) {
      mainWindow.webContents.send('backend-message', msg)
    }
    pendingBackendMessages = []
  }
})

ipcMain.handle('set-dirty', (_e, dirty) => { projectDirty = !!dirty })

ipcMain.handle('quit-now', () => {
  userConfirmedQuit = true
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close()
})

ipcMain.handle('get-app-version', () => app.getVersion())

ipcMain.handle('check-for-updates', async () => {
  try {
    const result = await autoUpdater.checkForUpdates()
    if (!result || !result.updateInfo) return { ok: true, available: false, version: app.getVersion() }
    const remote = result.updateInfo.version
    return { ok: true, available: remote && remote !== app.getVersion(), version: remote }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('send-to-backend', (_e, msg) => {
  if (backendProcess && backendProcess.stdin.writable) {
    backendProcess.stdin.write(JSON.stringify(msg) + '\n')
  }
})

ipcMain.handle('open-audio-dialog', async () => {
  return dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Audio Files', extensions: ['wav', 'mp3', 'aiff', 'aif', 'flac', 'ogg', 'm4a', 'aac'] }
    ]
  })
})

ipcMain.handle('open-project-dialog', async () => {
  return dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'FlowCast Project', extensions: ['flowcast'] }]
  })
})

ipcMain.handle('save-project-dialog', async (_e, defaultName) => {
  return dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName || 'Untitled.flowcast',
    filters: [{ name: 'FlowCast Project', extensions: ['flowcast'] }]
  })
})

ipcMain.handle('read-file', (_e, filePath) => {
  return fs.readFileSync(filePath, 'utf8')
})

ipcMain.handle('write-file', (_e, filePath, content) => {
  fs.writeFileSync(filePath, content, 'utf8')
})

ipcMain.handle('show-item-in-folder', (_e, filePath) => {
  shell.showItemInFolder(filePath)
})
