'use strict';
// Clasificación de archivos en foto / vídeo / otro, por extensión y tipo MIME.
const path = require('path');

const PHOTO = new Set(['.jpg', '.jpeg', '.heic', '.heif', '.png', '.gif', '.webp', '.avif', '.bmp', '.tif', '.tiff',
  '.dng', '.raw', '.cr2', '.cr3', '.nef', '.arw', '.orf', '.rw2']);
const VIDEO = new Set(['.mov', '.mp4', '.m4v', '.3gp', '.avi', '.mkv', '.webm', '.hevc', '.mts', '.m2ts', '.wmv']);

function kindOf(name, mime = '') {
  const ext = path.extname(String(name)).toLowerCase();
  if (PHOTO.has(ext) || /^image\//.test(mime)) return 'photo';
  if (VIDEO.has(ext) || /^video\//.test(mime)) return 'video';
  return 'other';
}

const isHeic = (p) => /\.(heic|heif)$/i.test(p);

module.exports = { kindOf, isHeic };
