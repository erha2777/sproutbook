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
rem    This launcher just adds --no-sandbox so the app can start.
rem
rem    (Comments here are intentionally ASCII-only: cmd.exe parses .cmd files
rem     using the OEM code page, and non-ASCII bytes can corrupt the parsing.)
rem
rem  Security note:
rem    Disabling the renderer sandbox lowers process isolation. This app only
rem    loads local files, its CSP forbids all remote resources, contextIsolation
rem    is enabled and nodeIntegration is disabled, so the practical risk is
rem    limited. If you would rather not disable it, look for the real cause
rem    first - see the troubleshooting section in README.md.
rem ===========================================================================

if not exist "%~dp0Sproutbook.exe" (
  echo [ERROR] Sproutbook.exe was not found next to this launcher.
  echo         Keep this .cmd file in the same folder as Sproutbook.exe.
  pause
  exit /b 1
)

start "" "%~dp0Sproutbook.exe" --no-sandbox %*
