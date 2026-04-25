"""
FlowCast backend — Python audio engine + OSC server
Communicates with Electron renderer via stdin/stdout newline-delimited JSON.
"""

import sys
import json
import threading
import time

import socketserver

import numpy as np
import sounddevice as sd
import soundfile as sf
from pythonosc import dispatcher as osc_dispatcher
from pythonosc import osc_server
from pythonosc import udp_client as osc_udp_client
from pythonosc import osc_message_builder

# ── IPC helpers ────────────────────────────────────────────────────────────────

def send(msg: dict):
    """Emit a JSON message to the renderer."""
    print(json.dumps(msg), flush=True)

def send_log(text: str, level: str = 'info'):
    send({'type': 'log', 'level': level, 'text': text})

# ── Audio engine ───────────────────────────────────────────────────────────────

# Active playback state: id -> dict
active_cues: dict = {}
active_lock = threading.Lock()

# libsndfile (especially its MP3 decoder) is not thread-safe — concurrent sf.read
# / sf.info calls cause SIGBUS crashes in mpeg_init. Serialise all access.
_sndfile_lock = threading.Lock()

def play_cue(cue_id: str, file_path: str, in_point: float, out_point,
             volume_db: float, pan: float, fade_in: float, fade_out: float,
             loop: bool = False, device_id=None):
    """Load and play an audio file in a background thread."""
    def _worker():
        try:
            with _sndfile_lock:
                data, samplerate = sf.read(file_path, dtype='float32', always_2d=True)
        except Exception as e:
            send_log(f'Failed to open {file_path}: {e}', 'error')
            return

        # Stereo mix-down if needed
        if data.shape[1] == 1:
            data = np.repeat(data, 2, axis=1)
        elif data.shape[1] > 2:
            data = data[:, :2]

        in_sample  = int(in_point * samplerate)
        out_sample = int(out_point * samplerate) if out_point is not None else len(data)
        chunk      = data[in_sample:out_sample].copy()

        # Fade in/out only — gain/pan applied live in callback so they can be adjusted
        total = len(chunk)
        if fade_in > 0:
            fi = min(int(fade_in * samplerate), total)
            chunk[:fi] *= np.linspace(0, 1, fi)[:, np.newaxis]
        if fade_out > 0:
            fo = min(int(fade_out * samplerate), total)
            chunk[-fo:] *= np.linspace(1, 0, fo)[:, np.newaxis]

        # Each playback gets its own state dict, captured by the callback closure.
        # active_cues[cue_id] points at the LATEST playback so external operations
        # (stop/set_volume/fadeout) target the most recent one. If a previous playback
        # for the same cue_id is still running we mark it stopped so its callback
        # exits cleanly; we cannot rely on the renderer's stop arriving in time.
        # Initial coefficient values — used to seed the per-frame interpolation so the
        # very first callback doesn't ramp from 0 to target (which would itself be a fade-in).
        _gain0  = 10 ** (volume_db / 20.0)
        _angle0 = (pan + 1) * 0.25 * np.pi
        _l0     = _gain0 * float(np.cos(_angle0))
        _r0     = _gain0 * float(np.sin(_angle0))

        my_info = {
            'data':              chunk,
            'pos':               0,
            'samplerate':        samplerate,
            'stopped':           False,
            'paused':             False,
            'duck_gain':         1.0,
            'volume_db':         volume_db,
            'pan':               pan,
            'loop':              loop,
            # Sample-accurate fade gain — ramped per-frame in the callback, no zipper noise
            'fade_gain':         1.0,
            'fade_gain_target':  1.0,
            'fade_gain_step':    0.0,   # per-sample increment; 0 = no ramp in progress
            'stop_when_faded':   False, # if true, stop_cue() once fade_gain reaches target
            # Coefficient values from the previous frame — the callback ramps from these
            # to the current target across the frame to absorb step changes from
            # set_volume / set_pan / duck_cue without zipper noise.
            'prev_l':            _l0,
            'prev_r':            _r0,
        }
        with active_lock:
            old = active_cues.get(cue_id)
            if old is not None:
                old['stopped'] = True   # signal previous playback's callback to exit
            active_cues[cue_id] = my_info

        def callback(outdata, frames, time_info, status):
            info = my_info   # closure-captured — never re-read from active_cues
            if info['stopped']:
                outdata[:] = 0
                raise sd.CallbackStop()
            if info['paused']:
                outdata[:] = 0
                return
            pos   = info['pos']
            buf   = info['data']
            avail = len(buf) - pos
            n     = min(frames, avail)

            # Build per-channel target coefficients from current volume/pan/duck.
            duck   = info['duck_gain']
            gain   = 10 ** (info['volume_db'] / 20.0)
            angle  = (info['pan'] + 1) * 0.25 * np.pi
            tgt_l  = gain * float(np.cos(angle)) * duck
            tgt_r  = gain * float(np.sin(angle)) * duck
            prev_l = info['prev_l']
            prev_r = info['prev_r']

            # Sample-accurate fade ramp — separate from prev→tgt because it spans many frames
            fg_step = info['fade_gain_step']
            fg      = info['fade_gain']
            if fg_step != 0.0:
                fg_end    = fg + fg_step * n
                fg_target = info['fade_gain_target']
                if (fg_step > 0 and fg_end >= fg_target) or (fg_step < 0 and fg_end <= fg_target):
                    fg_end = fg_target
                    info['fade_gain_step'] = 0.0
                fg_arr = np.linspace(fg, fg_end, n, endpoint=False, dtype=np.float32)
                info['fade_gain'] = fg_end
                fg_changed = True
            else:
                fg_arr = fg
                fg_end = fg
                fg_changed = False

            # If volume/pan/duck stepped between callbacks, ramp prev→tgt across the frame
            # to absorb the discontinuity. Otherwise apply a flat coefficient.
            coef_changed = (prev_l != tgt_l) or (prev_r != tgt_r)
            if coef_changed:
                coef_l = np.linspace(prev_l, tgt_l, n, endpoint=False, dtype=np.float32)
                coef_r = np.linspace(prev_r, tgt_r, n, endpoint=False, dtype=np.float32)
                if fg_changed:
                    coef_l = coef_l * fg_arr
                    coef_r = coef_r * fg_arr
                else:
                    coef_l = coef_l * fg_arr   # fg_arr is scalar here
                    coef_r = coef_r * fg_arr
                outdata[:n, 0] = buf[pos:pos + n, 0] * coef_l
                outdata[:n, 1] = buf[pos:pos + n, 1] * coef_r
            elif fg_changed:
                outdata[:n, 0] = buf[pos:pos + n, 0] * (tgt_l * fg_arr)
                outdata[:n, 1] = buf[pos:pos + n, 1] * (tgt_r * fg_arr)
            else:
                outdata[:n, 0] = buf[pos:pos + n, 0] * (tgt_l * fg_arr)
                outdata[:n, 1] = buf[pos:pos + n, 1] * (tgt_r * fg_arr)

            info['prev_l'] = tgt_l
            info['prev_r'] = tgt_r

            if info['stop_when_faded'] and fg_changed and fg_end == 0.0:
                info['stopped'] = True

            if n < frames:
                outdata[n:] = 0
            info['pos'] += n
            if info['pos'] >= len(buf):
                if info['loop']:
                    info['pos'] = 0   # seamless loop — restart from beginning
                else:
                    raise sd.CallbackStop()

        kwargs = dict(
            samplerate=samplerate,
            channels=2,
            dtype='float32',
            callback=callback
        )
        if device_id:
            kwargs['device'] = device_id

        try:
            with sd.OutputStream(**kwargs) as stream:
                # Wait until stream ends or this playback is stopped
                while stream.active:
                    if my_info['stopped']:
                        break
                    time.sleep(0.05)
        except Exception as e:
            send_log(f'Playback error for {cue_id}: {e}', 'error')
        finally:
            # Only clear the slot and emit cue_done if WE are still the active playback
            # (a fresh play_cue for the same id may have replaced us — don't clobber it)
            with active_lock:
                if active_cues.get(cue_id) is my_info:
                    active_cues.pop(cue_id, None)
                    superseded = False
                else:
                    superseded = True
            if not superseded:
                send({'type': 'cue_done', 'id': cue_id})

    t = threading.Thread(target=_worker, daemon=True)
    t.start()

