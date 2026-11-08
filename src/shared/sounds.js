/* Efectos de sonido sintetizados (WebAudio): pitidos cortos al estilo de los programas de los 2000. Sin archivos de audio. */
(function (root) {
  let ctx = null;
  let enabled = true;
  const last = {};

  function audio() {
    if (!ctx) ctx = new (root.AudioContext || root.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone(freq, start, dur, type = 'square', vol = 0.05) {
    const c = audio();
    const t0 = c.currentTime + start;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  const SOUNDS = {
    start: () => tone(880, 0, 0.05, 'square', 0.025),
    done: () => { tone(660, 0, 0.09); tone(990, 0.09, 0.16); },
    pair: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.08, 0.11)),
    error: () => { tone(196, 0, 0.16, 'sawtooth', 0.045); tone(147, 0.17, 0.26, 'sawtooth', 0.045); },
    text: () => { tone(1250, 0, 0.05); tone(1660, 0.06, 0.07); },
    click: () => tone(2200, 0, 0.012, 'square', 0.02),
  };

  function play(name) {
    if (!enabled || !SOUNDS[name]) return;
    const now = Date.now();
    if (now - (last[name] || 0) < 350) return; // varios archivos seguidos = un solo sonido
    last[name] = now;
    try {
      SOUNDS[name]();
    } catch {
      /* sin audio disponible */
    }
  }

  root.NT_SOUND = { play, setEnabled: (v) => (enabled = !!v) };
})(window);
