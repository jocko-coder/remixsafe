'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { supabase } = require('./supabase');
const { downloadSource, uploadZip } = require('./storage');
const { generateVariants, PRESETS } = require('./pipeline');
const { createZip } = require('./zip');

const POLL_INTERVAL_MS = 5000;
const TMP_ROOT = path.join(os.tmpdir(), 'remixsafe');

function ts() {
  return new Date().toISOString();
}
function log(...args) {
  console.log(`[${ts()}]`, ...args);
}
function errlog(...args) {
  console.error(`[${ts()}]`, ...args);
}

async function rmrf(dir) {
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
  } catch (e) {
    errlog(`cleanup failed for ${dir}: ${e.message}`);
  }
}

async function testConnection() {
  try {
    const { error } = await supabase.from('jobs').select('id').limit(1);
    if (error) {
      errlog(`Supabase connection FAILED: ${error.message}`);
      return false;
    }
    log('Supabase connection OK');
    return true;
  } catch (e) {
    errlog(`Supabase connection threw: ${e.message}`);
    return false;
  }
}

async function fetchNextJob() {
  const { data, error } = await supabase
    .from('jobs')
    .select('*')
    .eq('status', 'queued')
    .order('created_at', { ascending: true })
    .limit(1);

  if (error) {
    errlog(`fetchNextJob error: ${error.message}`);
    return null;
  }
  return data && data.length ? data[0] : null;
}

async function claimJob(jobId) {
  // Optimistic claim: only update if still queued.
  const { data, error } = await supabase
    .from('jobs')
    .update({ status: 'processing', started_at: new Date().toISOString() })
    .eq('id', jobId)
    .eq('status', 'queued')
    .select()
    .limit(1);

  if (error) {
    errlog(`claimJob error: ${error.message}`);
    return null;
  }
  return data && data.length ? data[0] : null;
}

async function markDone(jobId, zipUrl, variantCount) {
  const { error } = await supabase
    .from('jobs')
    .update({
      status: 'done',
      output_url: zipUrl,
      variant_urls: [zipUrl],
      variant_count_actual: variantCount,
      finished_at: new Date().toISOString(),
      error_message: null,
    })
    .eq('id', jobId);
  if (error) errlog(`markDone error: ${error.message}`);
}

async function markFailed(jobId, message) {
  const { error } = await supabase
    .from('jobs')
    .update({
      status: 'failed',
      error_message: String(message).slice(0, 2000),
      finished_at: new Date().toISOString(),
    })
    .eq('id', jobId);
  if (error) errlog(`markFailed error: ${error.message}`);
}

async function processJob(job) {
  const jobId = job.id;
  const workDir = path.join(TMP_ROOT, String(jobId));
  const variantsDir = path.join(workDir, 'variants');
  const sourcePath = job.source_path || job.source_url || job.input_path;
  const preset = (job.preset || job.platform || 'tiktok').toLowerCase();
  const count = parseInt(job.variant_count || job.count || 5, 10);

  if (!sourcePath) throw new Error('Job is missing source_path');
  if (!PRESETS[preset]) throw new Error(`Unsupported preset: ${preset}`);

  log(`Job ${jobId}: preset=${preset} count=${count} source=${sourcePath}`);

  await fs.promises.mkdir(variantsDir, { recursive: true });

  const ext = path.extname(sourcePath) || '.mp4';
  const localInput = path.join(workDir, `source${ext}`);

  log(`Job ${jobId}: downloading source...`);
  await downloadSource(supabase, sourcePath, localInput);

  log(`Job ${jobId}: generating variants...`);
  const variantFiles = await generateVariants(localInput, variantsDir, preset, count);
  log(`Job ${jobId}: produced ${variantFiles.length} variant(s)`);

  const zipPath = path.join(workDir, 'variants.zip');
  log(`Job ${jobId}: zipping...`);
  const { bytes } = await createZip(variantFiles, zipPath);
  log(`Job ${jobId}: zip ready (${(bytes / 1024 / 1024).toFixed(2)} MB)`);

  log(`Job ${jobId}: uploading zip...`);
  const url = await uploadZip(supabase, jobId, zipPath);
  log(`Job ${jobId}: uploaded -> ${url}`);

  return { url, variantCount: variantFiles.length };
}

async function tick() {
  let job = null;
  try {
    job = await fetchNextJob();
    if (!job) return;

    const claimed = await claimJob(job.id);
    if (!claimed) {
      // Another worker grabbed it.
      return;
    }
    job = claimed;
    log(`Processing job ${job.id}...`);

    let result;
    try {
      result = await processJob(job);
      await markDone(job.id, result.url, result.variantCount);
      log(`Job ${job.id}: DONE`);
    } catch (e) {
      errlog(`Job ${job.id}: FAILED — ${e.message}`);
      await markFailed(job.id, e.message);
    } finally {
      await rmrf(path.join(TMP_ROOT, String(job.id)));
    }
  } catch (e) {
    errlog(`tick error: ${e.stack || e.message}`);
    if (job && job.id) {
      try { await markFailed(job.id, e.message); } catch (_) {}
      await rmrf(path.join(TMP_ROOT, String(job.id)));
    }
  }
}

async function main() {
  log('RemixSafe worker starting...');
  await fs.promises.mkdir(TMP_ROOT, { recursive: true });
  await testConnection();

  let running = true;
  const shutdown = (sig) => {
    log(`Received ${sig}, shutting down after current tick...`);
    running = false;
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('uncaughtException', (e) => errlog(`uncaughtException: ${e.stack || e.message}`));
  process.on('unhandledRejection', (e) => errlog(`unhandledRejection: ${e && e.stack ? e.stack : e}`));

  while (running) {
    await tick();
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch((e) => {
  errlog(`fatal: ${e.stack || e.message}`);
  process.exit(1);
});
