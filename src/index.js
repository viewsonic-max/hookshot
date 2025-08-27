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
  genrePresets,
  rmsSeries // optional if you still use it elsewhere
} = require('./energy');
const { toMonoWav, renderClip } = require('./ffmpegs');

// tiny unicode sparkline
function spark(arr, width = 40) {
  const ticks = '▁▂▃▄▅▆▇█';
  if (!arr.length) return '';
  const min = Math.min(...arr), max = Math.max(...arr);
  const rng = max - min || 1;
  // downsample to width
  const step = Math.max(1, Math.floor(arr.length / width));
  let out = '';
  for (let i = 0; i < arr.length; i += step) {
    const v = (arr[i] - min) / rng;
    out += ticks[Math.min(ticks.length - 1, Math.floor(v * (ticks.length)))] || ticks[0];
  }
  return out;
}

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('in', { alias: 'i', type: 'string', demandOption: true, desc: 'Input audio (mp3/wav)' })
    .option('out', { alias: 'o', type: 'string', default: 'hookshot.mp4', desc: 'Output MP4 path' })
    .option('duration', { alias: 'd', type: 'number', default: 17, desc: 'Clip duration seconds' })
    .option('title', { type: 'string', default: '', desc: 'Top title text' })
    .option('subtitle', { type: 'string', default: '', desc: 'Subtitle (e.g., @artist · generated on Suno)' })
    .option('bg', { type: 'string', desc: 'Background image (optional)' })
    .option('qr', { type: 'string', desc: 'QR link to overlay (optional)' })
    .option('genre', { type: 'string', default: 'hiphop', desc: 'pop|hiphop|electronic|rock|acoustic' })
    .option('font', { type: 'string', default: path.join(__dirname, '../assets/Inter-Bold.ttf'), desc: 'TTF font for drawtext' })
    .help().argv;

  const audioIn = path.resolve(argv.in);
  if (!fs.existsSync(audioIn)) throw new Error(`Audio file not found: ${audioIn}`);

  // 1) Convert to analysis WAV
  const tmpWav = tmp.tmpNameSync({ postfix: '.wav' });
  await toMonoWav(audioIn, tmpWav, 22050);

  // 2) Feature-based hook pick
  const { mono, sampleRate } = decodeMonoWav(tmpWav);

  const preset = genrePresets[argv.genre?.toLowerCase()] || genrePresets.hiphop;
  let { startSec, score, features, frameSec } = findBestHook({
    samples: mono,
    sampleRate,
    windowSec: argv.duration,
    weights: preset
  });

  console.log(`Hook chosen at ${startSec.toFixed(2)}s (score ${score.toFixed(3)})`);
  if (features?.energy && features?.novelty) {
    console.log('energy :', spark(Array.from(features.energy)));
    console.log('novelty:', spark(Array.from(features.novelty)));
  }

  // Guard rails
  const approxDur = mono.length / sampleRate;
  if (startSec + argv.duration > approxDur) {
    startSec = Math.max(0, approxDur - argv.duration);
  }

  // 3) Optional QR
  let qrPath = null;
  if (argv.qr) {
    qrPath = tmp.tmpNameSync({ postfix: '.png' });
    await QRCode.toFile(qrPath, argv.qr, { margin: 0, width: 512 });
  }

  // 4) Render
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
