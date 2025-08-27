// src/ffmpegs.js
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// escape helpers
function escText(t = '') {
  return String(t)
    .replace(/\\/g, '\\\\')  // backslashes
    .replace(/:/g, '\\:')    // colons
    .replace(/'/g, "\\'")    // single quotes
    .replace(/\[/g, '\\[')   // brackets
    .replace(/\]/g, '\\]');
}
function escPathForFilter(p = '') {
  // safest: forward slashes + escape colon + escape quotes
  return `'${String(p)
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")}'`;
}

function toMonoWav(input, outPath, ar = 22050) {
  return new Promise((resolve, reject) => {
    ffmpeg(input)
      .audioChannels(1)
      .audioFrequency(ar)
      .format('wav')
      .on('end', () => resolve(outPath))
      .on('error', reject)
      .save(outPath);
  });
}

function renderClip({
  inputAudio, startSec, durationSec, outPath,
  bgImage, title = '', subtitle = '',
  fontPath, qrPath
}) {
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg();

    // inputs:
    cmd.input(inputAudio).seekInput(startSec).duration(durationSec);

    if (bgImage) {
      cmd.input(bgImage).inputOptions(['-loop', '1']);
    } else {
      cmd.input(`color=c=black:s=1080x1920:d=${durationSec}`)
         .inputOptions(['-f', 'lavfi']);
    }

    if (qrPath) cmd.input(qrPath).inputOptions(['-loop', '1']);

    const fontArg = escPathForFilter(fontPath);
    const drw = (t, x, y, size) =>
      `drawtext=fontfile=${fontArg}:text='${escText(t)}':x=${x}:y=${y}:fontsize=${size}:fontcolor=white@0.95:shadowx=2:shadowy=2`;

    // Build filters
    const filters = [
      "[1:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920[bg]",
      "[0:a]showwaves=s=1080x640:mode=line:r=30,format=rgba[wv]",
      "[bg][wv]overlay=0:120,format=yuv420p[base]",
      `[base]${drw(title, 54, 48, 56)}[t1]`,
      `[t1]${drw(subtitle, 54, 122, 36)}[t2]`
    ];

    if (qrPath) {
      filters.push("[2:v]scale=220:220[qr]");
      filters.push("[t2][qr]overlay=W-w-44:H-h-44[vfinal]");
    } else {
      filters.push("[t2]null[vfinal]");  // ensure vfinal always exists
    }

    // Attach filter graph
    cmd.complexFilter(filters, ['vfinal']);

    // Output options
    cmd.outputOptions([   // video from filter graph
      "-map", "0:a",        // audio from input
      "-c:v", "libx264",
      "-c:a", "aac",
      "-b:a", "192k",
      "-pix_fmt", "yuv420p",
      "-r", "30",
      "-shortest",
      "-movflags", "+faststart",
      "-map_metadata", "-1",
      "-map_chapters", "-1"
    ])
      .on('stderr', line => { if (process.env.FFMPEG_LOG) console.log(line); })
      .on('end', () => resolve(outPath))
      .on('error', reject)
      .save(outPath);
  });
}

module.exports = { toMonoWav, renderClip };
