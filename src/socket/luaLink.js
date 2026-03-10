'use strict';
/**
 * GBA Link Cable over WebSockets
 *
 * Inspired by https://github.com/TheHunterManX/GBA-PK-multiplayer
 * Protocol insights from mGBA lockstep.c and VBA-M gbaLink.h (LINK_CABLE_SOCKET):
 *   - All players must exchange words before the transfer is considered complete.
 *   - The coordinator (Player 0 / master) dispatches as soon as ALL connected
 *     players have submitted their words – no unnecessary waiting.
 *   - If a slave does not respond within SLAVE_TIMEOUT the transfer is aborted
 *     with 0xFFFF in the missing slot (matches GBA hardware "no cable" value).
 *
 * Architecture (mirrors the GBA SIO Multiplay hardware model):
 *   Player 0 (master) has the link cable active at all times.  The master
 *   initiates every SIO transfer cycle by writing to SIOMLT_SEND and setting
 *   the START bit.  Players 1–3 (slaves) are passive: they keep SIOMLT_SEND
 *   ready and respond immediately when the master signals.
 *
 * SIO Modes (common ground between mGBA and VBA-M):
 *   Both emulators support multiple SIO modes via RCNT/SIOCNT.  The modes
 *   supported by this server are:
 *   - MULTI (0): 16-bit multiplay (up to 4 players) – primary Pokémon mode
 *   - NORMAL8 (1): 8-bit normal (2 players, master/slave clock)
 *   - NORMAL32 (2): 32-bit normal (2 players, master/slave clock)
 *   Games may switch modes during communication (e.g. handshake in Normal
 *   mode, then data exchange in Multiplay mode).
 *
 * Transfer state machine (shared by mGBA lockstep & VBA-M link cable):
 *   IDLE → PENDING (master sent) → ACTIVE (slaves responding) → COMPLETE
 *   This state machine prevents duplicate dispatches and ensures clean
 *   transitions between transfer cycles.
 *
 * Network protocol:
 *   1. Master (P0) sends `lua:send`  → server saves master's word.
 *      If all slaves have already buffered their words (pre-responded), the
 *      packet is dispatched immediately – no round-trip penalty.
 *      Otherwise `lua:masterReady` is broadcast to slaves and a SLAVE_TIMEOUT
 *      watchdog is armed.
 *   2. Each slave sends `lua:send`   → server buffers the slave word.
 *      If master has already sent AND all remaining slaves have now responded,
 *      the packet is dispatched immediately without waiting for the timeout.
 *   3. After all slaves respond OR SLAVE_TIMEOUT ms elapses, the server
 *      broadcasts `lua:sync` with the complete 4-word packet to every player.
 *   4. All players inject the received words into SIOMULTI0-3 and fire the
 *      SIO IRQ so the game can process the exchange.
 */

const lobbyManager = require('./lobbyManager');

// Increased from 200 ms → 500 ms to accommodate variable network latency.
// VBA-M and mGBA both use a configurable timeout; 500 ms is still fast enough
// for Pokémon trading (turn-based, not real-time) while surviving a congested
// network hop.
const SLAVE_TIMEOUT = 500; // ms to wait for slave responses after master sends

// ── SIO Mode constants (shared with client) ──────────────────────────────
// These match the GBA hardware mode encoding derived from RCNT/SIOCNT.
const SIO_MODE = {
  MULTI:    0,  // 16-bit multiplay (up to 4 players)
  NORMAL8:  1,  // 8-bit normal serial (2 players)
  NORMAL32: 2,  // 32-bit normal serial (2 players)
};

// ── Transfer state machine ───────────────────────────────────────────────
// Both mGBA (lockstep.c) and VBA-M (gbaLink.cpp) use explicit transfer
// states to coordinate the exchange cycle.  This server mirrors that pattern.
const TRANSFER_STATE = {
  IDLE:     0,  // No transfer in progress
  PENDING:  1,  // Master has sent, waiting for slaves
  ACTIVE:   2,  // Slaves are responding
  COMPLETE: 3,  // Transfer dispatched, resetting
};

