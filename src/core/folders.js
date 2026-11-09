'use strict';
// Carpetas PC → móvil: listado recursivo y ZIP en streaming (sin comprimir: fotos y vídeos ya lo están,
// y así el tamaño final se conoce de antemano y el móvil puede mostrar el progreso).
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const MAX_FILES = 20000;
const SKIP = /^(desktop\.ini|thumbs\.db|\.ds_store)$/i;

/** Todos los archivos de una carpeta (sin enlaces simbólicos ni archivos de sistema). */
async function walk(root) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isSymbolicLink() || SKIP.test(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) {
        const st = await fsp.stat(full).catch(() => null);
        if (!st) continue;
        files.push({ full, rel: path.relative(root, full).split(path.sep).join('/'), size: st.size, mtime: st.mtime });
        if (files.length >= MAX_FILES) return files;
      }
    }
  }
  return files;
}

async function folderInfo(root) {
  const files = await walk(root);
  return { count: files.length, size: files.reduce((s, f) => s + f.size, 0) };
}

/**
 * Crea el ZIP de una carpeta. Devuelve { stream, size } (size = tamaño exacto del ZIP, o -1 si no se sabe).
 * Dentro del ZIP todo va bajo una carpeta con el nombre original.
 */
async function zipFolder(root) {
  const yazl = require('yazl');
  const files = await walk(root);
  const zip = new yazl.ZipFile();
  const base = path.basename(root);
  for (const f of files) zip.addFile(f.full, `${base}/${f.rel}`, { compress: false, mtime: f.mtime });
  const size = await new Promise((resolve) => zip.end({}, (total) => resolve(total)));
  return { stream: zip.outputStream, size, count: files.length };
}

module.exports = { walk, folderInfo, zipFolder };
