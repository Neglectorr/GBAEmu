'use strict';
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

// Get save data for a ROM
router.get('/:romId', requireAuth, (req, res) => {
  db.saves.findOne({ userId: req.user._id, romId: req.params.romId }, (err, save) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    if (!save) return res.status(404).json({ error: 'No save found' });
    // Return base64-encoded save data (stored as a base64 string in NeDB)
    res.json({
      romId: save.romId,
      data: save.data || null,
      updatedAt: save.updatedAt,
    });
  });
});

// Upload/update save data
router.put('/:romId', requireAuth, (req, res) => {
  const { data } = req.body; // base64 encoded save data
  if (!data) return res.status(400).json({ error: 'No save data provided' });

  // Validate the base64 data by decoding it, then check size
  let buffer;
  try {
    buffer = Buffer.from(data, 'base64');
  } catch {
    return res.status(400).json({ error: 'Invalid base64 data' });
  }

  if (buffer.length > 2 * 1024 * 1024) { // 2 MB max save size (NDS / modified ROMs)
    return res.status(400).json({ error: 'Save file too large' });
  }

  // Reject uninitialized SRAM (all 0xFF bytes) – this is not real save data
  // and would waste database space with a huge base64 blob of slashes.
  const isBlank = buffer.every(b => b === 0xFF);
  if (isBlank) {
    return res.status(400).json({ error: 'Save data is uninitialized (all 0xFF)' });
  }

  // Store the save as a base64 string (not a Buffer) because NeDB serialises
  // data as JSON and Buffers do not survive the round-trip intact.
  const query = { userId: req.user._id, romId: req.params.romId };
  db.saves.remove(query, { multi: true }, (removeErr) => {
    if (removeErr) return res.status(500).json({ error: 'Failed to save' });
    db.saves.insert({ ...query, data, updatedAt: new Date() }, (insertErr) => {
      if (insertErr) return res.status(500).json({ error: 'Failed to save' });
      // Compact the datafile so stale records from the remove are purged
      db.saves.compactDatafile();
      res.json({ success: true });
    });
  });
});

// Delete save data
router.delete('/:romId', requireAuth, (req, res) => {
  db.saves.remove({ userId: req.user._id, romId: req.params.romId }, { multi: true }, (err) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json({ success: true });
  });
});

module.exports = router;
