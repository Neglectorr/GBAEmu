'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const gameJsPath  = path.join(__dirname, '../public/js/game.js');
const gameJs      = fs.readFileSync(gameJsPath, 'utf8');
const gameNdsJs   = fs.readFileSync(path.join(__dirname, '../public/js/game-nds.js'), 'utf8');
const serverJs    = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const savesJs     = fs.readFileSync(path.join(__dirname, '../src/routes/saves.js'), 'utf8');
const dbIndexJs   = fs.readFileSync(path.join(__dirname, '../src/db/index.js'), 'utf8');

// ── Save API fix: getSaveFile / loadSaveFiles ─────────────────────────────
describe('Save system – correct EmulatorJS API usage', () => {
  it('game.js uses getSaveFile() instead of getSave()', () => {
    assert.ok(
      gameJs.includes('getSaveFile()'),
      'game.js must call ejs.gameManager.getSaveFile() for extracting save data'
    );
    assert.ok(
      !gameJs.includes('.getSave()'),
      'game.js must NOT use the non-existent .getSave() method'
    );
  });

  it('game.js uses FS.writeFile + loadSaveFiles() instead of loadSave()', () => {
    assert.ok(
      gameJs.includes('getSaveFilePath()'),
      'game.js must call getSaveFilePath() to determine the save file path'
    );
    assert.ok(
      gameJs.includes('FS.writeFile(savePath, buf)'),
      'game.js must write save data to the filesystem via FS.writeFile'
    );
    assert.ok(
      gameJs.includes('loadSaveFiles()'),
      'game.js must call loadSaveFiles() to refresh the emulator after writing'
    );
    assert.ok(
      !gameJs.includes('.loadSave('),
      'game.js must NOT use the non-existent .loadSave() method'
    );
  });

  it('game-nds.js uses getSaveFile() instead of getSave()', () => {
    assert.ok(
      gameNdsJs.includes('getSaveFile()'),
      'game-nds.js must call ejs.gameManager.getSaveFile()'
    );
    assert.ok(
      !gameNdsJs.includes('.getSave()'),
      'game-nds.js must NOT use the non-existent .getSave() method'
    );
  });

  it('game-nds.js uses FS.writeFile + loadSaveFiles() instead of loadSave()', () => {
    assert.ok(
      gameNdsJs.includes('getSaveFilePath()'),
      'game-nds.js must call getSaveFilePath()'
    );
    assert.ok(
      gameNdsJs.includes('loadSaveFiles()'),
      'game-nds.js must call loadSaveFiles()'
    );
    assert.ok(
      !gameNdsJs.includes('.loadSave('),
      'game-nds.js must NOT use .loadSave()'
    );
  });
});

// ── EmulatorJS save/load button interception ───────────────────────────────
describe('EmulatorJS save/load buttons redirect to server', () => {
  it('game.js hooks saveState to also persist save states to the server', () => {
    assert.ok(
      gameJs.includes("ejsInstance.on('saveState'"),
      'game.js must intercept saveState to back up save states server-side'
    );
  });

  it('game.js hooks loadState to also load save states from the server', () => {
    assert.ok(
      gameJs.includes("ejsInstance.on('loadState'"),
      'game.js must intercept loadState to restore save states from the server'
    );
  });

  it('game.js hooks the saveSave event to persist to server', () => {
    assert.ok(
      gameJs.includes("ejsInstance.on('saveSave'"),
      'game.js must register a saveSave event handler'
    );
  });

  it('game.js hooks the loadSave event to load from server', () => {
    assert.ok(
      gameJs.includes("ejsInstance.on('loadSave'"),
      'game.js must register a loadSave event handler'
    );
  });

  it('game.js enables saveSavFiles and loadSavFiles buttons', () => {
    assert.ok(
      gameJs.includes('saveSavFiles: true'),
      'saveSavFiles button must be enabled'
    );
    assert.ok(
      gameJs.includes('loadSavFiles: true'),
      'loadSavFiles button must be enabled'
    );
  });
});

// ── EmulatorJS Netplay removed – Lua-style link cable only ────────────────
describe('EmulatorJS Netplay removed – Lua-style link cable emulation only', () => {
  it('game.js does NOT enable experimental netplay', () => {
    assert.ok(
      !gameJs.includes('EJS_EXPERIMENTAL_NETPLAY = true'),
      'game.js must NOT set EJS_EXPERIMENTAL_NETPLAY – only Lua-style link cable emulation is used'
    );
  });

  it('game.js does NOT set EJS_netplayServer', () => {
    assert.ok(
      !gameJs.includes('EJS_netplayServer'),
      'game.js must NOT set EJS_netplayServer – netplay is not used'
    );
  });

  it('game.js does NOT set EJS_gameID (no netplay room matching needed)', () => {
    assert.ok(
      !gameJs.includes('EJS_gameID'),
      'game.js must NOT set EJS_gameID – netplay is disabled'
    );
  });

  it('game.js disables the netplay button', () => {
    assert.ok(
      gameJs.includes('netplay:      false') || gameJs.includes('netplay: false'),
      'game.js must disable the netplay button (netplay: false)'
    );
  });

  it('server.js does NOT load the netplay module (fully removed)', () => {
    assert.ok(
      !serverJs.includes("require('./src/socket/netplay')"),
      'server.js must NOT require the netplay module – EmulatorJS netplay is fully removed'
    );
  });

  it('server.js loads the Lua-style link cable module', () => {
    assert.ok(
      serverJs.includes("require('./src/socket/luaLink')"),
      'server.js must require the luaLink module'
    );
  });

  it('toggleLinkCable uses only SIO link cable – no netplay calls', () => {
    const fnStart = gameJs.indexOf('function toggleLinkCable');
    assert.ok(fnStart !== -1, 'toggleLinkCable must exist');
    const fnBody = gameJs.substring(fnStart, fnStart + 600);
    assert.ok(
      !fnBody.includes('openNetplayMenu'),
      'toggleLinkCable must NOT call openNetplayMenu'
    );
    assert.ok(
      !fnBody.includes('isNetplay'),
      'toggleLinkCable must NOT check ejs.isNetplay'
    );
    assert.ok(
      fnBody.includes('enableLinkCable') || fnBody.includes('disableLinkCable'),
      'toggleLinkCable must call enableLinkCable / disableLinkCable'
    );
  });

  it('game.js does NOT define autoJoinNetplayRoom', () => {
    assert.ok(
      !gameJs.includes('async function autoJoinNetplayRoom'),
      'game.js must NOT define autoJoinNetplayRoom – netplay is removed'
    );
  });
});

// ── Save data stored as base64 string (not Buffer) in NeDB ────────────────
describe('Save data storage uses base64 strings (not Buffers)', () => {
  it('saves route does not call .toString("base64") on retrieved data', () => {
    assert.ok(
      !savesJs.includes('.toString(\'base64\')') && !savesJs.includes('.toString("base64")'),
      'saves.js must NOT call .toString("base64") – data is already stored as base64'
    );
  });

  it('saves route stores the base64 string directly (not a Buffer)', () => {
    // The insert call must use `data` (the raw base64 string from req.body),
    // not `buffer` (the decoded Buffer used only for validation).
    assert.ok(
      savesJs.includes('data, updatedAt'),
      'saves.js must insert { data } (the base64 string), not { data: buffer }'
    );
  });

  it('saves route validates base64 and checks size before storing', () => {
    assert.ok(
      savesJs.includes("Buffer.from(data, 'base64')"),
      'saves.js must still validate the base64 data by decoding it'
    );
    assert.ok(
      savesJs.includes('buffer.length > 2 * 1024 * 1024'),
      'saves.js must still enforce the 2 MB size limit'
    );
  });
});

// ── NeDB deprecation fixes ────────────────────────────────────────────────
describe('NeDB API uses non-deprecated methods', () => {
  it('saves route uses db.saves.compactDatafile() (not persistence.compactDatafile)', () => {
    assert.ok(
      savesJs.includes('db.saves.compactDatafile()'),
      'saves.js must call db.saves.compactDatafile()'
    );
    assert.ok(
      !savesJs.includes('persistence.compactDatafile'),
      'saves.js must NOT use the deprecated persistence.compactDatafile()'
    );
  });

  it('db/index.js uses saves.setAutocompactionInterval (not persistence.setAutocompactionInterval)', () => {
    assert.ok(
      dbIndexJs.includes('saves.setAutocompactionInterval('),
      'db/index.js must call saves.setAutocompactionInterval()'
    );
    assert.ok(
      !dbIndexJs.includes('persistence.setAutocompactionInterval'),
      'db/index.js must NOT use the deprecated persistence.setAutocompactionInterval()'
    );
  });
});

