#!/usr/bin/env node
const path = require('path');
const fs = require('fs-extra');
const tmp = require('tmp');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const QRCode = require('qrcode');

const {
  decodeMonoWav,
  findBestHook,
  genrePresets
} = require('./energy');
const { toMonoWav, renderClip } = require('./ffmpegs');

/* ---------------- Sparkline + debug helpers ---------------- */
const SPARKS = '▁▂▃▄▅▆▇█';
function spark(arr, width = 40) {
  if (!arr || !arr.length) return '';
  let mn = Infinity, mx = -Infinity;
  for (const v of arr) { if (v < mn) mn = v; if (v > mx) mx = v; }
  const rng = (mx - mn) || 1;
  const step = Math.max(1, Math.floor(arr.length / width));
  let out = '';
  for (let i = 0; i < arr.length; i += step) {
    const t = (arr[i] - mn) / rng;
    out += SPARKS[Math.min(7, Math.max(0, Math.floor(t * 7)))];
  }
  return out;
}

function printDebug(chosen, argv) {
  // Energy path: preview energy + novelty bars (if present)
  if (chosen?.features?.energy && chosen?.features?.novelty) {
    console.log('energy :', spark(Array.from(chosen.features.energy)));
    console.log('novelty:', spark(Array.from(chosen.features.novelty)));
  }
  // Chorus path: preview repetition bar over the selected window
  if (chosen?.method === 'chorus' && chosen?.repetition && chosen?.frameSec != null) {
    const rep = Array.from(chosen.repetition);
    const winFrames = Math.max(8, Math.floor(argv.duration / chosen.frameSec));
    const startFrame = Math.max(0, Math.min(rep.length - 1, Math.round(chosen.startSec / chosen.frameSec)));
    const slice = rep.slice(startFrame, startFrame + winFrames);
    if (slice.length) console.log('repeat :', spark(slice));
  }
}

/* ---------------- Main ---------------- */
async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('in',       { alias: 'i', type: 'string', demandOption: true, desc: 'Input audio (mp3/wav)' })
    .option('out',      { alias: 'o', type: 'string', default: 'hookshot.mp4', desc: 'Output MP4 path' })
    .option('duration', { alias: 'd', type: 'number', default: 17, desc: 'Clip duration seconds' })
    .option('title',    { type: 'string', default: '', desc: 'Top title text' })
    .option('subtitle', { type: 'string', default: '', desc: 'Subtitle (e.g., @artist · generated on Suno)' })
    .option('bg',       { type: 'string', desc: 'Background image (optional)' })
    .option('qr',       { type: 'string', desc: 'QR link to overlay (optional)' })
    .option('genre',    { type: 'string', default: 'hiphop', desc: 'pop|hiphop|electronic|rock|acoustic' })
    .option('font',     { type: 'string', default: path.join(__dirname, '../assets/Inter-Bold.ttf'), desc: 'TTF font for drawtext' })
    .option('method',   { type: 'string', default: 'auto', desc: 'auto|energy|chorus' })
    .help()
    .argv;

  const audioIn = path.resolve(argv.in);
  if (!fs.existsSync(audioIn)) throw new Error(`Audio file not found: ${audioIn}`);

  // 1) Convert to analysis WAV (mono 22.05kHz)
  const tmpWav = tmp.tmpNameSync({ postfix: '.wav' });
  await toMonoWav(audioIn, tmpWav, 22050);

  // 2) Decode analysis wav → mono pcm + sampleRate
  const { mono, sampleRate } = decodeMonoWav(tmpWav);

  // 3) Optional chorus detector (lazy load)
  let findChorusHook;
  let chorusAvail = false;
  try {
    ({ findChorusHook } = require('./sections'));
    chorusAvail = typeof findChorusHook === 'function';
  } catch (_) {
    chorusAvail = false;
  }

  // 4) Pick method
  const preset = genrePresets[argv.genre?.toLowerCase()] || genrePresets.hiphop;
  let chosen;

  if (argv.method === 'chorus') {
    if (!chorusAvail) {
      console.warn('⚠️ chorus requested but unavailable — falling back to energy.');
      const a = findBestHook({ samples: mono, sampleRate, windowSec: argv.duration, weights: preset });
      chosen = { ...a, method: 'energy' };
    } else {
      const b = findChorusHook({ samples: mono, sampleRate, windowSec: argv.duration });
      chosen = { ...b, method: 'chorus' };
    }
  } else if (argv.method === 'energy') {
    const a = findBestHook({ samples: mono, sampleRate, windowSec: argv.duration, weights: preset });
    chosen = { ...a, method: 'energy' };
  } else {
    // auto: compare normalized scores
    const a = findBestHook({ samples: mono, sampleRate, windowSec: argv.duration, weights: preset });
    let b = null;
    if (chorusAvail) b = findChorusHook({ samples: mono, sampleRate, windowSec: argv.duration });

    if (!b) {
      chosen = { ...a, method: 'energy', normScore: 1 };
    } else {
      const norm = (s, lo, hi) => (s - lo) / ((hi - lo) || 1);
      const aN = norm(a.score, a.scoreMin ?? a.score, a.scoreMax ?? a.score + 1e-9);
      const bN = norm(b.score, b.scoreMin ?? b.score, b.scoreMax ?? b.score + 1e-9);
      chosen = (bN > aN * 1.05) ? { ...b, method: 'chorus', normScore: bN }
                                : { ...a, method: 'energy', normScore: aN };
    }
  }

  let { startSec, score, frameSec } = chosen;
  console.log(`Method: ${chosen.method} · start=${startSec.toFixed(2)}s · score=${(chosen.normScore ?? score).toFixed(3)}`);
  printDebug(chosen, argv);

  // 5) Guard rails: keep clip inside total duration
  const approxDur = mono.length / sampleRate;
  if (startSec + argv.duration > approxDur) {
    startSec = Math.max(0, approxDur - argv.duration);
  }

  // 6) Optional QR image
  let qrPath = null;
  if (argv.qr) {
    qrPath = tmp.tmpNameSync({ postfix: '.png' });
    await QRCode.toFile(qrPath, argv.qr, { margin: 0, width: 512 });
  }

  // 7) Render MP4
  const outPath = path.resolve(argv.out);
  await renderClip({
    inputAudio: audioIn,
    startSec,
    durationSec: argv.duration,
    outPath,
    bgImage: argv.bg ? path.resolve(argv.bg) : null,
    title: argv.title,
    subtitle: argv.subtitle,
    fontPath: path.resolve(argv.font),
    qrPath
  });

  console.log(`\n✅ Hookshot complete.`);
  console.log(`Start @ ${startSec.toFixed(2)}s · Duration ${argv.duration}s`);
  console.log(`Output → ${outPath}\n`);
}

main().catch((e) => {
  console.error('❌ Error:\n', e && e.stack ? e.stack : e);
  process.exit(1);
});
