// RemixSafe video worker
// Polls Supabase `jobs` table, runs ffmpeg transforms, uploads variants.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const ffmpeg = require('fluent-ffmpeg');
const fetch = require('node-fetch');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('[worker] missing SUPABASE_URL / SUPABASE_SERVICE_KEY in .env');
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const POLL_MS = parseInt(process.env.POLL_MS || '5000', 10);
const WORK_DIR = process.env.WORK_DIR || path.join(os.tmpdir(), 'remixsafe-worker');
fs.mkdirSync(WORK_DIR, { recursive: true });

console.log(`[worker] starting · polling every ${POLL_MS}ms · workdir ${WORK_DIR}`);
loop();

async function loop() {
  while (true) {
    try {
      const job = await claimJob();
      if (job) {
        console.log(`[worker] picked up job ${job.id} (${job.preset}, ${job.variant_count}x)`);
        await processJob(job);
      } else {
        await sleep(POLL_MS);
      }
    } catch (err) {
      console.error('[worker] loop error:', err);
      await sleep(POLL_MS);
    }
  }
}

// Atomically claim the oldest queued job by flipping its status to 'processing'.
async function claimJob() {
  // 1. find a queued job
  const { data: queued, error: qErr } = await admin
    .from('jobs')
    .select('*')
    .eq('status', 'queued')
    .order('created_at', { ascending: true })
    .limit(1);
  if (qErr) throw qErr;
  if (!queued || queued.length === 0) return null;
  const job = queued[0];

  // 2. try to flip it (still queued?)
  const { data: claimed, error: cErr } = await admin
    .from('jobs')
    .update({ status: 'processing', updated_at: new Date().toISOString() })
    .eq('id', job.id)
    .eq('status', 'queued')
    .select()
    .maybeSingle();
  if (cErr) throw cErr;
  return claimed || null; // null means another worker grabbed it
}

async function processJob(job) {
  const jobDir = path.join(WORK_DIR, job.id);
  fs.mkdirSync(jobDir, { recursive: true });
  const sourcePath = path.join(jobDir, 'source.mp4');

  try {
    // 1. Download source from storage
    console.log(`[worker] downloading source for ${job.id}`);
    const { data: blob, error: dlErr } = await admin
      .storage.from('sources').download(job.source_path);
    if (dlErr) throw new Error('download failed: ' + dlErr.message);
    const buf = Buffer.from(await blob.arrayBuffer());
    fs.writeFileSync(sourcePath, buf);

    // 2. Run N variants
    const variantUrls = [];
    for (let i = 0; i < job.variant_count; i++) {
      const outName = `variant_${String(i+1).padStart(2,'0')}_${crypto.randomBytes(3).toString('hex')}.mp4`;
      const outPath = path.join(jobDir, outName);
      console.log(`[worker]   encoding variant ${i+1}/${job.variant_count}`);
      await runVariant(sourcePath, outPath, job.preset, i);

      // 3. Upload to variants bucket
      const storagePath = `${job.user_id}/${job.id}/${outName}`;
      const data = fs.readFileSync(outPath);
      const { error: upErr } = await admin
        .storage.from('variants')
        .upload(storagePath, data, { contentType: 'video/mp4', upsert: true });
      if (upErr) throw new Error('upload failed: ' + upErr.message);

      const { data: pub } = admin.storage.from('variants').getPublicUrl(storagePath);
      variantUrls.push(pub.publicUrl);

      // Update progress incrementally so the UI can show it
      await admin.from('jobs').update({
        variant_urls: variantUrls,
        updated_at: new Date().toISOString(),
      }).eq('id', job.id);

      fs.unlinkSync(outPath);
    }

    // 4. Mark done
    await admin.from('jobs').update({
      status: 'done',
      variant_urls: variantUrls,
      updated_at: new Date().toISOString(),
    }).eq('id', job.id);
    console.log(`[worker] job ${job.id} done`);

  } catch (err) {
    console.error(`[worker] job ${job.id} failed:`, err);
    // Mark failed + refund remixes
    await admin.from('jobs').update({
      status: 'failed',
      error_message: String(err.message || err),
      updated_at: new Date().toISOString(),
    }).eq('id', job.id);
    await admin.from('ledger').insert({
      user_id: job.user_id,
      delta: job.variant_count,
      reason: `refund:${job.id}`,
    });
  } finally {
    // Clean up working dir
    try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch {}
  }
}

