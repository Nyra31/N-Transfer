'use strict';
/**
 * Skins personalizadas: archivos .css en la carpeta de skins del usuario.
 * El id es el nombre del archivo (a-z, 0-9, guiones) y el nombre visible sale de un comentario  /* @name Mi skin *\/
 * Cada skin define sus variables dentro de la clase .skin-<id> (ver SKINS.md y la plantilla).
 */
const fs = require('fs');
const path = require('path');

const BUILT_IN = new Set(['winamp', 'chrome', 'luna']);

function createSkinManager(dir, onChange) {
  let skins = [];
  let timer = null;

  function scan() {
    fs.mkdirSync(dir, { recursive: true });
    skins = [];
    for (const f of fs.readdirSync(dir)) {
      if (!/\.css$/i.test(f)) continue;
      const id = f.replace(/\.css$/i, '').toLowerCase().replace(/[^a-z0-9-]/g, '-');
      if (!id || BUILT_IN.has(id)) continue;
      const file = path.join(dir, f);
      let css = '';
      try {
        css = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (css.length > 512 * 1024) continue;
      const name = (/@name\s+([^*\n]+)/.exec(css) || [])[1]?.trim() || id;
      skins.push({ id, name, file, css });
    }
    return skins;
  }

  function watch() {
    try {
      fs.watch(dir, () => {
        clearTimeout(timer);
        timer = setTimeout(() => onChange(scan()), 300);
      });
    } catch {
      /* algunos sistemas de archivos no permiten vigilar: se recarga al reiniciar */
    }
  }

  /** Crea la plantilla si la carpeta está vacía, para que el usuario tenga un punto de partida. */
  function ensureTemplate(templateFile) {
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'mi-skin.css');
    if (!fs.readdirSync(dir).some((f) => /\.css$/i.test(f))) fs.copyFileSync(templateFile, target);
  }

  scan();
  watch();
  return {
    list: () => skins,
    has: (id) => BUILT_IN.has(id) || skins.some((s) => s.id === id),
    rescan: () => onChange(scan()),
    ensureTemplate,
    dir,
  };
}

module.exports = { createSkinManager, BUILT_IN };
