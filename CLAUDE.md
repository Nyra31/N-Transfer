# N-Transfer

App de escritorio (Electron) para pasar fotos, vídeos, archivos y texto entre el móvil y el PC por Wi‑Fi, con skins al estilo de los reproductores de los 2000. El móvil usa una web app que sirve el propio PC (sin app nativa todavía).

- Repo público: https://github.com/Nyra31/N-Transfer (MIT). Usuario de GitHub: **Nyra31** (`gh` ya autenticado).
- Versión publicada: **0.3.0** (GitHub Releases, auto-update con electron-updater).
- Idioma del proyecto: **español** (código comentado en español, UI en español e inglés). Habla con el usuario en español.
- La carpeta local sigue llamándose `ios-transfer`; el usuario quería renombrarla a `n-transfer` (VS Code la bloqueaba). Si se renombra, no cambia nada del código.

## Comandos

```bash
npm start            # app en desarrollo (usa scripts/electron.js, ver «Trampas»)
npm test             # 22 pruebas del núcleo (servidor) sin Electron
npm run shots        # 25 pruebas de punta a punta con la app real + capturas en ./shots (revisar las PNG)
npm run icons        # regenerar iconos desde el SVG de scripts/make-icons.js
npm run dist         # instalador Windows en ./dist (NSIS)
```

- Para probar también la conversión HEIC: `HEIC_SAMPLE=<ruta a una .heic>` en `npm test` y `npm run shots`. Hay una muestra pública (fixture de heic-convert): `https://drive.google.com/uc?export=download&id=1J_761fe_HWSijAthq7h_D2Zsf1_es1cT`. No se versiona.
- Después de cambios grandes: `npm test` + `npm run shots` y **mirar las capturas** (`shots/*.png`), que es donde han salido los fallos visuales.

## Publicar una versión

1. Escribir `release-notes/vX.Y.Z.md` (lo usa el workflow como cuerpo de la release).
2. Subir `version` en package.json (o `npm version`), commit y push.
3. `git tag -a vX.Y.Z -m "N-Transfer X.Y.Z"` y `git push origin vX.Y.Z` → `.github/workflows/release.yml` crea la release y luego compila y sube los archivos.
4. Comprobar: una sola release con `latest.yml`, `.exe` y `.blockmap`; `releases/latest/download/latest.yml` debe anunciar la versión nueva.

Publicar es visible para todos (y actualiza las copias instaladas): **pedir confirmación al usuario antes de etiquetar**.

## Arquitectura

```
src/core/      Sin Electron (multiplataforma). server.js = HTTP + API v1, store.js, net.js (IPs/.local),
               mdns.js (anuncio y descubrimiento _ntransfer._tcp), heic.js + heic-worker.js (HEIC→JPG en hilo),
               folders.js (ZIP en streaming con yazl), kinds.js (foto/vídeo/otro)
src/main/      Electron: main.js (ventana, bandeja, IPC, menús, actualizaciones, «Enviar a»), preload.js (lista
               blanca de canales IPC), viewer.js (visor), custom-skins.js, thumbs.js, diagnostics.js (asistente
               «¿No conecta?»), autostart.js, devshots.js (solo pruebas, excluido del instalador)
src/renderer/  Interfaz del PC (index.html/app.js/styles.css) y visor (viewer.*)
src/mobile/    Web app del móvil que sirve el PC (index.html, app.js, mobile.css, icons)
src/shared/    Común a PC y móvil: i18n.js (es/en), viz.js (visualizador), sounds.js, skins/*.css
build/         icon.png/svg, installer.nsh (acceso «Enviar a» + regla de firewall en la 1.ª instalación)
scripts/       electron.js (lanzador), shots.js, test-core.js, make-icons.js
```

- **API v1** documentada en README.md. Es estable porque la usarán las apps nativas futuras: añadir, no romper.
- Subidas reanudables por sesiones (`POST /uploads` → `PUT /uploads/:id?offset=N`); el `.ntpart` en disco manda.
- Emparejamiento: código de 8 caracteres (QR o tecleado), token por dispositivo (solo se guarda el hash).
- Skins: variables CSS bajo `.skin-<id>`; las personalizadas son `.css` en `userData/skins` (las del editor llevan `/* @editor {json} */`).
- Configuración y estado en `userData/config.json` (Store). Miniaturas en `userData/thumbs`.

