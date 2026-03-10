'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('Spectator streaming – frame broadcast logic', () => {
  const gameJsPath = path.join(__dirname, '../public/js/game.js');
  const gameJs = fs.readFileSync(gameJsPath, 'utf8');

  it('throttles frames at FRAME_EMIT_INTERVAL boundary (>=, not >)', () => {
    // The old ">" comparison would skip frames that arrive exactly at the
    // interval boundary, effectively halving the frame rate when only the
    // backup timer is running.
    assert.ok(
      gameJs.includes('now - broadcastFrame._last >= FRAME_EMIT_INTERVAL'),
      'broadcastFrame must use >= (not >) for the throttle comparison'
    );
    assert.ok(
      !gameJs.includes('now - broadcastFrame._last > FRAME_EMIT_INTERVAL'),
      'broadcastFrame must NOT use strict > for the throttle comparison'
    );
  });

  it('broadcasts frames synchronised with the browser render cycle', () => {
    assert.ok(
      gameJs.includes('requestAnimationFrame'),
      'frame broadcast must use requestAnimationFrame for reliable render-synced capture'
    );
    // The old setInterval-based approach should be replaced
    assert.ok(
      !gameJs.includes("setInterval(broadcastFrame"),
      'frame broadcast must NOT use setInterval(broadcastFrame, …) – use requestAnimationFrame loop instead'
    );
  });

  it('broadcastFrame has error handling to prevent silent failures', () => {
    // Extract the broadcastFrame function body
    const fnStart = gameJs.indexOf('function broadcastFrame()');
    assert.ok(fnStart !== -1, 'broadcastFrame function must exist');
    // Read enough of the function body to cover the capture logic
    const fnBody = gameJs.substring(fnStart, fnStart + 1500);
    assert.ok(
      fnBody.includes('try {') && fnBody.includes('catch'),
      'broadcastFrame must wrap canvas capture in try-catch'
    );
  });

  it('stopFrameBroadcastTimer cancels the requestAnimationFrame loop', () => {
    assert.ok(
      gameJs.includes('function stopFrameBroadcastTimer'),
      'stopFrameBroadcastTimer function must exist'
    );
    assert.ok(
      gameJs.includes('cancelAnimationFrame'),
      'stopFrameBroadcastTimer must call cancelAnimationFrame'
    );
  });

  it('switching to spectator stops the frame broadcast', () => {
    assert.ok(
      gameJs.includes('stopFrameBroadcastTimer()'),
      'switchToSpectator must call stopFrameBroadcastTimer()'
    );
  });

  it('game:frame listener is registered for spectator updates', () => {
    assert.ok(
      gameJs.includes("lobbySocket.on('game:frame'"),
      'game:frame event listener must be registered'
    );
    assert.ok(
      gameJs.includes('updateSpectatorFrame(pIdx, frame)'),
      'game:frame handler must call updateSpectatorFrame'
    );
  });

  it('updateSpectatorFrame revokes old blob URLs to prevent memory leaks', () => {
    const fnStart = gameJs.indexOf('function updateSpectatorFrame');
    assert.ok(fnStart !== -1, 'updateSpectatorFrame function must exist');
    // Read enough of the function body to cover the revocation logic
    const fnBody = gameJs.substring(fnStart, fnStart + 1000);
    assert.ok(
      fnBody.includes('URL.revokeObjectURL'),
      'updateSpectatorFrame must revoke old blob URLs'
    );
  });

  it('broadcastFrame does not gate on lobbyState spectator/player count', () => {
    // The old guard "!lobbyState?.spectators?.length && ... <= 1" prevented
    // frames from ever reaching a spectator when lobbyState had not yet been
    // updated after the spectator joined, causing a permanently black screen.
    // The server routes game:frame only to others via socket.to(lobby.id),
    // so the broadcasting player (me) never receives their own feed back.
    const fnStart = gameJs.indexOf('function broadcastFrame()');
    assert.ok(fnStart !== -1, 'broadcastFrame function must exist');
    const fnBody = gameJs.substring(fnStart, fnStart + 400);
    assert.ok(
      !fnBody.includes('!lobbyState?.spectators?.length'),
      'broadcastFrame must NOT gate on lobbyState spectator count – stale lobbyState causes black screen'
    );
    assert.ok(
      !fnBody.includes('lobbyState?.players?.length <= 1'),
      'broadcastFrame must NOT gate on lobbyState player count – use server-side routing instead'
    );
  });

  it('handleLobbyState builds sidebar spectator grid proactively, not only when Watch tab is active', () => {
    // The old guard "if (sidebarTab === 'watch') buildSidebarSpectatorGrid(...)"
    // meant the sidebar grid was never built if the user had not yet opened the
    // Watch tab, so updateSidebarSpectatorFrame silently no-opped on every frame
    // and the Watch panel remained permanently black.
    const handleIdx = gameJs.indexOf('function handleLobbyState');
    assert.ok(handleIdx !== -1, 'handleLobbyState must exist');
    const handleBody = gameJs.substring(handleIdx, handleIdx + 1500);
    assert.ok(
      !handleBody.includes("if (sidebarTab === 'watch')"),
      'handleLobbyState must NOT gate sidebar grid building on sidebarTab – grid must be built proactively'
    );
    assert.ok(
      handleBody.includes('buildSidebarSpectatorGrid'),
      'handleLobbyState must always call buildSidebarSpectatorGrid to keep the Watch panel ready'
    );
  });

});

