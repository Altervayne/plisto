; Installer hooks for the Windows NSIS bundle.

; Deletes the decode helper's AppContainer profile and its per-user storage while plisto.exe is still
; installed. Its exit code is ignored, so a failure never stops the uninstall.
!macro NSIS_HOOK_PREUNINSTALL
  ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --plisto-remove-container'
!macroend
