# N-Transfer

Pasa fotos, vídeos y archivos entre tu móvil y tu PC por Wi‑Fi, sin cables, sin cuentas y sin la nube. Con skins al estilo de los reproductores de los 2000.

![N-Transfer](build/icon.png)

## Cómo se usa

1. Instala N-Transfer en el PC ([descarga la última versión](https://github.com/Nyra31/N-Transfer/releases/latest)).
2. Pulsa **Emparejar** y escanea el código QR con la cámara del móvil. El móvil y el PC tienen que estar en la misma red Wi‑Fi.
3. En el móvil, pulsa **Emparejar**. Ya está: no hace falta volver a escanear.
4. **Móvil → PC:** pulsa *Fotos y vídeos* o *Archivos*. Se guardan con su calidad original en `Descargas\N-Transfer` (se puede cambiar en Ajustes).
5. **PC → móvil:** arrastra archivos a la ventana de N-Transfer y aparecerán en el móvil, en «Desde el PC».

**Consejo:** añade N-Transfer a la pantalla de inicio del móvil. En iPhone: *Compartir → Añadir a pantalla de inicio*. En Android: *⋮ → Añadir a pantalla de inicio*.

### Instalar

| Sistema | Descarga | Notas |
|---|---|---|
| **Windows 10/11** | `N-Transfer-Setup-X.Y.Z.exe` | No está firmado: si aparece SmartScreen, *Más información → Ejecutar de todas formas*. El instalador pide permiso de administrador una vez para el firewall. |
| **macOS 11+** (Intel y Apple Silicon) | `N-Transfer-X.Y.Z-mac.dmg` | Arrastra N-Transfer a Aplicaciones. Al no estar firmada por Apple, la primera vez: clic derecho sobre la app → **Abrir** → Abrir (o *Ajustes del Sistema → Privacidad y seguridad → Abrir igualmente*). Acepta el permiso de **red local**. Las actualizaciones se avisan en la app y se descargan a mano. |
| **Linux** (x64) | `.AppImage` o `.deb` | AppImage: `chmod +x N-Transfer-*.AppImage` y ábrelo. Debian/Ubuntu: `sudo apt install ./N-Transfer-*.deb`. En GNOME, el icono de la bandeja necesita la extensión *AppIndicator*. |

> Para emparejar, la ventana **Emparejar** del PC tiene que estar abierta: el PC no acepta móviles nuevos en ningún otro momento.

## Funciones

**Transferencias**
- En las dos direcciones, con progreso y velocidad en tiempo real.
- **Vista previa en directo**: la foto o el vídeo que se está enviando aparece en la pantalla LCD (en el PC y en el móvil).
- **Pausar, reanudar y cancelar** desde el PC o desde el móvil.
- **Reanudación automática**: si se corta el Wi‑Fi o se bloquea el móvil a mitad de un vídeo, continúa donde se quedó. Si vuelves a elegir el mismo archivo, también.
- **Texto y enlaces** entre móvil y PC (lo que llega al PC se copia al portapapeles; en el PC, `Ctrl+V` abre «Enviar texto»).

- **Carpetas PC → móvil**: se descargan como un ZIP generado al momento.
- **«Enviar a → N-Transfer»** en el menú contextual del Explorador de Windows.
- **Varios PCs**: el móvil ve los demás PCs con N-Transfer de la red, se empareja escribiendo su código y elige a cuál enviar.

**Fotos y vídeos**
- Miniaturas en el historial y **visor integrado** (doble clic) con flechas y tira de miniaturas.
- **HEIC → JPG** opcional: guardar el original, original + JPG, o solo JPG.
- **Carpetas por tipo**: fotos, vídeos y otros archivos en carpetas distintas, cada una configurable.

**Historial**
- **Buscar y filtrar** por tipo y dispositivo (`Ctrl+F`); **selección múltiple** (`Ctrl`/`Mayús`+clic, `Ctrl+A`) para abrir, quitar o mandar a la papelera.
- **Arrastrar** fotos y archivos desde la lista a otra carpeta o aplicación.
- El móvil también guarda su historial de envíos.

**Conexión**
- **Asistente «¿No conecta?»**: comprueba el firewall, el tipo de red de Windows, la IP y el nombre `.local`, y detecta en directo si llega la conexión del móvil.
- El instalador añade el permiso del firewall (un aviso de administrador, solo la primera vez).
- Nombre del PC y dirección del QR configurables.

**Interfaz**
- 3 skins: **Clásico** (LCD verde), **Plata cromada** y **Luna XP**, y **skins personalizadas**: con el **editor visual** (vista previa en directo) o en CSS ([cómo crear una](SKINS.md)). La skin se aplica también en el móvil.
- **Tamaño doble** (`Ctrl+D`) o 1,5×, **modo mini** (una LCD diminuta), **siempre visible** y modo plegado (doble clic en la barra de título).
- Visualizador con tres modos (clic): barras, osciloscopio o apagado.
- **Efectos de sonido** al emparejar, terminar o fallar (desactivables).
- **Estadísticas**: total transferido, fotos, vídeos y velocidad máxima. Clic en la LCD para ir cambiando lo que muestra.
- Icono en la bandeja del sistema, arranque con el sistema, español e inglés.
- Actualizaciones automáticas desde GitHub Releases.

## Plataformas

| Plataforma | Estado |
|---|---|
| Windows 10/11 | ✅ |
| macOS (universal) | ✅ compila y arranca en las pruebas automáticas; sin firma de Apple |
| Linux x64 (AppImage, .deb) | ✅ compila y arranca en las pruebas automáticas |
| iPhone / iPad (web app) | ✅ |
| Android (web app) | ✅ debería funcionar igual (por probar) |
| Apps nativas iOS / Android | 📋 planificadas: usarán la API `/api/v1` |

## Desarrollo

Requiere [Node.js](https://nodejs.org) 20 o superior.

```bash
npm install
npm start          # ejecutar en modo desarrollo
npm test           # pruebas del servidor (HEIC_SAMPLE=foto.heic para probar también la conversión)
npm run shots      # prueba de punta a punta con la app real + capturas en ./shots
npm run icons      # regenerar los iconos desde el SVG
npm run dist       # crear el instalador de Windows en ./dist  (dist:mac / dist:linux en esos sistemas)
npm run smoke      # arrancar la app ya empaquetada y comprobar que funciona
```

### Estructura

```
src/core/      Servidor HTTP, emparejamiento y transferencias (sin Electron: multiplataforma)
src/main/      Proceso principal de Electron: ventana, bandeja, menús, actualizaciones
src/renderer/  Interfaz del PC
src/mobile/    Web app del móvil que sirve el PC
src/shared/    Skins, idiomas y visualizador, comunes al PC y al móvil
```

### API para clientes nativos (v1)

El PC anuncia el servicio `_ntransfer._tcp` por mDNS/Bonjour y escucha en el puerto `47800`.

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/v1/info` | Información pública del PC |
| POST | `/api/v1/pair` | `{code, name, platform}` → `{token, deviceId}` |
| GET | `/api/v1/me` | Datos del dispositivo, id/nombre del PC, skin/idioma y skins disponibles |
| GET | `/api/v1/peers` | Otros PCs con N-Transfer en la red (descubiertos por mDNS) |
| POST | `/api/v1/uploads` | `{name, size, mtime, type, thumb?}` → `{id, offset}`; reanuda si el mismo archivo estaba a medias |
| PUT | `/api/v1/uploads/:id?offset=N` | Bytes desde `N` → `{done, offset}`. `409` offset incorrecto · `423` en pausa · `410` cancelada |
| GET | `/api/v1/uploads/:id` | `{offset, size, state}` |
| POST | `/api/v1/uploads/:id/state` | `{state: "paused" \| "active"}` |
| DELETE | `/api/v1/uploads/:id` | Cancelar |
| PUT | `/api/v1/upload` | Subida simple de una vez (cabeceras `X-File-Name`, `X-File-Mtime`) |
| POST | `/api/v1/text` | `{text}` |
| GET | `/api/v1/outbox` | Archivos y textos que ofrece el PC |
| GET | `/api/v1/outbox/:id` | Descarga (admite `Range`); las carpetas se sirven como ZIP |
| GET | `/api/v1/outbox/:id/thumb` | Miniatura JPG |
| GET | `/api/v1/events` | Server‑Sent Events: `outbox`, `settings`, `control` (`{id, action}`), `unpaired` |

Autenticación: cabecera `X-Device-Token` o parámetro `?d=`.

### Publicar una versión

```bash
npm version patch          # o minor / major
git push --follow-tags     # GitHub Actions prueba, compila y publica para Windows, macOS y Linux
```

Antes, `release-notes/vX.Y.Z.md` con las notas. La release se crea en borrador y solo se publica si las pruebas y la app empaquetada funcionan en los tres sistemas. Para compilar sin publicar: *Actions → Release → Run workflow*.

## Licencia

[MIT](LICENSE)