describe('NDS spectator streaming – frame broadcast logic (game-nds.js)', () => {
  const ndsJsPath = path.join(__dirname, '../public/js/game-nds.js');
  const ndsJs = fs.readFileSync(ndsJsPath, 'utf8');

  it('broadcastFrame does not gate on lobbyState spectator/player count', () => {
    // The old guard "!lobbyState?.spectators?.length && lobbyState?.players?.length <= 1"
    // prevented frames from ever reaching a spectator when lobbyState had not yet been
    // updated after the spectator joined, causing a permanently black screen.
    const fnStart = ndsJs.indexOf('function broadcastFrame()');
    assert.ok(fnStart !== -1, 'broadcastFrame function must exist in game-nds.js');
    // 400 chars covers the guard lines at the top of the function body
    const fnBody = ndsJs.substring(fnStart, fnStart + 400);
    assert.ok(
      !fnBody.includes('!lobbyState?.spectators?.length'),
      'broadcastFrame must NOT gate on lobbyState spectator count – stale lobbyState causes black screen'
    );
    assert.ok(
      !fnBody.includes('lobbyState?.players?.length <= 1'),
      'broadcastFrame must NOT gate on lobbyState player count – use server-side routing instead'
    );
  });

  it('handleLobbyState builds sidebar spectator grid proactively, not only when Watch tab is active', () => {
    // The old guard "if (sidebarTab === 'watch') buildSidebarSpectatorGrid(...)"
    // meant the sidebar grid was never built if the user had not yet opened the
    // Watch tab, so updateSidebarSpectatorFrame silently no-opped on every frame
    // and the Watch panel remained permanently black.
    const handleIdx = ndsJs.indexOf('function handleLobbyState');
    assert.ok(handleIdx !== -1, 'handleLobbyState must exist in game-nds.js');
    // 1500 chars covers the entire body of handleLobbyState
    const handleBody = ndsJs.substring(handleIdx, handleIdx + 1500);
    assert.ok(
      !handleBody.includes("if (sidebarTab === 'watch')"),
      'handleLobbyState must NOT gate sidebar grid building on sidebarTab – grid must be built proactively'
    );
    assert.ok(
      handleBody.includes('buildSidebarSpectatorGrid'),
      'handleLobbyState must always call buildSidebarSpectatorGrid to keep the Watch panel ready'
    );
  });

  it('broadcasts frames synchronised with the browser render cycle', () => {
    assert.ok(
      ndsJs.includes('requestAnimationFrame'),
      'frame broadcast must use requestAnimationFrame for reliable render-synced capture'
    );
    assert.ok(
      !ndsJs.includes('setInterval(broadcastFrame'),
      'frame broadcast must NOT use setInterval(broadcastFrame, …) – use requestAnimationFrame loop instead'
    );
  });

  it('game:frame listener updates spectator view', () => {
    assert.ok(
      ndsJs.includes("lobbySocket.on('game:frame'"),
      'game:frame event listener must be registered in game-nds.js'
    );
    assert.ok(
      ndsJs.includes('updateSpectatorFrame(pIdx, frame)'),
      'game:frame handler must call updateSpectatorFrame in game-nds.js'
    );
  });

});