class LuaLinkSession {
  constructor(lobbyId) {
    this.lobbyId = lobbyId;
    this.transferId = 0;
    this.masterWord = null;      // null until master sends in this cycle
    this.slaveWords = new Map(); // playerIndex -> word
    this.connectedPlayers = new Map(); // socketId -> playerIndex
    this.readyPlayers = new Set();    // socketIds that have confirmed ready
    this._timer = null;
    // SIO mode: clients report their detected mode so the server can adapt
    // the dispatch logic (Normal mode is 2-player only, Multiplay is 1-4).
    this.sioMode = SIO_MODE.MULTI;
    // Transfer state machine
    this.transferState = TRANSFER_STATE.IDLE;
    // ── Diagnostics ─────────────────────────────────────────────────────
    this.stats = {
      totalTransfers: 0,
      masterSends: 0,
      slaveSends: 0,
      normalTransfers: 0,
      timeouts: 0,
      lastTransferAt: null,
      createdAt: Date.now(),
    };
  }

  setMasterWord(word) {
    this.masterWord = word & 0xFFFF;
  }

  setSlaveWord(playerIndex, word) {
    this.slaveWords.set(playerIndex, word & 0xFFFF);
  }

  /** Build the 4-word SIOMULTI0-3 packet (0xFFFF = not connected). */
  buildPacket() {
    const words = [0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF];
    if (this.masterWord !== null) words[0] = this.masterWord;
    for (const [idx, w] of this.slaveWords) {
      if (idx >= 1 && idx <= 3) words[idx] = w;
    }
    return words;
  }

  /** Build a Normal mode packet (2-player only: master ↔ slave exchange). */
  buildNormalPacket() {
    return {
      masterWord: this.masterWord ?? 0xFFFF,
      slaveWord: this.slaveWords.get(1) ?? 0xFFFF,
    };
  }

  reset() {
    this.masterWord = null;
    this.slaveWords.clear();
    this.transferId++;
    this.transferState = TRANSFER_STATE.IDLE;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }

  setTimeout(fn) {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(fn, SLAVE_TIMEOUT);
  }

  clearTimeout() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }

  allSlavesResponded(slaveIndices) {
    return slaveIndices.length === 0 ||
           slaveIndices.every(idx => this.slaveWords.has(idx));
  }

  /** Check if all connected players have signalled ready. */
  allPlayersReady() {
    for (const [socketId] of this.connectedPlayers) {
      if (!this.readyPlayers.has(socketId)) return false;
    }
    return this.connectedPlayers.size > 0;
  }
}

const sessions = new Map(); // lobbyId -> LuaLinkSession

