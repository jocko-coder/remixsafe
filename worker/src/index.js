'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const { supabase } = require('./supabase');
const { downloadSource, uploadZip } = require('./storage');
const { generateVariants, PRESETS } = require('./pipeline');
const { createZip } = require('./zip');

const POLL_INTERVAL_MS = 5000;
const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
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
      variant_urls: [zipUrl],
      variant_count_actual: variantCount,
      updated_at: new Date().toISOString(),
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

async function sendDoneEmail(userId, jobId, zipUrl) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    log(`sendDoneEmail: RESEND_API_KEY not set, skipping email for job ${jobId}`);
    return;
  }

  let userEmail = null;
  try {
    const { data, error } = await supabase.auth.admin.getUserById(userId);
    if (error) {
      errlog(`sendDoneEmail: failed to fetch user ${userId}: ${error.message}`);
      return;
    }
    userEmail = data && data.user && data.user.email;
  } catch (e) {
    errlog(`sendDoneEmail: getUserById threw: ${e.message}`);
    return;
  }

  if (!userEmail) {
    log(`sendDoneEmail: no email for user ${userId}, skipping`);
    return;
  }

  const shortId = String(jobId).slice(0, 8);
  const body = {
    from: 'RemixSafe <noreply@remixsafe.com>',
    to: [userEmail],
    subject: `Your variants are ready — Job #${shortId}`,
    text: `Your RemixSafe job is done! Download your variants ZIP here: ${zipUrl}\n\nLogin to your dashboard: https://remixsafe.netlify.app/app/index.html`,
  };

  try {
    const fetch = require('node-fetch');
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      errlog(`sendDoneEmail: Resend API error ${res.status}: ${text}`);
    } else {
      log(`sendDoneEmail: email sent to ${userEmail} for job ${shortId}`);
    }
  } catch (e) {
    errlog(`sendDoneEmail: fetch threw: ${e.message}`);
  }
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
  const variantFiles = await generateVariants(localInput, variantsDir, preset, count, async (i, total) => {
    // Progress callback: update error_message after each variant is encoded
    await supabase
      .from('jobs')
      .update({
        error_message: `${i + 1}/${total} variants encoded`,
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId);
    log(`Job ${jobId}: progress ${i + 1}/${total}`);
  });
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

function startHealthServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  });
  server.listen(3000, () => {
    log('Health server listening on port 3000');
  });
  server.on('error', (e) => {
    errlog(`Health server error: ${e.message}`);
  });
  return server;
}

async function tick(state) {
  let job = null;
  try {
    job = await fetchNextJob();
    if (!job) {
      // Track idle time
      const idleMs = Date.now() - state.idleSince;
      const idleMin = Math.floor(idleMs / 60000);
      const remainMin = Math.ceil((IDLE_TIMEOUT_MS - idleMs) / 60000);
      if (idleMs >= IDLE_TIMEOUT_MS) {
        log(`Idle for ${idleMin}m, exiting (Fly will restart on next job)`);
        process.exit(0);
      } else if (idleMs > 5 * 60 * 1000) {
        log(`[idle ${idleMin}m] no jobs, will exit in ${remainMin}m`);
      }
      return;
    }

    // Reset idle timer when a job is found
    state.idleSince = Date.now();

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

      // Send email notification
      const userId = job.user_id;
      if (userId) {
        await sendDoneEmail(userId, job.id, result.url);
      }
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

  startHealthServer();

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

  const state = { idleSince: Date.now() };

  while (running) {
    await tick(state);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch((e) => {
  errlog(`fatal: ${e.stack || e.message}`);
  process.exit(1);
});
