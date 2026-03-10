'use strict';
/**
 * NDS Wireless Link Emulation over WebSockets
 *
 * Implements a simplified NDS local wireless protocol over Socket.IO,
 * mirroring the architecture of the GBA Link Cable handler.
 *
 * Hardware background:
 *   The Nintendo DS supports local wireless multiplayer via its built-in
 *   WiFi hardware. Games exchange packets between host and guest consoles.
 *
 * Network protocol:
 *   Each player's emulator sends local wireless packets via `ndsLink:send`.
 *   The server relays packets to all other players in the session via
 *   `ndsLink:data`. This enables multiplayer when the underlying emulator
 *   core supports wireless packet interception.
 *
 * Spectator / frame relay:
 *   Even without full wireless emulation, the lobby infrastructure allows
 *   players to share screens, chat, and coordinate via the same lobby
 *   system used by GBA.
 */

const lobbyManager = require('./lobbyManager');

const SYNC_TIMEOUT = 2000; // max ms to wait for all players

class NdsLinkSession {
  constructor(lobbyId, playerCount) {
    this.lobbyId = lobbyId;
    this.playerCount = playerCount;
    this.pending = new Map();   // playerIndex -> { packet, socketId }
    this.transferId = 0;
    this._timer = null;
  }

  addPacket(playerIndex, packet, socketId) {
    this.pending.set(playerIndex, { packet, socketId });
  }

  isComplete() {
    return this.pending.size >= this.playerCount;
  }

  buildRelay() {
    const packets = {};
    for (const [idx, { packet }] of this.pending) {
      packets[idx] = packet;
    }
    return packets;
  }

  reset() {
    this.pending.clear();
    this.transferId++;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }

  setTimeout(fn) {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(fn, SYNC_TIMEOUT);
  }

  clearTimeout() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }
}

const sessions = new Map(); // lobbyId -> NdsLinkSession

module.exports = function setupNdsLinkSocket(io) {
  const ndsNS = io.of('/ndslink');

  ndsNS.on('connection', (socket) => {
    const req = socket.request;
    const user = req.user;

    if (!user) {
      socket.disconnect(true);
      return;
    }

    let currentLobbyId = null;

    // ── Join an NDS link session ─────────────────────────────────────────────
    socket.on('nds:join', (data, ack) => {
      const { lobbyId } = data || {};
      const lobby = lobbyManager.getLobby(lobbyId);
      if (!lobby) return ack?.({ error: 'Lobby not found' });

      const player = lobby.findPlayer(user._id);
      if (!player) return ack?.({ error: 'You are not a player in this lobby' });

      if (lobby.status !== 'playing') return ack?.({ error: 'Game not started' });

      // Create or get session
      if (!sessions.has(lobbyId)) {
        sessions.set(lobbyId, new NdsLinkSession(lobbyId, lobby.players.length));
      }

      lobby.linkCableActive = true;

      currentLobbyId = lobbyId;
      socket.join(lobbyId);

      ack?.({
        success: true,
        playerIndex: player.playerIndex,
        playerCount: lobby.players.length,
      });

      // Notify others that NDS link is active
      ndsNS.to(lobbyId).emit('nds:status', {
        active: true,
        playerCount: lobby.players.length,
        playerIndex: player.playerIndex,
      });

      console.log(`[NDS] ${user.displayName} joined NDS link in lobby ${lobbyId} as P${player.playerIndex}`);
    });

    // ── Send a wireless packet ───────────────────────────────────────────────
    socket.on('nds:send', (data, ack) => {
      if (!currentLobbyId) return ack?.({ error: 'Not in an NDS link session' });

      const lobby = lobbyManager.getLobby(currentLobbyId);
      if (!lobby) return ack?.({ error: 'Lobby not found' });

      const player = lobby.findPlayer(user._id);
      if (!player) return ack?.({ error: 'Not a player in this lobby' });

      const session = sessions.get(currentLobbyId);
      if (!session) return ack?.({ error: 'No active NDS link session' });

      const packet = data?.packet ?? null;
      const transferId = data?.transferId ?? session.transferId;

      // Ignore stale transfers
      if (transferId !== session.transferId) {
        return ack?.({ error: 'stale transfer', currentTransferId: session.transferId });
      }

      session.addPacket(player.playerIndex, packet, socket.id);
      ack?.({ success: true, buffered: session.pending.size });

      if (session.isComplete()) {
        session.clearTimeout();
        dispatchSync(ndsNS, session, currentLobbyId);
      } else {
        session.setTimeout(() => {
          console.log(`[NDS] Timeout in ${currentLobbyId} — syncing with ${session.pending.size}/${session.playerCount} players`);
          dispatchSync(ndsNS, session, currentLobbyId);
        });
      }
    });

    // ── Leave NDS link session ───────────────────────────────────────────────
    socket.on('nds:leave', (data, ack) => {
      if (currentLobbyId) {
        leaveNdsSession(socket, currentLobbyId);
        currentLobbyId = null;
      }
      ack?.({ success: true });
    });

    // ── Disconnect ────────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
      if (currentLobbyId) {
        leaveNdsSession(socket, currentLobbyId);
      }
    });
  });

  function dispatchSync(ns, session, lobbyId) {
    const packets = session.buildRelay();
    const transferId = session.transferId;

    ns.to(lobbyId).emit('nds:sync', {
      transferId,
      packets,
      timestamp: Date.now(),
    });

    session.reset();
  }

  function leaveNdsSession(socket, lobbyId) {
    socket.leave(lobbyId);
    const lobby = lobbyManager.getLobby(lobbyId);
    if (lobby) {
      const session = sessions.get(lobbyId);
      if (session) {
        if (session.pending.size > 0) {
          dispatchSync(ndsNS, session, lobbyId);
        }
        if (lobby.isEmpty()) {
          sessions.delete(lobbyId);
          lobby.linkCableActive = false;
        }
      }
    }
  }

  // Expose for lobby cleanup
  module.exports.destroySession = (lobbyId) => {
    const session = sessions.get(lobbyId);
    if (session) { session.clearTimeout(); sessions.delete(lobbyId); }
  };
};