// ── GBA Link Cable – improved SIO register detection ──────────────────────
describe('GBA Link Cable – SIO register detection improvements', () => {
  it('findGbaIoBase searches for 4×0x0000 (zero-initialised SIOMULTI)', () => {
    assert.ok(
      gameJs.includes('0x0000 ||'),
      'findGbaIoBase must also search for 4 consecutive 0x0000 (mGBA initialises SIO regs to zero)'
    );
  });

  it('findGbaIoBase anchors on SOUNDBIAS = 0x0200', () => {
    assert.ok(
      gameJs.includes('0x0200') && gameJs.includes('0x088'),
      'findGbaIoBase must use SOUNDBIAS (IO+0x088 = 0x0200) as a search anchor'
    );
  });

  it('findGbaIoBase uses a shared scoreCandidate validation function', () => {
    assert.ok(
      gameJs.includes('function scoreCandidate('),
      'findGbaIoBase must use a scoreCandidate helper to validate I/O region candidates'
    );
  });

  it('installRegisterInterceptor injects connected SIOCNT state', () => {
    assert.ok(
      gameJs.includes('connectedSiocnt'),
      'installRegisterInterceptor must write a connected SIOCNT value each frame'
    );
  });

  it('installRegisterInterceptor tracks SIOMLT_SEND changes', () => {
    assert.ok(
      gameJs.includes('lastSendWord') && gameJs.includes('sendChanged'),
      'installRegisterInterceptor must detect SIOMLT_SEND value changes as a transfer trigger'
    );
  });

  it('installRegisterInterceptor sets RCNT to SIO mode', () => {
    assert.ok(
      gameJs.includes('rcntIdx') && gameJs.includes('0x134'),
      'installRegisterInterceptor must keep RCNT (IO+0x134) in SIO mode'
    );
  });

  it('installRegisterInterceptor initialises SIOMULTI0-3 to 0xFFFF', () => {
    const fnStart = gameJs.indexOf('function installRegisterInterceptor');
    assert.ok(fnStart !== -1, 'installRegisterInterceptor must exist');
    const fnBody = gameJs.substring(fnStart, fnStart + 5000);
    assert.ok(
      fnBody.includes('0xFFFF') && fnBody.includes('multi0'),
      'installRegisterInterceptor must initialise SIOMULTI0-3 to 0xFFFF before polling starts'
    );
  });
});

// ── GBA Link Cable – multiplayer window improvements ──────────────────────
describe('GBA Link Cable – multiplayer window improvements', () => {
  it('installRegisterInterceptor maintains a cachedMulti array', () => {
    const fnStart = gameJs.indexOf('function installRegisterInterceptor');
    assert.ok(fnStart !== -1);
    const fnBody = gameJs.substring(fnStart, fnStart + 5000);
    assert.ok(
      fnBody.includes('cachedMulti'),
      'installRegisterInterceptor must use a cachedMulti array for persistent data injection'
    );
  });

  it('installRegisterInterceptor continuously re-injects cached SIOMULTI data', () => {
    const fnStart = gameJs.indexOf('function installRegisterInterceptor');
    const fnBody = gameJs.substring(fnStart, fnStart + 5000);
    // Should write all four SIOMULTI registers from cache in poll cycle
    // (either via direct cachedMulti[N] access or via injectMultiWords helper)
    assert.ok(
      (fnBody.includes('cachedMulti[0]') &&
       fnBody.includes('cachedMulti[1]') &&
       fnBody.includes('cachedMulti[2]') &&
       fnBody.includes('cachedMulti[3]')) ||
      fnBody.includes('injectMultiWords'),
      'pollRegisters must continuously re-inject all 4 cached SIOMULTI values'
    );
  });

  it('installRegisterInterceptor triggers SIO IRQ via IF register', () => {
    const fnStart = gameJs.indexOf('function installRegisterInterceptor');
    const fnBody = gameJs.substring(fnStart, fnStart + 5000);
    assert.ok(
      fnBody.includes('ifIdx') && fnBody.includes('0x202'),
      'installRegisterInterceptor must reference IF register at IO+0x202'
    );
    assert.ok(
      fnBody.includes('(1 << 7)'),
      'installRegisterInterceptor must set Serial Communication IRQ bit (bit 7) in IF'
    );
  });

  it('installRegisterInterceptor ensures IE has SIO IRQ enabled', () => {
    const fnStart = gameJs.indexOf('function installRegisterInterceptor');
    const fnBody = gameJs.substring(fnStart, fnStart + 5000);
    assert.ok(
      fnBody.includes('ieIdx') && fnBody.includes('0x200'),
      'installRegisterInterceptor must reference IE register at IO+0x200'
    );
  });

  it('installRegisterInterceptor preserves game-written SIOCNT bits', () => {
    const fnStart = gameJs.indexOf('function installRegisterInterceptor');
    const fnBody = gameJs.substring(fnStart, fnStart + 5000);
    assert.ok(
      fnBody.includes('GAME_SIOCNT_MASK') || fnBody.includes('0x4003'),
      'installRegisterInterceptor must preserve game baud rate and IRQ enable bits'
    );
    assert.ok(
      fnBody.includes('buildConnectedSiocnt'),
      'installRegisterInterceptor must use buildConnectedSiocnt to merge game bits'
    );
  });

  it('installRegisterInterceptor uses high-frequency supplemental polling', () => {
    const fnStart = gameJs.indexOf('function installRegisterInterceptor');
    const fnBody = gameJs.substring(fnStart, fnStart + 10000);
    assert.ok(
      fnBody.includes('setInterval') && fnBody.includes('runPollCycle'),
      'installRegisterInterceptor must set up a setInterval timer for high-frequency polling'
    );
    assert.ok(
      gameJs.includes('_lcPollingInterval'),
      'game.js must declare _lcPollingInterval for the supplementary timer'
    );
  });

  it('disableLinkCable clears the supplementary polling interval', () => {
    const fnStart = gameJs.indexOf('function disableLinkCable');
    assert.ok(fnStart !== -1);
    const fnBody = gameJs.substring(fnStart, fnStart + 500);
    assert.ok(
      fnBody.includes('_lcPollingInterval'),
      'disableLinkCable must clear _lcPollingInterval'
    );
  });

  it('scoreCandidate validates IE register (upper bits should be 0)', () => {
    const fnStart = gameJs.indexOf('function scoreCandidate');
    assert.ok(fnStart !== -1);
    const fnBody = gameJs.substring(fnStart, fnStart + 1500);
    assert.ok(
      fnBody.includes('0x200') && fnBody.includes('ieIdx'),
      'scoreCandidate must validate IE register at IO+0x200'
    );
  });

  it('requestTransfer uses reduced safety timeout (1500ms or less)', () => {
    const fnStart = gameJs.indexOf('function requestTransfer(');
    assert.ok(fnStart !== -1);
    const fnBody = gameJs.substring(fnStart, fnStart + 1500);
    assert.ok(
      fnBody.includes('1500'),
      'requestTransfer safety timeout should be 1500ms (reduced from 3000ms)'
    );
  });

  it('requestTransfer sends the current transferId (not hardcoded 0)', () => {
    const fnStart = gameJs.indexOf('function requestTransfer(');
    assert.ok(fnStart !== -1);
    const fnBody = gameJs.substring(fnStart, fnStart + 500);
    assert.ok(
      !fnBody.includes('transferId: 0'),
      'requestTransfer must NOT hardcode transferId: 0 – it should use currentTransferId'
    );
    assert.ok(
      fnBody.includes('transferId') && fnBody.includes('currentTransferId'),
      'requestTransfer must send the current transferId to avoid stale-transfer rejections'
    );
  });

  it('lua:sync handler updates currentTransferId for next round', () => {
    const syncIdx = gameJs.indexOf("lcSocket.on('lua:sync'");
    assert.ok(syncIdx !== -1, "lua:sync handler must exist");
    const syncBody = gameJs.substring(syncIdx, syncIdx + 400);
    assert.ok(
      syncBody.includes('currentTransferId'),
      "lua:sync handler must update currentTransferId so subsequent sends use the correct ID"
    );
  });
});

