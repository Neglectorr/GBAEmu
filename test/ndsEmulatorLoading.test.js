'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('NDS emulator loading – EmulatorJS integration', () => {
  const serverJsPath = path.join(__dirname, '../server.js');
  const gameNdsJsPath = path.join(__dirname, '../public/js/game-nds.js');
  const gameNdsHtmlPath = path.join(__dirname, '../public/game-nds.html');
  const serverJs = fs.readFileSync(serverJsPath, 'utf8');
  const gameNdsJs = fs.readFileSync(gameNdsJsPath, 'utf8');
  const gameNdsHtml = fs.readFileSync(gameNdsHtmlPath, 'utf8');

  it('CSP scriptSrc includes blob: for EmulatorJS core loading', () => {
    // EmulatorJS creates blob: URL scripts in initGameCore() to load the
    // WASM core. Without blob: in script-src, the browser blocks the script
    // and the emulator never starts.
    assert.ok(
      /scriptSrc\s*:.*blob:/s.test(serverJs),
      'CSP scriptSrc must include "blob:" to allow EmulatorJS blob URL scripts'
    );
  });

  it('CSP connectSrc includes blob: for WASM data fetching', () => {
    // The Emscripten runtime locateFile() returns blob: URLs for WASM data.
    // fetch() of blob: URLs is blocked without blob: in connect-src.
    assert.ok(
      /connectSrc\s*:.*blob:/s.test(serverJs),
      'CSP connectSrc must include "blob:" to allow WASM blob URL fetching'
    );
  });

  it('loadRomAndStart has a loading guard to prevent double initialisation', () => {
    // Without a guard, handleLobbyState and game:start can both call
    // loadRomAndStart(), causing EmulatorJS to be initialised twice.
    assert.ok(
      gameNdsJs.includes('loadingStarted'),
      'game-nds.js must use a loadingStarted guard variable'
    );
    assert.ok(
      /if\s*\(\s*loadingStarted/.test(gameNdsJs),
      'loadRomAndStart must check loadingStarted before proceeding'
    );
  });

  it('game:start handler does not call loadRomAndStart when already loading', () => {
    // The game:start event handler should check loadingStarted to prevent
    // duplicate calls to loadRomAndStart().
    const startIdx = gameNdsJs.indexOf("on('game:start'");
    assert.ok(startIdx !== -1, 'game-nds.js must have a game:start handler');
    // Search within the handler (up to the next top-level socket handler)
    const nextHandler = gameNdsJs.indexOf("lobbySocket.on(", startIdx + 1);
    const endIdx = nextHandler !== -1 ? nextHandler : startIdx + 600;
    const gameStartSection = gameNdsJs.slice(startIdx, endIdx);
    assert.ok(
      gameStartSection.includes('loadingStarted'),
      'game:start handler must check loadingStarted flag'
    );
  });

  it('start-game-btn is hidden when loading begins', () => {
    assert.ok(
      gameNdsJs.includes("getElementById('start-game-btn').style.display = 'none'"),
      'loadRomAndStart must hide the start-game-btn to avoid confusion'
    );
  });

  it('EmulatorJS loader.js exists in the installed package', () => {
    const loaderPath = path.join(
      __dirname,
      '../node_modules/@emulatorjs/emulatorjs/data/loader.js'
    );
    assert.ok(
      fs.existsSync(loaderPath),
      'EmulatorJS loader.js must exist in node_modules'
    );
  });

  it('DeSmuME WASM core data file exists', () => {
    const corePath = path.join(
      __dirname,
      '../node_modules/@emulatorjs/core-desmume/desmume-wasm.data'
    );
    assert.ok(
      fs.existsSync(corePath),
      'desmume-wasm.data must exist in the core-desmume package'
    );
  });

  it('game-nds.html has the EmulatorJS container element', () => {
    assert.ok(
      gameNdsHtml.includes('id="nds-emulator"'),
      'game-nds.html must contain the #nds-emulator container'
    );
  });

  it('server serves EmulatorJS data files at /emulator-nds/', () => {
    assert.ok(
      serverJs.includes("'/emulator-nds'"),
      'server.js must serve EmulatorJS data at /emulator-nds/'
    );
    assert.ok(
      serverJs.includes("'/emulator-nds/cores'"),
      'server.js must serve DeSmuME core files at /emulator-nds/cores/'
    );
  });

  it('loadingStarted is reset on error for retry capability', () => {
    // If loading fails, the guard must be reset so the user can try again.
    const catchIdx = gameNdsJs.indexOf('} catch (err)');
    assert.ok(catchIdx !== -1, 'loadRomAndStart must have a catch block');
    // Look at the catch block up to its closing brace (find next function or end)
    const afterCatch = gameNdsJs.slice(catchIdx, catchIdx + 500);
    assert.ok(
      afterCatch.includes('loadingStarted = false'),
      'loadingStarted must be reset to false in the catch block'
    );
  });
});
