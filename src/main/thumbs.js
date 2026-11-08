'use strict';
// Miniaturas de archivos del PC (para «Para el móvil» y el visor), usando las del propio sistema.
const { nativeImage } = require('electron');
const fs = require('fs');
const { isHeic } = require('../core/kinds');
const { convertHeic } = require('../core/heic');

const SIZE = 240;

async function makeThumbnail(file, out) {
  let img = null;
  // Windows y macOS: miniaturas del sistema (incluye vídeos si hay códec instalado).
  if (process.platform === 'win32' || process.platform === 'darwin') {
    img = await nativeImage.createThumbnailFromPath(file, { width: SIZE, height: SIZE }).catch(() => null);
  }
  if ((!img || img.isEmpty()) && isHeic(file)) {
    // Sin la extensión HEIF de Windows: convertimos nosotros y reducimos.
    const tmp = out + '.full.jpg';
    try {
      await convertHeic(file, tmp, 0.8);
      img = nativeImage.createFromPath(tmp);
    } catch {
      img = null;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  if (!img || img.isEmpty()) img = nativeImage.createFromPath(file); // JPG/PNG en Linux
  if (!img || img.isEmpty()) return false;
  const { width, height } = img.getSize();
  const scale = SIZE / Math.max(width, height);
  if (scale < 1) img = img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'good' });
  fs.writeFileSync(out, img.toJPEG(78));
  return true;
}

module.exports = { makeThumbnail };
