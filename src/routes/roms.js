'use strict';
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

// List available ROMs
router.get('/', requireAuth, (req, res) => {
  db.roms.find({}).sort({ displayName: 1 }).exec((err, roms) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json(roms.map(r => ({
      _id: r._id,
      displayName: r.displayName,
      filename: r.filename,
      fileSize: r.fileSize,
      consoleType: r.consoleType || 'gba',
      createdAt: r.createdAt,
    })));
  });
});

// Get a single ROM's metadata
router.get('/:id', requireAuth, (req, res) => {
  db.roms.findOne({ _id: req.params.id }, (err, rom) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    if (!rom) return res.status(404).json({ error: 'ROM not found' });
    res.json({
      _id: rom._id,
      displayName: rom.displayName,
      filename: rom.filename,
      fileSize: rom.fileSize,
      consoleType: rom.consoleType || 'gba',
      createdAt: rom.createdAt,
    });
  });
});

// Get ROMs that are link-cable-compatible with a given ROM
router.get('/:id/compatible', requireAuth, (req, res) => {
  const { getCompatibleRoms } = require('../pokemon-compat');
  db.roms.findOne({ _id: req.params.id }, (err, sourceRom) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    if (!sourceRom) return res.status(404).json({ error: 'ROM not found' });

    db.roms.find({ consoleType: sourceRom.consoleType || 'gba' }).sort({ displayName: 1 }).exec((err2, allRoms) => {
      if (err2) return res.status(500).json({ error: 'Database error' });

      const compat = getCompatibleRoms(sourceRom.displayName, allRoms);
      res.json(compat.map(r => ({
        _id: r._id,
        displayName: r.displayName,
        filename: r.filename,
        fileSize: r.fileSize,
        consoleType: r.consoleType || 'gba',
        createdAt: r.createdAt,
      })));
    });
  });
});

// Download ROM binary (streamed to authenticated users)
router.get('/:id/download', requireAuth, (req, res) => {
  const path = require('path');
  const fs = require('fs');

  db.roms.findOne({ _id: req.params.id }, (err, rom) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    if (!rom) return res.status(404).json({ error: 'ROM not found' });

    const filePath = path.join(__dirname, '../../', rom.filePath);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'ROM file not found on disk' });
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${rom.filename}"`);
    res.setHeader('Content-Length', rom.fileSize);
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    fs.createReadStream(filePath).pipe(res);
  });
});

module.exports = router;
