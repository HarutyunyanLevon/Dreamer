; No desktop shortcut: Dreamer lives in the Start menu (and the taskbar pin, if the user adds one).
; The finish page's "Create desktop shortcut" box starts unchecked...
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED

!macro NSIS_HOOK_POSTINSTALL
  ; ...and silent/passive installs (which skip the finish page) don't get one either.
  ${If} ${Silent}
    Delete "$DESKTOP\${PRODUCTNAME}.lnk"
  ${EndIf}
  ; Older versions started with Windows; that entry is gone for good.
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Dreamer"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; The leftover "start with Windows" entry of older versions.
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Dreamer"
!macroend
