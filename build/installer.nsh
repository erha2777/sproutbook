; ===========================================================================
;  Sproutbook - custom NSIS installer script
; ===========================================================================
;
;  Why an extra shortcut is created:
;
;  On some Windows setups (low-integrity processes, restricted job objects,
;  certain security software) Chromium's process sandbox cannot initialize.
;  Electron then crashes during native startup (exception 0x80000003) before
;  any application code runs, so double-clicking the normal shortcut appears
;  to do nothing.
;
;  That crash happens before the app's JavaScript, so the app cannot recover
;  by itself - --no-sandbox must be present on the command line. This script
;  therefore adds a second shortcut with the switch baked into its arguments,
;  so users always have one entry point that works.
;
;  Users who do not need it can simply delete the icon; it changes nothing
;  about the normal shortcut or the app itself.
;
;  Keep this file ASCII-only and CRLF: NSIS is sensitive to script encoding
;  and line endings. See .gitattributes.
; ===========================================================================

!macro customInstall
  CreateShortCut "$DESKTOP\${PRODUCT_NAME} (compat).lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--no-sandbox" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
!macroend

!macro customUnInstall
  Delete "$DESKTOP\${PRODUCT_NAME} (compat).lnk"
!macroend
