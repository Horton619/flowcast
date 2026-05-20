# IPC protocol (renderer ↔ main ↔ backend)

> Load this doc when working on: `main.js` stdout/stdin handling, `preload.js`, `window.flowcast.*`, `sendToBackend`, `onBackendMessage`, JSON message types, `pendingBackendMessages`, `renderer-ready` signal.

## TL;DR

Three processes talk over two boundaries. **Renderer ↔ main** uses Electron's `contextBridge` (preload exposes `window.flowcast.*`) and `ipcMain.handle` / `ipcRenderer.invoke`. **Main ↔ backend** uses the Python subprocess's stdin (line-delimited JSON request from main → backend) and stdout (line-delimited JSON events from backend → main, forwarded to renderer over `backend-message`). Lines can be many KB (waveform JSON ≈ 20KB); main.js uses `readline.createInterface` to buffer across data events because `data` callbacks do NOT guarantee complete lines. Backend stderr is mirrored to the renderer as `{type: 'log', level: 'error'}` so Python crash output surfaces in the renderer console. Messages emitted before the renderer's IPC listeners are registered get buffered in `pendingBackendMessages` and flushed on the `renderer-ready` signal.

## The decisions / invariants (what's locked in)

- **One JSON object per line, newline-terminated.** Both directions. Backend's `send()` does `sys.stdout.write(json.dumps(payload) + '\n'); sys.stdout.flush()`. Main writes `JSON.stringify(msg) + '\n'` to backend.stdin. NEVER use indented JSON or embedded newlines.
- **main.js uses `readline.createInterface({ input: backendProcess.stdout })`**, not `stdout.on('data')`. The raw `data` event does not guarantee complete lines — a 20KB `file_loaded` waveform JSON gets chunked across several events, and `JSON.parse` on a chunk silently discards it. readline buffers across chunks and emits one event per complete line. This was the root cause of the combo clip duration bug.
- **`pendingBackendMessages` + `renderer-ready`** handle the renderer-startup race. Backend emits `ready` (and starts OSC + sends `osc_started`) before the renderer's `onBackendMessage` listener is registered. main.js buffers messages until either the `did-finish-load` event (300ms delay) OR the explicit `rendererReady()` IPC call fires. Both paths flush the buffer with an `isDestroyed()` guard.
- **stderr is also forwarded** as `{type: 'log', level: 'error', text}`. This makes Python tracebacks and our own `send_log` warnings visible in the renderer console without anyone needing to attach a debugger. The forward is guarded by `mainWindow && !mainWindow.isDestroyed()` — without this, a window close + Python stderr write would throw on a destroyed webContents.
- **Renderer→main via `ipcRenderer.invoke`**, never `send`. Preload exposes `sendToBackend`, `setDirty`, `quitNow`, `installUpdateNow`, dialog helpers, etc. — all `invoke`-based so they return promises.
- **The preload bridge is the only surface.** Renderer cannot `require('electron')` or `require('child_process')`. Everything goes through `window.flowcast.*`. Adding a new capability means: (a) `ipcMain.handle` in main.js, (b) expose function in preload.js, (c) call `window.flowcast.<name>()` in renderer.
- **`send-to-backend` is one-way.** main.js writes to backend.stdin but doesn't await a response. Backend responses come back via the stdout event stream. Don't try to make them request/response — the protocol is stateless.
- **Backend tolerates junk strings on numeric fields.** `play` handler parses `msg.get('device')` against `(None, '', 0, 'undefined', 'null', 'NaN')` and falls back to `None`. Earlier, `int('undefined')` from a renderer that sent a missing dataset attribute as a literal string crashed the play call.

## Code references

| File | What it owns |
|---|---|
| `main.js:50-65` | `readline.createInterface` on backend stdout, JSON parse + forward |
| `main.js:67-93` | stderr handler + `exit` handler (emit `backend_exited`) |
| `main.js:104-113` | `did-finish-load` timer flush of `pendingBackendMessages` |
| `main.js:204-244` | All `ipcMain.handle` registrations |
| `preload.js` | The full `window.flowcast.*` surface |
| `backend/main.py:24-28` | `send` (stdout) + `send_log` helpers |
| `backend/main.py:962-988` | Main `for line in sys.stdin:` loop + per-message dispatch |
| `renderer/renderer.js` `onBackendMessage` switch | Routing for every `msg.type` |

## What NOT to do

- ❌ **Don't replace `readline.createInterface` with `stdout.on('data')` + manual splitting.** Even "obvious" implementations miss the edge cases readline handles (CR/LF, partial lines at EOF, encoding). Combo waveform JSONs silently disappeared this way.
- ❌ **Don't `JSON.stringify` with indent / spaces in `send()`.** Multi-line JSON breaks the line-delimited protocol.
- ❌ **Don't add new Electron API access in the renderer.** It runs in `contextIsolation: true, nodeIntegration: false`. The preload bridge is the only path.
- ❌ **Don't `mainWindow.webContents.send(...)` without `&& !mainWindow.isDestroyed()`.** Stderr / exit events arrive after window close more often than you'd think.
- ❌ **Don't ship messages that aren't JSON-serializable.** Numpy arrays, datetime objects, etc. all need conversion first (e.g., `float(x)` not raw `np.float32`). The waveform JSON uses `list(map(float, peaks))`.
- ❌ **Don't add a new `ipcMain.handle` without exposing it through preload.** Renderer can't see ipcMain handlers directly.
- ❌ **Don't `gh secret set --body -` when transferring secrets** — sets the literal dash character, not stdin. Use `cmd | gh secret set NAME --repo owner/repo` (omit `--body`). Unrelated to this file but learned painfully and worth flagging anywhere we touch CI / secret transport.
- ❌ **Don't trust `device_id = int(raw_dev)` without the guard set.** Renderer sometimes sends 'undefined' / 'null' string for missing dataset attrs; the play handler's parse must tolerate them.
