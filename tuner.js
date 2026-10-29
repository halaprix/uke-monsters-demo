// Tuning step for a grown-up and child together: pluck a string, the monster shows
// too low / too high / just right. Cents are used only here, never for grading chords.
// Uses globals from index.html: ctx, music, pitchAnalyser, micOn, settings, setMood, chime, burst, say, $.

const TUNINGS = {
  standard: [{ name: 'G', midi: 67 }, { name: 'C', midi: 60 }, { name: 'E', midi: 64 }, { name: 'A', midi: 69 }],
  lowg:     [{ name: 'G', midi: 55 }, { name: 'C', midi: 60 }, { name: 'E', midi: 64 }, { name: 'A', midi: 69 }],
};
const IN_TUNE_CENTS = 8;          // open strings can be tuned this closely; fretted notes can't
const HOLD_MS = 600;              // how long a string must stay in tune to count
const midiHz = m => 440 * 2 ** ((m - 69) / 12);

// ---- YIN pitch detector (de Cheveigné & Kawahara 2002) ----
// Returns { f, conf } or null. buf: Float32Array of samples, sr: sample rate.
function yinPitch(buf, sr, fmin = 150, fmax = 1100) {
  const tauMin = Math.max(2, Math.floor(sr / fmax));
  const tauMax = Math.min(Math.floor(sr / fmin), buf.length >> 1);
  const W = buf.length - tauMax;
  const d = new Float32Array(tauMax + 2);
  for (let tau = 1; tau <= tauMax + 1; tau++) {
    let s = 0;
    for (let i = 0; i < W; i++) { const x = buf[i] - buf[i + tau]; s += x * x; }
    d[tau] = s;
  }
  // cumulative mean normalised difference
  let run = 0;
  d[0] = 1;
  for (let tau = 1; tau <= tauMax + 1; tau++) { run += d[tau]; d[tau] = run ? d[tau] * tau / run : 1; }
  let tau = -1;
  for (let t = tauMin; t <= tauMax; t++) {
    if (d[t] < 0.15) { while (t + 1 <= tauMax && d[t + 1] < d[t]) t++; tau = t; break; }
  }
  if (tau < 0) {                                   // no dip under the threshold: take the best one if it is decent
    let best = tauMin;
    for (let t = tauMin; t <= tauMax; t++) if (d[t] < d[best]) best = t;
    if (d[best] > 0.35) return null;
    tau = best;
  }
  // parabolic interpolation around the dip for sub-sample accuracy
  const a = d[tau - 1], b = d[tau], c = d[tau + 1], den = a - 2 * b + c;
  const shift = den ? 0.5 * (a - c) / den : 0;
  return { f: sr / (tau + shift), conf: 1 - b };
}

// Read the mic and return { f, db } (f null when quiet or unclear). Tests replace this function.
let tunerBuf = null;
function readPitch() {
  if (!micOn || !pitchAnalyser) return { f: null, db: -100 };
  if (!tunerBuf || tunerBuf.length !== pitchAnalyser.fftSize) tunerBuf = new Float32Array(pitchAnalyser.fftSize);
  pitchAnalyser.getFloatTimeDomainData(tunerBuf);
  let s = 0;
  for (let i = 0; i < tunerBuf.length; i++) s += tunerBuf[i] * tunerBuf[i];
  const db = 10 * Math.log10(s / tunerBuf.length + 1e-12);
  if (db < -55) return { f: null, db };
  const p = yinPitch(tunerBuf, ctx.sampleRate);
  return { f: p && p.conf > 0.8 ? p.f : null, db };
}

// A clean reference note at the exact pitch (additive, so no Karplus-Strong period rounding).
function refTone(midi) {
  const f = midiHz(midi), t = ctx.currentTime + 0.02;
  [1, 2, 3, 4].forEach((h, i) => {
    const o = ctx.createOscillator(), g = ctx.createGain(), amp = [0.22, 0.09, 0.05, 0.025][i];
    o.frequency.value = f * h;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(amp, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0008, t + 2.4 / h);
    o.connect(g).connect(music);
    o.start(t); o.stop(t + 2.5);
  });
}

// ---- the tuning screen ----
const Tuner = {
  open: false, lock: null, done: [false, false, false, false], heldSince: 0, hist: [], quietSince: 0, raf: 0, onDone: null,
  strings() { return TUNINGS[settings.tuning] || TUNINGS.standard; },
};

function openTuner(onDone) {
  Tuner.open = true; Tuner.lock = null; Tuner.done = [false, false, false, false];
  Tuner.hist = []; Tuner.heldSince = 0; Tuner.onDone = onDone || null;
  music.gain.cancelScheduledValues(ctx.currentTime); music.gain.value = 1;
  $('stage').classList.add('tuning');
  $('tuner').classList.remove('hide');
  $('tFinish').classList.add('hide');
  drawTunerStrings();
  setNeedle(null);
  setMood('tune');
  say(micOn ? '🎵 Let’s tune!' : '🎵 Tune by ear');
  $('tMsg').textContent = micOn ? 'Pluck one string. Tap a letter to hear its note.' : 'No microphone: tap a letter to hear its note and match it by ear.';
  cancelAnimationFrame(Tuner.raf);
  Tuner.raf = requestAnimationFrame(tunerLoop);
}

