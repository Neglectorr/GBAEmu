'use strict';
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const lobbyManager = require('../socket/lobbyManager');

// List all open lobbies
router.get('/', requireAuth, (req, res) => {
  res.json(lobbyManager.getPublicLobbies());
});

// Get a specific lobby
router.get('/:id', requireAuth, (req, res) => {
  const lobby = lobbyManager.getLobby(req.params.id);
  if (!lobby) return res.status(404).json({ error: 'Lobby not found' });
  res.json(lobby.toPublic());
});

module.exports = router;