// ── Lua Link Cable server – master/slave architecture ─────────────────────
describe('Lua Link Cable server – master/slave architecture', () => {
  it('luaLink.js defines SLAVE_TIMEOUT (fast, ≤ 500ms)', () => {
    const luaLinkJs = fs.readFileSync(path.join(__dirname, '../src/socket/luaLink.js'), 'utf8');
    const match = luaLinkJs.match(/SLAVE_TIMEOUT\s*=\s*(\d+)/);
    assert.ok(match, 'luaLink.js must define SLAVE_TIMEOUT');
    const timeout = parseInt(match[1], 10);
    assert.ok(
      timeout <= 500,
      `SLAVE_TIMEOUT should be ≤ 500ms for responsive multiplayer, got ${timeout}ms`
    );
  });

  it('luaLink.js identifies P0 as master on lua:join', () => {
    const luaLinkJs = fs.readFileSync(path.join(__dirname, '../src/socket/luaLink.js'), 'utf8');
    assert.ok(
      luaLinkJs.includes('isMaster') && luaLinkJs.includes('playerIndex === 0'),
      'luaLink.js must identify P0 as master and communicate isMaster to clients'
    );
  });

  it('luaLink.js broadcasts lua:masterReady when master sends', () => {
    const luaLinkJs = fs.readFileSync(path.join(__dirname, '../src/socket/luaLink.js'), 'utf8');
    assert.ok(
      luaLinkJs.includes("'lua:masterReady'"),
      'luaLink.js must emit lua:masterReady to slaves when master sends its word'
    );
  });

  it('game.js connects to /lualink namespace (not old /linkcable)', () => {
    assert.ok(
      gameJs.includes("io('/lualink'"),
      'game.js must use the /lualink socket namespace'
    );
    assert.ok(
      !gameJs.includes("io('/linkcable'"),
      'game.js must NOT use the old /linkcable namespace'
    );
  });

  it('game.js uses lua:join to join the session', () => {
    assert.ok(
      gameJs.includes("'lua:join'"),
      "game.js must use lua:join to join the Lua-style link cable session"
    );
  });

  it('game.js uses lua:send for the master transfer', () => {
    assert.ok(
      gameJs.includes("'lua:send'"),
      "game.js must use lua:send for the Lua-style link cable transfer"
    );
  });

  it('game.js enables link cable for P0 when other players are present', () => {
    assert.ok(
      gameJs.includes('playerIndex === 0') && gameJs.includes('enableLinkCable'),
      'game.js must enable link cable for P0 (triggered once another player joins)'
    );
    // P0 should NOT connect unconditionally solo – the condition must also check
    // that other players are present or linkCableActive is set.
    assert.ok(
      gameJs.includes('otherPlayersPresent') || gameJs.includes('players?.length') ||
      gameJs.includes('linkCableActive'),
      'game.js P0 link-cable enable must be guarded by a players-present / linkCableActive check'
    );
  });

  it('game.html has compatible ROM selector modal', () => {
    const gameHtml = fs.readFileSync(path.join(__dirname, '../public/game.html'), 'utf8');
    assert.ok(
      gameHtml.includes('compat-rom-modal'),
      'game.html must include the #compat-rom-modal element for compatible ROM selection'
    );
  });
});

// ── Multiplayer connection – spectator-by-default join ─────────────────────
describe('Multiplayer connection – spectator-by-default', () => {
  it('lobby.js adds new users as spectators by default on join', () => {
    const lobbyJs = fs.readFileSync(path.join(__dirname, '../src/socket/lobby.js'), 'utf8');
    const joinIdx = lobbyJs.indexOf("socket.on('lobby:join'");
    assert.ok(joinIdx !== -1, 'lobby:join handler must exist');
    const joinBody = lobbyJs.substring(joinIdx, joinIdx + 2000);
    // The default join path must call addSpectator (not addPlayer)
    const addSpectatorIdx = joinBody.indexOf('lobby.addSpectator(user');
    assert.ok(addSpectatorIdx !== -1,
      'lobby:join must call addSpectator by default');
    // addPlayer must NOT appear before addSpectator in the join handler
    // (addPlayer is only reached via lobby:switch-role)
    const addPlayerIdx = joinBody.indexOf('lobby.addPlayer(user');
    const addPlayerBeforeSpec = addPlayerIdx !== -1 && addPlayerIdx < addSpectatorIdx;
    assert.ok(!addPlayerBeforeSpec,
      'lobby:join default path must not call addPlayer before addSpectator');
  });

  it('lobby:switch-role allows a spectator to become a player', () => {
    const lobbyJs = fs.readFileSync(path.join(__dirname, '../src/socket/lobby.js'), 'utf8');
    const switchRoleIdx = lobbyJs.indexOf("socket.on('lobby:switch-role'");
    assert.ok(switchRoleIdx !== -1, 'lobby:switch-role handler must exist');
    const switchRoleBody = lobbyJs.substring(switchRoleIdx, switchRoleIdx + 1000);
    assert.ok(switchRoleBody.includes('switchToPlayer'),
      'lobby:switch-role must call switchToPlayer');
    assert.ok(switchRoleBody.includes('switchToSpectator'),
      'lobby:switch-role must call switchToSpectator');
  });

  it('users can join as spectator then opt in as player via the LobbyManager', () => {
    const lobbyManager = require('../src/socket/lobbyManager');
    // Clean up
    for (const l of lobbyManager.getPublicLobbies()) {
      lobbyManager.removeLobby(l.id);
    }

    const lobby = lobbyManager.createLobby({
      name: 'Spectator-Join Test',
      hostId: 'host1',
      hostName: 'Host',
      romId: 'rom1',
      romName: 'TestROM',
      consoleType: 'gba',
    });

    // User joins as spectator (the new default)
    const specResult = lobby.addSpectator(
      { _id: 'user1', displayName: 'User1', avatarUrl: '' },
      'socket-user1'
    );
    assert.ok(specResult.success, 'user must be able to join as spectator');
    assert.equal(lobby.spectators.length, 1);
    assert.equal(lobby.players.length, 0);

    // User opts in as player via switch-role
    const switchResult = lobby.switchToPlayer('user1', 'socket-user1');
    assert.ok(switchResult.success, 'user must be able to switch to player');
    assert.equal(switchResult.playerIndex, 0, 'first player gets index 0');
    assert.equal(lobby.players.length, 1);
    assert.equal(lobby.spectators.length, 0);

    lobbyManager.removeLobby(lobby.id);
  });
});

// ── Link cable session tracking ────────────────────────────────────────────
describe('Link cable session – connected player tracking', () => {
  it('LuaLinkSession tracks connected players via connectedPlayers map', () => {
    const luaLinkJs = fs.readFileSync(path.join(__dirname, '../src/socket/luaLink.js'), 'utf8');
    assert.ok(
      luaLinkJs.includes('connectedPlayers'),
      'LuaLinkSession must have a connectedPlayers map'
    );
  });

  it('lua:join adds player to connectedPlayers', () => {
    const luaLinkJs = fs.readFileSync(path.join(__dirname, '../src/socket/luaLink.js'), 'utf8');
    assert.ok(
      luaLinkJs.includes('session.connectedPlayers.set('),
      'lua:join must add the player to session.connectedPlayers'
    );
  });

  it('lua:status broadcasts connectedCount to clients', () => {
    const luaLinkJs = fs.readFileSync(path.join(__dirname, '../src/socket/luaLink.js'), 'utf8');
    assert.ok(
      luaLinkJs.includes('connectedCount'),
      'lua:status must include connectedCount so clients know how many players are linked'
    );
  });

  it('leaveLuaSession removes player from connectedPlayers', () => {
    const luaLinkJs = fs.readFileSync(path.join(__dirname, '../src/socket/luaLink.js'), 'utf8');
    assert.ok(
      luaLinkJs.includes('session.connectedPlayers.delete('),
      'leaveLuaSession must remove the player from connectedPlayers'
    );
  });
});

