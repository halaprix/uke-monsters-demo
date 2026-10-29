/* UkeGrader - browser port of ukegrader/grader.py (+ chords.py).
 *
 * Plain classic script, no dependencies. Defines window.UkeGrader.
 *
 *   UkeGrader.grade(samples, fsIn, expected, opts) -> {
 *     onset_time_s, chroma[12] (C..B), scores {chord: r}, argmax,
 *     presence_db, accept, confidence, lead }
 *
 * samples: mono Float32Array (or any array-like of numbers) at rate fsIn.
 * opts: { tuning: 'standard'|'lowg', threshold: 0.89, margin: 0.045,
 *         minPresenceDb: -30 (null disables the presence gate) }
 *
 * Pipeline (same as Python):
 *  1. resample to 22.05 kHz (scipy.signal.resample_poly equivalent:
 *     Kaiser(5.0)-windowed sinc, half length 10*max(up,down))
 *  2. STFT -> band-limited log spectral flux -> strongest onset over an
 *     adaptive median threshold, stepping back to the first string
 *  3. RMS spectrum 50..400 ms after the onset minus 1.5 x the spectrum of
 *     -350..-20 ms (spectral subtraction of stationary bleed)
 *  4. peaks of the log-compressed, median-whitened spectrum (180..2000 Hz)
 *     -> nearest semitone (raised-cosine cents weight) -> 12-bin chroma
 *  5. centred cosine vs templates of the real voicings + 6 harmonics
 *  6. accept / confidence / lead
 */
