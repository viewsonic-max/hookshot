// enhanced-energy.js - Advanced hook detection with unified feature extraction

const FFT = require('fft.js');
const wav = require('node-wav');
const fs = require('fs');

// ---------- Utils ----------
function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

function applyHannWindow(buf) {
  const N = buf.length;
  for (let i = 0; i < N; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
    buf[i] *= w;
  }
}

// Compute magnitude spectrum using fft.js (N must be pow2 >= 2)
function computeFFT(samples) {
  const N = samples.length;
  if (N < 2) return new Float32Array(2);

  const f = new FFT(N);
  const out = f.createComplexArray();
  const data = f.createComplexArray();

  // real -> complex (imag=0)
  for (let i = 0; i < N; i++) {
    data[2 * i] = samples[i];
    data[2 * i + 1] = 0;
  }

  f.transform(out, data);

  // magnitudes for bins [0..N/2)
  const mags = new Float32Array(N >> 1);
  for (let k = 0; k < mags.length; k++) {
    const re = out[2 * k];
    const im = out[2 * k + 1];
    mags[k] = Math.hypot(re, im);
  }
  return mags;
}

// ---------- I/O ----------
function decodeMonoWav(path) {
  const buffer = fs.readFileSync(path);
  const { sampleRate, channelData } = wav.decode(buffer);
  const mono = channelData.length === 1
    ? channelData[0]
    : channelData.reduce((a, ch) => a.map((v, i) => (v + ch[i]) / channelData.length));
  return { mono, sampleRate };
}

// ---------- UNIFIED FEATURE EXTRACTION ----------
// This is the key optimization: extract all features in a single pass
function extractAllFeatures(samples, sampleRate, frameSec = 0.1) {
  const targetSize = Math.max(2, Math.floor(sampleRate * frameSec));
  const frameSize = nextPow2(targetSize);
  const hop = Math.floor(frameSize / 2);
  const nFrames = Math.max(1, Math.floor((samples.length - frameSize) / hop) + 1);
  
  // Preallocate all feature arrays for efficiency
  const features = {
    energy: new Float32Array(nFrames),
    centroid: new Float32Array(nFrames),
    zcr: new Float32Array(nFrames),
    spectralFlux: new Float32Array(nFrames),
    // We'll compute novelty as a post-processing step since it depends on energy
    novelty: null
  };
  
  // Working buffers to avoid repeated allocations
  const frame = new Float32Array(frameSize);
  const windowedFrame = new Float32Array(frameSize);
  let prevMags = null;
  
  // Configuration for ZCR
  const eps = 1e-4;  // Dead zone threshold for zero crossing detection
  const removeDC = true;  // Remove DC component for more accurate ZCR
  
  for (let i = 0; i < nFrames; i++) {
    const start = i * hop;
    
    // Extract frame once - this is the key optimization
    for (let j = 0; j < frameSize; j++) {
      frame[j] = samples[start + j] ?? 0;
    }
    
    // 1. Compute RMS energy (before windowing, as windowing reduces energy)
    let sum = 0;
    for (let j = 0; j < frameSize; j++) {
      sum += frame[j] * frame[j];
    }
    features.energy[i] = Math.sqrt(sum / frameSize);
    
    // 2. Zero Crossing Rate (computed on raw frame, not windowed)
    // This detects percussive/rhythmic content
    let mean = 0;
    if (removeDC) {
      // Calculate mean for DC removal
      for (let j = 0; j < frameSize; j++) mean += frame[j];
      mean /= frameSize;
    }
    
    const sgn = (x) => (x > eps ? 1 : x < -eps ? -1 : 0);
    let crossings = 0;
    let prev = sgn(frame[0] - mean);
    
    for (let j = 1; j < frameSize; j++) {
      const curr = sgn(frame[j] - mean);
      // Count actual sign changes, ignoring transitions through zero-zone
      if (prev !== 0 && curr !== 0 && prev !== curr) crossings++;
      // Update prev only when we leave the dead zone
      if (prev === 0 && curr !== 0) prev = curr;
      else if (curr !== 0) prev = curr;
    }
    features.zcr[i] = crossings / (frameSize - 1);
    
    // 3. Apply Hann window for spectral analysis
    // Windowing reduces spectral leakage in FFT
    for (let j = 0; j < frameSize; j++) {
      windowedFrame[j] = frame[j];
    }
    applyHannWindow(windowedFrame);
    
    // 4. Compute FFT once (expensive operation)
    const mags = computeFFT(windowedFrame);
    
    // 5. Spectral centroid (brightness indicator)
    let weightedSum = 0, magSum = 0;
    const binHz = sampleRate / frameSize;  // Frequency resolution
    for (let k = 0; k < mags.length; k++) {
      const freq = k * binHz;
      const m = mags[k];
      weightedSum += freq * m;
      magSum += m;
    }
    features.centroid[i] = magSum > 0 ? weightedSum / magSum : 0;
    
    // 6. Spectral flux (detects sudden changes better than simple novelty)
    if (prevMags) {
      let flux = 0;
      for (let k = 0; k < mags.length; k++) {
        // Only count positive differences (onset detection)
        const diff = mags[k] - prevMags[k];
        if (diff > 0) flux += diff;
      }
      features.spectralFlux[i] = flux;
    } else {
      features.spectralFlux[i] = 0;  // First frame has no flux
    }
    
    // Store current mags for next iteration
    prevMags = new Float32Array(mags);
  }
  
  // 7. Compute novelty from energy series (post-processing step)
  // This is more efficient than spectral flux for energy-based novelty
  features.novelty = computeNovelty(features.energy);
  
  // Return all features with metadata
  return {
    features,
    frameSec: hop / sampleRate,  // Actual frame timing
    frameSize,
    hop,
    nFrames
  };
}