// ── Client-side link cable auto-activation ─────────────────────────────────
describe('Client-side link cable – auto-activation improvements', () => {
  it('game.js declares _pendingLinkCable flag', () => {
    assert.ok(
      gameJs.includes('_pendingLinkCable'),
      'game.js must declare _pendingLinkCable for deferred link cable activation'
    );
  });

  it('lua:status handler sets _pendingLinkCable when emulator is not ready', () => {
    const statusIdx = gameJs.indexOf("lcSocket.on('lua:status'");
    assert.ok(statusIdx !== -1, 'lua:status handler must exist');
    const statusBody = gameJs.substring(statusIdx, statusIdx + 800);
    assert.ok(
      statusBody.includes('_pendingLinkCable = true'),
      'lua:status must set _pendingLinkCable when emulator is not ready yet'
    );
  });

  it('EJS_onGameStart checks _pendingLinkCable for auto-connect', () => {
    const startIdx = gameJs.indexOf('EJS_onGameStart');
    assert.ok(startIdx !== -1, 'EJS_onGameStart must exist');
    const startBody = gameJs.substring(startIdx, startIdx + 3000);
    assert.ok(
      startBody.includes('_pendingLinkCable'),
      'EJS_onGameStart must check _pendingLinkCable for deferred link cable activation'
    );
  });

  it('enableLinkCable shows connected count in toast', () => {
    const fnStart = gameJs.indexOf('function enableLinkCable');
    assert.ok(fnStart !== -1);
    const fnBody = gameJs.substring(fnStart, fnStart + 600);
    assert.ok(
      fnBody.includes('connectedCount'),
      'enableLinkCable must show connected player count in feedback'
    );
  });

  it('handleLobbyState enables link cable for all players (not just P0)', () => {
    const fnStart = gameJs.indexOf('function handleLobbyState');
    assert.ok(fnStart !== -1);
    const fnBody = gameJs.substring(fnStart, fnStart + 3000);
    assert.ok(
      fnBody.includes('!lcEnabled && (otherPlayersPresent || lobby.linkCableActive)'),
      'handleLobbyState must enable link cable for ALL players when others are present'
    );
    // The if-condition that enables link cable must NOT be restricted to P0 only.
    // Find the line containing the enableLinkCable guard and check the preceding
    // characters for a playerIndex === 0 gate.
    const guardIdx = fnBody.indexOf('!lcEnabled && (otherPlayersPresent');
    assert.ok(guardIdx > 0);
    // Look at the 80 characters before the guard for a P0-only restriction
    const preceding = fnBody.substring(Math.max(0, guardIdx - 80), guardIdx);
    assert.ok(
      !preceding.includes('playerIndex === 0'),
      'Link cable auto-enable must NOT be restricted to P0 only'
    );
  });
});

// ── Server-side Save States (separate from in-game saves) ─────────────────
const savestatesJs = fs.readFileSync(path.join(__dirname, '../src/routes/savestates.js'), 'utf8');
const gameHtml     = fs.readFileSync(path.join(__dirname, '../public/game.html'), 'utf8');
const luaLinkJs    = fs.readFileSync(path.join(__dirname, '../src/socket/luaLink.js'), 'utf8');
const webrtcSignalJs = fs.readFileSync(path.join(__dirname, '../src/socket/webrtcSignal.js'), 'utf8');

describe('Server-side Save States (savestates.db)', () => {
  it('db/index.js creates a separate savestates datastore', () => {
    assert.ok(
      dbIndexJs.includes("savestates.db"),
      'db/index.js must create a savestates.db datastore separate from saves.db'
    );
  });

  it('db/index.js exports the savestates collection', () => {
    assert.ok(
      dbIndexJs.includes('savestates'),
      'db/index.js must export savestates'
    );
  });

  it('db/index.js indexes savestates by userId and romId', () => {
    assert.ok(
      dbIndexJs.includes("savestates.ensureIndex"),
      'db/index.js must index savestates collection'
    );
  });

  it('db/index.js auto-compacts savestates.db', () => {
    assert.ok(
      dbIndexJs.includes("savestates.setAutocompactionInterval"),
      'db/index.js must auto-compact savestates.db'
    );
  });

  it('savestates route validates base64 and checks size', () => {
    assert.ok(
      savestatesJs.includes("Buffer.from(data, 'base64')"),
      'savestates.js must validate the base64 data'
    );
    assert.ok(
      savestatesJs.includes('MAX_STATE_SIZE'),
      'savestates.js must enforce a maximum size'
    );
  });

  it('savestates route uses slot 1 for quick-save', () => {
    assert.ok(
      savestatesJs.includes('slot: 1'),
      'savestates.js must use slot 1 for quick-save'
    );
  });

  it('savestates route stores data in savestates collection (not saves)', () => {
    assert.ok(
      savestatesJs.includes('db.savestates'),
      'savestates.js must use db.savestates (not db.saves)'
    );
    // Ensure no db.saves.findOne / db.saves.remove / db.saves.insert calls
    assert.ok(
      !savestatesJs.includes('db.saves.'),
      'savestates.js must NOT call methods on db.saves'
    );
  });

  it('server.js registers the savestates route', () => {
    assert.ok(
      serverJs.includes("require('./src/routes/savestates')"),
      'server.js must register the savestates route'
    );
    assert.ok(
      serverJs.includes('/api/savestates'),
      'server.js must mount savestates at /api/savestates'
    );
  });

  it('game.js defines persistSaveState function', () => {
    assert.ok(
      gameJs.includes('async function persistSaveState'),
      'game.js must define persistSaveState for server-side save state storage'
    );
  });

  it('game.js defines loadServerSaveState function', () => {
    assert.ok(
      gameJs.includes('async function loadServerSaveState'),
      'game.js must define loadServerSaveState for server-side save state retrieval'
    );
  });

  it('game.js persistSaveState uses /api/savestates endpoint (not /api/saves)', () => {
    const fnStart = gameJs.indexOf('async function persistSaveState');
    assert.ok(fnStart !== -1);
    const fnBody = gameJs.substring(fnStart, fnStart + 1500);
    assert.ok(
      fnBody.includes('/api/savestates/'),
      'persistSaveState must use /api/savestates/ endpoint'
    );
    assert.ok(
      !fnBody.includes('/api/saves/'),
      'persistSaveState must NOT use /api/saves/ endpoint'
    );
  });
});

// ── Multiplayer Diagnostics ───────────────────────────────────────────────
describe('Multiplayer Diagnostics', () => {
  it('luaLink.js tracks transfer statistics', () => {
    assert.ok(
      luaLinkJs.includes('stats'),
      'LuaLinkSession must track transfer stats'
    );
    assert.ok(
      luaLinkJs.includes('totalTransfers'),
      'Stats must include totalTransfers count'
    );
    assert.ok(
      luaLinkJs.includes('masterSends'),
      'Stats must include masterSends count'
    );
  });

  it('luaLink.js handles lua:ping for latency measurement', () => {
    assert.ok(
      luaLinkJs.includes("'lua:ping'"),
      'luaLink.js must handle lua:ping events'
    );
    assert.ok(
      luaLinkJs.includes('serverTime'),
      'lua:ping response must include serverTime'
    );
  });

  it('luaLink.js handles lua:diagnostics for session verification', () => {
    assert.ok(
      luaLinkJs.includes("'lua:diagnostics'"),
      'luaLink.js must handle lua:diagnostics events'
    );
    assert.ok(
      luaLinkJs.includes('architecture'),
      'lua:diagnostics response must include architecture info'
    );
  });

  it('game.js defines requestLinkDiagnostics function', () => {
    assert.ok(
      gameJs.includes('async function requestLinkDiagnostics'),
      'game.js must define requestLinkDiagnostics'
    );
  });

  it('game.js defines showLinkDiagnostics function', () => {
    assert.ok(
      gameJs.includes('async function showLinkDiagnostics'),
      'game.js must define showLinkDiagnostics'
    );
  });

  it('game.html has diagnostics button', () => {
    assert.ok(
      gameHtml.includes('lc-diagnostics-btn'),
      'game.html must include a diagnostics button'
    );
  });

  it('game.html has diagnostics panel', () => {
    assert.ok(
      gameHtml.includes('lc-diagnostics-panel'),
      'game.html must include a diagnostics panel'
    );
    assert.ok(
      gameHtml.includes('lc-diagnostics-content'),
      'game.html must include a diagnostics content area'
    );
  });
});