def stop_cue(cue_id: str):
    with active_lock:
        info = active_cues.get(cue_id)
        if info:
            info['stopped'] = True

def stop_all():
    with active_lock:
        for info in active_cues.values():
            info['stopped'] = True

def pause_all():
    with active_lock:
        for info in active_cues.values():
            info['paused'] = True

def resume_all():
    with active_lock:
        for info in active_cues.values():
            info['paused'] = False

def set_volume(cue_id: str, db: float):
    """Live volume adjustment — updates stored dB; callback applies it next frame."""
    with active_lock:
        info = active_cues.get(cue_id)
        if info:
            info['volume_db'] = db

def set_pan(cue_id: str, pan: float):
    """Live pan adjustment (-1 = full left, 0 = center, 1 = full right)."""
    with active_lock:
        info = active_cues.get(cue_id)
        if info:
            info['pan'] = pan

def duck_cue(cue_id: str, target_gain: float, fade_secs: float):
    """Ramp the duck_gain of a playing cue toward target_gain over fade_secs."""
    def _ramp():
        steps    = max(int(fade_secs * 40), 1)
        interval = fade_secs / steps
        for i in range(steps + 1):
            with active_lock:
                info = active_cues.get(cue_id)
            if not info or info.get('stopped'):
                return
            frac = i / steps
            current = info.get('duck_gain', 1.0)
            new_gain = current + (target_gain - current) * frac
            with active_lock:
                info2 = active_cues.get(cue_id)
                if info2:
                    info2['duck_gain'] = new_gain
            time.sleep(interval)
    threading.Thread(target=_ramp, daemon=True).start()

