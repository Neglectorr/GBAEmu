'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const presenceServerJs = fs.readFileSync(
  path.join(__dirname, '../src/socket/presence.js'), 'utf8');
const presenceClientJs = fs.readFileSync(
  path.join(__dirname, '../public/js/pokemonPresence.js'), 'utf8');
const serverJs = fs.readFileSync(
  path.join(__dirname, '../server.js'), 'utf8');
const gameJs = fs.readFileSync(
  path.join(__dirname, '../public/js/game.js'), 'utf8');
const gameHtml = fs.readFileSync(
  path.join(__dirname, '../public/game.html'), 'utf8');

// ── Server module ────────────────────────────────────────────────────────────
describe('Presence server – socket namespace', () => {
  it('presence.js exports a setup function', () => {
    const mod = require('../src/socket/presence');
    assert.strictEqual(typeof mod, 'function',
      'src/socket/presence.js must export a function that accepts io');
  });

  it('presence.js registers the /presence namespace', () => {
    assert.ok(
      presenceServerJs.includes("io.of('/presence')"),
      "presence.js must call io.of('/presence') to create the namespace");
  });

  it('presence.js handles presence:join event', () => {
    assert.ok(
      presenceServerJs.includes("presence:join"),
      "presence.js must listen for the 'presence:join' event");
  });

  it('presence.js handles presence:update event', () => {
    assert.ok(
      presenceServerJs.includes("presence:update"),
      "presence.js must listen for the 'presence:update' event");
  });

  it('presence.js handles presence:leave event', () => {
    assert.ok(
      presenceServerJs.includes("presence:leave"),
      "presence.js must listen for the 'presence:leave' event");
  });

  it('presence.js emits presence:state to relay a player update', () => {
    assert.ok(
      presenceServerJs.includes("presence:state"),
      "presence.js must emit 'presence:state' to broadcast player position");
  });

  it('presence.js emits presence:left when a player disconnects', () => {
    assert.ok(
      presenceServerJs.includes("presence:left"),
      "presence.js must emit 'presence:left' on disconnect/leave");
  });

  it('presence.js rate-limits updates (UPDATE_RATE_LIMIT_MS)', () => {
    assert.ok(
      presenceServerJs.includes('UPDATE_RATE_LIMIT_MS'),
      'presence.js must define UPDATE_RATE_LIMIT_MS to cap update frequency');
    const match = presenceServerJs.match(/UPDATE_RATE_LIMIT_MS\s*=\s*(\d+)/);
    assert.ok(match, 'UPDATE_RATE_LIMIT_MS must be assigned a numeric value');
    const limit = parseInt(match[1], 10);
    assert.ok(limit >= 50 && limit <= 500,
      `UPDATE_RATE_LIMIT_MS should be 50–500ms (got ${limit})`);
  });

  it('presence.js authenticates the socket connection (requires user)', () => {
    assert.ok(
      presenceServerJs.includes('socket.request.user') &&
      presenceServerJs.includes('socket.disconnect(true)'),
      'presence.js must disconnect unauthenticated sockets');
  });

  it('presence.js sanitises incoming coordinate values', () => {
    assert.ok(
      presenceServerJs.includes('0xFF') || presenceServerJs.includes('0xFFFF'),
      'presence.js must mask/validate coordinate fields to prevent injection');
  });
});

// ── Server registration ──────────────────────────────────────────────────────
describe('server.js – presence module registration', () => {
  it('server.js requires the presence socket module', () => {
    assert.ok(
      serverJs.includes("require('./src/socket/presence')"),
      "server.js must require('./src/socket/presence') to register the namespace");
  });

  it('server.js calls the presence setup function with io', () => {
    assert.ok(
      serverJs.includes("require('./src/socket/presence')(io)"),
      "server.js must call the presence module factory with io");
  });
});