// ── WebRTC P2P link cable with Socket.IO signaling + fallback ─────────────
describe('WebRTC P2P link cable – direct connection with Socket.IO fallback', () => {
  it('game.js uses RTCPeerConnection for direct P2P link cable', () => {
    assert.ok(
      gameJs.includes('RTCPeerConnection'),
      'game.js must use RTCPeerConnection to establish a direct P2P link cable connection'
    );
    assert.ok(
      gameJs.includes('createDataChannel'),
      'game.js must create a DataChannel for low-latency link cable data transfer'
    );
  });

  it('game.js uses WebRTC offer/answer handshake for signaling', () => {
    assert.ok(
      gameJs.includes('createOffer'),
      'game.js must call createOffer to initiate the WebRTC P2P connection'
    );
    assert.ok(
      gameJs.includes('createAnswer'),
      'game.js must call createAnswer on the slave side to complete the handshake'
    );
  });

  it('game.js connects to /webrtc-signal namespace for signaling', () => {
    assert.ok(
      gameJs.includes("io('/webrtc-signal'"),
      "game.js must connect to the /webrtc-signal Socket.IO namespace for SDP/ICE relay"
    );
  });

  it('game.js has fallback to Socket.IO relay when WebRTC is unavailable', () => {
    assert.ok(
      gameJs.includes('_rtcFallback'),
      'game.js must track WebRTC fallback state (_rtcFallback)'
    );
    assert.ok(
      gameJs.includes('requestTransfer(sendWord)'),
      'game.js must fall back to Socket.IO requestTransfer when WebRTC is unavailable'
    );
  });

  it('game.js uses requestTransferWebRtc as the primary transfer path for the master', () => {
    assert.ok(
      gameJs.includes('function requestTransferWebRtc('),
      'game.js must define requestTransferWebRtc() as the WebRTC transfer function'
    );
    assert.ok(
      gameJs.includes('requestTransferWebRtc(sendWord)'),
      'game.js must call requestTransferWebRtc in the register interceptor'
    );
  });

  it('luaLink.js Socket.IO relay is preserved as fallback (server still relays data)', () => {
    assert.ok(
      !luaLinkJs.includes('peer'),
      'luaLink.js must NOT reference peer-to-peer connections – it is the relay fallback'
    );
    assert.ok(
      luaLinkJs.includes("ns.to(lobbyId).emit('lua:sync'"),
      'luaLink.js must still broadcast sync data through the server (fallback path)'
    );
  });

  it('lua:diagnostics confirms Socket.IO relay architecture', () => {
    assert.ok(
      luaLinkJs.includes("'client-server (Socket.IO, no P2P)'"),
      'lua:diagnostics must explicitly report the Socket.IO relay architecture'
    );
  });

  it('webrtcSignal.js relays SDP offers/answers for P2P negotiation', () => {
    assert.ok(
      webrtcSignalJs.includes("'webrtc:offer'"),
      "webrtcSignal.js must handle the webrtc:offer signaling message"
    );
    assert.ok(
      webrtcSignalJs.includes("'webrtc:answer'"),
      "webrtcSignal.js must handle the webrtc:answer signaling message"
    );
    assert.ok(
      webrtcSignalJs.includes("'webrtc:ice-candidate'"),
      "webrtcSignal.js must handle ICE candidate relay"
    );
  });

  it('server.js registers the /webrtc-signal namespace', () => {
    assert.ok(
      serverJs.includes('webrtcSignal'),
      'server.js must require and register the webrtcSignal socket module'
    );
  });

  it('game.js DataChannel protocol includes transfer/word/sync message types', () => {
    assert.ok(
      gameJs.includes("type: 'transfer'"),
      "game.js must send transfer notifications to slaves via DataChannel"
    );
    assert.ok(
      gameJs.includes("type: 'sync'"),
      "game.js must broadcast sync packets to slaves via DataChannel"
    );
    assert.ok(
      gameJs.includes("type: 'word'"),
      "game.js must send word responses from slave to master via DataChannel"
    );
  });
});

// ── Multiplayer link cable – I/O detection improvements ───────────────────
describe('Multiplayer link cable – robust I/O detection', () => {
  it('game.js defines getWasmModule helper with fallback paths', () => {
    assert.ok(
      gameJs.includes('function getWasmModule()'),
      'game.js must define getWasmModule() for robust WASM Module access'
    );
    // Should try multiple paths
    assert.ok(
      gameJs.includes('gameManager?.Module') && gameJs.includes('ejs.Module'),
      'getWasmModule must try multiple paths to find the WASM Module'
    );
  });

  it('game.js caches the WASM module reference', () => {
    assert.ok(
      gameJs.includes('_cachedWasmModule'),
      'getWasmModule must cache the Module reference to avoid repeated lookups'
    );
  });

  it('findGbaIoBase uses getWasmModule instead of hardcoded path', () => {
    const fnStart = gameJs.indexOf('function findGbaIoBase()');
    assert.ok(fnStart !== -1);
    const fnBody = gameJs.substring(fnStart, fnStart + 300);
    assert.ok(
      fnBody.includes('getWasmModule()'),
      'findGbaIoBase must use getWasmModule() for Module access'
    );
  });

  it('game.js defines findIoBaseViaCheat for cheat-marker detection', () => {
    assert.ok(
      gameJs.includes('async function findIoBaseViaCheat()'),
      'game.js must define findIoBaseViaCheat for cheat-marker-based I/O detection'
    );
  });

  it('findIoBaseViaCheat uses the mGBA cheat system', () => {
    const fnStart = gameJs.indexOf('async function findIoBaseViaCheat()');
    assert.ok(fnStart !== -1);
    const fnBody = gameJs.substring(fnStart, fnStart + 2000);
    assert.ok(
      fnBody.includes('setCheat') && fnBody.includes('resetCheat'),
      'findIoBaseViaCheat must use setCheat/resetCheat to write marker values'
    );
  });

  it('findIoBaseViaCheat tries multiple cheat code formats', () => {
    const fnStart = gameJs.indexOf('async function findIoBaseViaCheat()');
    const fnBody = gameJs.substring(fnStart, fnStart + 2000);
    assert.ok(
      fnBody.includes('CHEAT_FORMATS'),
      'findIoBaseViaCheat must try multiple cheat code formats for compatibility'
    );
  });

  it('findIoBaseViaCheat cleans up cheats after detection', () => {
    const fnStart = gameJs.indexOf('async function findIoBaseViaCheat()');
    const fnBody = gameJs.substring(fnStart, fnStart + 3000);
    // Must disable and reset cheats after scanning
    const resetCount = (fnBody.match(/resetCheat/g) || []).length;
    assert.ok(
      resetCount >= 2,
      'findIoBaseViaCheat must clean up cheats after detection (multiple resetCheat calls)'
    );
  });

  it('game.js defines validateIoBase for I/O base verification', () => {
    assert.ok(
      gameJs.includes('function validateIoBase('),
      'game.js must define validateIoBase to verify detected I/O base is correct'
    );
  });

  it('validateIoBase checks KEYINPUT and DISPCNT registers', () => {
    const fnStart = gameJs.indexOf('function validateIoBase(');
    assert.ok(fnStart !== -1);
    const fnBody = gameJs.substring(fnStart, fnStart + 800);
    assert.ok(
      fnBody.includes('0x130') && fnBody.includes('KEYINPUT'),
      'validateIoBase must check KEYINPUT register at IO+0x130'
    );
    assert.ok(
      fnBody.includes('DISPCNT') || fnBody.includes('0x000'),
      'validateIoBase must check DISPCNT register at IO+0x000'
    );
  });

  it('attemptLinkCableSetup is async and tries cheat-based detection', () => {
    assert.ok(
      gameJs.includes('async function attemptLinkCableSetup('),
      'attemptLinkCableSetup must be async to support cheat-marker detection'
    );
    const fnStart = gameJs.indexOf('async function attemptLinkCableSetup(');
    const fnBody = gameJs.substring(fnStart, fnStart + 2000);
    assert.ok(
      fnBody.includes('findIoBaseViaCheat'),
      'attemptLinkCableSetup must try cheat-based detection as fallback'
    );
    assert.ok(
      fnBody.includes('validateIoBase'),
      'attemptLinkCableSetup must validate the detected I/O base'
    );
  });

  it('findGbaIoBase includes DISPCNT as detection anchor', () => {
    const fnStart = gameJs.indexOf('function findGbaIoBase()');
    const fnBody = gameJs.substring(fnStart, fnStart + 6000);
    assert.ok(
      fnBody.includes('DISPCNT'),
      'findGbaIoBase must use DISPCNT (IO+0x000) as a detection anchor'
    );
  });

  it('scoreCandidate validates DISPCNT register', () => {
    const fnStart = gameJs.indexOf('function scoreCandidate(');
    assert.ok(fnStart !== -1);
    const fnBody = gameJs.substring(fnStart, fnStart + 2000);
    assert.ok(
      fnBody.includes('DISPCNT') || (fnBody.includes('0x000') && fnBody.includes('dmode')),
      'scoreCandidate must validate DISPCNT register (display mode 0-5)'
    );
  });

  it('game.js tracks which detection strategy succeeded', () => {
    assert.ok(
      gameJs.includes('_lcDetectionStrategy'),
      'game.js must track which I/O detection strategy was used'
    );
  });

  it('diagnostics panel shows I/O detection status', () => {
    const fnStart = gameJs.indexOf('async function showLinkDiagnostics()');
    assert.ok(fnStart !== -1);
    const fnBody = gameJs.substring(fnStart, fnStart + 3000);
    assert.ok(
      fnBody.includes('_lcDetectionStrategy'),
      'showLinkDiagnostics must display which detection strategy was used'
    );
    assert.ok(
      fnBody.includes('getWasmModule'),
      'showLinkDiagnostics must report whether WASM Module is available'
    );
  });

  it('installSaveStateProtocol tries cheat-based detection in background', () => {
    const fnStart = gameJs.indexOf('function installSaveStateProtocol(');
    assert.ok(fnStart !== -1);
    const fnBody = gameJs.substring(fnStart, fnStart + 1500);
    assert.ok(
      fnBody.includes('findIoBaseViaCheat'),
      'installSaveStateProtocol must try cheat-based detection during background scans'
    );
  });

  it('LC_MAX_RETRIES is at least 15 for more search time', () => {
    const match = gameJs.match(/LC_MAX_RETRIES\s*=\s*(\d+)/);
    assert.ok(match, 'LC_MAX_RETRIES must be defined');
    const retries = parseInt(match[1], 10);
    assert.ok(
      retries >= 15,
      `LC_MAX_RETRIES should be >= 15 for thorough detection, got ${retries}`
    );
  });

  it('runPollCycle uses getWasmModule instead of hardcoded path', () => {
    const fnStart = gameJs.indexOf('function runPollCycle()');
    assert.ok(fnStart !== -1);
    const fnBody = gameJs.substring(fnStart, fnStart + 300);
    assert.ok(
      fnBody.includes('getWasmModule()'),
      'runPollCycle must use getWasmModule() for Module access'
    );
  });
});