// Compute novelty score from any time series
function computeNovelty(series) {
  const novelty = new Float32Array(series.length);
  novelty[0] = 0;
  
  // Detect positive differences (onsets)
  for (let i = 1; i < series.length; i++) {
    novelty[i] = Math.max(0, series[i] - series[i - 1]);
  }
  
  // Apply smoothing to reduce noise
  const smoothed = new Float32Array(series.length);
  const windowSize = 5;
  
  for (let i = 0; i < series.length; i++) {
    let sum = 0, count = 0;
    // Centered moving average
    for (let j = Math.max(0, i - windowSize); 
         j <= Math.min(series.length - 1, i + windowSize); j++) {
      sum += novelty[j];
      count++;
    }
    smoothed[i] = sum / count;
  }
  
  return smoothed;
}

// ---------- Legacy Feature Extraction (for backward compatibility) ----------
function rmsSeries(samples, sampleRate, frameSec = 0.1) {
  const desired = Math.max(2, Math.floor(sampleRate * frameSec));
  const frame = nextPow2(desired);
  const hop = Math.floor(frame / 2);

  const n = Math.max(1, Math.floor((samples.length - frame) / hop) + 1);
  const out = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    let sum = 0;
    const off = i * hop;
    for (let j = 0; j < frame; j++) {
      const s = samples[off + j] || 0;
      sum += s * s;
    }
    out[i] = Math.sqrt(sum / frame);
  }
  return { series: out, frameSec: frame / sampleRate };
}

function spectralCentroid(samples, sampleRate, frameSec = 0.1) {
  const result = extractAllFeatures(samples, sampleRate, frameSec);
  return result.features.centroid;
}

function zeroCrossingRate(
  samples,
  sampleRate,
  frameSec = 0.0464,
  hopRatio = 0.5,
  eps = 1e-4,
  removeDC = true
) {
  // For compatibility, we'll use the unified extractor with adjusted params
  const result = extractAllFeatures(samples, sampleRate, frameSec);
  const outFrameSec = result.frameSize / sampleRate;
  
  return { 
    ratio: result.features.zcr,
    perSec: result.features.zcr.map(r => r * sampleRate / result.frameSize),
    frameSec: outFrameSec 
  };
}

function noveltyScore(series) {
  return computeNovelty(series);
}

