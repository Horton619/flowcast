"""
FlowCast backend — Python audio engine + OSC server
Communicates with Electron renderer via stdin/stdout newline-delimited JSON.
"""

import sys
import json
import threading
import time

import numpy as np
import sounddevice as sd
import soundfile as sf
from pythonosc import dispatcher as osc_dispatcher
from pythonosc import osc_server

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

def play_cue(cue_id: str, file_path: str, in_point: float, out_point,
             volume_db: float, pan: float, fade_in: float, fade_out: float,
             device_id=None):
    """Load and play an audio file in a background thread."""
    def _worker():
        try:
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

        # Volume
        gain = 10 ** (volume_db / 20.0)

        # Pan (constant-power)
        angle  = (pan + 1) * 0.25 * np.pi   # -1..1 → 0..π/2
        left   = np.cos(angle)
        right  = np.sin(angle)
        chunk[:, 0] *= gain * left
        chunk[:, 1] *= gain * right

        # Fade in/out
        total = len(chunk)
        if fade_in > 0:
            fi = min(int(fade_in * samplerate), total)
            chunk[:fi] *= np.linspace(0, 1, fi)[:, np.newaxis]
        if fade_out > 0:
            fo = min(int(fade_out * samplerate), total)
            chunk[-fo:] *= np.linspace(1, 0, fo)[:, np.newaxis]

        # Register active cue
        with active_lock:
            active_cues[cue_id] = {
                'data':       chunk,
                'pos':        0,
                'samplerate': samplerate,
                'stopped':    False,
                'paused':     False,
            }

        def callback(outdata, frames, time_info, status):
            with active_lock:
                info = active_cues.get(cue_id)
            if info is None or info['stopped']:
                outdata[:] = 0
                raise sd.CallbackStop()
            if info['paused']:
                outdata[:] = 0
                return
            pos   = info['pos']
            buf   = info['data']
            avail = len(buf) - pos
            n     = min(frames, avail)
            outdata[:n] = buf[pos:pos + n]
            if n < frames:
                outdata[n:] = 0
            info['pos'] += n
            if info['pos'] >= len(buf):
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
                # Wait until stream ends or cue is stopped
                while stream.active:
                    with active_lock:
                        info = active_cues.get(cue_id)
                    if info is None or info.get('stopped'):
                        break
                    time.sleep(0.05)
        except Exception as e:
            send_log(f'Playback error for {cue_id}: {e}', 'error')
        finally:
            with active_lock:
                active_cues.pop(cue_id, None)
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
    """Live volume adjustment — applies gain to remaining buffer (approximate)."""
    # For v1 this is a no-op during playback; full implementation in later phase
    pass

# ── Waveform generation ────────────────────────────────────────────────────────

def generate_waveform(file_path: str, num_bars: int = 200) -> list:
    """Return a list of normalised amplitude values (0-1) for the waveform display."""
    try:
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
# Mirrors QLab OSC API so Bitfocus Companion QLab module works unchanged.

_osc_thread = None

def start_osc_server(port: int):
    global _osc_thread

    def _go(addr, *args):
        send({'type': 'osc_command', 'command': 'go'})

    def _stop(addr, *args):
        send({'type': 'osc_command', 'command': 'stop'})

    def _pause(addr, *args):
        send({'type': 'osc_command', 'command': 'pause'})

    def _resume(addr, *args):
        send({'type': 'osc_command', 'command': 'resume'})

    def _cue_handler(addr, *args):
        # addr format: /cue/NUMBER/command  or  /cue/selected/command
        parts = addr.strip('/').split('/')   # ['cue', NUMBER, 'start']
        if len(parts) < 3:
            return
        cue_num = parts[1]   # could be 'selected'
        command = parts[2]
        if command in ('start', 'go'):
            cmd = 'cue_start' if cue_num != 'selected' else 'go'
        elif command == 'stop':
            cmd = 'cue_stop'
        elif command == 'load':
            cmd = 'cue_select'
        else:
            return
        send({'type': 'osc_command', 'command': cmd, 'cueNumber': cue_num})

    disp = osc_dispatcher.Dispatcher()
    disp.map('/go',        _go)
    disp.map('/stop',      _stop)
    disp.map('/pause',     _pause)
    disp.map('/resume',    _resume)
    disp.map('/cue/*',     _cue_handler)

    try:
        server = osc_server.ThreadingOSCUDPServer(('0.0.0.0', port), disp)
        send({'type': 'osc_started', 'port': port})
        _osc_thread = threading.Thread(target=server.serve_forever, daemon=True)
        _osc_thread.start()
    except Exception as e:
        send({'type': 'osc_error', 'error': str(e)})

# ── Main IPC loop ──────────────────────────────────────────────────────────────

def handle_message(msg: dict):
    t = msg.get('type')

    if t == 'start_osc':
        start_osc_server(msg.get('port', 53000))

    elif t == 'load_file':
        cue_id    = msg['id']
        file_path = msg['filePath']
        def _load():
            try:
                info     = sf.info(file_path)
                duration = info.duration
                waveform = generate_waveform(file_path)
                send({'type': 'file_loaded', 'id': cue_id,
                      'duration': duration, 'waveformData': waveform})
            except Exception as e:
                send_log(f'load_file failed: {e}', 'error')
        threading.Thread(target=_load, daemon=True).start()

    elif t == 'play':
        play_cue(
            cue_id    = msg['id'],
            file_path = msg['filePath'],
            in_point  = msg.get('inPoint', 0),
            out_point = msg.get('outPoint'),
            volume_db = msg.get('volume', 0),
            pan       = msg.get('pan', 0),
            fade_in   = msg.get('fadeIn', 0),
            fade_out  = msg.get('fadeOut', 0),
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

    elif t == 'set_output_device':
        # Applied on next playback
        pass


def main():
    send({
        'type':          'ready',
        'outputDevices': get_output_devices()
    })

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