// ── HEAPU8 fallback – mGBA core only exports HEAPU8 ──────────────────────
describe('WASM Module HEAPU8 fallback (mGBA core compatibility)', () => {
  it('getWasmModule derives HEAPU16 from HEAPU8 when not natively exported', () => {
    assert.ok(
      gameJs.includes('HEAPU8') && gameJs.includes('Uint16Array'),
      'getWasmModule must create HEAPU16 from HEAPU8.buffer when HEAPU16 is missing'
    );
    const fnStart = gameJs.indexOf('function getWasmModule()');
    assert.ok(fnStart !== -1);
    const fnBody = gameJs.substring(fnStart, fnStart + 1500);
    assert.ok(
      fnBody.includes('HEAPU8'),
      'getWasmModule must check for HEAPU8 as fallback'
    );
  });

  it('game.js defines _ensureHeap16 helper for buffer freshness', () => {
    assert.ok(
      gameJs.includes('function _ensureHeap16('),
      'game.js must define _ensureHeap16 to derive HEAPU16 from HEAPU8'
    );
    const fnStart = gameJs.indexOf('function _ensureHeap16(');
    const fnBody = gameJs.substring(fnStart, fnStart + 500);
    assert.ok(
      fnBody.includes('Uint16Array') && fnBody.includes('HEAPU8'),
      '_ensureHeap16 must create a Uint16Array view from HEAPU8.buffer'
    );
  });

  it('_ensureHeap16 detects stale HEAPU16 via buffer comparison', () => {
    const fnStart = gameJs.indexOf('function _ensureHeap16(');
    assert.ok(fnStart !== -1);
    const fnBody = gameJs.substring(fnStart, fnStart + 500);
    assert.ok(
      fnBody.includes('.buffer'),
      '_ensureHeap16 must compare .buffer references to detect memory growth'
    );
  });

  it('pokemonPresence.js derives HEAPU16 from HEAPU8 in readEwramShort', () => {
    const presenceJs = fs.readFileSync(
      path.join(__dirname, '../public/js/pokemonPresence.js'), 'utf8'
    );
    const fnStart = presenceJs.indexOf('function readEwramShort(');
    assert.ok(fnStart !== -1);
    const fnBody = presenceJs.substring(fnStart, fnStart + 600);
    assert.ok(
      fnBody.includes('HEAPU8') && fnBody.includes('Uint16Array'),
      'readEwramShort must derive HEAPU16 from HEAPU8 when not natively available'
    );
  });
});