// ── Client module – game database ────────────────────────────────────────────
describe('Pokemon presence client – game database (GAME_DB)', () => {
  it('pokemonPresence.js defines a GAME_DB object', () => {
    assert.ok(
      presenceClientJs.includes('GAME_DB'),
      'pokemonPresence.js must define a GAME_DB address table');
  });

  it('GAME_DB contains FireRed entry (BPRE)', () => {
    assert.ok(
      presenceClientJs.includes('BPRE'),
      'GAME_DB must have an entry for Pokemon FireRed (game code BPRE)');
  });

  it('GAME_DB contains LeafGreen entry (BPGE)', () => {
    assert.ok(
      presenceClientJs.includes('BPGE'),
      'GAME_DB must have an entry for Pokemon LeafGreen (game code BPGE)');
  });

  it('GAME_DB contains Ruby entry (AXVE)', () => {
    assert.ok(
      presenceClientJs.includes('AXVE'),
      'GAME_DB must have an entry for Pokemon Ruby (game code AXVE)');
  });

  it('GAME_DB contains Sapphire entry (AXPE)', () => {
    assert.ok(
      presenceClientJs.includes('AXPE'),
      'GAME_DB must have an entry for Pokemon Sapphire (game code AXPE)');
  });

  it('GAME_DB contains Emerald entry (BPEE)', () => {
    assert.ok(
      presenceClientJs.includes('BPEE'),
      'GAME_DB must have an entry for Pokemon Emerald (game code BPEE)');
  });

  it('GAME_DB contains Quetzal entry (BPEE_Q)', () => {
    assert.ok(
      presenceClientJs.includes('BPEE_Q'),
      'GAME_DB must have an entry for Pokemon Quetzal (game code BPEE_Q)');
  });

  it('FRLG entries include EWRAM-based playerDataAddr', () => {
    // FireRed/LeafGreen store player data in EWRAM (0x02xxxxxx)
    assert.ok(
      presenceClientJs.includes('0x2036e48'),
      'FRLG entries must reference gPlayerData at 0x2036e48 (EWRAM)');
  });

  it('FRLG entries include EWRAM-based mapBankAddr', () => {
    assert.ok(
      presenceClientJs.includes('0x203f3a8'),
      'FRLG entries must reference gMapBank at 0x203f3a8 (EWRAM)');
  });

  it('GAME_DB entries include a gameCode field', () => {
    // Each entry embeds its game code directly so _pollAndSend can read it
    // without a separate reverse-lookup step.
    assert.ok(
      presenceClientJs.includes("gameCode: 'BPRE'") &&
      presenceClientJs.includes("gameCode: 'BPGE'") &&
      presenceClientJs.includes("gameCode: 'AXVE'"),
      'each GAME_DB entry must have a gameCode field matching its key');
  });

  it('RS entries have null playerDataAddr (player data is in IWRAM)', () => {
    assert.ok(
      presenceClientJs.includes('playerDataAddr: null'),
      'RS entries must use playerDataAddr: null because gPlayerData is in IWRAM (not yet readable)');
  });

  it('Emerald entry has EWRAM-based playerDataAddr', () => {
    assert.ok(
      presenceClientJs.includes('0x2037360'),
      'Emerald entry must reference gPlayerData at 0x2037360 (EWRAM)');
  });

  it('Emerald entry has correct mapBankAddr', () => {
    assert.ok(
      presenceClientJs.includes('0x203bc80'),
      'Emerald entry must reference gMapBank at 0x203bc80 (EWRAM)');
  });
});

// ── Client module – memory reading ──────────────────────────────────────────
describe('Pokemon presence client – EWRAM memory access', () => {
  it('pokemonPresence.js accesses mGBA WASM via EJS_emulator', () => {
    assert.ok(
      presenceClientJs.includes('EJS_emulator'),
      'pokemonPresence.js must access the mGBA WASM through window.EJS_emulator');
  });

  it('pokemonPresence.js uses retro_get_memory_data to locate EWRAM', () => {
    assert.ok(
      presenceClientJs.includes('retro_get_memory_data'),
      'pokemonPresence.js must use retro_get_memory_data(2) to find the EWRAM base pointer');
  });

  it('pokemonPresence.js reads from Emscripten HEAPU8', () => {
    assert.ok(
      presenceClientJs.includes('HEAPU8'),
      'pokemonPresence.js must read GBA memory via Module.HEAPU8');
  });

  it('pokemonPresence.js reads 16-bit values from HEAPU16', () => {
    assert.ok(
      presenceClientJs.includes('HEAPU16'),
      'pokemonPresence.js must read 16-bit values via Module.HEAPU16');
  });

  it('readEwramByte validates the address is within EWRAM bounds (0x40000)', () => {
    assert.ok(
      presenceClientJs.includes('0x40000'),
      'EWRAM read helpers must enforce the 256KB EWRAM size limit (0x40000 bytes)');
  });
});

