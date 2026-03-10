'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const ROMS_DIR = path.join(__dirname, '../uploads/roms');
const ALLOWED_EXTENSIONS = ['.gba', '.gbc', '.gb', '.nds', '.zip'];

/**
 * Compute the MD5 checksum of a file.
 * @param {string} filePath
 * @returns {Promise<string>}
 */
function computeChecksum(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
    stream.on('data', d => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Scan the uploads/roms directory and insert any ROM files that are not
 * already tracked in the database (matched by storedFilename).
 * @returns {Promise<number>} Number of ROMs added
 */
async function scanRoms() {
  if (!fs.existsSync(ROMS_DIR)) return 0;

  const files = fs.readdirSync(ROMS_DIR).filter(f => {
    const ext = path.extname(f).toLowerCase();
    return ALLOWED_EXTENSIONS.includes(ext);
  });

  if (files.length === 0) return 0;

  // Load all existing storedFilenames from the database
  const existingRoms = await new Promise((resolve, reject) => {
    db.roms.find({}, { storedFilename: 1 }, (err, docs) => {
      if (err) return reject(err);
      resolve(docs);
    });
  });
  const knownFiles = new Set(existingRoms.map(r => r.storedFilename));

  let added = 0;

  for (const file of files) {
    if (knownFiles.has(file)) continue;

    const filePath = path.join(ROMS_DIR, file);

    let stat;
    try {
      stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;
    } catch {
      continue;
    }

    let checksum;
    try {
      checksum = await computeChecksum(filePath);
    } catch {
      continue;
    }

    const relPath = path.relative(path.join(__dirname, '..'), filePath);
    const displayName = file
      .replace(/^\d{10,}_/, '')              // strip leading timestamp prefix (10+ digits)
      .replace(/\.[^.]+$/, '')               // strip extension
      .replace(/[_-]/g, ' ')                 // convert separators to spaces
      .trim() || file;

    const ext = path.extname(file).toLowerCase();
    const consoleType = ext === '.nds' ? 'nds' : 'gba';

    const romDoc = {
      filename: file,
      storedFilename: file,
      displayName,
      filePath: relPath,
      fileSize: stat.size,
      checksum,
      consoleType,
      uploadedBy: null,
      createdAt: new Date(),
    };

    await new Promise((resolve, reject) => {
      db.roms.insert(romDoc, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    added++;
    console.log(`ROM scanned and added: ${file} → "${displayName}"`);
  }

  return added;
}

module.exports = { scanRoms };