// ── Multiplayer data exchange – mGBA/VBA-M parity improvements ────────────
// These tests verify the key improvements that replicate the common
// denominator from mGBA (lockstep.c) and VBA-M (gbaLink.cpp): both
// emulators intercept SIO at the driver level, override internal disconnect
// results, and properly manage SIOCNT error/start bits.
describe('Multiplayer data exchange – mGBA/VBA-M parity improvements', () => {
  it('installRegisterInterceptor detects START bit falling edge (post-transfer re-injection)', () => {
    const fnStart = gameJs.indexOf('function installRegisterInterceptor');
    assert.ok(fnStart !== -1);
    const fnBody = gameJs.substring(fnStart, fnStart + 10000);
    assert.ok(
      fnBody.includes('startFell'),
      'installRegisterInterceptor must detect START bit falling edge to catch mGBA internal SIO completions'
    );
    assert.ok(
      fnBody.includes('errorBitSet'),
      'installRegisterInterceptor must check the SIOCNT error bit (bit 6) set by mGBA when no cable is attached'
    );
  });

  it('installRegisterInterceptor re-injects data after mGBA internal SIO completion', () => {
    const fnStart = gameJs.indexOf('function installRegisterInterceptor');
    const fnBody = gameJs.substring(fnStart, fnStart + 10000);
    // When START falls with error bit, we must re-inject cached data + fire IRQ
    assert.ok(
      fnBody.includes('startFell') && fnBody.includes('errorBitSet') &&
      fnBody.includes('injectMultiWords') && fnBody.includes('injectSioIrq'),
      'On START falling edge with error, must re-inject cached SIOMULTI data and fire SIO IRQ'
    );
  });

  it('buildConnectedSiocnt clears error bit (bit 6) and START bit (bit 7)', () => {
    const fnStart = gameJs.indexOf('function installRegisterInterceptor');
    const fnBody = gameJs.substring(fnStart, fnStart + 5000);
    assert.ok(
      fnBody.includes('0x00C0') || fnBody.includes('~0x00C0'),
      'buildConnectedSiocnt must clear bits 6 (error) and 7 (START) from SIOCNT'
    );
  });

  it('injectMultiWords validates 16-bit word boundaries', () => {
    const fnStart = gameJs.indexOf('function installRegisterInterceptor');
    const fnBody = gameJs.substring(fnStart, fnStart + 5000);
    assert.ok(
      fnBody.includes('function injectMultiWords'),
      'installRegisterInterceptor must define injectMultiWords helper for safe SIOMULTI writes'
    );
    assert.ok(
      fnBody.includes('0xFFFF'),
      'injectMultiWords must mask words to 16-bit range'
    );
  });

  it('installRegisterInterceptor has bounds checking via maxRequiredIdx', () => {
    const fnStart = gameJs.indexOf('function installRegisterInterceptor');
    const fnBody = gameJs.substring(fnStart, fnStart + 10000);
    assert.ok(
      fnBody.includes('maxRequiredIdx'),
      'installRegisterInterceptor must pre-compute maxRequiredIdx for heap bounds checking'
    );
    assert.ok(
      fnBody.includes('maxRequiredIdx >= heap16.length'),
      'runPollCycle must check maxRequiredIdx against heap size before accessing registers'
    );
  });

  it('requestTransfer retries on stale-transfer error (mGBA/VBA-M coordinator behaviour)', () => {
    const fnStart = gameJs.indexOf('function requestTransfer(');
    assert.ok(fnStart !== -1);
    const fnBody = gameJs.substring(fnStart, fnStart + 1500);
    assert.ok(
      fnBody.includes('_retryCount') || fnBody.includes('retryCount'),
      'requestTransfer must support retry logic for stale-transfer errors'
    );
    assert.ok(
      fnBody.includes('retryCount < 1'),
      'requestTransfer must retry at most once on stale-transfer to avoid infinite loops'
    );
  });

  it('luaLink.js clears stale slave words when master initiates new cycle', () => {
    const luaLinkJs = fs.readFileSync(path.join(__dirname, '../src/socket/luaLink.js'), 'utf8');
    const masterBlock = luaLinkJs.indexOf('Master initiates the transfer cycle');
    assert.ok(masterBlock !== -1, 'Master handler block must exist');
    const blockBody = luaLinkJs.substring(masterBlock, masterBlock + 1000);
    assert.ok(
      blockBody.includes('slaveWords.clear'),
      'Master handler must clear stale slave words at start of new cycle'
    );
  });

  it('luaLink.js lua:join returns transferId for client sync', () => {
    const luaLinkJs = fs.readFileSync(path.join(__dirname, '../src/socket/luaLink.js'), 'utf8');
    const joinIdx = luaLinkJs.indexOf("socket.on('lua:join'");
    assert.ok(joinIdx !== -1);
    const joinBody = luaLinkJs.substring(joinIdx, joinIdx + 2000);
    assert.ok(
      joinBody.includes('transferId'),
      'lua:join ack must include transferId so client can sync its counter'
    );
  });

  it('enableLinkCable syncs transferId from server on join', () => {
    const fnStart = gameJs.indexOf('function enableLinkCable');
    assert.ok(fnStart !== -1);
    const fnBody = gameJs.substring(fnStart, fnStart + 800);
    assert.ok(
      fnBody.includes('res.transferId'),
      'enableLinkCable must sync currentTransferId from server response'
    );
  });

  it('master requestTransfer re-reads WASM module after async operation', () => {
    const fnStart = gameJs.indexOf('function installRegisterInterceptor');
    const fnBody = gameJs.substring(fnStart, fnStart + 10000);
    // After the async requestTransfer resolves, the heap may have been
    // replaced (memory growth).  The code must re-acquire the module.
    assert.ok(
      fnBody.includes('curMod') || fnBody.includes('getWasmModule()'),
      'Master transfer callback must re-read WASM module in case of memory growth'
    );
  });

  it('slave _luaInjectSync performs bounds checking', () => {
    const fnStart = gameJs.indexOf('window._luaInjectSync = ');
    assert.ok(fnStart !== -1, '_luaInjectSync assignment must exist');
    const fnBody = gameJs.substring(fnStart, fnStart + 500);
    assert.ok(
      fnBody.includes('maxRequiredIdx') || fnBody.includes('heap16.length'),
      '_luaInjectSync must verify heap bounds before writing SIOMULTI registers'
    );
  });

  it('slave _luaGetSlaveWord performs bounds checking', () => {
    const fnStart = gameJs.indexOf('_luaGetSlaveWord');
    assert.ok(fnStart !== -1);
    const fnBody = gameJs.substring(fnStart, fnStart + 300);
    assert.ok(
      fnBody.includes('sendIdx') && fnBody.includes('sendIdx >='),
      '_luaGetSlaveWord must verify sendIdx is within heap bounds'
    );
  });

  it('LuaLinkSession server uses fresh slave words per cycle (not pre-buffered)', () => {
    const luaLinkJs = fs.readFileSync(path.join(__dirname, '../src/socket/luaLink.js'), 'utf8');
    // The server must clear slave words at the start of each master cycle.
    // This prevents stale slave data from a previous cycle bleeding into
    // the current one – matching how real GBA hardware latches slave words
    // at the moment the master initiates the transfer.
    assert.ok(
      luaLinkJs.includes('session.slaveWords.clear()'),
      'Server must clear stale slave words at start of each master-initiated cycle'
    );
    // Count occurrences – slaveWords.clear() should appear at least twice
    // (once in reset() and once in the master handler)
    const clearCount = (luaLinkJs.match(/slaveWords\.clear\(\)/g) || []).length;
    assert.ok(
      clearCount >= 2,
      `slaveWords.clear() should appear at least 2 times (in reset and master handler), found ${clearCount}`
    );
  });

  it('luaLink.js always broadcasts masterReady to all slaves (fresh words for new cycle)', () => {
    const luaLinkJs = fs.readFileSync(path.join(__dirname, '../src/socket/luaLink.js'), 'utf8');
    const masterBlock = luaLinkJs.indexOf('Master initiates the transfer cycle');
    const blockBody = luaLinkJs.substring(masterBlock, masterBlock + 1500);
    // After clearing stale slave words, masterReady should go to ALL slaves
    // (not just pending ones, since previous responses were flushed)
    assert.ok(
      blockBody.includes('pendingSlaves: slaveIndices'),
      'lua:masterReady must be broadcast to all slave indices after clearing stale words'
    );
  });
});

// ── SIO mode detection – mGBA/VBA-M common ground ────────────────────────
describe('SIO mode detection – mGBA/VBA-M common ground', () => {
  it('game.js defines SIO_MODE constants matching server values', () => {
    assert.ok(gameJs.includes('SIO_MODE_MULTI'), 'SIO_MODE_MULTI must be defined');
    assert.ok(gameJs.includes('SIO_MODE_NORMAL8'), 'SIO_MODE_NORMAL8 must be defined');
    assert.ok(gameJs.includes('SIO_MODE_NORMAL32'), 'SIO_MODE_NORMAL32 must be defined');
  });

  it('game.js defines detectSioMode function for RCNT/SIOCNT mode detection', () => {
    assert.ok(
      gameJs.includes('function detectSioMode'),
      'game.js must define detectSioMode to detect Normal vs Multiplay mode'
    );
  });

  it('detectSioMode checks RCNT bit 15 for GPIO mode', () => {
    const fnStart = gameJs.indexOf('function detectSioMode');
    assert.ok(fnStart !== -1);
    const fnBody = gameJs.substring(fnStart, fnStart + 500);
    assert.ok(fnBody.includes('0x8000'), 'detectSioMode must check RCNT bit 15');
  });

  it('detectSioMode reads SIOCNT bits 12-13 for mode selection', () => {
    const fnStart = gameJs.indexOf('function detectSioMode');
    const fnBody = gameJs.substring(fnStart, fnStart + 500);
    assert.ok(
      fnBody.includes('>> 12') || fnBody.includes('>>> 12'),
      'detectSioMode must extract mode bits from SIOCNT bits 12-13'
    );
  });

  it('runPollCycle calls detectSioMode for auto-detection', () => {
    const fnStart = gameJs.indexOf('function runPollCycle');
    const fnBody = gameJs.substring(fnStart, fnStart + 3000);
    assert.ok(fnBody.includes('detectSioMode'), 'runPollCycle must call detectSioMode');
  });

  it('game.js tracks currentSioMode state variable', () => {
    assert.ok(
      gameJs.includes('currentSioMode'),
      'game.js must track the current SIO mode'
    );
  });

  it('game.js emits lua:setMode when mode changes', () => {
    assert.ok(
      gameJs.includes("lua:setMode"),
      'game.js must emit lua:setMode to notify server of mode changes'
    );
  });

  it('luaLink.js defines SIO_MODE constants', () => {
    const luaLinkJs = fs.readFileSync(path.join(__dirname, '../src/socket/luaLink.js'), 'utf8');
    assert.ok(luaLinkJs.includes('SIO_MODE'), 'luaLink.js must define SIO_MODE constants');
    assert.ok(luaLinkJs.includes('MULTI'), 'SIO_MODE must include MULTI');
    assert.ok(luaLinkJs.includes('NORMAL8'), 'SIO_MODE must include NORMAL8');
    assert.ok(luaLinkJs.includes('NORMAL32'), 'SIO_MODE must include NORMAL32');
  });

  it('luaLink.js handles lua:setMode event', () => {
    const luaLinkJs = fs.readFileSync(path.join(__dirname, '../src/socket/luaLink.js'), 'utf8');
    assert.ok(
      luaLinkJs.includes("lua:setMode"),
      'luaLink.js must handle lua:setMode from clients'
    );
  });

  it('luaLink.js supports Normal mode dispatch', () => {
    const luaLinkJs = fs.readFileSync(path.join(__dirname, '../src/socket/luaLink.js'), 'utf8');
    assert.ok(
      luaLinkJs.includes('dispatchNormalSync'),
      'luaLink.js must have dispatchNormalSync for Normal mode transfers'
    );
  });
});