function closeTuner() {
  Tuner.open = false;
  cancelAnimationFrame(Tuner.raf);
  $('tuner').classList.add('hide');
  $('stage').classList.remove('tuning');
  setMood('idle');
  say('🎸');
}

function drawTunerStrings() {
  $('tStrings').innerHTML = Tuner.strings().map((s, i) =>
    `<button class="tstr ${Tuner.done[i] ? 'ok' : ''} ${Tuner.lock === i ? 'lock' : ''}" data-i="${i}">` +
    `<b>${s.name}</b><small>${Tuner.done[i] ? '⭐' : '🔈'}</small></button>`).join('');
}

// needle: cents in [-50, 50] maps across the bar; null hides it
function setNeedle(cents) {
  const n = $('tNeedle');
  if (cents == null) { n.style.opacity = 0.25; n.style.left = '50%'; n.classList.remove('good'); return; }
  const c = Math.max(-50, Math.min(50, cents));
  n.style.opacity = 1;
  n.style.left = (50 + c) + '%';
  n.classList.toggle('good', Math.abs(cents) <= IN_TUNE_CENTS);
}

function tunerLoop(now) {
  if (!Tuner.open) return;
  const { f } = readPitch();
  const strs = Tuner.strings();
  if (f) {
    Tuner.hist.push(f); if (Tuner.hist.length > 5) Tuner.hist.shift();
    const fm = [...Tuner.hist].sort((a, b) => a - b)[Tuner.hist.length >> 1];   // median of the last few
    // which string? the locked one, else the nearest target
    let i = Tuner.lock, cents;
    if (i == null) {
      let best = Infinity;
      strs.forEach((s, k) => { const c = 1200 * Math.log2(fm / midiHz(s.midi)); if (Math.abs(c) < Math.abs(best)) { best = c; i = k; } });
      cents = best;
      if (Math.abs(cents) > 300) { setNeedle(null); $('tMsg').textContent = 'Hmm, that’s far from any string. Tap the letter you are tuning.'; i = null; }
    } else cents = 1200 * Math.log2(fm / midiHz(strs[i].midi));
    if (i != null && Tuner.done.every(Boolean)) {
      highlight(i);
      setNeedle(cents);                            // all done: keep the needle live, keep the "all in tune" message
    } else if (i != null) {
      highlight(i);
      setNeedle(cents);
      const name = strs[i].name;
      if (Math.abs(cents) <= IN_TUNE_CENTS) {
        $('tMsg').textContent = `${name} sounds just right! Hold it…`;
        if (!Tuner.heldSince) Tuner.heldSince = now;
        if (now - Tuner.heldSince > HOLD_MS && !Tuner.done[i]) stringTuned(i);
      } else {
        Tuner.heldSince = 0;
        const far = Math.abs(cents) > 40 ? 'a lot' : 'a little';
        $('tMsg').textContent = cents < 0 ? `${name} is ${far} low 🐢: tighten the peg slowly` : `${name} is ${far} high 🐇: loosen the peg slowly`;
      }
    }
    Tuner.quietSince = 0;
  } else {
    Tuner.heldSince = 0;
    if (!Tuner.quietSince) Tuner.quietSince = now;
    if (now - Tuner.quietSince > 1200) { Tuner.hist = []; setNeedle(null); highlight(Tuner.lock); }
  }
  Tuner.raf = requestAnimationFrame(tunerLoop);
}

function highlight(i) {
  document.querySelectorAll('#tStrings .tstr').forEach((b, k) => b.classList.toggle('hot', k === i));
}

function stringTuned(i) {
  Tuner.done[i] = true;
  drawTunerStrings();
  highlight(i);
  chime(true);
  burst(['⭐', '✨'], 8, 26);
  const mon = $('mon'); mon.classList.remove('bump'); void mon.offsetWidth; mon.classList.add('bump');
  if (Tuner.done.every(Boolean)) {
    setMood('cheer');
    say('🎉 Your uke is ready!');
    $('tMsg').textContent = 'All four strings are in tune.';
    $('tFinish').classList.remove('hide');
    setTimeout(() => { if (Tuner.open) setMood('idle'); }, 1300);
  } else {
    const left = Tuner.strings().filter((_, k) => !Tuner.done[k]).map(s => s.name).join(', ');
    say(`⭐ ${Tuner.strings()[i].name} is ready!`);
    $('tMsg').textContent = `Next: ${left}`;
    if (Tuner.lock === i) Tuner.lock = null;
  }
}

$('tStrings').addEventListener('click', e => {
  const b = e.target.closest('.tstr'); if (!b) return;
  const i = +b.dataset.i;
  Tuner.lock = Tuner.lock === i ? null : i;      // tap again to go back to automatic
  drawTunerStrings();
  refTone(Tuner.strings()[i].midi);
  $('tMsg').textContent = Tuner.lock == null ? 'Pluck one string.' : `Tuning ${Tuner.strings()[i].name}: pluck it and turn its peg.`;
});
$('tClose').addEventListener('click', () => { closeTuner(); $('start').classList.remove('hide'); });
$('tFinish').addEventListener('click', () => { const next = Tuner.onDone; closeTuner(); if (next) next(); else $('start').classList.remove('hide'); });
