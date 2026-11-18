; No desktop shortcut: Dreamer lives in the Start menu (and the taskbar pin, if the user adds one).
; The finish page's "Create desktop shortcut" box starts unchecked...
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED

!macro NSIS_HOOK_POSTINSTALL
  ; ...and silent/passive installs (which skip the finish page) don't get one either.
  ${If} ${Silent}
    Delete "$DESKTOP\${PRODUCTNAME}.lnk"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Dreamer's "start with Windows" entry (tauri-plugin-autostart does not remove it).
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Dreamer"
!macroend
