'use strict';

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

/**
 * Zip an array of file paths into outputPath. Resolves once the archive is
 * fully written and closed.
 */
function createZip(filePaths, outputPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    output.on('close', () => resolve({ path: outputPath, bytes: archive.pointer() }));
    output.on('error', reject);
    archive.on('error', reject);
    archive.on('warning', (err) => {
      if (err.code !== 'ENOENT') reject(err);
    });

    archive.pipe(output);

    for (const f of filePaths) {
      archive.file(f, { name: path.basename(f) });
    }

    archive.finalize();
  });
}

module.exports = { createZip };