// ── Client module – Socket.IO communication ──────────────────────────────────
describe('Pokemon presence client – socket communication', () => {
  it('pokemonPresence.js connects to the /presence namespace', () => {
    assert.ok(
      presenceClientJs.includes("'/presence'") || presenceClientJs.includes('"/presence"'),
      "pokemonPresence.js must connect to the '/presence' Socket.IO namespace");
  });

  it('pokemonPresence.js emits presence:update with position data', () => {
    assert.ok(
      presenceClientJs.includes("'presence:update'"),
      "pokemonPresence.js must emit 'presence:update' with player position data");
  });

  it('pokemonPresence.js listens for presence:state from other players', () => {
    assert.ok(
      presenceClientJs.includes("'presence:state'"),
      "pokemonPresence.js must listen for 'presence:state' to receive other players' positions");
  });

  it('pokemonPresence.js listens for presence:left when a peer disconnects', () => {
    assert.ok(
      presenceClientJs.includes("'presence:left'"),
      "pokemonPresence.js must listen for 'presence:left' to remove a peer's indicator");
  });

  it('pokemonPresence.js sends presence:join when connecting to a lobby', () => {
    assert.ok(
      presenceClientJs.includes("'presence:join'"),
      "pokemonPresence.js must emit 'presence:join' to register in the lobby room");
  });
});

// ── Client module – overlay rendering ───────────────────────────────────────
describe('Pokemon presence client – canvas overlay', () => {
  it('pokemonPresence.js creates a canvas overlay element', () => {
    assert.ok(
      presenceClientJs.includes("createElement('canvas')"),
      'pokemonPresence.js must create a <canvas> element for the presence overlay');
  });

  it('overlay canvas has pointer-events:none (non-blocking)', () => {
    assert.ok(
      presenceClientJs.includes('pointer-events:none'),
      'the overlay canvas must have pointer-events:none so it does not block game input');
  });

  it('overlay uses GBA screen dimensions (240×160)', () => {
    assert.ok(
      presenceClientJs.includes('240') && presenceClientJs.includes('160'),
      'overlay renderer must use the GBA screen dimensions (240×160 pixels)');
  });

  it('overlay uses TILE_PX for coordinate conversion', () => {
    assert.ok(
      presenceClientJs.includes('TILE_PX'),
      'overlay must use a TILE_PX constant to convert tile coords to screen pixels');
  });

  it('overlay draws player indicators with per-player colours', () => {
    assert.ok(
      presenceClientJs.includes('PLAYER_COLORS'),
      'overlay must use a PLAYER_COLORS array so each player has a distinct colour');
  });
});

// ── Client module – public API ────────────────────────────────────────────────
describe('Pokemon presence client – public API', () => {
  it('pokemonPresence.js exports initPresence via window.PokemonPresence', () => {
    assert.ok(
      presenceClientJs.includes('PokemonPresence') &&
      presenceClientJs.includes('initPresence'),
      'pokemonPresence.js must expose initPresence through window.PokemonPresence');
  });

  it('pokemonPresence.js exports stopPresence via window.PokemonPresence', () => {
    assert.ok(
      presenceClientJs.includes('stopPresence'),
      'pokemonPresence.js must expose stopPresence for cleanup');
  });

  it('pokemonPresence.js exports detectGame via window.PokemonPresence', () => {
    assert.ok(
      presenceClientJs.includes('detectGame'),
      'pokemonPresence.js must expose detectGame for ROM-name-based game detection');
  });
});

// ── game.js integration ──────────────────────────────────────────────────────
describe('game.js – presence system integration', () => {
  it('game.js calls PokemonPresence.initPresence after emulator starts', () => {
    assert.ok(
      gameJs.includes('PokemonPresence') && gameJs.includes('initPresence'),
      'game.js must call PokemonPresence.initPresence when the emulator is ready');
  });

  it('game.js calls PokemonPresence.stopPresence on leave', () => {
    assert.ok(
      gameJs.includes('stopPresence'),
      'game.js must call PokemonPresence.stopPresence when the player leaves');
  });

  it('game.js passes lobbyId and playerIndex to initPresence', () => {
    const initIdx = gameJs.indexOf('initPresence');
    assert.ok(initIdx !== -1, 'initPresence call must exist');
    const callBody = gameJs.substring(initIdx, initIdx + 100);
    assert.ok(
      callBody.includes('lobbyId') && callBody.includes('playerIndex'),
      'initPresence must be called with lobbyId and playerIndex');
  });

  it('game.js passes EJS_gameName to initPresence for game detection', () => {
    const initIdx = gameJs.indexOf('initPresence');
    const callBody = gameJs.substring(initIdx, initIdx + 120);
    assert.ok(
      callBody.includes('EJS_gameName'),
      'initPresence must receive window.EJS_gameName for ROM-name-based game detection');
  });
});