def fadeout_cue(cue_id: str, duration: float):
    """Fade a playing cue to silence over `duration` seconds, then stop it.
    The ramp is applied per-frame in the playback callback for click-free fades."""
    with active_lock:
        info = active_cues.get(cue_id)
        if not info:
            return
        sr = info['samplerate']
        current_fg = info['fade_gain']
        info['fade_gain_target'] = 0.0
        info['fade_gain_step']   = -current_fg / max(1, duration * sr)
        info['stop_when_faded']  = True

# ── Waveform generation ────────────────────────────────────────────────────────

def generate_waveform(file_path: str, num_bars: int = 200) -> list:
    """Return a list of normalised amplitude values (0-1) for the waveform display."""
    try:
        with _sndfile_lock:
            data, _ = sf.read(file_path, dtype='float32', always_2d=True)
        mono     = np.abs(data).mean(axis=1)
        chunk_sz = max(1, len(mono) // num_bars)
        bars     = []
        for i in range(num_bars):
            sl   = mono[i * chunk_sz:(i + 1) * chunk_sz]
            bars.append(float(sl.max()) if len(sl) else 0.0)
        peak = max(bars) if bars else 1.0
        if peak > 0:
            bars = [b / peak for b in bars]
        return bars
    except Exception as e:
        send_log(f'Waveform error for {file_path}: {e}', 'error')
        return []

# ── Output device list ─────────────────────────────────────────────────────────

def get_output_devices() -> list:
    devices = []
    try:
        for i, d in enumerate(sd.query_devices()):
            if d['max_output_channels'] > 0:
                devices.append({'id': i, 'name': d['name']})
    except Exception:
        pass
    return devices

# ── OSC server ─────────────────────────────────────────────────────────────────
# Mirrors QLab v3/v4 OSC API so Bitfocus Companion QLab module works unchanged.
# Runs BOTH a UDP server and a TCP/SLIP server on the same port.
#
# Companion "QLab with feedback" module uses TCP (Use TCP? = ON).
# QLab v4 TCP framing is SLIP-encoded (RFC 1055).
#
# Companion handshake flow:
#   1. TCP connect
#   2. Sends /workspaces → reply with workspace list JSON
#   3. Sends /workspace/{id}/connect ["passcode"] → reply OK
#   4. Sends /workspace/{id}/cueLists → reply with cue list stub
#   5. Sends /workspace/{id}/go, /workspace/{id}/cue/{num}/start, etc.

WORKSPACE_ID   = 'flowcast'
WORKSPACE_NAME = 'FlowCast'

# Thread-local: set to the open TCP socket while inside a TCP request handler
_tcp_conn_local = threading.local()

# ── SLIP framing (RFC 1055) ────────────────────────────────────────────────────

_SLIP_END     = 0xC0
_SLIP_ESC     = 0xDB
_SLIP_ESC_END = 0xDC
_SLIP_ESC_ESC = 0xDD


def _slip_encode(data: bytes) -> bytes:
    out = bytearray([_SLIP_END])
    for b in data:
        if b == _SLIP_END:
            out += bytes([_SLIP_ESC, _SLIP_ESC_END])
        elif b == _SLIP_ESC:
            out += bytes([_SLIP_ESC, _SLIP_ESC_ESC])
        else:
            out.append(b)
    out.append(_SLIP_END)
    return bytes(out)


def _slip_decode(buf: bytes):
    """Return (list_of_decoded_packets, leftover_bytes)."""
    packets = []
    current = bytearray()
    i = 0
    while i < len(buf):
        b = buf[i]
        if b == _SLIP_END:
            if current:
                packets.append(bytes(current))
                current = bytearray()
        elif b == _SLIP_ESC:
            i += 1
            if i < len(buf):
                nb = buf[i]
                current.append(_SLIP_END if nb == _SLIP_ESC_END else
                                _SLIP_ESC if nb == _SLIP_ESC_ESC else nb)
        else:
            current.append(b)
        i += 1
    return packets, bytes(current)


# ── OSC reply helpers ─────────────────────────────────────────────────────────

def _build_reply_dgram(osc_address: str, data) -> bytes:
    """Build raw OSC bytes for a QLab-style reply."""
    payload = json.dumps({'status': 'ok', 'address': osc_address, 'data': data})
    b = osc_message_builder.OscMessageBuilder(f'/reply{osc_address}')
    b.add_arg(payload)
    return b.build().dgram




def _osc_reply(client_address: tuple, osc_address: str, data):
    """Send a QLab-format JSON reply.
    If we're inside a TCP handler, writes back on the same socket (SLIP-encoded).
    Otherwise sends a UDP packet back to the sender's source port.
    """
    dgram = _build_reply_dgram(osc_address, data)

    tcp_conn = getattr(_tcp_conn_local, 'conn', None)
    if tcp_conn is not None:
        try:
            tcp_conn.sendall(_slip_encode(dgram))
        except Exception as e:
            send_log(f'OSC TCP reply error: {e}', 'warn')
    else:
        ip, port = client_address
        # Construct a fresh UDP client per reply. The socket is local and gc'd
        # immediately after; previously we cached one per (ip, port) which leaked
        # sockets when a flaky Companion reconnected from new ephemeral ports.
        try:
            c = osc_udp_client.SimpleUDPClient(ip, port)
            c.send_message(f'/reply{osc_address}',
                           json.dumps({'status': 'ok', 'address': osc_address, 'data': data}))
        except Exception as e:
            send_log(f'OSC UDP reply error to {ip}:{port}: {e}', 'warn')


# ── Cue command parser ────────────────────────────────────────────────────────

def _fire_cue_cmd(addr: str):
    """Parse /cue/NUM/verb or /workspace/ID/cue/NUM/verb and fire the cue."""
    parts = addr.strip('/').split('/')
    try:
        cue_idx = parts.index('cue')
    except ValueError:
        return
    if len(parts) < cue_idx + 3:
        return
    cue_num = parts[cue_idx + 1]
    command = parts[cue_idx + 2]
    if command in ('start', 'go'):
        cmd = 'cue_start' if cue_num not in ('selected', 'active') else 'go'
    elif command == 'stop':
        # 'active' means stop all playing cues
        cmd = 'stop' if cue_num == 'active' else 'cue_stop'
    elif command == 'pause':
        # 'active' means pause all; per-cue pause treated the same
        send({'type': 'osc_command', 'command': 'pause'})
        return
    elif command == 'resume':
        send({'type': 'osc_command', 'command': 'resume'})
        return
    elif command == 'load':
        cmd = 'cue_select'
    else:
        send_log(f'OSC unknown cue verb: {command!r} (from {addr})', 'warn')
        return
    send({'type': 'osc_command', 'command': cmd, 'cueNumber': cue_num})


# ── TCP OSC handler (SLIP framing) ────────────────────────────────────────────

def _make_tcp_handler(dispatcher):
    """Return a socketserver.BaseRequestHandler class bound to the given dispatcher."""

    class OSCTCPHandler(socketserver.BaseRequestHandler):
        def handle(self):
            _tcp_conn_local.conn = self.request
            buf = b''
            self.request.settimeout(60)
            try:
                while True:
                    try:
                        chunk = self.request.recv(4096)
                    except Exception:
                        break
                    if not chunk:
                        break
                    buf += chunk
                    packets, buf = _slip_decode(buf)
                    for pkt in packets:
                        try:
                            dispatcher.call_handlers_for_packet(pkt, self.client_address)
                        except Exception as e:
                            send_log(f'OSC TCP dispatch error: {e}', 'warn')
            finally:
                _tcp_conn_local.conn = None

    return OSCTCPHandler


class _ThreadingTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads      = True

class _ThreadingUDPServer(socketserver.ThreadingMixIn, socketserver.UDPServer):
    allow_reuse_address = True
    daemon_threads      = True

_osc_servers: list = []  # active servers — shut these down before restarting


# ── Build shared dispatcher ───────────────────────────────────────────────────

def _make_dispatcher(passcode: str = ''):

    def _go(ca, addr, *a):
        send({'type': 'osc_command', 'command': 'go'})

    def _stop(ca, addr, *a):
        send({'type': 'osc_command', 'command': 'stop'})

    def _panic(ca, addr, *a):
        send({'type': 'osc_command', 'command': 'stop'})

    def _pause(ca, addr, *a):
        send({'type': 'osc_command', 'command': 'pause'})

    def _resume(ca, addr, *a):
        send({'type': 'osc_command', 'command': 'resume'})

    def _cue_handler(ca, addr, *a):
        _fire_cue_cmd(addr)

    def _workspaces(ca, addr, *a):
        send_log(f'OSC /workspaces from {ca[0]}:{ca[1]}')
        _osc_reply(ca, '/workspaces', [
            {'uniqueID': WORKSPACE_ID, 'displayName': WORKSPACE_NAME,
             'hasPasscode': bool(passcode)}
        ])

    def _default(ca, addr, *a):
        parts = addr.strip('/').split('/')
        if len(parts) >= 2 and parts[0] == 'workspace':
            wid = parts[1]
            sub = parts[2] if len(parts) > 2 else ''
            if sub == 'connect':
                # args[0] is the passcode string if provided
                provided = str(a[0]) if a else ''
                if passcode and provided != passcode:
                    send_log(f'OSC connect rejected — wrong passcode from {ca[0]}', 'warn')
                    _osc_reply(ca, addr, 'badpass')
                else:
                    send_log(f'OSC Companion connected (workspace={wid}) from {ca[0]}')
                    _osc_reply(ca, addr, 'ok')
            elif sub == 'cueLists':
                # Reply with a single stub cue list — keeps Companion's dropdown populated
                _osc_reply(ca, addr, [
                    {'uniqueID': 'main', 'displayName': 'Main', 'type': 'cuelist',
                     'number': '1', 'isRunning': False}
                ])
            elif sub == 'go':
                send({'type': 'osc_command', 'command': 'go'})
            elif sub in ('stop', 'panic'):
                send({'type': 'osc_command', 'command': 'stop'})
            elif sub == 'pause':
                send({'type': 'osc_command', 'command': 'pause'})
            elif sub == 'resume':
                send({'type': 'osc_command', 'command': 'resume'})
            elif sub == 'cue':
                _fire_cue_cmd(addr)
            elif sub == 'select':
                sel_cmd = parts[3] if len(parts) > 3 else ''
                if sel_cmd == 'nextCue':
                    send({'type': 'osc_command', 'command': 'next_cue'})
                elif sel_cmd in ('previousCue', 'prevCue'):
                    send({'type': 'osc_command', 'command': 'prev_cue'})
                else:
                    send_log(f'OSC unhandled select cmd: {addr!r}', 'warn')
            elif sub == 'playhead':
                # Companion uses /workspace/{id}/playhead/next|previous
                ph_cmd = parts[3] if len(parts) > 3 else ''
                if ph_cmd == 'next':
                    send({'type': 'osc_command', 'command': 'next_cue'})
                elif ph_cmd == 'previous':
                    send({'type': 'osc_command', 'command': 'prev_cue'})
                else:
                    send_log(f'OSC unhandled playhead cmd: {addr!r}', 'warn')
            elif sub == 'showMode':
                pass  # silently ignore — show/edit mode toggle not applicable
            else:
                send_log(f'OSC unhandled workspace cmd: {addr!r} args={a}', 'warn')
        else:
            send_log(f'OSC unrecognized: {addr!r} args={a}', 'warn')

    disp = osc_dispatcher.Dispatcher()
    def _next_cue(ca, addr, *a):
        send({'type': 'osc_command', 'command': 'next_cue'})

    def _prev_cue(ca, addr, *a):
        send({'type': 'osc_command', 'command': 'prev_cue'})

    def _version(ca, addr, *a):
        # Reply with a QLab-compatible version string so Companion is satisfied
        _osc_reply(ca, '/version', '5.0')

    def _connect(ca, addr, *a):
        send_log(f'OSC /connect from {ca[0]}')
        _osc_reply(ca, '/connect', 'ok')

    disp.map('/go',                   _go,          needs_reply_address=True)
    disp.map('/stop',                 _stop,        needs_reply_address=True)
    disp.map('/panic',                _panic,       needs_reply_address=True)
    disp.map('/pause',                _pause,       needs_reply_address=True)
    disp.map('/resume',               _resume,      needs_reply_address=True)
    disp.map('/cue/*',                _cue_handler, needs_reply_address=True)
    disp.map('/workspaces',           _workspaces,  needs_reply_address=True)
    disp.map('/version',              _version,     needs_reply_address=True)
    disp.map('/connect',              _connect,     needs_reply_address=True)
    disp.map('/select/nextCue',       _next_cue,    needs_reply_address=True)
    disp.map('/select/previousCue',   _prev_cue,    needs_reply_address=True)
    disp.set_default_handler(_default,              needs_reply_address=True)
    return disp


# ── Start both servers ────────────────────────────────────────────────────────

def start_osc_server(port: int, passcode: str = ''):
    global _osc_servers

    # Shut down any running servers before binding the new ones
    old = _osc_servers[:]
    _osc_servers = []
    for srv in old:
        try:
            srv.shutdown()
            srv.server_close()
        except Exception:
            pass

    disp = _make_dispatcher(passcode)
    errors = []
    new_servers = []

    # UDP server
    try:
        udp_srv = _ThreadingUDPServer(('0.0.0.0', port), disp)
        threading.Thread(target=udp_srv.serve_forever, daemon=True).start()
        send_log(f'OSC UDP listening on 0.0.0.0:{port}')
        new_servers.append(udp_srv)
    except Exception as e:
        errors.append(f'UDP: {e}')

    # TCP server (for Companion "QLab with feedback" module)
    try:
        tcp_handler = _make_tcp_handler(disp)
        tcp_srv = _ThreadingTCPServer(('0.0.0.0', port), tcp_handler)
        threading.Thread(target=tcp_srv.serve_forever, daemon=True).start()
        send_log(f'OSC TCP listening on 0.0.0.0:{port}')
        new_servers.append(tcp_srv)
    except Exception as e:
        errors.append(f'TCP: {e}')

    _osc_servers = new_servers

    if errors:
        send({'type': 'osc_error', 'error': '; '.join(errors)})
    else:
        send({'type': 'osc_started', 'port': port})

# ── Main IPC loop ──────────────────────────────────────────────────────────────

def handle_message(msg: dict):
    t = msg.get('type')

    if t == 'start_osc':
        start_osc_server(msg.get('port', 53000), msg.get('passcode', ''))

    elif t == 'load_file':
        cue_id    = msg['id']
        file_path = msg['filePath']
        def _load():
            try:
                with _sndfile_lock:
                    info = sf.info(file_path)
                duration = info.duration
                # Scale bar count with duration so long clips stay detailed
                num_bars = min(max(int(duration * 20), 200), 2000)
                waveform = generate_waveform(file_path, num_bars)
                send({'type': 'file_loaded', 'id': cue_id,
                      'duration': duration, 'waveformData': waveform})
            except Exception as e:
                send_log(f'load_file failed: {e}', 'error')
                send({'type': 'load_file_failed', 'id': cue_id, 'error': str(e)})
        threading.Thread(target=_load, daemon=True).start()

    elif t == 'play':
        raw_dev   = msg.get('device')
        device_id = int(raw_dev) if raw_dev not in (None, '', 0) else None
        play_cue(
            cue_id    = msg['id'],
            file_path = msg['filePath'],
            in_point  = msg.get('inPoint', 0),
            out_point = msg.get('outPoint'),
            volume_db = msg.get('volume', 0),
            pan       = msg.get('pan', 0),
            fade_in   = msg.get('fadeIn', 0),
            fade_out  = msg.get('fadeOut', 0),
            loop      = bool(msg.get('loop', False)),
            device_id = device_id,
        )

    elif t == 'stop':
        stop_cue(msg['id'])

    elif t == 'panic' or t == 'stop_all':
        stop_all()

    elif t == 'pause_all':
        pause_all()

    elif t == 'resume_all':
        resume_all()

    elif t == 'set_volume':
        set_volume(msg['id'], msg.get('value', 0))

    elif t == 'set_pan':
        set_pan(msg['id'], msg.get('value', 0))

    elif t == 'fadeout':
        fadeout_cue(msg['id'], msg.get('duration', 2.0))

    elif t == 'duck_start':
        db          = msg.get('amount', -12)
        target_gain = 10 ** (db / 20.0)
        duck_cue(msg['id'], target_gain, msg.get('fadeIn', 0.5))

    elif t == 'duck_end':
        duck_cue(msg['id'], 1.0, msg.get('fadeOut', 1.0))

    elif t == 'set_output_device':
        # Applied on next playback
        pass

    elif t == 'rescan_devices':
        # Reinitialise PortAudio so newly connected devices show up. Refuse while
        # any stream is active — sd._terminate() frees C state that live OutputStreams
        # still reference, which can SIGSEGV the backend.
        with active_lock:
            busy = bool(active_cues)
        if busy:
            send({'type': 'devices_updated',
                  'outputDevices': get_output_devices(),
                  'warning': 'Stop playback before rescanning audio devices.'})
        else:
            try:
                sd._terminate()
                sd._initialize()
            except Exception as e:
                send_log(f'rescan_devices failed: {e}', 'error')
            send({'type': 'devices_updated', 'outputDevices': get_output_devices()})

    elif t == 'test_tone':
        # Play a 1-second sine on the currently selected output device. Used by the
        # Settings "Play test tone" button to verify routing before a show.
        raw_dev   = msg.get('device')
        device_id = int(raw_dev) if raw_dev not in (None, '', 0) else None
        def _tone():
            try:
                sr  = 48000
                dur = 1.0
                freq = 440.0
                t = np.linspace(0, dur, int(sr * dur), endpoint=False, dtype=np.float32)
                wave = (0.25 * np.sin(2 * np.pi * freq * t)).astype(np.float32)
                # 20ms fade-in/out so it doesn't click
                fade = int(0.02 * sr)
                wave[:fade]   *= np.linspace(0, 1, fade, dtype=np.float32)
                wave[-fade:]  *= np.linspace(1, 0, fade, dtype=np.float32)
                stereo = np.stack([wave, wave], axis=1)
                kwargs = dict(samplerate=sr, channels=2, dtype='float32')
                if device_id:
                    kwargs['device'] = device_id
                sd.play(stereo, **kwargs)
                sd.wait()
            except Exception as e:
                send_log(f'test_tone failed: {e}', 'error')
        threading.Thread(target=_tone, daemon=True).start()


def main():
    # Watchdog: exit if Electron parent process dies (gets reparented to PID 1)
    import os as _os
    _parent_pid = _os.getppid()
    def _parent_watchdog():
        while True:
            time.sleep(2)
            if _os.getppid() != _parent_pid:
                _os._exit(0)   # reparented — original parent is gone
    threading.Thread(target=_parent_watchdog, daemon=True).start()

    send({
        'type':          'ready',
        'outputDevices': get_output_devices()
    })

    # Start OSC immediately on default port — renderer can restart on a different port later
    start_osc_server(53000)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
            handle_message(msg)
        except json.JSONDecodeError as e:
            send_log(f'Bad JSON from renderer: {e}', 'error')
        except Exception as e:
            send_log(f'Unhandled error: {e}', 'error')


if __name__ == '__main__':
    main()
