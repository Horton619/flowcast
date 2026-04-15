const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const { autoUpdater } = require('electron-updater')

let mainWindow
let backendProcess

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

function startBackend() {
  const exe = getBackendExecutable()
  const args = app.isPackaged ? [] : [path.join(__dirname, 'backend', 'main.py')]

  backendProcess = spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'] })

  backendProcess.stdout.on('data', (data) => {
    const lines = data.toString().split('\n').filter(l => l.trim())
    for (const line of lines) {
      try {
        const msg = JSON.parse(line)
        if (mainWindow) mainWindow.webContents.send('backend-message', msg)
      } catch {
        console.log('[backend]', line)
      }
    }
  })

  backendProcess.stderr.on('data', (data) => {
    console.error('[backend stderr]', data.toString())
    if (mainWindow) {
      mainWindow.webContents.send('backend-message', {
        type: 'log',
        level: 'error',
        text: data.toString()
      })
    }
  })

  backendProcess.on('exit', (code) => {
    console.log('[backend] exited with code', code)
    if (mainWindow) {
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
        { label: 'Select All', role: 'selectAll' }
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
  startBackend()
  createWindow()
  autoUpdater.checkForUpdatesAndNotify().catch(() => {})
})

app.on('before-quit', () => {
  if (backendProcess) backendProcess.kill()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

// ── IPC handlers ──────────────────────────────────────────────────────────────

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