## Decisiones ya tomadas (no reabrir sin que lo pida el usuario)

- Electron (no Tauri/.NET). Web app en el móvil; app nativa iOS/Android más adelante (necesita Mac + cuenta Apple Developer para iOS).
- Futuro: soporte **Android** (la web app ya lo detecta, sin probar) y escritorio **macOS/Linux** (configurado en electron-builder; para publicarlo, añadir `macos-latest`/`ubuntu-latest` a la matriz del workflow). No usar APIs ni comandos solo de Windows en `src/core`.
- Instalador NSIS por usuario, sin firmar. Regla de firewall con `profile=any` (muchas Wi‑Fi de casa están como «Pública» en Windows, incluida la del usuario); el servidor exige token.
- HEIC→JPG opcional (por defecto se guarda el original). La copia JPG pierde EXIF.
- Descartado por el usuario de momento: subcarpetas por fecha, por dispositivo, saltar duplicados, renombrar al recibir, borrar de «Para el móvil» al bajar, confirmar dispositivos nuevos, ZIP de todo, estadísticas ya hechas.

## Trampas conocidas (ya resueltas; no volver a caer)

- **ELECTRON_RUN_AS_NODE**: el entorno de Claude/VS Code la define y Electron arranca como Node (`app` undefined). Lanzar siempre con `node scripts/electron.js …` o quitar la variable.
- **PowerShell 5**: `Get-Content`/`Set-Content` estropean UTF‑8 (tildes) y `-Encoding utf8` añade BOM (npm falla al leer package.json). Editar con las herramientas de edición o con Node. Para descargar binarios usar Bash (`>` en PowerShell los corrompe).
- **Safari (iOS)**: la app de pantalla de inicio no comparte almacenamiento con Safari, y Safari lee el manifest al cargar. Por eso el servidor escribe el token en el HTML (`serveIndex`) y tras emparejar se recarga con `?d=token`.
- **electron-builder** creaba releases duplicadas al subir en paralelo → el workflow crea la release antes. `releaseType: "release"` (si no, borrador).
- El hilo de HEIC no carga desde `app.asar` → `asarUnpack` en package.json (heic-convert, heic-decode, libheif-js, jpeg-js, pngjs y el worker).
- Chromium reordena los argumentos de la segunda instancia (`--send` puede ir antes que la ruta de la app) → `handleSendArgs` filtra rutas propias.
- En el móvil no rehacer los botones en cada evento de progreso (los toques fallan); en el PC, el progreso actualiza solo las filas activas.
- `capturePage` puede fallar con «UnknownVizError» si la ventana aún no se ha pintado (devshots reintenta).

## Pendiente / próximos pasos

- Probar en el iPhone del usuario: calidad original (iOS puede convertir HEIC→JPG y recomprimir vídeo al elegir desde Safari), miniaturas de vídeos grandes, reanudar tras bloquear la pantalla, varios PCs con dos PCs reales, `prompt()` del código en la app de inicio.
- Probar el instalador 0.3.0 desde cero: aviso UAC del firewall una vez y «Enviar a → N-Transfer» en el Explorador. Arrastrar desde la lista a otras apps (no automatizable).
- Ideas aún no elegidas: compilar para Mac/Linux, ZIP de todo en el móvil, confirmar dispositivos nuevos, renombrar al recibir, subcarpetas por fecha, saltar duplicados.

## Convenciones

- Commits en español, con la línea `Co-Authored-By` que indique el sistema. Commit/push cuando se termina un bloque de trabajo; el usuario los ha aceptado hasta ahora.
- Textos de interfaz siempre en `src/shared/i18n.js` (es y en a la vez).
- Cada función nueva: prueba en `scripts/test-core.js` (núcleo) o en `src/main/devshots.js` (punta a punta) y captura si es visual.