// ── Connection ready handshake ───────────────────────────────────────────
describe('Connection ready handshake – mGBA/VBA-M common ground', () => {
  it('luaLink.js handles lua:ready event', () => {
    const luaLinkJs = fs.readFileSync(path.join(__dirname, '../src/socket/luaLink.js'), 'utf8');
    assert.ok(
      luaLinkJs.includes("lua:ready"),
      'luaLink.js must handle lua:ready for connection handshake'
    );
  });

  it('luaLink.js broadcasts lua:readyState to all players', () => {
    const luaLinkJs = fs.readFileSync(path.join(__dirname, '../src/socket/luaLink.js'), 'utf8');
    assert.ok(
      luaLinkJs.includes("lua:readyState"),
      'luaLink.js must broadcast lua:readyState when ready state changes'
    );
  });

  it('LuaLinkSession tracks readyPlayers', () => {
    const luaLinkJs = fs.readFileSync(path.join(__dirname, '../src/socket/luaLink.js'), 'utf8');
    assert.ok(
      luaLinkJs.includes('readyPlayers'),
      'LuaLinkSession must track which players are ready'
    );
  });

  it('LuaLinkSession has allPlayersReady method', () => {
    const luaLinkJs = fs.readFileSync(path.join(__dirname, '../src/socket/luaLink.js'), 'utf8');
    assert.ok(
      luaLinkJs.includes('allPlayersReady'),
      'LuaLinkSession must have allPlayersReady() method'
    );
  });

  it('game.js emits lua:ready after joining link cable session', () => {
    assert.ok(
      gameJs.includes("lua:ready"),
      'game.js must emit lua:ready to signal emulator is ready for transfers'
    );
  });

  it('game.js handles lua:readyState event', () => {
    assert.ok(
      gameJs.includes("lua:readyState"),
      'game.js must handle lua:readyState from server'
    );
  });

  it('game.js tracks _allPlayersReady state', () => {
    assert.ok(
      gameJs.includes('_allPlayersReady'),
      'game.js must track whether all players have signalled ready'
    );
  });
});

// ── Transfer state machine ──────────────────────────────────────────────
describe('Transfer state machine – mGBA/VBA-M common ground', () => {
  it('luaLink.js defines TRANSFER_STATE constants', () => {
    const luaLinkJs = fs.readFileSync(path.join(__dirname, '../src/socket/luaLink.js'), 'utf8');
    assert.ok(luaLinkJs.includes('TRANSFER_STATE'), 'TRANSFER_STATE must be defined');
    assert.ok(luaLinkJs.includes('IDLE'), 'TRANSFER_STATE must include IDLE');
    assert.ok(luaLinkJs.includes('PENDING'), 'TRANSFER_STATE must include PENDING');
    assert.ok(luaLinkJs.includes('ACTIVE'), 'TRANSFER_STATE must include ACTIVE');
    assert.ok(luaLinkJs.includes('COMPLETE'), 'TRANSFER_STATE must include COMPLETE');
  });

  it('LuaLinkSession tracks transferState', () => {
    const luaLinkJs = fs.readFileSync(path.join(__dirname, '../src/socket/luaLink.js'), 'utf8');
    assert.ok(
      luaLinkJs.includes('this.transferState'),
      'LuaLinkSession must track transferState'
    );
  });

  it('master lua:send sets transferState to PENDING', () => {
    const luaLinkJs = fs.readFileSync(path.join(__dirname, '../src/socket/luaLink.js'), 'utf8');
    assert.ok(
      luaLinkJs.includes('TRANSFER_STATE.PENDING'),
      'master must set transferState to PENDING when initiating'
    );
  });

  it('dispatchSync sets transferState to COMPLETE', () => {
    const luaLinkJs = fs.readFileSync(path.join(__dirname, '../src/socket/luaLink.js'), 'utf8');
    const dispatchBlock = luaLinkJs.indexOf('function dispatchSync');
    assert.ok(dispatchBlock !== -1);
    const blockBody = luaLinkJs.substring(dispatchBlock, dispatchBlock + 500);
    assert.ok(
      blockBody.includes('TRANSFER_STATE.COMPLETE'),
      'dispatchSync must set transferState to COMPLETE'
    );
  });

  it('session.reset() resets transferState to IDLE', () => {
    const luaLinkJs = fs.readFileSync(path.join(__dirname, '../src/socket/luaLink.js'), 'utf8');
    const resetBlock = luaLinkJs.indexOf('reset()');
    assert.ok(resetBlock !== -1);
    const blockBody = luaLinkJs.substring(resetBlock, resetBlock + 300);
    assert.ok(
      blockBody.includes('TRANSFER_STATE.IDLE'),
      'reset() must set transferState back to IDLE'
    );
  });

  it('lua:diagnostics includes transferState and sioMode', () => {
    const luaLinkJs = fs.readFileSync(path.join(__dirname, '../src/socket/luaLink.js'), 'utf8');
    const diagBlock = luaLinkJs.indexOf("lua:diagnostics");
    assert.ok(diagBlock !== -1);
    const blockBody = luaLinkJs.substring(diagBlock, diagBlock + 2000);
    assert.ok(blockBody.includes('sioMode'), 'diagnostics must report sioMode');
    assert.ok(blockBody.includes('transferState'), 'diagnostics must report transferState');
  });
});

// ── Normal mode SIOCNT handling ─────────────────────────────────────────
describe('Normal mode SIOCNT handling – mGBA/VBA-M common ground', () => {
  it('buildConnectedSiocnt handles Normal mode differently from Multiplay', () => {
    const fnStart = gameJs.indexOf('function buildConnectedSiocnt');
    assert.ok(fnStart !== -1);
    const fnBody = gameJs.substring(fnStart, fnStart + 800);
    assert.ok(
      fnBody.includes('SIO_MODE_NORMAL'),
      'buildConnectedSiocnt must check for Normal mode'
    );
  });

  it('installRegisterInterceptor defines normalSiocntBase', () => {
    assert.ok(
      gameJs.includes('normalSiocntBase'),
      'game.js must define normalSiocntBase for Normal mode clock direction'
    );
  });

  it('luaLink.js lua:join returns sioMode in ack', () => {
    const luaLinkJs = fs.readFileSync(path.join(__dirname, '../src/socket/luaLink.js'), 'utf8');
    const joinBlock = luaLinkJs.indexOf("lua:join");
    const blockBody = luaLinkJs.substring(joinBlock, joinBlock + 2000);
    assert.ok(
      blockBody.includes('sioMode'),
      'lua:join ack must include the current sioMode'
    );
  });

  it('luaLink.js exports SIO_MODE and TRANSFER_STATE', () => {
    const luaLinkJs = fs.readFileSync(path.join(__dirname, '../src/socket/luaLink.js'), 'utf8');
    assert.ok(
      luaLinkJs.includes('module.exports.SIO_MODE'),
      'luaLink.js must export SIO_MODE for external use'
    );
    assert.ok(
      luaLinkJs.includes('module.exports.TRANSFER_STATE'),
      'luaLink.js must export TRANSFER_STATE for external use'
    );
  });
});
