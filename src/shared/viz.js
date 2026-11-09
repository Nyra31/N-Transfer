/* Analizador de espectro «de mentira» para la pantalla LCD: reacciona a la velocidad de transferencia. */
(function (root) {
  function createViz(canvas, opts = {}) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    const barW = opts.barWidth || 4;
    const gap = opts.gap || 2;
    const seg = opts.segment || 2;
    const n = Math.floor((W + gap) / (barW + gap));
    const heights = new Float32Array(n);
    const peaks = new Float32Array(n);
    const phase = Array.from({ length: n }, () => Math.random() * Math.PI * 2);
    const speed = Array.from({ length: n }, () => 1.5 + Math.random() * 3);
    // Perfil típico: más energía en graves que en agudos
    const profile = Array.from({ length: n }, (_, i) => 1 - (i / n) * 0.55);
    let colors = ['#0f0', '#ff0', '#f00', '#ccc'];
    let level = 0;
    let target = 0.03;
    let last = 0;
    let mode = 'bars'; // bars · scope · off

    function readColors() {
      const cs = getComputedStyle(canvas);
      colors = ['--viz-1', '--viz-2', '--viz-3', '--viz-peak'].map((v, i) => cs.getPropertyValue(v).trim() || colors[i]);
    }

    function frame(ts) {
      requestAnimationFrame(frame);
      if (ts - last < 33) return; // ~30 fps
      last = ts;
      level += (target - level) * 0.08;
      const time = ts / 1000;
      ctx.clearRect(0, 0, W, H);
      if (mode === 'off') return;
      if (mode === 'scope') return drawScope(time);
      for (let i = 0; i < n; i++) {
        const wave = 0.5 + 0.5 * Math.sin(time * speed[i] + phase[i]);
        const jitter = Math.random() * 0.35;
        const v = Math.min(1, level * profile[i] * (0.45 + 0.55 * wave + jitter));
        heights[i] = Math.max(v, heights[i] * 0.82);
        peaks[i] = Math.max(heights[i], peaks[i] - 0.015);
        const x = i * (barW + gap);
        const h = Math.round(heights[i] * H);
        for (let y = 0; y < h; y += seg + 1) {
          const f = y / H;
          ctx.fillStyle = f < 0.55 ? colors[0] : f < 0.8 ? colors[1] : colors[2];
          ctx.fillRect(x, H - y - seg, barW, seg);
        }
        const py = Math.round(peaks[i] * H);
        if (py > 1) {
          ctx.fillStyle = colors[3];
          ctx.fillRect(x, H - py - 1, barW, 1);
        }
      }
    }

    /** Osciloscopio: una onda que se agita más cuanto más rápido va la transferencia. */
    function drawScope(time) {
      const mid = H / 2;
      const amp = (H / 2 - 1) * Math.min(1, level * 1.15);
      ctx.fillStyle = colors[0];
      let prev = mid;
      for (let x = 0; x < W; x += 2) {
        const p = x / W;
        const y = mid + amp * (0.6 * Math.sin(p * 18 + time * 9) + 0.3 * Math.sin(p * 47 - time * 13) + 0.25 * (Math.random() - 0.5));
        const top = Math.round(Math.min(prev, y));
        const h = Math.max(1, Math.round(Math.abs(y - prev)));
        ctx.fillRect(x, top, 2, h); // píxeles verticales unidos, como los osciloscopios de la época
        prev = y;
      }
      ctx.fillStyle = colors[3];
      ctx.globalAlpha = 0.25;
      ctx.fillRect(0, Math.round(mid), W, 1);
      ctx.globalAlpha = 1;
    }

    readColors();
    requestAnimationFrame(frame);
    return {
      setLevel(v) { target = Math.max(0.03, Math.min(1, v)); },
      setMode(m) { mode = ['bars', 'scope', 'off'].includes(m) ? m : 'bars'; },
      get mode() { return mode; },
      readColors,
    };
  }

  root.NT_VIZ = { createViz };
})(window);