// ---------- ffmpeg transform pipeline ----------
const PRESETS = {
  tiktok:  { w: 1080, h: 1920, bitrate: '6M',  maxDuration: 60 },
  shorts:  { w: 1080, h: 1920, bitrate: '10M', maxDuration: 60 },
  reels:   { w: 1080, h: 1920, bitrate: '6M',  maxDuration: 90 },
};

function rand(min, max) { return min + Math.random() * (max - min); }

function runVariant(inPath, outPath, presetKey, seed) {
  const preset = PRESETS[presetKey] || PRESETS.tiktok;

  // Randomized parameters for this variant
  const zoom        = rand(1.02, 1.05);              // 2-5% zoom in
  const xOff        = rand(0, 1);                    // crop x offset 0..1
  const yOff        = rand(0, 1);
  const speed       = rand(0.97, 1.03);              // 97-103% speed
  const hueShift    = rand(-3, 3);                   // ±3 degrees
  const pitchPct    = rand(-0.02, 0.02);             // ±2% audio pitch
  const noiseAmt    = Math.floor(rand(2, 6));        // very low noise
  const trimStart   = +rand(0.03, 0.10).toFixed(3);  // ~1-3 frames @30fps
  const trimEnd     = +rand(0.03, 0.10).toFixed(3);

  // Audio: change sample rate (asetrate) then resample back. Net effect = pitch + slight tempo.
  const baseSR = 44100;
  const newSR  = Math.round(baseSR * (1 + pitchPct));

  // Build video filter chain
  // 1) scale up by `zoom`, crop back to target dims with random offset
  // 2) hue shift
  // 3) tiny noise
  // 4) setpts for speed
  const scaledW = Math.round(preset.w * zoom);
  const scaledH = Math.round(preset.h * zoom);
  const cropX = Math.round((scaledW - preset.w) * xOff);
  const cropY = Math.round((scaledH - preset.h) * yOff);

  const vf = [
    `scale=${scaledW}:${scaledH}:force_original_aspect_ratio=increase`,
    `crop=${preset.w}:${preset.h}:${cropX}:${cropY}`,
    `hue=h=${hueShift.toFixed(2)}`,
    `noise=alls=${noiseAmt}:allf=t`,
    `setpts=${(1/speed).toFixed(4)}*PTS`,
  ].join(',');

  const af = [
    `asetrate=${newSR}`,
    `aresample=${baseSR}`,
    `atempo=${speed.toFixed(4)}`,
  ].join(',');

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg(inPath)
      .setStartTime(trimStart)
      .videoFilters(vf)
      .audioFilters(af)
      .videoCodec('libx264')
      .audioCodec('aac')
      .outputOptions([
        '-pix_fmt yuv420p',
        '-preset veryfast',
        '-movflags +faststart',
        '-map_metadata -1',          // strip ALL original metadata
        '-metadata', `comment=remix-${crypto.randomBytes(4).toString('hex')}`,
        '-metadata', `encoder=remixsafe`,
        `-b:v ${preset.bitrate}`,
        `-maxrate ${preset.bitrate}`,
        `-bufsize ${parseInt(preset.bitrate) * 2}M`,
        `-t ${Math.max(1, preset.maxDuration - trimEnd - trimStart)}`,
      ])
      .on('start', cl => console.log(`[ffmpeg] ${cl.slice(0, 120)}…`))
      .on('error', reject)
      .on('end', resolve)
      .save(outPath);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
