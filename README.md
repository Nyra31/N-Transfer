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

- Transferencia en las dos direcciones, con progreso y velocidad en tiempo real.
- Emparejamiento único por QR; cada dispositivo tiene su propia clave, que se puede revocar.
- 3 skins: **Clásico** (LCD verde), **Plata cromada** y **Luna XP**. La skin se aplica también en el móvil.
- Modo plegado: doble clic en la barra de título.
- Icono en la bandeja del sistema y arranque con el sistema.
- Español e inglés.
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
npm run shots      # prueba automática + capturas de todas las skins en ./shots
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
| GET | `/api/v1/me` | Datos del dispositivo y de la skin/idioma del PC |
| PUT | `/api/v1/upload` | Cuerpo = archivo; cabeceras `X-File-Name` (URI‑encoded) y `X-File-Mtime` |
| GET | `/api/v1/outbox` | Archivos que ofrece el PC |
| GET | `/api/v1/outbox/:id` | Descarga (admite `Range`) |
| GET | `/api/v1/events` | Server‑Sent Events: `outbox`, `settings`, `unpaired` |

Autenticación: cabecera `X-Device-Token` o parámetro `?d=`.

### Publicar una versión

```bash
npm version patch          # o minor / major
git push --follow-tags     # GitHub Actions compila y publica el instalador en Releases
```

## Licencia

[MIT](LICENSE)
