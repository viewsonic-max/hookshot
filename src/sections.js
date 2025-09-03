// src/sections.js
// Chorus / repetition detector via chroma self-similarity (pure JS)

const FFT = require('fft.js');

/* -------------------- small helpers -------------------- */
function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

function hann(N) {
  const w = new Float32Array(N);
  for (let i = 0; i < N; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
  return w;
}

function cos(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const d = (Math.sqrt(na) * Math.sqrt(nb)) || 1;
  return dot / d;
}

function safeCell(S, r, c) {
  const row = S[r];
  if (!row) return 0;
  return (c >= 0 && c < row.length) ? row[c] : 0;
}

function smooth1D(x, win = 5) {
  if (!x || !x.length || win <= 1) return x;
  const y = new Float32Array(x.length);
  const half = Math.floor(win / 2);
  for (let i = 0; i < x.length; i++) {
    let s = 0, c = 0;
    for (let j = i - half; j <= i + half; j++) {
      if (j < 0 || j >= x.length) continue;
      s += x[j]; c++;
    }
    y[i] = s / (c || 1);
  }
  return y;
}

/* -------------------- STFT + chroma -------------------- */
function stftMag(samples, sampleRate, frameSec = 0.0464, hopRatio = 0.5) {
  const target = Math.max(2, Math.floor(sampleRate * frameSec));
  const N = nextPow2(target);
  const H = Math.max(1, Math.floor(N * hopRatio));
  const W = hann(N);

  const frames = Math.max(1, Math.floor((samples.length - N) / H) + 1);
  const fft = new FFT(N);
  const out = fft.createComplexArray();
  const buf = fft.createComplexArray();

  const mags = Array(frames);
  for (let i = 0; i < frames; i++) {
    const off = i * H;
    for (let j = 0; j < N; j++) {
      const s = samples[off + j] || 0;
      buf[2 * j] = s * W[j];
      buf[2 * j + 1] = 0;
    }
    fft.transform(out, buf);

    const half = N >> 1;
    const m = new Float32Array(half);
    for (let k = 0; k < half; k++) {
      const re = out[2 * k], im = out[2 * k + 1];
      m[k] = Math.hypot(re, im);
    }
    mags[i] = m;
  }
  return { mags, frameSec: N / sampleRate };
}

function chromaFromMag(mag, sampleRate) {
  const n = mag.length;
  const chroma = new Float32Array(12);
  for (let k = 1; k < n; k++) {
    const freq = (k * sampleRate) / (2 * n);
    if (freq < 80 || freq > 5000) continue; // focus on midband
    const pitch = 69 + 12 * Math.log2(freq / 440);
    const cls = ((Math.round(pitch) % 12) + 12) % 12; // 0..11
    chroma[cls] += mag[k];
  }
  // L2 normalize
  let s = 0;
  for (let i = 0; i < 12; i++) s += chroma[i] * chroma[i];
  const norm = Math.sqrt(s) || 1;
  for (let i = 0; i < 12; i++) chroma[i] /= norm;
  return chroma;
}

function chromaSeries(samples, sampleRate, frameSec = 0.0464, hopRatio = 0.5) {
  const { mags, frameSec: step } = stftMag(samples, sampleRate, frameSec, hopRatio);
  const C = new Array(mags.length);
  for (let i = 0; i < mags.length; i++) C[i] = chromaFromMag(mags[i], sampleRate);
  return { C, frameSec: step };
}

/* -------------------- self-similarity & repetition -------------------- */
function selfSimilarity(C) {
  const N = C.length;
  const S = Array(N);
  for (let i = 0; i < N; i++) {
    S[i] = new Float32Array(N);
    for (let j = 0; j < N; j++) S[i][j] = cos(C[i], C[j]); // [-1,1]
  }
  return S;
}

// Edge-compensated, bidirectional repetition scoring.
// Averages across valid stripes and normalizes to [0,1].
function repetitionScore(S, w, opts = {}) {
  const N = S.length;
  const R = new Float32Array(N);
  if (N === 0) return R;

  const W = Math.max(1, Math.min(w, N));

  const frameSec   = opts.frameSec ?? 0.0464;
  const minLagSec  = opts.minLagSec ?? 6;
  const maxLagSec  = opts.maxLagSec ?? 45;
  const lagStepSec = opts.lagStepSec ?? 0.25;
  const bidir      = opts.bidirectional ?? true;

  const minLag  = Math.max(1, Math.round(minLagSec / frameSec));
  const maxLag  = Math.max(minLag + 1, Math.round(maxLagSec / frameSec));
  const lagStep = Math.max(1, Math.round(lagStepSec / frameSec));

  for (let i = 0; i < N; i++) {
    let sum = 0, count = 0;

    // forward lags (i -> i + d)
    for (let d = minLag; d <= maxLag; d += lagStep) {
      if (i + d + W > N) continue;
      let stripe = 0;
      for (let k = 0; k < W; k++) {
        stripe += safeCell(S, i + k, i + d + k);
      }
      sum += stripe / W; count++;
    }

    if (bidir) {
      // backward lags (i -> i - d)
      for (let d = minLag; d <= maxLag; d += lagStep) {
        if (i - d < 0 || i - d + W > N) continue;
        let stripe = 0;
        for (let k = 0; k < W; k++) {
          stripe += safeCell(S, i + k, i - d + k);
        }
        sum += stripe / W; count++;
      }
    }

    R[i] = count ? (sum / count) : 0;
  }

  // normalize R to [0,1]
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < N; i++) { if (R[i] < mn) mn = R[i]; if (R[i] > mx) mx = R[i]; }
  const rng = (mx - mn) || 1;
  for (let i = 0; i < N; i++) R[i] = (R[i] - mn) / rng;

  return R;
}

