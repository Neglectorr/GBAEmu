'use strict';
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const lobbyManager = require('../src/socket/lobbyManager');

const fakeUser = (id = 'u1') => ({
  _id: id,
  displayName: `User ${id}`,
  avatarUrl: '',
});

describe('LobbyManager – lobby lifecycle', () => {
  let lobby;

  beforeEach(() => {
    // Clean up any leftover lobbies
    for (const l of lobbyManager.getPublicLobbies()) {
      lobbyManager.removeLobby(l.id);
    }

    lobby = lobbyManager.createLobby({
      name: 'Test Lobby',
      hostId: 'u1',
      hostName: 'User u1',
      romId: 'rom1',
      romName: 'TestROM',
      consoleType: 'gba',
    });
  });

  it('newly created lobby has zero players and still exists via getLobby', () => {
    // After our fix, lobby:create no longer auto-joins the player.
    // The lobby must still be retrievable so game.html can find it.
    assert.equal(lobby.players.length, 0);
    assert.ok(lobbyManager.getLobby(lobby.id), 'lobby should be retrievable by id');
  });

  it('newly created lobby is NOT listed in getPublicLobbies (0 players)', () => {
    const publicLobbies = lobbyManager.getPublicLobbies();
    const found = publicLobbies.find(l => l.id === lobby.id);
    assert.equal(found, undefined, 'empty lobby should not appear in public list');
  });

  it('lobby appears in public list after a player joins', () => {
    lobby.addPlayer(fakeUser('u1'), 'socket-1');
    const publicLobbies = lobbyManager.getPublicLobbies();
    const found = publicLobbies.find(l => l.id === lobby.id);
    assert.ok(found, 'lobby with a player should appear in public list');
    assert.equal(found.playerCount, 1);
  });

  it('lobby survives the create-socket disconnecting (no player to remove)', () => {
    // Simulate the old lobby.html socket disconnecting:
    // findLobbyBySocket returns null because no player was added with that socketId.
    const found = lobbyManager.findLobbyBySocket('old-lobby-page-socket');
    assert.equal(found, null, 'no lobby should be associated with the old socket');

    // The lobby itself must still exist.
    assert.ok(lobbyManager.getLobby(lobby.id), 'lobby must survive the disconnect');
  });

  it('game page can join the lobby after creation', () => {
    // Simulate what game.html does: emit lobby:join which calls addPlayer
    const result = lobby.addPlayer(fakeUser('u1'), 'game-page-socket');
    assert.ok(result.success);
    assert.equal(result.playerIndex, 0);
    assert.equal(lobby.players.length, 1);
    assert.equal(lobby.players[0].socketId, 'game-page-socket');
  });

  it('lobby is dissolved only when all players leave from game page', () => {
    lobby.addPlayer(fakeUser('u1'), 'game-page-socket');
    assert.ok(!lobby.isEmpty());

    lobby.removeUser('game-page-socket');
    assert.ok(lobby.isEmpty(), 'lobby should be empty after the only player leaves');
  });

  it('allows a player to join mid-game (playing status)', () => {
    lobby.addPlayer(fakeUser('u1'), 'socket-1');
    lobby.startGame();
    assert.equal(lobby.status, 'playing');

    // A second player should be able to join mid-game
    const result = lobby.addPlayer(fakeUser('u2'), 'socket-2');
    assert.ok(result.success, 'should allow mid-game join');
    assert.equal(result.playerIndex, 1);
    assert.equal(lobby.players.length, 2);
  });

  it('switchToSpectator moves a player to spectators', () => {
    lobby.addPlayer(fakeUser('u1'), 'socket-1');
    lobby.addPlayer(fakeUser('u2'), 'socket-2');

    const result = lobby.switchToSpectator('u1');
    assert.ok(result.success);
    assert.equal(result.role, 'spectator');
    assert.equal(lobby.players.length, 1);
    assert.equal(lobby.spectators.length, 1);
    assert.equal(lobby.spectators[0].userId, 'u1');
  });

  it('switchToPlayer moves a spectator to players', () => {
    lobby.addPlayer(fakeUser('u1'), 'socket-1');
    lobby.addSpectator(fakeUser('u2'), 'socket-2');

    const result = lobby.switchToPlayer('u2', 'socket-2');
    assert.ok(result.success);
    assert.equal(result.role, 'player');
    assert.equal(lobby.players.length, 2);
    assert.equal(lobby.spectators.length, 0);
  });

  it('switchToPlayer fails when lobby is full', () => {
    for (let i = 1; i <= 4; i++) {
      lobby.addPlayer(fakeUser(`p${i}`), `socket-p${i}`);
    }
    lobby.addSpectator(fakeUser('s1'), 'socket-s1');

    const result = lobby.switchToPlayer('s1', 'socket-s1');
    assert.ok(result.error, 'should fail when full');
    assert.equal(lobby.spectators.length, 1, 'spectator should remain');
  });

  it('switchToSpectator fails for non-player', () => {
    lobby.addSpectator(fakeUser('u1'), 'socket-1');
    const result = lobby.switchToSpectator('u1');
    assert.ok(result.error);
  });

  it('spectator-only lobby appears in getPublicLobbies', () => {
    lobby.addPlayer(fakeUser('u1'), 'socket-1');
    lobby.addSpectator(fakeUser('u2'), 'socket-2');
    // Remove the player so only a spectator remains
    lobby.removeUser('socket-1');
    assert.equal(lobby.players.length, 0);
    assert.equal(lobby.spectators.length, 1);

    const publicLobbies = lobbyManager.getPublicLobbies();
    const found = publicLobbies.find(l => l.id === lobby.id);
    assert.ok(found, 'spectator-only lobby should appear in public list');
    assert.equal(found.spectatorCount, 1);
  });

  it('reconnecting player gets socketId updated', () => {
    lobby.addPlayer(fakeUser('u1'), 'old-socket');
    assert.equal(lobby.players[0].socketId, 'old-socket');

    // Simulate reconnection: update socketId
    const player = lobby.findPlayer('u1');
    player.socketId = 'new-socket';
    assert.equal(lobby.players[0].socketId, 'new-socket');
    assert.ok(lobbyManager.findLobbyBySocket('new-socket'), 'should find lobby by new socket');
  });

  it('reconnecting spectator gets socketId updated', () => {
    lobby.addSpectator(fakeUser('u1'), 'old-socket');
    assert.equal(lobby.spectators[0].socketId, 'old-socket');

    // Simulate reconnection: update socketId
    const spec = lobby.findSpectator('u1');
    spec.socketId = 'new-socket';
    assert.equal(lobby.spectators[0].socketId, 'new-socket');
    assert.ok(lobbyManager.findLobbyBySocket('new-socket'), 'should find lobby by new socket');
  });

  it('lobby stores consoleType and exposes it in toPublic', () => {
    assert.equal(lobby.consoleType, 'gba');
    const pub = lobby.toPublic();
    assert.equal(pub.consoleType, 'gba');
  });

  it('NDS lobby stores consoleType "nds"', () => {
    // Clean up
    for (const l of lobbyManager.getPublicLobbies()) {
      lobbyManager.removeLobby(l.id);
    }

    const ndsLobby = lobbyManager.createLobby({
      name: 'NDS Lobby',
      hostId: 'u1',
      hostName: 'User u1',
      romId: 'rom2',
      romName: 'NDS TestROM',
      consoleType: 'nds',
    });

    assert.equal(ndsLobby.consoleType, 'nds');
    ndsLobby.addPlayer(fakeUser('u1'), 'socket-1');
    const pub = ndsLobby.toPublic();
    assert.equal(pub.consoleType, 'nds');

    lobbyManager.removeLobby(ndsLobby.id);
  });

  it('lobby defaults consoleType to "gba" when not provided', () => {
    for (const l of lobbyManager.getPublicLobbies()) {
      lobbyManager.removeLobby(l.id);
    }

    const defaultLobby = lobbyManager.createLobby({
      name: 'Default Lobby',
      hostId: 'u1',
      hostName: 'User u1',
      romId: 'rom3',
      romName: 'DefaultROM',
    });

    assert.equal(defaultLobby.consoleType, 'gba', 'should default to gba');
    lobbyManager.removeLobby(defaultLobby.id);
  });
});

describe('Lobby join – first player vs spectator role assignment', () => {
  const lobbyJsPath = path.join(__dirname, '../src/socket/lobby.js');
  const lobbyJs = fs.readFileSync(lobbyJsPath, 'utf8');

  it('lobby:join adds the first user as player when no players exist yet', () => {
    // The first person to join an otherwise-empty lobby becomes the player
    // so they can launch the game immediately instead of spectating nobody.
    assert.ok(
      lobbyJs.includes('lobby.players.length === 0'),
      'lobby:join must check players.length === 0 to decide player vs spectator role'
    );
  });

  it('lobby:join adds subsequent users as spectators', () => {
    // 2nd, 3rd and 4th users join as spectators and can switch to player later.
    assert.ok(
      lobbyJs.includes('addSpectator(user, socket.id)'),
      'lobby:join must call addSpectator for non-first users'
    );
  });

  it('lobby:join ack includes role:player for the first user', () => {
    // The client reads the ack role to set myRole = "player" correctly.
    assert.ok(
      lobbyJs.includes("role: 'player'"),
      'lobby:join ack must include role: "player" for the first user'
    );
  });
});
