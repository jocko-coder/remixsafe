'use strict';

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const SOURCES_BUCKET = 'sources';
const VARIANTS_BUCKET = 'variants';

/**
 * Download a file from the `sources` bucket to a local path.
 * Tries signed URL first (works for private buckets), falls back to direct download.
 */
async function downloadSource(supabase, sourcePath, localPath) {
  await fs.promises.mkdir(path.dirname(localPath), { recursive: true });

  // Prefer signed URL — streams large files without buffering through the SDK.
  const { data: signed, error: signErr } = await supabase
    .storage
    .from(SOURCES_BUCKET)
    .createSignedUrl(sourcePath, 60 * 10);

  if (!signErr && signed && signed.signedUrl) {
    const res = await fetch(signed.signedUrl);
    if (!res.ok) {
      throw new Error(`Source download failed (${res.status}): ${sourcePath}`);
    }
    await streamToFile(res.body, localPath);
    return localPath;
  }

  // Fallback: SDK download (buffers into memory).
  const { data, error } = await supabase
    .storage
    .from(SOURCES_BUCKET)
    .download(sourcePath);

  if (error || !data) {
    throw new Error(`Source download failed for ${sourcePath}: ${error ? error.message : 'no data'}`);
  }

  const buf = Buffer.from(await data.arrayBuffer());
  await fs.promises.writeFile(localPath, buf);
  return localPath;
}

/**
 * Upload zipped variants to the `variants` bucket at {jobId}/variants.zip.
 * Returns a public URL (bucket assumed public) — if bucket is private, returns
 * a long-lived signed URL instead.
 */
async function uploadZip(supabase, jobId, localZipPath) {
  const remotePath = `${jobId}/variants.zip`;
  const fileBuffer = await fs.promises.readFile(localZipPath);

  const { error: upErr } = await supabase
    .storage
    .from(VARIANTS_BUCKET)
    .upload(remotePath, fileBuffer, {
      contentType: 'application/zip',
      upsert: true,
    });

  if (upErr) {
    throw new Error(`ZIP upload failed: ${upErr.message}`);
  }

  // Try public URL first
  const { data: pub } = supabase.storage.from(VARIANTS_BUCKET).getPublicUrl(remotePath);
  if (pub && pub.publicUrl) {
    // Verify the public URL is reachable; if not, fall back to signed.
    try {
      const head = await fetch(pub.publicUrl, { method: 'HEAD' });
      if (head.ok) return pub.publicUrl;
    } catch (_) {
      // ignore — will sign below
    }
  }

  const { data: signed, error: signErr } = await supabase
    .storage
    .from(VARIANTS_BUCKET)
    .createSignedUrl(remotePath, 60 * 60 * 24 * 7); // 7 days

  if (signErr || !signed) {
    throw new Error(`Could not create signed URL for ${remotePath}: ${signErr ? signErr.message : 'unknown'}`);
  }
  return signed.signedUrl;
}

function streamToFile(stream, localPath) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(localPath);
    stream.pipe(out);
    stream.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
  });
}

module.exports = { downloadSource, uploadZip };