(function () {
  'use strict';

  // ------------------------------------------------------------------ chords.py
  var TUNINGS = {
    standard: [67, 60, 64, 69], // G4 C4 E4 A4 (re-entrant)
    lowg: [55, 60, 64, 69]      // G3 C4 E4 A4
  };
  // Fret per string (G, C, E, A). Order matters (argmax ties -> first).
  var CHORD_SHAPES = {
    open: [0, 0, 0, 0],
    C: [0, 0, 0, 3],
    Am: [2, 0, 0, 0],
    F: [2, 0, 1, 0],
    G7: [0, 2, 1, 2],
    G: [0, 2, 3, 2]
  };
  var CHORDS = Object.keys(CHORD_SHAPES);
  var PC_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  function midiToHz(m) { return 440.0 * Math.pow(2.0, (m - 69.0) / 12.0); }
  function voicingMidi(frets, tuning) {
    var o = TUNINGS[tuning];
    if (!o) throw new Error('unknown tuning ' + tuning);
    return frets.map(function (f, i) { return f == null ? null : o[i] + f; });
  }

  // ------------------------------------------------------------------ constants
  var FS = 22050;
  var DEFAULT_THRESHOLD = 0.89, DEFAULT_MARGIN = 0.045, DEFAULT_MIN_PRESENCE_DB = -30.0;
  var F_LO = 180.0, F_HI = 2000.0;
  var N_HARM = 6, HARM_DECAY = 0.8;
  var ONSET_NFFT = 1024, ONSET_HOP = 256;
  var CHROMA_NFFT = 4096, CHROMA_HOP = 512;
  var BG_T0 = -0.35, BG_T1 = -0.02, BG_ALPHA = 1.5;
  var MIDI_LO = 54, MIDI_HI = 95;

  // ------------------------------------------------------------------ helpers
  // Python round(): half to even.
  function pyRound(x) {
    var r = Math.round(x);
    if (Math.abs(x % 1) === 0.5 && r % 2 !== 0) r -= 1;
    return r;
  }
  function gcd(a, b) { while (b) { var t = a % b; a = b; b = t; } return a; }
  function arrMax(a) { var m = -Infinity; for (var i = 0; i < a.length; i++) if (a[i] > m) m = a[i]; return m; }

  // np.hanning (symmetric)
  var hannCache = {};
  function hanning(n) {
    if (hannCache[n]) return hannCache[n];
    var w = new Float64Array(n);
    for (var i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
    return (hannCache[n] = w);
  }

  // ------------------------------------------------------------------ FFT
  // Iterative radix-2 complex FFT; rfftMag returns |X[k]| for k = 0..n/2.
  var fftCache = {};
  function fftTables(n) {
    if (fftCache[n]) return fftCache[n];
    var bits = Math.round(Math.log2(n));
    var rev = new Uint32Array(n);
    for (var i = 0; i < n; i++) {
      var r = 0;
      for (var b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      rev[i] = r;
    }
    var cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
    for (var k = 0; k < n / 2; k++) { cos[k] = Math.cos(2 * Math.PI * k / n); sin[k] = -Math.sin(2 * Math.PI * k / n); }
    return (fftCache[n] = { rev: rev, cos: cos, sin: sin, re: new Float64Array(n), im: new Float64Array(n) });
  }
  // frame: source array, off: start index (zero outside [0, src.length)), win: window
  function rfftMag(src, off, n, win, out) {
    var T = fftTables(n), re = T.re, im = T.im, rev = T.rev, i;
    for (i = 0; i < n; i++) {
      var j = off + i;
      re[rev[i]] = (j >= 0 && j < src.length) ? src[j] * win[i] : 0;
      im[rev[i]] = 0;
    }
    for (var size = 2; size <= n; size <<= 1) {
      var half = size >> 1, step = n / size;
      for (var s = 0; s < n; s += size) {
        for (var k = 0, t = 0; k < half; k++, t += step) {
          var a = s + k, b = a + half;
          var wr = T.cos[t], wi = T.sin[t];
          var xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
    var m = out || new Float64Array(n / 2 + 1);
    for (i = 0; i <= n / 2; i++) m[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
    return m;
  }

  // ------------------------------------------------------------------ resampling
  // Exact port of scipy.signal.resample_poly(x, up, down) with the default
  // window ('kaiser', 5.0) and zero padding:
  //   h = up * firwin(2*L+1, 1/max(up,down), kaiser 5), L = 10*max(up,down)
  //   y[k] = sum_m x[m] * h[k*down - m*up + L],  len(y) = ceil(n*up/down)
  function besselI0(x) {
    var s = 1, t = 1, k = 1;
    for (; k < 200; k++) { t *= (x / (2 * k)) * (x / (2 * k)); s += t; if (t < 1e-17 * s) break; }
    return s;
  }
  var filtCache = {};
  function polyFilter(up, down) {
    var key = up + '/' + down;
    if (filtCache[key]) return filtCache[key];
    var maxRate = Math.max(up, down), fc = 1 / maxRate, L = 10 * maxRate, N = 2 * L + 1;
    var h = new Float64Array(N), beta = 5.0, i0b = besselI0(beta), sum = 0;
    for (var i = 0; i < N; i++) {
      var m = i - L, x = fc * m;
      var sinc = m === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      var r = 2 * i / (N - 1) - 1;
      var w = besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0b;
      h[i] = fc * sinc * w;
      sum += h[i];
    }
    for (i = 0; i < N; i++) h[i] = h[i] / sum * up; // firwin scale=True, then *= up
    return (filtCache[key] = { h: h, L: L });
  }
  function resamplePoly(x, up, down) {
    var n = x.length;
    if (up === down) return Float64Array.from(x);
    var nOut = Math.ceil(n * up / down);
    var F = polyFilter(up, down), h = F.h, L = F.L, hl = h.length;
    var y = new Float64Array(nOut);
    for (var k = 0; k < nOut; k++) {
      var c = k * down + L;                       // h index for m = 0
      var mLo = Math.max(0, Math.ceil((c - (hl - 1)) / up));
      var mHi = Math.min(n - 1, Math.floor(c / up));
      var acc = 0;
      for (var m = mLo, t = c - mLo * up; m <= mHi; m++, t -= up) acc += x[m] * h[t];
      y[k] = acc;
    }
    return y;
  }
  function toFS(samples, fsIn) {
    fsIn = Math.round(fsIn || FS);
    if (fsIn === FS) return Float64Array.from(samples);
    var g = gcd(fsIn, FS);
    return resamplePoly(samples, FS / g, fsIn / g);
  }

  // ------------------------------------------------------------------ scipy-like utils
  // scipy.ndimage.median_filter(x, size, mode='nearest') for odd size.
  function medianFilter(x, size) {
    var n = x.length, h = size >> 1, out = new Float64Array(n), buf = new Float64Array(size);
    for (var i = 0; i < n; i++) {
      for (var j = -h; j <= h; j++) {
        var idx = i + j; idx = idx < 0 ? 0 : (idx >= n ? n - 1 : idx);
        buf[j + h] = x[idx];
      }
      buf.sort();
      out[i] = buf[h];
    }
    return out;
  }
  // scipy.signal.find_peaks(x, height=hmin (scalar or array), distance=d)
  function findPeaks(x, height, distance) {
    var n = x.length, peaks = [], i = 1, iMax = n - 1;
    while (i < iMax) {                       // _local_maxima_1d (plateau -> middle)
      if (x[i - 1] < x[i]) {
        var ia = i + 1;
        while (ia < iMax && x[ia] === x[i]) ia++;
        if (x[ia] < x[i]) { peaks.push((i + ia - 1) >> 1); i = ia; }
      }
      i++;
    }
    if (height != null) {
      peaks = peaks.filter(function (p) {
        return x[p] >= (typeof height === 'number' ? height : height[p]);
      });
    }
    if (distance && distance > 1 && peaks.length > 1) {   // _select_by_peak_distance
      var d = Math.ceil(distance), np_ = peaks.length, keep = new Uint8Array(np_).fill(1);
      var order = peaks.map(function (_, k) { return k; })
        .sort(function (a, b) { return x[peaks[a]] - x[peaks[b]] || a - b; });
      for (var q = np_ - 1; q >= 0; q--) {
        var j = order[q];
        if (!keep[j]) continue;
        for (var k = j - 1; k >= 0 && peaks[j] - peaks[k] < d; k--) keep[k] = 0;
        for (k = j + 1; k < np_ && peaks[k] - peaks[j] < d; k++) keep[k] = 0;
      }
      peaks = peaks.filter(function (_, k) { return keep[k]; });
    }
    return peaks;
  }

  // ------------------------------------------------------------------ onset detection
  // Log-compressed spectral flux (150..5000 Hz) of a centred Hann STFT.
  function onsetStrength(x) {
    var pad = ONSET_NFFT >> 1, nb = ONSET_NFFT / 2 + 1;
    var nFrames = 1 + Math.floor((x.length + 2 * pad - ONSET_NFFT) / ONSET_HOP);
    if (nFrames < 1) nFrames = 1;
    var win = hanning(ONSET_NFFT), S = [], gmax = 0, f, k;
    for (f = 0; f < nFrames; f++) {
      var m = rfftMag(x, f * ONSET_HOP - pad, ONSET_NFFT, win);
      S.push(m);
      for (k = 0; k < nb; k++) if (m[k] > gmax) gmax = m[k];
    }
    var band = [];
    for (k = 0; k < nb; k++) { var fr = k * FS / ONSET_NFFT; if (fr >= 150 && fr <= 5000) band.push(k); }
    var nB = band.length, scale = 1000.0 / (gmax + 1e-12);
    var Lf = S.map(function (m) {
      var l = new Float64Array(nB);
      for (var b = 0; b < nB; b++) l[b] = Math.log1p(scale * m[band[b]]);
      return l;
    });
    // flux vs max of previous 2 frames; first two frames compare to themselves (-> 0)
    var flux = new Float64Array(nFrames);
    for (f = 2; f < nFrames; f++) {
      var s = 0, L0 = Lf[f], L1 = Lf[f - 1], L2 = Lf[f - 2];
      for (var b2 = 0; b2 < nB; b2++) {
        var d = L0[b2] - (L1[b2] > L2[b2] ? L1[b2] : L2[b2]);
        if (d > 0) s += d;
      }
      flux[f] = s;
    }
    return flux;
  }

  function strongestOnset(x) {
    var flux = onsetStrength(x);
    var med = medianFilter(flux, Math.floor(0.5 * FS / ONSET_HOP) | 1);
    var minDist = Math.max(1, Math.floor(0.08 * FS / ONSET_HOP));
    var fmax = arrMax(flux), hmin = new Float64Array(flux.length);
    for (var i = 0; i < flux.length; i++) hmin[i] = med[i] + 0.1 * fmax;
    var peaks = findPeaks(flux, hmin, minDist);
    if (!peaks.length) {
      var am = 0; for (i = 1; i < flux.length; i++) if (flux[i] > flux[am]) am = i;
      peaks = [am];
    }
    var t = peaks.map(function (p) { return p * ONSET_HOP / FS; });
    var s = peaks.map(function (p) { return flux[p] - med[p]; });
    var k = 0; for (i = 1; i < s.length; i++) if (s[i] > s[k]) k = i;
    // step back to the first string of the strum (< 150 ms, >= 25% as strong)
    var best = t[k];
    for (var j = k - 1; j >= 0; j--) {
      if (best - t[j] > 0.15 || s[j] < 0.25 * s[k]) break;
      best = t[j];
    }
    return best;
  }

  // ------------------------------------------------------------------ chroma
  // RMS-averaged magnitude spectrum of [onset+t0, onset+t1] (non-centred frames).
  function windowSpectrum(x, onset, t0, t1) {
    var nb = CHROMA_NFFT / 2 + 1, out = new Float64Array(nb);
    var a = Math.max(0, pyRound((onset + t0) * FS));
    var b = Math.min(x.length, pyRound((onset + t1) * FS));
    if (b - a < CHROMA_NFFT / 4) return out;
    var seg = x.subarray(a, b);                 // zero-padded to NFFT by rfftMag
    var segLen = Math.max(seg.length, CHROMA_NFFT);
    var nFrames = 1 + Math.floor((segLen - CHROMA_NFFT) / CHROMA_HOP);
    var win = hanning(CHROMA_NFFT), m = new Float64Array(nb);
    for (var f = 0; f < nFrames; f++) {
      rfftMag(seg, f * CHROMA_HOP, CHROMA_NFFT, win, m);
      for (var k = 0; k < nb; k++) out[k] += m[k] * m[k];
    }
    for (k = 0; k < nb; k++) out[k] = Math.sqrt(out[k] / nFrames);
    return out;
  }

  // Log-compress and subtract a 41-bin running median.
  function whiten(mag) {
    var mx = arrMax(mag), L = new Float64Array(mag.length);
    for (var i = 0; i < mag.length; i++) L[i] = Math.log1p(100.0 * mag[i] / (mx + 1e-12));
    var floor = medianFilter(L, 41);
    for (i = 0; i < L.length; i++) L[i] = Math.max(L[i] - floor[i], 0.0);
    return L;
  }

  // Semitone salience from whitened-spectrum peaks (parabolic interpolation).
  function pitchSalience(mag) {
    var W = whiten(mag), sal = new Float64Array(MIDI_HI - MIDI_LO + 1);
    var wmax = arrMax(W);
    if (wmax <= 0) return sal;
    var pk = findPeaks(W, 0.05 * wmax, null), df = FS / CHROMA_NFFT;
    for (var q = 0; q < pk.length; q++) {
      var p = pk[q];
      if (p < 1 || p >= W.length - 1) continue;
      var a = W[p - 1], b = W[p], c = W[p + 1];
      var d = 0.5 * (a - c) / (a - 2 * b + c + 1e-12);
      var f = (p + d) * df;
      if (!(f >= F_LO && f <= F_HI)) continue;
      var m = 69.0 + 12.0 * Math.log2(f / 440.0);
      var k = pyRound(m);
      if (k >= MIDI_LO && k <= MIDI_HI) {
        var cc = Math.cos(Math.PI * (m - k));
        sal[k - MIDI_LO] += b * cc * cc;
      }
    }
    return sal;
  }

  function foldChroma(sal) {
    var c = new Array(12).fill(0), n = 0, i;
    for (i = 0; i < sal.length; i++) c[(i + MIDI_LO) % 12] += sal[i];
    for (i = 0; i < 12; i++) n += c[i] * c[i];
    n = Math.sqrt(n);
    return n > 0 ? c.map(function (v) { return v / n; }) : c;
  }

  // ------------------------------------------------------------------ templates + scoring
  var templates = {};
  function chordTemplate(chord, tuning) {
    var key = chord + '|' + tuning;
    if (templates[key]) return templates[key];
    var t = new Array(12).fill(0);
    voicingMidi(CHORD_SHAPES[chord], tuning).forEach(function (m) {
      if (m == null) return;
      var f0 = midiToHz(m);
      for (var h = 1; h <= N_HARM; h++) {
        if (h * f0 >= F_LO && h * f0 <= F_HI) {
          var pc = ((pyRound(m + 12 * Math.log2(h)) % 12) + 12) % 12;
          t[pc] += Math.pow(HARM_DECAY, h - 1);
        }
      }
    });
    var n = Math.sqrt(t.reduce(function (s, v) { return s + v * v; }, 0));
    return (templates[key] = t.map(function (v) { return v / n; }));
  }

  // Pearson correlation (cosine after removing each vector's mean).
  function centredCosine(a, b) {
    var ma = 0, mb = 0, i;
    for (i = 0; i < 12; i++) { ma += a[i]; mb += b[i]; }
    ma /= 12; mb /= 12;
    var dot = 0, na = 0, nb = 0;
    for (i = 0; i < 12; i++) {
      var x = a[i] - ma, y = b[i] - mb;
      dot += x * y; na += x * x; nb += y * y;
    }
    var den = Math.sqrt(na) * Math.sqrt(nb);
    return den > 0 ? dot / den : 0.0;
  }

  // Weakest note of the expected voicing (dB re strongest); fundamental band
  // +-50 cents plus half-weighted 2nd harmonic.
  function stringPresenceDb(mag, chord, tuning) {
    var df = FS / CHROMA_NFFT;
    function band(f) {
      var lo = f * Math.pow(2, -0.5 / 12), hi = f * Math.pow(2, 0.5 / 12), s = 0;
      for (var k = Math.max(0, Math.floor(lo / df)); k < mag.length; k++) {
        var fr = k * df;
        if (fr > hi) break;
        if (fr >= lo) s += mag[k] * mag[k];
      }
      return s;
    }
    var notes = voicingMidi(CHORD_SHAPES[chord], tuning).filter(function (m, i, arr) {
      return m != null && arr.indexOf(m) === i;
    });
    var E = notes.map(function (n) { return band(midiToHz(n)) + 0.5 * band(2 * midiToHz(n)); });
    var mx = Math.max.apply(null, E), mn = Math.min.apply(null, E);
    if (mx <= 0) return -100.0;
    return 10 * Math.log10(mn / mx + 1e-10);
  }

  function decide(scores, expected, threshold, margin, presenceDb, minPresenceDb) {
    var sExp = scores[expected], bestOther = -Infinity;
    CHORDS.forEach(function (c) { if (c !== expected && scores[c] > bestOther) bestOther = scores[c]; });
    var lead = sExp - bestOther;
    var slack = Math.min((sExp - threshold) / 0.05, (lead - margin) / 0.05);
    if (minPresenceDb != null && presenceDb != null) slack = Math.min(slack, (presenceDb - minPresenceDb) / 4.0);
    return { accept: slack >= 0, confidence: 1.0 / (1.0 + Math.exp(-2.0 * slack)), lead: lead };
  }

  // ------------------------------------------------------------------ public API
  function analyse(samples, fsIn, tuning) {
    var x = toFS(samples, fsIn);
    var onset = strongestOnset(x);
    var mag = windowSpectrum(x, onset, 0.05, 0.40);
    if (BG_ALPHA > 0) {
      var bg = windowSpectrum(x, onset, BG_T0, BG_T1);
      for (var k = 0; k < mag.length; k++) mag[k] = Math.max(mag[k] - BG_ALPHA * bg[k], 0.0);
    }
    var chroma = foldChroma(pitchSalience(mag));
    var scores = {}, presence = {};
    CHORDS.forEach(function (c) {
      scores[c] = centredCosine(chroma, chordTemplate(c, tuning));
      presence[c] = stringPresenceDb(mag, c, tuning);
    });
    return { onset_time_s: onset, chroma: chroma, scores: scores, presence_db: presence };
  }

  function grade(samples, fsIn, expected, opts) {
    opts = opts || {};
    if (!CHORD_SHAPES.hasOwnProperty(expected)) {
      throw new Error('unknown chord ' + expected + '; known: ' + CHORDS.join(', '));
    }
    var tuning = opts.tuning || 'standard';
    var threshold = opts.threshold != null ? opts.threshold : DEFAULT_THRESHOLD;
    var margin = opts.margin != null ? opts.margin : DEFAULT_MARGIN;
    var minPres = opts.minPresenceDb === undefined ? DEFAULT_MIN_PRESENCE_DB : opts.minPresenceDb;
    var feat = analyse(samples, fsIn, tuning);
    var scores = feat.scores, pres = feat.presence_db[expected];
    var d = decide(scores, expected, threshold, margin, pres, minPres);
    var argmax = CHORDS[0];
    CHORDS.forEach(function (c) { if (scores[c] > scores[argmax]) argmax = c; });
    return {
      onset_time_s: feat.onset_time_s,
      chroma: feat.chroma,
      scores: scores,
      argmax: argmax,
      presence_db: pres,
      accept: d.accept,
      confidence: d.confidence,
      lead: d.lead
    };
  }

  window.UkeGrader = {
    grade: grade,
    analyse: analyse,
    CHORDS: CHORDS,
    CHORD_SHAPES: CHORD_SHAPES,
    TUNINGS: TUNINGS,
    PC_NAMES: PC_NAMES,
    FS: FS,
    DEFAULTS: { threshold: DEFAULT_THRESHOLD, margin: DEFAULT_MARGIN, minPresenceDb: DEFAULT_MIN_PRESENCE_DB },
    // exposed for testing
    _resample: toFS
  };
})();