// ---------- Optimized Hook Finding ----------
function findBestHook({
  samples,
  sampleRate,
  windowSec = 17,
  weights = { energy: 0.4, centroid: 0.2, zcr: 0.15, novelty: 0.25 },
  useUnifiedExtraction = true  // Flag to use optimized extraction
}) {
  let features, frameSec;
  
  if (useUnifiedExtraction) {
    // Use the optimized single-pass extraction
    const result = extractAllFeatures(samples, sampleRate, 0.1);
    features = result.features;
    frameSec = result.frameSec;
  } else {
    // Fall back to legacy multi-pass extraction for compatibility
    const { series: energy, frameSec: energyStep } = rmsSeries(samples, sampleRate, 0.1);
    const centroid = spectralCentroid(samples, sampleRate, 0.1);
    const { ratio: zcrRatio } = zeroCrossingRate(samples, sampleRate, 0.0464);
    const novelty = noveltyScore(energy);
    
    features = { energy, centroid, zcr: zcrRatio, novelty };
    frameSec = energyStep;
  }
  
  // Align all features to same length (spectral flux might be shorter)
  const L = Math.min(
    features.energy.length,
    features.centroid.length,
    features.zcr.length,
    features.novelty.length
  );
  
  // Slice to common length
  const e = features.energy.slice(0, L);
  const c = features.centroid.slice(0, L);
  const z = features.zcr.slice(0, L);
  const n = features.novelty.slice(0, L);
  
  // Normalize each feature to [0, 1] range
  const normalize = (arr) => {
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] < min) min = arr[i];
      if (arr[i] > max) max = arr[i];
    }
    const range = (max - min) || 1;
    const out = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      out[i] = (arr[i] - min) / range;
    }
    return out;
  };
  
  const E = normalize(e);
  const C = normalize(c);
  const Z = normalize(z);
  const N = normalize(n);
  
  // Compute weighted score for each frame
  const scores = new Float32Array(L);
  for (let i = 0; i < L; i++) {
    scores[i] = weights.energy * E[i]
              + weights.centroid * C[i]
              + weights.zcr * Z[i]
              + weights.novelty * N[i];
  }
  
  // Find best window using prefix sum optimization
  const win = Math.max(1, Math.floor(windowSec / frameSec));
  const ps = new Float32Array(L + 1);
  for (let i = 0; i < L; i++) ps[i + 1] = ps[i] + scores[i];
  
  let best = -Infinity, bestIdx = 0;
  for (let i = 0; i + win <= L; i++) {
    // Bonus for dramatic entrance (novelty peak before window)
    const entrance = i > 0 ? N[i - 1] * 0.2 : 0;
    // Average score in window using prefix sum
    const avg = (ps[i + win] - ps[i]) / win + entrance;
    if (avg > best) {
      best = avg;
      bestIdx = i;
    }
  }
  
  return {
    startSec: bestIdx * frameSec,
    score: best,
    features: {
      energy: E.slice(bestIdx, bestIdx + win),
      centroid: C.slice(bestIdx, bestIdx + win),
      zcr: Z.slice(bestIdx, bestIdx + win),
      novelty: N.slice(bestIdx, bestIdx + win)
    },
    frameSec
  };
}

// ---------- Genre Presets ----------
const genrePresets = {
  pop:        { energy: 0.3,  centroid: 0.3,  zcr: 0.15, novelty: 0.25 },
  hiphop:     { energy: 0.4,  centroid: 0.2,  zcr: 0.25, novelty: 0.15 },
  electronic: { energy: 0.25, centroid: 0.25, zcr: 0.2,  novelty: 0.3  },
  rock:       { energy: 0.45, centroid: 0.2,  zcr: 0.2,  novelty: 0.15 },
  acoustic:   { energy: 0.2,  centroid: 0.3,  zcr: 0.1,  novelty: 0.4  }
};

// ---------- Exports ----------
module.exports = {
  // Core I/O
  decodeMonoWav,
  
  // Unified extraction (new, optimized)
  extractAllFeatures,
  
  // Legacy individual feature extractors (maintained for compatibility)
  rmsSeries,
  spectralCentroid,
  zeroCrossingRate,
  noveltyScore,
  
  // Hook detection
  findBestHook,
  genrePresets,
  
  // Legacy API for backward compatibility
  bestWindowStartSec: (series, frameSec, windowSec) => {
    const win = Math.max(1, Math.round(windowSec / frameSec));
    let bestSum = -Infinity, bestIdx = 0, curr = 0;
    for (let i = 0; i < series.length; i++) {
      curr += series[i];
      if (i >= win) curr -= series[i - win];
      if (i >= win - 1 && curr > bestSum) {
        bestSum = curr;
        bestIdx = i - win + 1;
      }
    }
    return bestIdx * frameSec;
  }
};