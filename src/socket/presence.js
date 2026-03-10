'use strict';
/**
 * Player Presence System – server-side relay
 *
 * Inspired by TheHunterManX/GBA-PK-multiplayer, which uses Lua scripts running
 * inside a desktop mGBA instance to read player position from GBA memory over
 * TCP sockets.  We reproduce the same concept in a web context: each player's
 * browser reads their position from the mGBA WASM heap and sends it here; the
 * server relays state updates to every other player in the same lobby so each
 * client can render an overlay showing where their teammates are.
 *
 * Socket.IO namespace: /presence
 *
 * Events (client → server):
 *   presence:join   { lobbyId }               – join the presence room
 *   presence:update { mapBank, mapId, x, y,   – broadcast player state
 *                     direction, animation,      (rate-limited: 100ms min)
 *                     gameCode }
 *   presence:leave  {}                         – leave the presence room
 *
 * Events (server → client):
 *   presence:joined { playerIndex }            – ack for presence:join
 *   presence:state  { playerIndex, mapBank,    – another player's state
 *                     mapId, x, y, direction,
 *                     animation, gameCode,
 *                     timestamp }
 *   presence:left   { playerIndex }            – player left / disconnected
 */

const lobbyManager = require('./lobbyManager');

// Minimum milliseconds between accepted presence:update events per socket.
// This limits each player to at most 10 state-updates per second.
const UPDATE_RATE_LIMIT_MS = 100;

module.exports = function setupPresenceSocket(io) {
  const presenceNS = io.of('/presence');

  presenceNS.on('connection', (socket) => {
    const user = socket.request.user;

    if (!user) {
      socket.disconnect(true);
      return;
    }

    let currentLobbyId = null;
    let lastUpdateTime = 0;

    // ── Join a presence room ─────────────────────────────────────────────────
    socket.on('presence:join', (data, ack) => {
      const { lobbyId } = data || {};
      const lobby = lobbyManager.getLobby(lobbyId);
      if (!lobby) return ack?.({ error: 'Lobby not found' });

      const player = lobby.findPlayer(user._id);
      if (!player) return ack?.({ error: 'Not a player in this lobby' });

      currentLobbyId = lobbyId;
      socket.join(lobbyId);

      ack?.({ success: true, playerIndex: player.playerIndex });
      console.log(`[Presence] ${user.displayName} joined lobby ${lobbyId} (P${player.playerIndex})`);
    });

    // ── Broadcast a player state update ─────────────────────────────────────
    socket.on('presence:update', (data) => {
      if (!currentLobbyId) return;

      // Rate-limit: ignore updates arriving faster than UPDATE_RATE_LIMIT_MS
      const now = Date.now();
      if (now - lastUpdateTime < UPDATE_RATE_LIMIT_MS) return;
      lastUpdateTime = now;

      const lobby = lobbyManager.getLobby(currentLobbyId);
      if (!lobby) return;

      const player = lobby.findPlayer(user._id);
      if (!player) return;

      // Sanitise incoming data – all values are integers within valid GBA ranges
      const state = {
        playerIndex: player.playerIndex,
        mapBank:   ((data?.mapBank   ?? 0) | 0) & 0xFF,
        mapId:     ((data?.mapId     ?? 0) | 0) & 0xFF,
        x:         ((data?.x         ?? 0) | 0) & 0xFFFF,
        y:         ((data?.y         ?? 0) | 0) & 0xFFFF,
        direction: ((data?.direction ?? 0) | 0) & 0xF,
        animation: ((data?.animation ?? 0) | 0) & 0xFF,
        gameCode:  String(data?.gameCode || '').substring(0, 8),
        timestamp: now,
      };

      // Relay to every other player in the same lobby room
      socket.to(currentLobbyId).emit('presence:state', state);
    });

    // ── Leave the presence room ──────────────────────────────────────────────
    socket.on('presence:leave', (data, ack) => {
      if (currentLobbyId) {
        _notifyLeft(currentLobbyId);
        socket.leave(currentLobbyId);
        currentLobbyId = null;
      }
      ack?.({ success: true });
    });

    // ── Disconnect ─────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
      if (currentLobbyId) {
        _notifyLeft(currentLobbyId);
      }
    });

    // Send a presence:left notification to the rest of the lobby
    function _notifyLeft(lobbyId) {
      const lobby = lobbyManager.getLobby(lobbyId);
      if (!lobby) return;
      const player = lobby.findPlayer(user._id);
      if (player) {
        presenceNS.to(lobbyId).emit('presence:left', {
          playerIndex: player.playerIndex,
        });
      }
    }
  });
};
