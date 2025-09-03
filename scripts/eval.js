// prints which method each song picked and the start time.
// drop some test audio in ./samples
const fs = require('fs');
const path = require('path');
const { decodeMonoWav } = require('../src/energy');
const { toMonoWav } = require('../src/ffmpegs');
const { findBestHook, genrePresets } = require('../src/energy');
const { findChorusHook } = require('../src/sections');
const tmp = require('tmp');

async function analyzeOne(p, duration = 17, genre = 'hiphop') {
  let wav = p;
  if (!/\.wav$/i.test(p)) {
    const t = tmp.tmpNameSync({ postfix: '.wav' });
    await toMonoWav(p, t, 22050);
    wav = t;
  }
  const { mono, sampleRate } = decodeMonoWav(wav);
  const a = findBestHook({ samples: mono, sampleRate, windowSec: duration, weights: genrePresets[genre] || genrePresets.hiphop });
  const b = findChorusHook({ samples: mono, sampleRate, windowSec: duration });

  const pick = (b.score > a.score * 1.05) ? { method: 'chorus', ...b } : { method: 'energy', ...a };
  return { energy: a.startSec, chorus: b.startSec, pick };
}

(async () => {
  const dir = path.join(process.cwd(), 'samples');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /\.(wav|mp3)$/i.test(f)) : [];
  if (!files.length) { console.log('No samples/*.wav|*.mp3 found'); process.exit(0); }
  console.log('file,energy_sec,chorus_sec,picked,score');
  for (const f of files) {
    const p = path.join(dir, f);
    const res = await analyzeOne(p);
    console.log([f, res.energy.toFixed(2), res.chorus.toFixed(2), res.pick.method, res.pick.score.toFixed(3)].join(','));
  }
})();
