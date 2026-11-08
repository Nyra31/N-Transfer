# Crear una skin para N-Transfer

Una skin es un archivo `.css` con una lista de colores. No hace falta saber programar.

1. En N-Transfer, abre **Menú → Skin → Carpeta de skins…**. La primera vez se crea `mi-skin.css` como plantilla.
2. Copia `mi-skin.css` con otro nombre, por ejemplo `neon-rosa.css`.
3. Dentro del archivo, cambia:
   - la primera línea, `/* @name Mi skin */`, por el nombre que quieras ver en el menú;
   - la clase `.skin-mi-skin` por `.skin-` + el nombre del archivo: `.skin-neon-rosa`.
4. Cambia los colores y guarda. N-Transfer recarga las skins solo; elígela en **Menú → Skin**.

La skin también se usa en el móvil, salvo que allí hayas elegido otra.

## Variables

| Variable | Qué colorea |
|---|---|
| `--font-ui`, `--font-lcd` | Tipografía general y de la pantalla LCD |
| `--text`, `--text-dim` | Texto general y secundario |
| `--frame-bg`, `--frame-hi`, `--frame-lo` | Fondo del marco y los dos tonos del bisel |
| `--panel-bg` | Paneles interiores |
| `--title-bg`, `--title-fg`, `--title-stripe` | Barra de título y sus rayas decorativas |
| `--lcd-bg`, `--lcd-fg`, `--lcd-dim`, `--lcd-glow`, `--lcd-border` | Pantalla LCD |
| `--btn-bg`, `--btn-hover`, `--btn-press`, `--btn-fg`, `--btn-hi`, `--btn-lo`, `--btn-radius` | Botones |
| `--accent`, `--track` | Relleno y fondo de las barras de progreso |
| `--list-bg`, `--list-fg`, `--list-dim`, `--list-sel-bg`, `--list-sel-fg`, `--list-active` | Lista de transferencias |
| `--viz-1`, `--viz-2`, `--viz-3`, `--viz-peak` | Visualizador de espectro (de abajo a arriba) y picos |
| `--input-bg`, `--input-fg` | Campos de texto |

Opcionales: `--lcd-radius`, `--progress-radius`, `--list-alt` (filas alternas), `--fieldset-radius`, `--input-radius`, `--check-color`, `--legend-fg`, `--title-case`, `--title-spacing`.

Puedes usar degradados, sombras y cualquier CSS válido. Por seguridad no se cargan imágenes ni fuentes de Internet.
Mira [`src/shared/skins/`](src/shared/skins/) para ver cómo están hechas las skins incluidas.
