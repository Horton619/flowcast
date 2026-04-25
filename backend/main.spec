# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the FlowCast audio engine.
# Produces a single-file binary `flowcast_backend` (or .exe on Windows) which
# electron-builder packages as an extraResource alongside the Electron app.

a = Analysis(
    ['main.py'],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=[
        # python-osc submodules sometimes get missed by static analysis
        'pythonosc.dispatcher',
        'pythonosc.osc_server',
        'pythonosc.osc_message_builder',
        'pythonosc.udp_client',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='flowcast_backend',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