module.exports = function setupLuaLinkSocket(io) {
  const llNS = io.of('/lualink');

  llNS.on('connection', (socket) => {
    const user = socket.request.user;
    if (!user) { socket.disconnect(true); return; }

    let currentLobbyId = null;

    // ── Join the Lua link cable session ───────────────────────────────────────
    socket.on('lua:join', (data, ack) => {
      const { lobbyId } = data || {};
      const lobby = lobbyManager.getLobby(lobbyId);
      if (!lobby) return ack?.({ error: 'Lobby not found' });

      const player = lobby.findPlayer(user._id);
      if (!player) return ack?.({ error: 'Not a player in this lobby' });
      if (lobby.status !== 'playing') return ack?.({ error: 'Game not started' });

      if (!sessions.has(lobbyId)) {
        sessions.set(lobbyId, new LuaLinkSession(lobbyId));
      }

      const session = sessions.get(lobbyId);
      session.connectedPlayers.set(socket.id, player.playerIndex);

      lobby.linkCableActive = true;
      currentLobbyId = lobbyId;
      socket.join(lobbyId);

      const isMaster = player.playerIndex === 0;
      const connectedCount = session.connectedPlayers.size;

      ack?.({
        success: true,
        playerIndex: player.playerIndex,
        playerCount: lobby.players.length,
        connectedCount,
        isMaster,
        transferId: session.transferId,
        sioMode: session.sioMode,
      });

      // Broadcast comprehensive status so all clients (including those
      // whose emulator is still loading) know exactly who is connected
      // to the link cable session.
      llNS.to(lobbyId).emit('lua:status', {
        active: true,
        playerCount: lobby.players.length,
        connectedCount,
        playerIndex: player.playerIndex,
        isMaster,
        sioMode: session.sioMode,
      });

      console.log(`[LuaLink] ${user.displayName} joined in lobby ${lobbyId} as P${player.playerIndex} (${isMaster ? 'master' : 'slave'}) – ${connectedCount} connected`);
    });

    // ── Player ready handshake (common to mGBA lockstep & VBA-M socket) ──────
    // Both emulators require a "ready" signal from each participant before
    // allowing transfers.  This prevents data loss when one player's emulator
    // is still loading while the other has already started sending.
    socket.on('lua:ready', (data, ack) => {
      if (!currentLobbyId) return ack?.({ error: 'Not in a session' });
      const session = sessions.get(currentLobbyId);
      if (!session) return ack?.({ error: 'No active session' });

      session.readyPlayers.add(socket.id);
      const allReady = session.allPlayersReady();

      ack?.({ success: true, allReady });

      // Broadcast ready status to all connected players
      llNS.to(currentLobbyId).emit('lua:readyState', {
        allReady,
        readyCount: session.readyPlayers.size,
        connectedCount: session.connectedPlayers.size,
      });

      if (allReady) {
        console.log(`[LuaLink] All players ready in lobby ${currentLobbyId} – link cable fully active`);
      }
    });

    // ── SIO mode change notification ─────────────────────────────────────────
    // Games may switch between Normal and Multiplay modes during communication.
    // Both mGBA and VBA-M detect mode changes via RCNT/SIOCNT; clients report
    // the detected mode so the server can adapt dispatch logic.
    socket.on('lua:setMode', (data, ack) => {
      if (!currentLobbyId) return ack?.({ error: 'Not in a session' });
      const session = sessions.get(currentLobbyId);
      if (!session) return ack?.({ error: 'No active session' });

      const mode = data?.mode;
      if (mode !== SIO_MODE.MULTI && mode !== SIO_MODE.NORMAL8 && mode !== SIO_MODE.NORMAL32) {
        return ack?.({ error: 'Invalid SIO mode' });
      }

      const prevMode = session.sioMode;
      session.sioMode = mode;
      ack?.({ success: true, mode });

      if (prevMode !== mode) {
        llNS.to(currentLobbyId).emit('lua:modeChanged', { mode, prevMode });
        console.log(`[LuaLink] SIO mode changed in ${currentLobbyId}: ${prevMode} → ${mode}`);
      }
    });

    // ── Send a word (master triggers the cycle; slaves respond) ───────────────
    socket.on('lua:send', (data, ack) => {
      if (!currentLobbyId) return ack?.({ error: 'Not in a session' });

      const lobby = lobbyManager.getLobby(currentLobbyId);
      if (!lobby) return ack?.({ error: 'Lobby not found' });

      const player = lobby.findPlayer(user._id);
      if (!player) return ack?.({ error: 'Not a player' });

      const session = sessions.get(currentLobbyId);
      if (!session) return ack?.({ error: 'No active session' });

      const word = (data?.word ?? 0xFFFF) & 0xFFFF;
      const transferId = data?.transferId ?? session.transferId;

      if (transferId !== session.transferId) {
        return ack?.({ error: 'stale transfer', currentTransferId: session.transferId });
      }

      // ── Normal mode transfers (2-player only) ─────────────────────────────
      if (session.sioMode === SIO_MODE.NORMAL8 || session.sioMode === SIO_MODE.NORMAL32) {
        if (player.playerIndex === 0) {
          session.setMasterWord(word);
          session.stats.masterSends++;
          session.transferState = TRANSFER_STATE.PENDING;
          ack?.({ success: true, transferId: session.transferId });

          // In Normal mode, only one slave (P1) participates
          if (session.slaveWords.has(1)) {
            session.clearTimeout();
            dispatchNormalSync(llNS, session, currentLobbyId);
          } else {
            llNS.to(currentLobbyId).emit('lua:masterReady', {
              transferId: session.transferId,
              masterWord: word,
              mode: session.sioMode,
              pendingSlaves: [1],
            });
            session.transferState = TRANSFER_STATE.ACTIVE;
            session.setTimeout(() => {
              session.stats.timeouts++;
              dispatchNormalSync(llNS, session, currentLobbyId);
            });
          }
        } else {
          session.setSlaveWord(player.playerIndex, word);
          session.stats.slaveSends++;
          ack?.({ success: true, buffered: session.slaveWords.size });

          if (session.masterWord !== null) {
            session.clearTimeout();
            dispatchNormalSync(llNS, session, currentLobbyId);
          }
        }
        return;
      }

      // ── Multiplay mode transfers (1-4 players) ────────────────────────────
      if (player.playerIndex === 0) {
        // ── Master initiates the transfer cycle ─────────────────────────────
        // Flush stale pre-buffered slave words.  In the real GBA hardware
        // (and both mGBA lockstep and VBA-M link cable), slave words are
        // latched when the master starts the transfer.
        session.slaveWords.clear();

        session.setMasterWord(word);
        session.stats.masterSends++;
        session.transferState = TRANSFER_STATE.PENDING;
        ack?.({ success: true, transferId: session.transferId });

        const slaveIndices = lobby.players
          .filter(p => p.playerIndex !== 0)
          .map(p => p.playerIndex);

        if (slaveIndices.length === 0) {
          dispatchSync(llNS, session, currentLobbyId);
        } else {
          // Broadcast to all slaves so they send fresh words for this cycle
          session.transferState = TRANSFER_STATE.ACTIVE;
          llNS.to(currentLobbyId).emit('lua:masterReady', {
            transferId: session.transferId,
            masterWord: word,
            mode: session.sioMode,
            pendingSlaves: slaveIndices,
          });

          // Dispatch after all remaining slaves respond or timeout fires
          session.setTimeout(() => {
            session.stats.timeouts++;
            console.log(`[LuaLink] Slave timeout in ${currentLobbyId} – dispatching with ${session.slaveWords.size}/${slaveIndices.length} slaves`);
            dispatchSync(llNS, session, currentLobbyId);
          });
        }
      } else {
        // ── Slave responds with its word ────────────────────────────────────
        session.setSlaveWord(player.playerIndex, word);
        session.stats.slaveSends++;
        ack?.({ success: true, buffered: session.slaveWords.size });

        // If master has already sent, check whether all slaves responded
        const slaveIndices = lobby.players
          .filter(p => p.playerIndex !== 0)
          .map(p => p.playerIndex);

        if (session.masterWord !== null && session.allSlavesResponded(slaveIndices)) {
          session.clearTimeout();
          dispatchSync(llNS, session, currentLobbyId);
        }
        // If master has not sent yet, just buffer the slave word for the next cycle
      }
    });

    // ── Diagnostics: ping/pong for latency measurement ──────────────────────
    socket.on('lua:ping', (data, ack) => {
      ack?.({
        serverTime: Date.now(),
        clientTime: data?.clientTime ?? null,
      });
    });

    // ── Diagnostics: request session state for verification ─────────────────
    socket.on('lua:diagnostics', (data, ack) => {
      if (!currentLobbyId) {
        return ack?.({
          connected: false,
          error: 'Not in a session',
          serverTime: Date.now(),
        });
      }
      const session = sessions.get(currentLobbyId);
      const lobby = lobbyManager.getLobby(currentLobbyId);
      if (!session || !lobby) {
        return ack?.({
          connected: false,
          error: 'Session or lobby not found',
          serverTime: Date.now(),
        });
      }
      const playerIdx = session.connectedPlayers.get(socket.id);
      const connectedList = [];
      for (const [, idx] of session.connectedPlayers) {
        connectedList.push(idx);
      }
      ack?.({
        connected: true,
        serverTime: Date.now(),
        lobbyId: currentLobbyId,
        playerIndex: playerIdx ?? -1,
        isMaster: playerIdx === 0,
        transferId: session.transferId,
        sioMode: session.sioMode,
        transferState: session.transferState,
        connectedPlayers: connectedList.sort(),
        connectedCount: session.connectedPlayers.size,
        lobbyPlayerCount: lobby.players.length,
        linkCableActive: !!lobby.linkCableActive,
        allReady: session.allPlayersReady(),
        stats: { ...session.stats },
        architecture: 'client-server (Socket.IO, no P2P)',
      });
    });

    // ── Leave Lua link session ────────────────────────────────────────────────
    socket.on('lua:leave', (data, ack) => {
      if (currentLobbyId) {
        leaveLuaSession(socket, currentLobbyId);
        currentLobbyId = null;
      }
      ack?.({ success: true });
    });

    // ── Disconnect ────────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
      if (currentLobbyId) leaveLuaSession(socket, currentLobbyId);
    });
  });

  /** Dispatch a Multiplay mode sync (4-word packet). */
  function dispatchSync(ns, session, lobbyId) {
    const packet = session.buildPacket();
    const transferId = session.transferId;
    session.stats.totalTransfers++;
    session.stats.lastTransferAt = Date.now();
    session.transferState = TRANSFER_STATE.COMPLETE;
    ns.to(lobbyId).emit('lua:sync', {
      transferId,
      words: packet, // [P0_word, P1_word, P2_word, P3_word]
      mode: SIO_MODE.MULTI,
      timestamp: Date.now(),
    });
    session.reset();
  }

  /** Dispatch a Normal mode sync (2-player master↔slave exchange). */
  function dispatchNormalSync(ns, session, lobbyId) {
    const normalPacket = session.buildNormalPacket();
    const transferId = session.transferId;
    session.stats.totalTransfers++;
    session.stats.normalTransfers++;
    session.stats.lastTransferAt = Date.now();
    session.transferState = TRANSFER_STATE.COMPLETE;
    ns.to(lobbyId).emit('lua:sync', {
      transferId,
      words: [normalPacket.masterWord, normalPacket.slaveWord, 0xFFFF, 0xFFFF],
      normalData: normalPacket,
      mode: session.sioMode,
      timestamp: Date.now(),
    });
    session.reset();
  }

  function leaveLuaSession(socket, lobbyId) {
    socket.leave(lobbyId);
    const lobby = lobbyManager.getLobby(lobbyId);
    if (!lobby) return;

    const session = sessions.get(lobbyId);
    if (session) {
      session.connectedPlayers.delete(socket.id);
      session.readyPlayers.delete(socket.id);

      // Flush any in-progress transfer with the leaving player absent
      if (session.masterWord !== null) {
        dispatchSync(llNS, session, lobbyId);
      }
      if (lobby.isEmpty() || session.connectedPlayers.size === 0) {
        sessions.delete(lobbyId);
        lobby.linkCableActive = false;
      } else {
        llNS.to(lobbyId).emit('lua:status', {
          active: lobby.linkCableActive,
          playerCount: lobby.players.length,
          connectedCount: session.connectedPlayers.size,
          sioMode: session.sioMode,
        });
      }
    }
  }

  // Expose for lobby cleanup (called when a lobby is dissolved)
  module.exports.destroySession = (lobbyId) => {
    const s = sessions.get(lobbyId);
    if (s) { s.clearTimeout(); sessions.delete(lobbyId); }
  };
};

// Export constants for tests
module.exports.SIO_MODE = SIO_MODE;
module.exports.TRANSFER_STATE = TRANSFER_STATE;
