'use strict';

const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');

const PRESETS = {
  tiktok:  { width: 1080, height: 1920, maxDuration: 60, crf: 23, audioBitrate: '128k' },
  shorts:  { width: 1080, height: 1920, maxDuration: 60, crf: 23, audioBitrate: '128k' },
  reels:   { width: 1080, height: 1920, maxDuration: 90, crf: 22, audioBitrate: '128k' },
};

const SAMPLE_RATE = 44100;

/**
 * Probe input duration in seconds (best-effort, returns null on failure).
 */
function probeDuration(inputPath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err || !metadata || !metadata.format) return resolve(null);
      const d = parseFloat(metadata.format.duration);
      resolve(Number.isFinite(d) ? d : null);
    });
  });
}

/**
 * Deterministic-but-varied pseudo-random in [0,1) seeded by (i, salt).
 */
function rand01(i, salt) {
  const x = Math.sin((i + 1) * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function randRange(i, salt, lo, hi) {
  return lo + rand01(i, salt) * (hi - lo);
}

/**
 * Build the filter complex string and audio filter for a single variant.
 */
function buildVariantFilters(i, preset) {
  const { width, height } = preset;

  // 1. Crop/zoom jitter: scale up by 1.01..1.05 then crop center back to W x H.
  const zoom = randRange(i, 1, 1.01, 1.05);
  const scaledW = Math.round(width * zoom);
  const scaledH = Math.round(height * zoom);

  // 2. Speed variation 0.97..1.03 (video: setpts=1/speed*PTS; audio: atempo=speed)
  const speed = randRange(i, 2, 0.97, 1.03);
  const ptsFactor = (1 / speed).toFixed(6);

  // 3. Mirror — 33% chance
  const mirror = rand01(i, 3) < 0.33;

  // 4. Hue shift -8..+8 deg
  const hueShift = randRange(i, 4, -8, 8).toFixed(3);

  // 5. Brightness ±0.03, contrast 1 ± 0.03 (eq filter: contrast around 1.0)
  const brightness = randRange(i, 5, -0.03, 0.03).toFixed(4);
  const contrast = (1 + randRange(i, 6, -0.03, 0.03)).toFixed(4);

  // 6. Audio pitch shift -2..+2 semitones
  const semitones = randRange(i, 7, -2, 2);
  const newRate = Math.round(SAMPLE_RATE * Math.pow(2, semitones / 12));

  // 7. Frame trim 0..3 frames at start
  const trimFrames = Math.floor(rand01(i, 8) * 4); // 0..3

  // ---- Build video filter chain ----
  const vParts = [];
  if (trimFrames > 0) {
    vParts.push(`trim=start_frame=${trimFrames}`);
    vParts.push('setpts=PTS-STARTPTS');
  }
  // scale to slightly larger, then center-crop back
  vParts.push(`scale=${scaledW}:${scaledH}:flags=lanczos`);
  vParts.push(`crop=${width}:${height}:(in_w-${width})/2:(in_h-${height})/2`);
  if (mirror) vParts.push('hflip');
  vParts.push(`hue=h=${hueShift}`);
  vParts.push(`eq=brightness=${brightness}:contrast=${contrast}`);
  vParts.push(`setpts=${ptsFactor}*PTS`);

  // ---- Build audio filter chain ----
  // atempo must be in [0.5, 2.0] — our speed is 0.97..1.03 so we're safe single-pass.
  const aParts = [];
  // strip leading samples roughly equivalent to trimmed frames (~ trimFrames/30s)
  if (trimFrames > 0) {
    const aTrimSec = (trimFrames / 30).toFixed(4);
    aParts.push(`atrim=start=${aTrimSec}`);
    aParts.push('asetpts=PTS-STARTPTS');
  }
  aParts.push(`asetrate=${newRate}`);
  aParts.push(`aresample=${SAMPLE_RATE}`);
  aParts.push(`atempo=${speed.toFixed(6)}`);

  return {
    videoFilter: vParts.join(','),
    audioFilter: aParts.join(','),
    meta: { speed, zoom, mirror, hueShift, brightness, contrast, semitones, trimFrames },
  };
}

/**
 * Generate `count` unique variants from inputPath into outputDir.
 * Returns array of output file paths.
 */
async function generateVariants(inputPath, outputDir, preset, count) {
  const cfg = PRESETS[preset];
  if (!cfg) throw new Error(`Unknown preset: ${preset}`);

  const desired = Math.max(1, parseInt(count, 10) || 1);
  await fs.promises.mkdir(outputDir, { recursive: true });

  const duration = await probeDuration(inputPath);
  // If we have a tiny clip, cap variant count by ceil(duration) so we don't waste cycles.
  let effectiveCount = desired;
  if (duration && duration < desired) {
    effectiveCount = Math.max(1, Math.ceil(duration));
  }

  const outputs = [];
  for (let i = 0; i < effectiveCount; i++) {
    const outPath = path.join(outputDir, `variant_${String(i + 1).padStart(3, '0')}.mp4`);
    await renderOne(inputPath, outPath, cfg, i);
    outputs.push(outPath);
  }
  return outputs;
}

function renderOne(inputPath, outPath, cfg, i) {
  return new Promise((resolve, reject) => {
    const { videoFilter, audioFilter } = buildVariantFilters(i, cfg);
    const encoderTag = `rsx-${Date.now().toString(36)}-${i}`;

    const cmd = ffmpeg(inputPath)
      .outputOptions([
        '-y',
        '-loglevel', 'error',
        '-map_metadata', '-1',
        '-t', String(cfg.maxDuration),
      ])
      .videoFilters(videoFilter)
      .audioFilters(audioFilter)
      .videoCodec('libx264')
      .outputOptions([
        '-preset', 'veryfast',
        '-crf', String(cfg.crf),
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
      ])
      .audioCodec('aac')
      .audioBitrate(cfg.audioBitrate)
      .outputOptions([
        '-metadata', `encoder=${encoderTag}`,
        '-metadata', `comment=${encoderTag}`,
      ])
      .on('error', (err, _stdout, stderr) => {
        reject(new Error(`ffmpeg failed on variant ${i + 1}: ${err.message}${stderr ? ' | ' + stderr.slice(-400) : ''}`));
      })
      .on('end', () => resolve(outPath))
      .save(outPath);

    // Just to ensure cmd reference isn't GC'd warning-free
    void cmd;
  });
}

module.exports = { generateVariants, PRESETS };
