@echo off
rem ===========================================================================
rem  Sproutbook - compatibility launcher
rem ===========================================================================
rem  Why this file exists:
rem    On some Windows setups Chromium's process sandbox fails to initialize.
rem    Electron then crashes during native startup (exception 0x80000003)
rem    BEFORE any JavaScript runs. The app therefore cannot recover by itself,
rem    and double-clicking Sproutbook.exe looks like "nothing happens".
rem
rem  Switches passed:
rem    --no-sandbox    see above.
rem
rem    --disable-gpu   Forces software rendering. On machines where the GPU /
rem                    DirectX stack misbehaves for a normal (non-elevated)
rem                    process, the GPU process fails, the renderer never
rem                    paints its first frame, and the window stays invisible
rem                    even though the app is running fine. Software
rem                    rendering sidesteps that entirely. This is simple
rem                    pixel-art UI, so the performance cost is negligible.
rem
rem  Two hard rules for this file (both were violated once and broke it):
rem    1. ASCII ONLY. cmd.exe parses .cmd files using the OEM code page, and
rem       non-ASCII bytes can decode into characters that wreck the parsing.
rem    2. CRLF line endings. cmd.exe is unreliable with LF-only .cmd files,
rem       especially inside if (...) blocks. See .gitattributes.
rem
rem  Security note:
rem    Disabling the renderer sandbox lowers process isolation. This app only
rem    loads local files, its CSP forbids all remote resources, contextIsolation
rem    is enabled and nodeIntegration is disabled, so the practical risk is
rem    limited. If you would rather not disable it, look for the real cause
rem    first - see the troubleshooting section in README.md.
rem
rem  Tip:
rem    Run this launcher once, then use
rem    Settings -> "Startup compatibility" -> "Create desktop shortcut".
rem    That makes a normal Windows shortcut with --no-sandbox baked in, so
rem    afterwards you can just double-click a desktop icon. No launcher needed.
rem ===========================================================================

if not exist "%~dp0Sproutbook.exe" (
  echo [ERROR] Sproutbook.exe was not found next to this launcher.
  echo         Keep this .cmd file in the same folder as Sproutbook.exe.
  pause
  exit /b 1
)

start "" "%~dp0Sproutbook.exe" --no-sandbox --disable-gpu %*
