'use strict';
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// The romScanner module under test
const { scanRoms } = require('../src/romScanner');
const db = require('../src/db');

const ROMS_DIR = path.join(__dirname, '../uploads/roms');

/**
 * Helper: write a small fake ROM file and return its expected MD5.
 */
function writeFakeRom(filename, content) {
  const filePath = path.join(ROMS_DIR, filename);
  fs.writeFileSync(filePath, content);
  return crypto.createHash('md5').update(content).digest('hex');
}

/**
 * Helper: remove all documents from the roms collection.
 */
function clearRomsDb() {
  return new Promise((resolve, reject) => {
    db.roms.remove({}, { multi: true }, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

/**
 * Helper: count documents in the roms collection.
 */
function countRoms() {
  return new Promise((resolve, reject) => {
    db.roms.count({}, (err, n) => {
      if (err) return reject(err);
      resolve(n);
    });
  });
}

/**
 * Helper: find a rom by storedFilename.
 */
function findRom(storedFilename) {
  return new Promise((resolve, reject) => {
    db.roms.findOne({ storedFilename }, (err, doc) => {
      if (err) return reject(err);
      resolve(doc);
    });
  });
}

/**
 * Helper: clean up any test ROM files from the uploads/roms directory.
 */
function cleanTestFiles(filenames) {
  for (const f of filenames) {
    const p = path.join(ROMS_DIR, f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

describe('ROM Scanner', () => {
  const testFiles = [
    'test_rom_1.gba',
    'test_rom_2.gbc',
    'test_rom_3.gb',
    'test_rom_4.zip',
    'test_not_a_rom.txt',
    '1700000000_Test Game.gba',
    'test_nds_rom.nds',
  ];

  beforeEach(async () => {
    // Ensure the upload directory exists
    if (!fs.existsSync(ROMS_DIR)) fs.mkdirSync(ROMS_DIR, { recursive: true });
    // Ensure clean state
    await clearRomsDb();
    cleanTestFiles(testFiles);
  });

  afterEach(async () => {
    await clearRomsDb();
    cleanTestFiles(testFiles);
  });

  it('should add ROM files from the uploads/roms directory to the database', async () => {
    const content = Buffer.from('FAKE_GBA_ROM_DATA');
    const expectedChecksum = writeFakeRom('test_rom_1.gba', content);

    const added = await scanRoms();

    assert.equal(added, 1, 'should have added exactly 1 ROM');

    const rom = await findRom('test_rom_1.gba');
    assert.ok(rom, 'ROM should exist in DB');
    assert.equal(rom.filename, 'test_rom_1.gba');
    assert.equal(rom.storedFilename, 'test_rom_1.gba');
    assert.equal(rom.displayName, 'test rom 1');
    assert.equal(rom.checksum, expectedChecksum);
    assert.equal(rom.fileSize, content.length);
    assert.equal(rom.uploadedBy, null);
  });

  it('should not add files that are already in the database', async () => {
    writeFakeRom('test_rom_1.gba', Buffer.from('ROM'));

    const first = await scanRoms();
    assert.equal(first, 1);

    // Run scan again – nothing new should be added
    const second = await scanRoms();
    assert.equal(second, 0);

    const total = await countRoms();
    assert.equal(total, 1, 'should still have exactly 1 ROM');
  });

  it('should scan multiple ROM file extensions (.gba, .gbc, .gb, .nds, .zip)', async () => {
    writeFakeRom('test_rom_1.gba', Buffer.from('gba'));
    writeFakeRom('test_rom_2.gbc', Buffer.from('gbc'));
    writeFakeRom('test_rom_3.gb', Buffer.from('gb'));
    writeFakeRom('test_rom_4.zip', Buffer.from('zip'));
    writeFakeRom('test_nds_rom.nds', Buffer.from('nds'));

    const added = await scanRoms();
    assert.equal(added, 5);

    const total = await countRoms();
    assert.equal(total, 5);
  });

  it('should ignore files with unsupported extensions', async () => {
    writeFakeRom('test_rom_1.gba', Buffer.from('rom'));
    fs.writeFileSync(path.join(ROMS_DIR, 'test_not_a_rom.txt'), 'not a rom');

    const added = await scanRoms();
    assert.equal(added, 1, 'should only add the .gba file');
  });

  it('should strip timestamp prefix from display name', async () => {
    writeFakeRom('1700000000_Test Game.gba', Buffer.from('rom'));

    await scanRoms();

    const rom = await findRom('1700000000_Test Game.gba');
    assert.ok(rom);
    assert.equal(rom.displayName, 'Test Game');
  });

  it('should return 0 when the uploads/roms directory is empty', async () => {
    const added = await scanRoms();
    assert.equal(added, 0);
  });

  it('should return 0 when the uploads/roms directory does not exist', async () => {
    // Temporarily rename the directory so it doesn't exist
    const tmpDir = ROMS_DIR + '_bak';
    if (fs.existsSync(ROMS_DIR)) fs.renameSync(ROMS_DIR, tmpDir);
    try {
      const added = await scanRoms();
      assert.equal(added, 0);
    } finally {
      if (fs.existsSync(tmpDir)) fs.renameSync(tmpDir, ROMS_DIR);
      else fs.mkdirSync(ROMS_DIR, { recursive: true });
    }
  });

  it('should set consoleType to "nds" for .nds files', async () => {
    writeFakeRom('test_nds_rom.nds', Buffer.from('NDS_ROM'));

    await scanRoms();

    const rom = await findRom('test_nds_rom.nds');
    assert.ok(rom, 'NDS ROM should exist in DB');
    assert.equal(rom.consoleType, 'nds', 'consoleType should be "nds" for .nds files');
  });

  it('should set consoleType to "gba" for .gba files', async () => {
    writeFakeRom('test_rom_1.gba', Buffer.from('GBA_ROM'));

    await scanRoms();

    const rom = await findRom('test_rom_1.gba');
    assert.ok(rom, 'GBA ROM should exist in DB');
    assert.equal(rom.consoleType, 'gba', 'consoleType should be "gba" for .gba files');
  });
});
