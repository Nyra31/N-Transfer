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

> La primera vez, Windows preguntará si permites a N-Transfer usar la red: acepta para **redes privadas**.
> El instalador no está firmado: si aparece SmartScreen, pulsa *Más información → Ejecutar de todas formas*.

## Funciones

**Transferencias**
- En las dos direcciones, con progreso y velocidad en tiempo real.
- **Vista previa en directo**: la foto o el vídeo que se está enviando aparece en la pantalla LCD (en el PC y en el móvil).
- **Pausar, reanudar y cancelar** desde el PC o desde el móvil.
- **Reanudación automática**: si se corta el Wi‑Fi o se bloquea el móvil a mitad de un vídeo, continúa donde se quedó. Si vuelves a elegir el mismo archivo, también.
- **Texto y enlaces** entre móvil y PC (lo que llega al PC se copia al portapapeles; en el PC, `Ctrl+V` abre «Enviar texto»).

**Fotos y vídeos**
- Miniaturas en el historial y **visor integrado** (doble clic) con flechas y tira de miniaturas.
- **HEIC → JPG** opcional: guardar el original, original + JPG, o solo JPG.
- **Carpetas por tipo**: fotos, vídeos y otros archivos en carpetas distintas, cada una configurable.

**Interfaz**
- 3 skins: **Clásico** (LCD verde), **Plata cromada** y **Luna XP**, y **skins personalizadas** en CSS ([cómo crear una](SKINS.md)). La skin se aplica también en el móvil.
- **Modo mini** (una LCD diminuta), **siempre visible** y modo plegado (doble clic en la barra de título).
- **Efectos de sonido** al emparejar, terminar o fallar (desactivables).
- **Estadísticas**: total transferido, fotos, vídeos y velocidad máxima. Clic en la LCD para ir cambiando lo que muestra.
- Icono en la bandeja del sistema, arranque con el sistema, español e inglés.
- Actualizaciones automáticas desde GitHub Releases.

## Plataformas

| Plataforma | Estado |
|---|---|
| Windows 10/11 | ✅ |
| iPhone / iPad (web app) | ✅ |
| Android (web app) | ✅ debería funcionar igual (por probar) |
| macOS / Linux (escritorio) | 🛠️ configurado en `electron-builder`, falta probarlo |
| Apps nativas iOS / Android | 📋 planificadas: usarán la API `/api/v1` |

## Desarrollo

Requiere [Node.js](https://nodejs.org) 20 o superior.

```bash
npm install
npm start          # ejecutar en modo desarrollo
npm test           # pruebas del servidor (HEIC_SAMPLE=foto.heic para probar también la conversión)
npm run shots      # prueba de punta a punta con la app real + capturas en ./shots
npm run icons      # regenerar los iconos desde el SVG
npm run dist       # crear el instalador de Windows en ./dist
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
| GET | `/api/v1/me` | Datos del dispositivo, skin/idioma del PC y skins disponibles |
| POST | `/api/v1/uploads` | `{name, size, mtime, type, thumb?}` → `{id, offset}`; reanuda si el mismo archivo estaba a medias |
| PUT | `/api/v1/uploads/:id?offset=N` | Bytes desde `N` → `{done, offset}`. `409` offset incorrecto · `423` en pausa · `410` cancelada |
| GET | `/api/v1/uploads/:id` | `{offset, size, state}` |
| POST | `/api/v1/uploads/:id/state` | `{state: "paused" \| "active"}` |
| DELETE | `/api/v1/uploads/:id` | Cancelar |
| PUT | `/api/v1/upload` | Subida simple de una vez (cabeceras `X-File-Name`, `X-File-Mtime`) |
| POST | `/api/v1/text` | `{text}` |
| GET | `/api/v1/outbox` | Archivos y textos que ofrece el PC |
| GET | `/api/v1/outbox/:id` | Descarga (admite `Range`) |
| GET | `/api/v1/outbox/:id/thumb` | Miniatura JPG |
| GET | `/api/v1/events` | Server‑Sent Events: `outbox`, `settings`, `control` (`{id, action}`), `unpaired` |

Autenticación: cabecera `X-Device-Token` o parámetro `?d=`.

### Publicar una versión

```bash
npm version patch          # o minor / major
git push --follow-tags     # GitHub Actions compila y publica el instalador en Releases
```

## Licencia

[MIT](LICENSE)
