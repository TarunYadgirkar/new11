; Registers Tarun Search with Windows as a web browser so it appears in
; Settings > Apps > Default apps. Nothing is changed until the user picks it.
!macro customInstall
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\TarunSearch" "" "Tarun Search"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\TarunSearch\Capabilities" "ApplicationName" "Tarun Search"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\TarunSearch\Capabilities" "ApplicationIcon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\TarunSearch\Capabilities" "ApplicationDescription" "A calm, fast, private browser."
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\TarunSearch\Capabilities\URLAssociations" "http" "TarunSearchURL"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\TarunSearch\Capabilities\URLAssociations" "https" "TarunSearchURL"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\TarunSearch\Capabilities\StartMenu" "StartMenuInternet" "TarunSearch"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\TarunSearch\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\TarunSearch\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
  WriteRegStr HKCU "Software\Classes\TarunSearchURL" "" "Tarun Search URL"
  WriteRegStr HKCU "Software\Classes\TarunSearchURL" "FriendlyTypeName" "Tarun Search URL"
  WriteRegStr HKCU "Software\Classes\TarunSearchURL\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  ; "--" stops Chromium from treating anything in the link as a command-line switch.
  WriteRegStr HKCU "Software\Classes\TarunSearchURL\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" -- "%1"'
  WriteRegStr HKCU "Software\RegisteredApplications" "TarunSearch" "Software\Clients\StartMenuInternet\TarunSearch\Capabilities"
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Clients\StartMenuInternet\TarunSearch"
  DeleteRegKey HKCU "Software\Classes\TarunSearchURL"
  DeleteRegValue HKCU "Software\RegisteredApplications" "TarunSearch"
!macroend
