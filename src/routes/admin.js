'use strict';
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');

const ROMS_DIR = path.join(__dirname, '../../uploads/roms');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, ROMS_DIR),
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}_${safeName}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1 GB max (modified ROMs can be 600-700 MB)
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowed = ['.gba', '.gbc', '.gb', '.nds', '.zip'];
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only GBA/GBC/GB/NDS ROM files are allowed'));
    }
  },
});

// Upload a new ROM (admin only)
router.post('/upload', requireAdmin, (req, res) => {
  upload.single('rom')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const { originalname, filename, size, path: filePath } = req.file;
    const displayName = req.body.displayName || path.basename(originalname, path.extname(originalname));

    // Compute checksum
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
    stream.on('data', d => hash.update(d));
    stream.on('end', () => {
      const checksum = hash.digest('hex');
      const relPath = path.relative(path.join(__dirname, '../..'), filePath);
      const ext = path.extname(originalname).toLowerCase();
      const consoleType = ext === '.nds' ? 'nds' : 'gba';

      const romDoc = {
        filename: originalname,
        storedFilename: filename,
        displayName,
        filePath: relPath,
        fileSize: size,
        checksum,
        consoleType,
        uploadedBy: req.user._id,
        createdAt: new Date(),
      };

      db.roms.insert(romDoc, (insErr, rom) => {
        if (insErr) return res.status(500).json({ error: 'Failed to save ROM metadata' });
        res.json({ success: true, rom: { _id: rom._id, displayName: rom.displayName, filename: rom.filename } });
      });
    });
    stream.on('error', () => res.status(500).json({ error: 'Failed to process ROM file' }));
  });
});

// Delete a ROM (admin only)
router.delete('/roms/:id', requireAdmin, (req, res) => {
  db.roms.findOne({ _id: req.params.id }, (err, rom) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    if (!rom) return res.status(404).json({ error: 'ROM not found' });

    // Resolve absolute file path and ensure it stays within the uploads directory
    const uploadsDir = path.resolve(__dirname, '../../uploads');
    const filePath = path.resolve(__dirname, '../../', rom.filePath || '');
    const safeToDelete = filePath.startsWith(path.normalize(uploadsDir) + path.sep);

    db.roms.remove({ _id: req.params.id }, {}, (removeErr) => {
      if (removeErr) return res.status(500).json({ error: 'Failed to delete ROM' });
      if (safeToDelete) {
        fs.unlink(filePath, () => {}); // best effort file deletion
      }
      res.json({ success: true });
    });
  });
});

// List all users (admin only)
router.get('/users', requireAdmin, (req, res) => {
  db.users.find({}).sort({ createdAt: -1 }).exec((err, users) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json(users.map(u => ({
      _id: u._id,
      email: u.email,
      displayName: u.displayName,
      avatarUrl: u.avatarUrl,
      isAdmin: u.isAdmin,
      createdAt: u.createdAt,
    })));
  });
});

// Toggle admin status
router.patch('/users/:id/admin', requireAdmin, (req, res) => {
  if (req.params.id === req.user._id) {
    return res.status(400).json({ error: 'Cannot modify your own admin status' });
  }
  db.users.findOne({ _id: req.params.id }, (err, user) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    if (!user) return res.status(404).json({ error: 'User not found' });
    db.users.update({ _id: req.params.id }, { $set: { isAdmin: !user.isAdmin } }, {}, (updErr) => {
      if (updErr) return res.status(500).json({ error: 'Update failed' });
      res.json({ success: true, isAdmin: !user.isAdmin });
    });
  });
});

module.exports = router;
