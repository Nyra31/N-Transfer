# iOS → PC Transfer

Pasa fotos, vídeos y archivos del iPhone/iPad a un PC con Windows por Wi‑Fi, sin cables ni apps en el iPhone.

## Cómo funciona

1. En el PC, ejecuta `Iniciar.bat` (o `npm start`).
2. Se abre una ventana en el navegador con un código QR.
3. Escanéalo con la cámara del iPhone → se abre Safari.
4. Pulsa **Fotos y vídeos** o **Archivos**, elige lo que quieras y se envía.

Los archivos se guardan con su calidad original en `Descargas\iPhone Transfer`.

> El iPhone y el PC deben estar en la misma red Wi‑Fi. La primera vez, Windows puede pedir permiso en el Firewall: acepta para **redes privadas**.

## Requisitos

- [Node.js](https://nodejs.org) 18 o superior

## Configuración (opcional)

| Variable     | Por defecto                     | Descripción              |
|--------------|---------------------------------|--------------------------|
| `PORT`       | `8080`                          | Puerto del servidor      |
| `DEST_DIR`   | `%USERPROFILE%\Downloads\iPhone Transfer` | Carpeta de destino |
| `NO_BROWSER` | —                               | Si existe, no abre el navegador |

## Seguridad

Cada vez que se inicia se genera un token aleatorio incluido en el QR; sin él no se pueden subir archivos. El panel del PC solo es accesible desde el propio PC.

## Nota sobre HEIC

Si quieres recibir fotos en JPG en vez de HEIC: en el iPhone ve a *Ajustes → Cámara → Formatos → Más compatible*.
