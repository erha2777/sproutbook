; ===========================================================================
;  Sproutbook - custom NSIS installer script
; ===========================================================================
;
;  1) Fixes a false "app is running" detection
;  ---------------------------------------------------------------------------
;  electron-builder's default check decides whether the app is running like
;  this (templates/nsis/include/allowOnlyOneInstallerInstance.nsh):
;
;      Get-CimInstance Win32_Process |
;        ? { $_.Path.StartsWith('$INSTDIR') }
;
;  i.e. ANY process whose executable lives under the install directory counts
;  as "the app is running". Worse, the matching kill loop does not exclude its
;  own PID. So if the chosen install directory happens to contain the installer
;  itself (for example when installing into the project folder or into the
;  portable build folder), the installer detects ITSELF, tries to kill itself,
;  fails, retries, and finally shows "Sproutbook cannot be closed" forever.
;
;  We override the hook with an exact executable-name match, which is what the
;  check actually means.
;
;  2) Adds a shortcut with --no-sandbox
;  ---------------------------------------------------------------------------
;  On some Windows setups Chromium's process sandbox cannot initialize; the app
;  then crashes before any JavaScript runs and cannot recover by itself. This
;  shortcut bakes the switch into its arguments so users always have one entry
;  point that works. Delete the icon if you do not need it.
;
;  Keep this file ASCII-only and CRLF: NSIS is sensitive to both.
; ===========================================================================

!macro customCheckAppRunning
  ; Is a process literally named Sproutbook.exe running?
  ; findstr /B anchors the match to the start of the CSV line, so
  ; "Sproutbook-<版本>-win-x64.exe" can never be mistaken for it.
  nsExec::ExecToStack '"$SYSDIR\cmd.exe" /C tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""'
  Pop $0 ; exit code: 0 = found
  Pop $1

  ${If} $0 == 0
    ; Try to close it. Unlike the default implementation this cannot match
    ; the installer itself, so there is no self-kill loop.
    nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /IM "${APP_EXECUTABLE_FILENAME}" /F /T'
    Pop $0
    Sleep 1200

    ; Still there? Most likely it runs elevated and we cannot kill it.
    nsExec::ExecToStack '"$SYSDIR\cmd.exe" /C tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""'
    Pop $0
    Pop $1

    ${If} $0 == 0
      ; Tell the user once and stop, instead of looping forever.
      MessageBox MB_OK|MB_ICONSTOP "$(appCannotBeClosed)"
      Quit
    ${EndIf}
  ${EndIf}
!macroend

!macro customInstall
  CreateShortCut "$DESKTOP\${PRODUCT_NAME} (compat).lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--no-sandbox" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
!macroend

!macro customUnInstall
  Delete "$DESKTOP\${PRODUCT_NAME} (compat).lnk"
!macroend
