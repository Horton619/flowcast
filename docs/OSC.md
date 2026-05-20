# OSC remote control (QLab API mirror)

> Load this doc when working on: `backend/main.py` OSC handlers, `start_osc_server`, SLIP framing, the `_tcp_conn_local` thread-local, the Companion handshake, the `osc_started` / `osc_command` messages, the OSC popover in `index.html`, the OSC status dot in the header.

## TL;DR

FlowCast pretends to be a QLab workspace so Bitfocus Companion's QLab module works unchanged. Listens on port 53000 by default, BOTH UDP and TCP simultaneously (Companion uses TCP by default). TCP uses SLIP framing (RFC 1055) — QLab v4's protocol. The Companion handshake is: client connects → sends `/workspaces` → we reply with workspace list → client sends `/workspace/{id}/connect ["passcode"]` → we reply OK → client sends `/workspace/{id}/cueLists` then `/go`, `/cue/{n}/start`, etc. OSC commands are forwarded to the renderer as `{type: 'osc_command', command: 'go' | 'stop' | ...}` messages — the renderer's transport logic handles them the same as keyboard / button input.

## The decisions / invariants (what's locked in)

- **Both UDP and TCP servers run on the same port.** Companion's QLab module defaults to TCP. UDP is for older clients / debug.
- **SLIP framing for TCP only.** Bytes 0xC0 frame both sides of each OSC packet; 0xDB escapes 0xC0 (→ 0xDC) and 0xDB itself (→ 0xDD). `_slip_encode` / `_slip_decode` in `backend/main.py`. UDP packets are raw.
- **Workspace handshake is required.** Companion will NOT send transport commands until `/workspace/{id}/connect` has been acknowledged. We respond on `/workspaces` with `[{"uniqueID": "flowcast", "displayName": "FlowCast"}]` and on `/workspace/flowcast/connect` with `"ok"`. WORKSPACE_ID = `'flowcast'`, WORKSPACE_NAME = `'FlowCast'`.
- **Reply routing uses a thread-local for TCP, fresh `SimpleUDPClient` per reply for UDP.** `_tcp_conn_local.conn` is set inside each TCP request handler so `_osc_reply` knows to write back on the same socket. Older code cached UDP clients in a dict — that leaked sockets on every reconnect from a new ephemeral port. Now we construct one per reply.
- **OSC starts at backend startup**, not on renderer request. `start_osc_server(53000)` runs in `main()` before the stdin loop. The renderer can call `start_osc` later to restart on a different port / with a passcode, which goes through proper teardown (`srv.shutdown()` + `srv.server_close()` — both required; shutdown alone doesn't free the port).
- **Passcode is optional.** Companion has a passcode field; we accept any string passed to `/workspace/{id}/connect` and just compare to the saved passcode (empty = no passcode).
- **OSC commands forward to renderer as `osc_command` messages.** The renderer's `handleOscCommand` is the dispatch point; it routes by `msg.command` to `go()`, `stopAll()`, `pauseAll()`, etc. — same code paths as keyboard / button input. This keeps OSC behaviour identical to manual transport.
- **Supported addresses:**
  - `/go`, `/workspace/{id}/go` → fire selected cue
  - `/stop`, `/panic`, `/workspace/{id}/stop` → stop all
  - `/pause`, `/resume`
  - `/playhead/next`, `/playhead/previous` → move selection
  - `/cue/{N}/start` → fire cue by user-facing number
  - `/workspaces`, `/workspace/{id}/connect`, `/workspace/{id}/cueLists` → Companion handshake / discovery

## Code references

| File | What it owns |
|---|---|
| `backend/main.py` `_slip_encode` / `_slip_decode` | SLIP byte framing |
| `backend/main.py` `_tcp_conn_local` | thread-local for the open TCP socket inside a request handler |
| `backend/main.py` `_osc_reply` | dispatches the reply on the right transport |
| `backend/main.py` `_workspaces_handler`, `_workspace_connect_handler` | Companion handshake |
| `backend/main.py` `_go_handler`, `_stop_handler`, `_cue_handler` etc. | transport mapping |
| `backend/main.py` `start_osc_server` | spins up UDP + TCP servers, sends `osc_started` event |
| `renderer/renderer.js` `handleOscCommand` | renderer-side dispatch |
| `renderer/index.html` OSC popover | port + passcode UI, Restart button, status dot |

## What NOT to do

- ❌ **Don't drop UDP support to simplify.** Bitfocus Companion defaults to TCP but other QLab-compatible clients still use UDP, and a TCP-only server breaks the discovery story. Keep both running on the same port.
- ❌ **Don't skip the workspace handshake.** Returning early on `/workspaces` or refusing `/workspace/.../connect` makes Companion silently never send any transport commands. Test specifically with Companion's QLab module, not just `osc-cli`.
- ❌ **Don't cache UDP reply clients keyed by `(ip, port)`.** A flaky Companion reconnecting from new ephemeral source ports every reply leaks one socket per reply — eventually fd exhaustion. The current code constructs a fresh `SimpleUDPClient` per reply (cheap, the socket is local and gc'd immediately).
- ❌ **Don't try to restart the OSC server without `server_close()` after `shutdown()`.** `shutdown()` stops the serve loop but doesn't release the listening socket — next bind on the same port fails with EADDRINUSE.
- ❌ **Don't add OSC behavior that bypasses the renderer.** Every command is forwarded as `osc_command` so manual + remote transport stay identical. If you handle it backend-side you'll diverge.
- ❌ **Don't change `WORKSPACE_ID` from `'flowcast'`.** It's the identifier Companion stores once connected. Changing it breaks every saved Companion config.
- ❌ **Don't trust the OSC command list to be exhaustive.** QLab has hundreds of OSC addresses; we mirror the small subset Companion actually uses for live show transport. Adding new ones is fine — but verify with a real Companion module before claiming support.
