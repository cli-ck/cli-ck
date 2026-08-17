; "Open in cli-ck" shell verbs for folders, folder backgrounds, and drives.
; HKCU matches installer currentUser scope. %V = clicked path.
; NoWorkingDirectory keeps Explorer from overriding %V (System32 on Drive).

!macro NSIS_HOOK_POSTINSTALL
  DeleteRegKey HKCU "Software\Classes\Directory\shell\OpenInOz"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\OpenInOz"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\OpenInOz"

  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInCliCk" "" "Open in cli-ck"
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInCliCk" "Icon" '"$INSTDIR\cli-ck.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInCliCk" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInCliCk\command" "" '"$INSTDIR\cli-ck.exe" "%V"'

  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInCliCk" "" "Open in cli-ck"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInCliCk" "Icon" '"$INSTDIR\cli-ck.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInCliCk" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInCliCk\command" "" '"$INSTDIR\cli-ck.exe" "%V"'

  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInCliCk" "" "Open in cli-ck"
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInCliCk" "Icon" '"$INSTDIR\cli-ck.exe",0'
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInCliCk" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInCliCk\command" "" '"$INSTDIR\cli-ck.exe" "%V"'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\Directory\shell\OpenInOz"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\OpenInOz"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\OpenInOz"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\OpenInCliCk"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\OpenInCliCk"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\OpenInCliCk"
!macroend