/* -------------------- public API -------------------- */
function findChorusHook({ samples, sampleRate, windowSec = 17 }) {
  // Build chroma sequence
  const { C, frameSec } = chromaSeries(samples, sampleRate, 0.0464, 0.5);
  const N = C.length;

  // If no frames, return a safe default
  if (!N) {
    return {
      startSec: 0,
      score: 0,
      scoreMin: 0,
      scoreMax: 1,
      frameSec: 0.0464,
      repetition: new Float32Array(0)
    };
  }

  // Self-similarity + repetition
  const w = Math.max(8, Math.floor(windowSec / frameSec));
  const S = selfSimilarity(C);

  const Rraw = repetitionScore(S, w, {
    frameSec,
    minLagSec: 6,
    maxLagSec: Math.min(60, Math.max(30, 3 * windowSec)), // adapt with clip size
    lagStepSec: 0.25,
    bidirectional: true
  });

  const R = smooth1D(Rraw, 5);

  // Windowed search (mean over R), track range for normalization
  const ps = new Float32Array(R.length + 1);
  for (let i = 0; i < R.length; i++) ps[i + 1] = ps[i] + R[i];

  let best = -Infinity, bestIdx = 0;
  let scoreMin = Infinity, scoreMax = -Infinity;
  const W = Math.max(1, Math.min(w, R.length));
  for (let i = 0; i + W <= R.length; i++) {
    const score = (ps[i + W] - ps[i]) / W;
    if (score > best) { best = score; bestIdx = i; }
    if (score < scoreMin) scoreMin = score;
    if (score > scoreMax) scoreMax = score;
  }

  // Guard: if scores were constant/NaN, fall back safely
  if (!isFinite(best)) {
    return {
      startSec: 0,
      score: 0,
      scoreMin: 0,
      scoreMax: 1,
      frameSec,
      repetition: R
    };
  }

  return {
    startSec: bestIdx * frameSec,
    score: best,
    scoreMin,
    scoreMax,
    frameSec,
    repetition: R
  };
}

module.exports = {
  chromaSeries,
  selfSimilarity,
  repetitionScore,
  findChorusHook
};