// ── game.html integration ─────────────────────────────────────────────────────
describe('game.html – presence script included', () => {
  it('game.html includes pokemonPresence.js before game.js', () => {
    const presenceIdx = gameHtml.indexOf('pokemonPresence.js');
    const gameJsIdx   = gameHtml.indexOf('game.js');
    assert.ok(presenceIdx !== -1,
      'game.html must include pokemonPresence.js');
    assert.ok(presenceIdx < gameJsIdx,
      'pokemonPresence.js must be included before game.js');
  });
});

// ── Presence group filtering (same ROM / counterpart only) ───────────────────
describe('Pokemon presence client – presence group filtering', () => {
  it('pokemonPresence.js defines PRESENCE_GROUP_BY_TYPE', () => {
    assert.ok(
      presenceClientJs.includes('PRESENCE_GROUP_BY_TYPE'),
      'pokemonPresence.js must define PRESENCE_GROUP_BY_TYPE to map game types to groups');
  });

  it('FRLG type maps to a presence group', () => {
    assert.ok(
      presenceClientJs.includes("FRLG:"),
      "PRESENCE_GROUP_BY_TYPE must include an entry for 'FRLG' (FireRed + LeafGreen)");
  });

  it('RS type maps to a presence group', () => {
    assert.ok(
      presenceClientJs.includes("RS:"),
      "PRESENCE_GROUP_BY_TYPE must include an entry for 'RS' (Ruby + Sapphire)");
  });

  it('pokemonPresence.js defines a getPresenceGroup helper', () => {
    assert.ok(
      presenceClientJs.includes('getPresenceGroup'),
      'pokemonPresence.js must define getPresenceGroup(gameCode) to resolve a group');
  });

  it('getPresenceGroup is exported via window.PokemonPresence', () => {
    // The public API should expose getPresenceGroup for external use / testing
    const exportLine = presenceClientJs.match(/window\.PokemonPresence\s*=\s*\{[^}]+\}/);
    assert.ok(exportLine, 'window.PokemonPresence must be assigned an object literal');
    assert.ok(
      exportLine[0].includes('getPresenceGroup'),
      'window.PokemonPresence must include getPresenceGroup');
  });

  it('presence:state handler filters by presence group', () => {
    // The handler must call getPresenceGroup on the incoming state.gameCode
    // and discard updates that do not match the local player's group.
    assert.ok(
      presenceClientJs.includes('peerGroup') &&
      presenceClientJs.includes('_myPresenceGroup'),
      "presence:state handler must compare peerGroup to _myPresenceGroup to filter cross-version updates");
  });

  it('_myPresenceGroup is reset to null in stopPresence', () => {
    assert.ok(
      presenceClientJs.includes('_myPresenceGroup = null'),
      '_myPresenceGroup must be reset to null when stopPresence() is called');
  });

  it('FireRed and LeafGreen share the same presence group (FRLG)', () => {
    // Both BPRE and BPGE must map to the same group identifier so they can
    // see each other's positions (Kanto map layout is identical in both).
    const frlgEntry  = presenceClientJs.includes("type: 'FRLG'");
    const frlgGroup  = /FRLG:\s*'FRLG'/.test(presenceClientJs);
    assert.ok(frlgEntry && frlgGroup,
      "FireRed and LeafGreen must both have type: 'FRLG' and FRLG must map to a group");
  });

  it('Ruby and Sapphire share the same presence group (RS)', () => {
    // Ruby and Sapphire use the same Hoenn map layout.
    const rsEntry = presenceClientJs.includes("type: 'RS'");
    const rsGroup = /RS:\s*'RS'/.test(presenceClientJs);
    assert.ok(rsEntry && rsGroup,
      "Ruby and Sapphire must both have type: 'RS' and RS must map to a group");
  });

  it('Emerald has its own presence group (EMERALD)', () => {
    // Emerald has expanded Hoenn maps (Battle Frontier, etc.)
    const emeraldEntry = presenceClientJs.includes("type: 'EMERALD'");
    const emeraldGroup = /EMERALD:\s*'EMERALD'/.test(presenceClientJs);
    assert.ok(emeraldEntry && emeraldGroup,
      "Emerald must have type: 'EMERALD' and EMERALD must map to a group");
  });

  it('Quetzal has its own presence group (QUETZAL)', () => {
    // Quetzal is an Emerald ROM hack with modified maps
    const quetzalEntry = presenceClientJs.includes("type: 'QUETZAL'");
    const quetzalGroup = /QUETZAL:\s*'QUETZAL'/.test(presenceClientJs);
    assert.ok(quetzalEntry && quetzalGroup,
      "Quetzal must have type: 'QUETZAL' and QUETZAL must map to a group");
  });
});
