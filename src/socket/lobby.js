'use strict';
const lobbyManager = require('./lobbyManager');
const db = require('../db');

module.exports = function setupLobbySocket(io) {
  const lobbyNS = io.of('/lobby');

  lobbyNS.on('connection', (socket) => {
    const req = socket.request;
    const user = req.user;

    if (!user) {
      socket.emit('error', { message: 'Authentication required' });
      socket.disconnect(true);
      return;
    }

    console.log(`[Lobby] ${user.displayName} connected (${socket.id})`);

    // ── Create a lobby ───────────────────────────────────────────────────────
    socket.on('lobby:create', (data, ack) => {
      const { name, romId, emulatorType } = data || {};
      if (!name || !romId) return ack?.({ error: 'name and romId required' });

      db.roms.findOne({ _id: romId }, (err, rom) => {
        if (err || !rom) return ack?.({ error: 'ROM not found' });

        const lobby = lobbyManager.createLobby({
          name: name.trim().substring(0, 50),
          hostId: user._id,
          hostName: user.displayName,
          romId,
          romName: rom.displayName,
          consoleType: rom.consoleType || 'gba',
          emulatorType: emulatorType || 'auto',
        });

        // Don't auto-join with this socket – the client will navigate to
        // game.html which opens a *new* socket and joins there.  Joining
        // here would cause the lobby to be dissolved when this socket
        // disconnects during the page transition.

        ack?.({ success: true, lobby: lobby.toPublic() });
        lobbyNS.emit('lobbies:updated', lobbyManager.getPublicLobbies());
        console.log(`[Lobby] Created: "${lobby.name}" by ${user.displayName} (emulator: ${lobby.emulatorType})`);
      });
    });

    // ── Join a lobby (auto-join as player when slots are available) ─────────
    socket.on('lobby:join', (data, ack) => {
      const { lobbyId } = data || {};
      const lobby = lobbyManager.getLobby(lobbyId);
      if (!lobby) return ack?.({ error: 'Lobby not found' });

      // Handle reconnecting users – update their socketId and rejoin room
      const existingPlayer = lobby.findPlayer(user._id);
      if (existingPlayer) {
        existingPlayer.socketId = socket.id;
        socket.join(lobby.id);
        ack?.({ success: true, role: 'player', playerIndex: existingPlayer.playerIndex, lobby: lobby.toPublic() });
        lobbyNS.to(lobby.id).emit('lobby:state', lobby.toPublic());
        lobbyNS.emit('lobbies:updated', lobbyManager.getPublicLobbies());
        return;
      }
      const existingSpec = lobby.findSpectator(user._id);
      if (existingSpec) {
        existingSpec.socketId = socket.id;
        socket.join(lobby.id);
        ack?.({ success: true, role: 'spectator', lobby: lobby.toPublic() });
        lobbyNS.to(lobby.id).emit('lobby:state', lobby.toPublic());
        lobbyNS.emit('lobbies:updated', lobbyManager.getPublicLobbies());
        return;
      }

      // All new users join as spectators by default.  The first user to
      // join an empty lobby is auto-promoted to player so they can start
      // the game immediately.  Subsequent users stay as spectators and can
      // switch to player via lobby:switch-role.  This matches the
      // connection-handshake pattern used by both mGBA (lockstep) and
      // VBA-M (link cable socket): players must explicitly opt in.
      const wasEmpty = lobby.players.length === 0;
      const specResult = lobby.addSpectator(user, socket.id);
      if (specResult.error) return ack?.({ error: specResult.error });
      socket.join(lobby.id);

      if (wasEmpty) {
        // Auto-promote the first joiner to player so a solo host can
        // launch the game without an extra click.
        const switchResult = lobby.switchToPlayer(user._id, socket.id);
        if (switchResult.success) {
          ack?.({ success: true, role: 'player', playerIndex: switchResult.playerIndex, lobby: lobby.toPublic() });
        } else {
          ack?.({ success: true, role: 'spectator', lobby: lobby.toPublic() });
        }
      } else {
        ack?.({ success: true, role: 'spectator', lobby: lobby.toPublic() });
      }

      lobbyNS.to(lobby.id).emit('lobby:state', lobby.toPublic());
      lobbyNS.emit('lobbies:updated', lobbyManager.getPublicLobbies());
    });

    // ── Join as spectator explicitly ─────────────────────────────────────────
    socket.on('lobby:spectate', (data, ack) => {
      const { lobbyId } = data || {};
      const lobby = lobbyManager.getLobby(lobbyId);
      if (!lobby) return ack?.({ error: 'Lobby not found' });

      const result = lobby.addSpectator(user, socket.id);
      if (result.error) return ack?.({ error: result.error });

      socket.join(lobby.id);
      ack?.({ success: true, role: 'spectator', lobby: lobby.toPublic() });
      lobbyNS.to(lobby.id).emit('lobby:state', lobby.toPublic());
      lobbyNS.emit('lobbies:updated', lobbyManager.getPublicLobbies());
    });

    // ── Switch between player and spectator ──────────────────────────────────
    socket.on('lobby:switch-role', (data, ack) => {
      const lobby = lobbyManager.findLobbyBySocket(socket.id);
      if (!lobby) return ack?.({ error: 'Not in a lobby' });

      const targetRole = data?.role; // 'spectator' or 'player'
      let result;

      if (targetRole === 'spectator') {
        result = lobby.switchToSpectator(user._id);
        if (result.error) return ack?.({ error: result.error });
        // Transfer host if needed
        if (lobby.isHost(user._id) && lobby.players.length > 0) {
          const newHost = lobby.players[0];
          lobby.hostId = newHost.userId;
          lobby.hostName = newHost.userName;
        }
      } else if (targetRole === 'player') {
        result = lobby.switchToPlayer(user._id, socket.id);
        if (result.error) return ack?.({ error: result.error });
      } else {
        return ack?.({ error: 'Invalid role' });
      }

      ack?.({ success: true, ...result, lobby: lobby.toPublic() });
      lobbyNS.to(lobby.id).emit('lobby:state', lobby.toPublic());
      lobbyNS.emit('lobbies:updated', lobbyManager.getPublicLobbies());
    });

    // ── Leave lobby ──────────────────────────────────────────────────────────
    socket.on('lobby:leave', (data, ack) => {
      handleLeave(socket, user, ack);
    });

    // ── Player ready toggle ───────────────────────────────────────────────────
    socket.on('lobby:ready', (data, ack) => {
      const lobby = lobbyManager.findLobbyBySocket(socket.id);
      if (!lobby) return ack?.({ error: 'Not in a lobby' });

      lobby.setPlayerReady(user._id, data?.ready ?? true);
      lobbyNS.to(lobby.id).emit('lobby:state', lobby.toPublic());
      ack?.({ success: true });
    });

    // ── Start game (host only) ────────────────────────────────────────────────
    socket.on('lobby:start', (data, ack) => {
      const lobby = lobbyManager.findLobbyBySocket(socket.id);
      if (!lobby) return ack?.({ error: 'Not in a lobby' });
      if (!lobby.isHost(user._id)) return ack?.({ error: 'Only the host can start the game' });

      const result = lobby.startGame();
      if (result.error) return ack?.({ error: result.error });

      lobbyNS.to(lobby.id).emit('game:start', { lobby: lobby.toPublic() });
      lobbyNS.emit('lobbies:updated', lobbyManager.getPublicLobbies());
      ack?.({ success: true, lobby: lobby.toPublic() });
      console.log(`[Lobby] Game started in "${lobby.name}"`);
    });

    // ── Chat message ─────────────────────────────────────────────────────────
    socket.on('lobby:chat', (data) => {
      const lobby = lobbyManager.findLobbyBySocket(socket.id);
      if (!lobby) return;
      const msg = String(data?.message || '').trim().substring(0, 200);
      if (!msg) return;
      lobbyNS.to(lobby.id).emit('lobby:chat', {
        userId: user._id,
        userName: user.displayName,
        avatar: user.avatarUrl,
        message: msg,
        timestamp: Date.now(),
      });
    });

    // ── Get lobby state ──────────────────────────────────────────────────────
    socket.on('lobby:get', (data, ack) => {
      const lobby = lobbyManager.getLobby(data?.lobbyId);
      if (!lobby) return ack?.({ error: 'Lobby not found' });
      ack?.({ lobby: lobby.toPublic() });
    });

    // ── List lobbies ─────────────────────────────────────────────────────────
    socket.on('lobbies:list', (data, ack) => {
      ack?.({ lobbies: lobbyManager.getPublicLobbies() });
    });

    // ── Frame broadcast (host streams canvas to spectators/other players) ────
    socket.on('game:frame', (data) => {
      const lobby = lobbyManager.findLobbyBySocket(socket.id);
      if (!lobby) return;
      const player = lobby.findPlayer(user._id);
      if (!player) return;

      // Broadcast frame to all other participants (spectators + other players)
      socket.to(lobby.id).emit('game:frame', {
        playerIndex: player.playerIndex,
        frame: data.frame, // base64 or ArrayBuffer PNG
        timestamp: Date.now(),
      });
    });

    // ── Audio chunk broadcast (opt-in spectator sound) ────────────────────────
    socket.on('game:audio', (data) => {
      const lobby = lobbyManager.findLobbyBySocket(socket.id);
      if (!lobby) return;
      const player = lobby.findPlayer(user._id);
      if (!player) return;
      // Relay audio chunk to spectators (and other players who want sound)
      socket.to(lobby.id).emit('game:audio', {
        playerIndex: player.playerIndex,
        chunk: data.chunk,
        timestamp: Date.now(),
      });
    });

    // ── Disconnect ────────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
      console.log(`[Lobby] ${user.displayName} disconnected (${socket.id})`);
      handleLeave(socket, user, null);
    });
  });

  function handleLeave(socket, user, ack) {
    const lobby = lobbyManager.findLobbyBySocket(socket.id);
    if (!lobby) {
      // Socket not found – player already reconnected with a new socket
      // (race condition: reconnect arrives before this disconnect fires).
      // Nothing to clean up; the lobby state is already consistent.
      return ack?.({ error: 'Not in a lobby' });
    }

    const removed = lobby.removeUser(socket.id);
    socket.leave(lobby.id);

    if (lobby.isEmpty()) {
      lobbyManager.removeLobby(lobby.id);
      console.log(`[Lobby] Lobby "${lobby.name}" dissolved (empty)`);
    } else if (removed?.type === 'player' && lobby.isHost(user._id)) {
      // Transfer host to first remaining player
      const newHost = lobby.players[0];
      if (newHost) {
        lobby.hostId = newHost.userId;
        lobby.hostName = newHost.userName;
        console.log(`[Lobby] Host transferred to ${newHost.userName} in "${lobby.name}"`);
      }
      lobbyNS.to(lobby.id).emit('lobby:host-changed', {
        hostId: lobby.hostId,
        hostName: lobby.hostName,
      });
      lobbyNS.to(lobby.id).emit('lobby:state', lobby.toPublic());
    } else {
      lobbyNS.to(lobby.id).emit('lobby:state', lobby.toPublic());
    }

    lobbyNS.emit('lobbies:updated', lobbyManager.getPublicLobbies());
    ack?.({ success: true });
  }
};
