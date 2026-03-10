'use strict';
const { v4: uuidv4 } = require('uuid');

const MAX_PLAYERS = 4;

class Lobby {
  constructor({ name, hostId, hostName, romId, romName, consoleType, emulatorType }) {
    this.id = uuidv4();
    this.name = name;
    this.hostId = hostId;
    this.hostName = hostName;
    this.romId = romId;
    this.romName = romName;
    this.consoleType = consoleType || 'gba'; // 'gba' | 'nds'
    this.emulatorType = emulatorType || 'auto'; // 'auto' | 'emulatorjs'
    this.status = 'waiting'; // waiting | playing
    this.players = [];       // [{ userId, userName, avatar, socketId, playerIndex, ready }]
    this.spectators = [];    // [{ userId, userName, avatar, socketId }]
    this.createdAt = new Date();
    this.linkCableActive = false;
  }

  addPlayer(user, socketId) {
    if (this.players.length >= MAX_PLAYERS) return { error: 'Lobby is full' };
    if (this.findPlayer(user._id)) return { error: 'Already in this lobby' };

    const playerIndex = this._nextPlayerIndex();
    const entry = {
      userId: user._id,
      userName: user.displayName,
      avatar: user.avatarUrl,
      socketId,
      playerIndex,
      ready: false,
    };
    this.players.push(entry);
    return { success: true, playerIndex };
  }

  addSpectator(user, socketId) {
    if (this.findSpectator(user._id)) return { error: 'Already spectating' };
    const entry = {
      userId: user._id,
      userName: user.displayName,
      avatar: user.avatarUrl,
      socketId,
    };
    this.spectators.push(entry);
    return { success: true };
  }

  removeUser(socketId) {
    const pi = this.players.findIndex(p => p.socketId === socketId);
    if (pi !== -1) {
      const [removed] = this.players.splice(pi, 1);
      return { type: 'player', user: removed };
    }
    const si = this.spectators.findIndex(s => s.socketId === socketId);
    if (si !== -1) {
      const [removed] = this.spectators.splice(si, 1);
      return { type: 'spectator', user: removed };
    }
    return null;
  }

  switchToSpectator(userId) {
    const pi = this.players.findIndex(p => p.userId === userId);
    if (pi === -1) return { error: 'Not a player in this lobby' };
    const [removed] = this.players.splice(pi, 1);
    if (this.findSpectator(userId)) return { error: 'Already spectating' };
    this.spectators.push({
      userId: removed.userId,
      userName: removed.userName,
      avatar: removed.avatar,
      socketId: removed.socketId,
    });
    return { success: true, role: 'spectator' };
  }

  switchToPlayer(userId, socketId) {
    if (this.players.length >= MAX_PLAYERS) return { error: 'Lobby is full' };
    if (this.findPlayer(userId)) return { error: 'Already a player' };
    const si = this.spectators.findIndex(s => s.userId === userId);
    if (si === -1) return { error: 'Not a spectator in this lobby' };
    const [removed] = this.spectators.splice(si, 1);
    const playerIndex = this._nextPlayerIndex();
    this.players.push({
      userId: removed.userId,
      userName: removed.userName,
      avatar: removed.avatar,
      socketId: socketId || removed.socketId,
      playerIndex,
      ready: false,
    });
    return { success: true, role: 'player', playerIndex };
  }

  setPlayerReady(userId, ready) {
    const player = this.findPlayer(userId);
    if (!player) return false;
    player.ready = ready;
    return true;
  }

  startGame() {
    if (this.players.length < 1) return { error: 'Need at least 1 player' };
    this.status = 'playing';
    return { success: true };
  }

  stopGame() {
    this.status = 'waiting';
    this.linkCableActive = false;
    this.players.forEach(p => { p.ready = false; });
    return { success: true };
  }

  findPlayer(userId) {
    return this.players.find(p => p.userId === userId);
  }

  findSpectator(userId) {
    return this.spectators.find(s => s.userId === userId);
  }

  isHost(userId) {
    return this.hostId === userId;
  }

  isEmpty() {
    return this.players.length === 0 && this.spectators.length === 0;
  }

  _nextPlayerIndex() {
    const used = new Set(this.players.map(p => p.playerIndex));
    for (let i = 0; i < MAX_PLAYERS; i++) {
      if (!used.has(i)) return i;
    }
    return MAX_PLAYERS;
  }

  toPublic() {
    return {
      id: this.id,
      name: this.name,
      hostId: this.hostId,
      hostName: this.hostName,
      romId: this.romId,
      romName: this.romName,
      consoleType: this.consoleType,
      emulatorType: this.emulatorType,
      status: this.status,
      playerCount: this.players.length,
      spectatorCount: this.spectators.length,
      maxPlayers: MAX_PLAYERS,
      players: this.players.map(p => ({
        userId: p.userId,
        userName: p.userName,
        avatar: p.avatar,
        playerIndex: p.playerIndex,
        ready: p.ready,
      })),
      spectators: this.spectators.map(s => ({
        userId: s.userId,
        userName: s.userName,
        avatar: s.avatar,
      })),
      linkCableActive: this.linkCableActive,
      createdAt: this.createdAt,
    };
  }
}

// ─── Lobby Manager ────────────────────────────────────────────────────────────
const lobbies = new Map();

module.exports = {
  createLobby(opts) {
    const lobby = new Lobby(opts);
    lobbies.set(lobby.id, lobby);
    return lobby;
  },

  getLobby(id) {
    return lobbies.get(id) || null;
  },

  getPublicLobbies() {
    return Array.from(lobbies.values())
      .filter(l => l.players.length > 0 || l.spectators.length > 0)
      .map(l => l.toPublic());
  },

  removeLobby(id) {
    lobbies.delete(id);
  },

  // Find lobby by socket ID
  findLobbyBySocket(socketId) {
    for (const lobby of lobbies.values()) {
      if (lobby.players.some(p => p.socketId === socketId)) return lobby;
      if (lobby.spectators.some(s => s.socketId === socketId)) return lobby;
    }
    return null;
  },
};
