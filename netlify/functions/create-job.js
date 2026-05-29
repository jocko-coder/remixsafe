// POST /create-job
// Body: { preset, variant_count, filename, size }
// Returns: { job, upload_url, upload_path }
const { getUser, json } = require('./_lib');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });

  const { user, admin, error } = await getUser(event);
  if (error) return json(401, { error });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid json' }); }

  const { preset, variant_count, filename, size } = body;
  if (!['tiktok', 'shorts', 'reels'].includes(preset)) return json(400, { error: 'invalid preset' });
  const count = parseInt(variant_count, 10);
  if (!Number.isInteger(count) || count < 1 || count > 10) return json(400, { error: 'variant_count must be 1-10' });
  if (size && size > 200 * 1024 * 1024) return json(400, { error: 'file too large (max 200MB)' });

  // Billing disabled — all users get free access during beta

  // Create job row
  const safeName = (filename || 'source.mp4').replace(/[^a-z0-9._-]/gi, '_');
  const jobId = crypto.randomUUID();
  const sourcePath = `${user.id}/${jobId}/${safeName}`;

  const { data: job, error: insErr } = await admin
    .from('jobs')
    .insert({
      id: jobId,
      user_id: user.id,
      preset,
      variant_count: count,
      status: 'queued',
      source_path: sourcePath,
    })
    .select()
    .single();
  if (insErr) return json(500, { error: 'job insert failed: ' + insErr.message });

  // Signed upload URL for source video
  const { data: upload, error: upErr } = await admin
    .storage
    .from('sources')
    .createSignedUploadUrl(sourcePath);
  if (upErr) return json(500, { error: 'signed url failed: ' + upErr.message });

  return json(200, {
    job,
    upload_url: upload.signedUrl,
    upload_path: sourcePath,
    token: upload.token,
  });
};

// Polyfill crypto.randomUUID for older Node
if (typeof crypto === 'undefined') {
  global.crypto = require('crypto').webcrypto;
}
