'use strict';
/**
 * Save-state API – server-side quick-save storage.
 *
 * This is intentionally separate from the in-game .sav persistence in
 * saves.js (which stores battery/SRAM data to saves.db).  Save states
 * capture the full emulator snapshot and are stored in savestates.db so
 * the two systems never interfere with each other.
 *
 * Only quick-save slot 1 is stored server-side.
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

// Maximum save-state size – 8 MB (mGBA snapshots are typically 300-400 KB,
// but we allow headroom for NDS or unusual cores).
const MAX_STATE_SIZE = 8 * 1024 * 1024;

// Get save state for a ROM (slot 1)
router.get('/:romId', requireAuth, (req, res) => {
  db.savestates.findOne(
    { userId: req.user._id, romId: req.params.romId, slot: 1 },
    (err, doc) => {
      if (err) return res.status(500).json({ error: 'Database error' });
      if (!doc) return res.status(404).json({ error: 'No save state found' });
      res.json({
        romId: doc.romId,
        slot: doc.slot,
        data: doc.data || null,
        updatedAt: doc.updatedAt,
      });
    }
  );
});

// Upload/update save state (slot 1)
router.put('/:romId', requireAuth, (req, res) => {
  const { data } = req.body; // base64 encoded save-state data
  if (!data) return res.status(400).json({ error: 'No save state data provided' });

  // Validate the base64 data
  let buffer;
  try {
    buffer = Buffer.from(data, 'base64');
  } catch {
    return res.status(400).json({ error: 'Invalid base64 data' });
  }

  if (buffer.length > MAX_STATE_SIZE) {
    return res.status(400).json({ error: 'Save state too large' });
  }

  if (buffer.length === 0) {
    return res.status(400).json({ error: 'Save state data is empty' });
  }

  const query = { userId: req.user._id, romId: req.params.romId, slot: 1 };
  db.savestates.remove(query, { multi: true }, (removeErr) => {
    if (removeErr) return res.status(500).json({ error: 'Failed to save state' });
    db.savestates.insert(
      { ...query, data, updatedAt: new Date() },
      (insertErr) => {
        if (insertErr) return res.status(500).json({ error: 'Failed to save state' });
        db.savestates.compactDatafile();
        res.json({ success: true });
      }
    );
  });
});

// Delete save state
router.delete('/:romId', requireAuth, (req, res) => {
  db.savestates.remove(
    { userId: req.user._id, romId: req.params.romId, slot: 1 },
    { multi: true },
    (err) => {
      if (err) return res.status(500).json({ error: 'Database error' });
      res.json({ success: true });
    }
  );
});

module.exports = router;
