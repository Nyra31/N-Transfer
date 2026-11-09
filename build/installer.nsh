; Pasos extra del instalador de N-Transfer (electron-builder incluye este archivo automáticamente).

!macro customInstall
  ; «Enviar a → N-Transfer» en el menú contextual del Explorador.
  ; Windows añade las rutas de los archivos elegidos detrás de --send.
  CreateShortCut "$SENDTO\N-Transfer.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--send" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0

  ; Permiso del firewall: solo en la primera instalación y si la regla no existe, para no pedir
  ; permisos de administrador en cada actualización. Si el usuario lo rechaza, el asistente
  ; «No conecta» de la app permite añadirla después.
  ${IfNot} ${isUpdated}
    nsExec::ExecToStack 'netsh advfirewall firewall show rule name="N-Transfer"'
    Pop $0
    Pop $1
    ${If} $0 != 0
      ExecShellWait "runas" "netsh.exe" 'advfirewall firewall add rule name="N-Transfer" dir=in action=allow program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" enable=yes profile=any' SW_HIDE
    ${EndIf}
  ${EndIf}
!macroend

!macro customUnInstall
  Delete "$SENDTO\N-Transfer.lnk"
!macroend
