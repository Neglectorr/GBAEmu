'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('Emulator loading – EmulatorJS with mGBA core', () => {
  const gameHtmlPath = path.join(__dirname, '../public/game.html');
  const gameJsPath = path.join(__dirname, '../public/js/game.js');
  const serverJsPath = path.join(__dirname, '../server.js');
  const gameHtml = fs.readFileSync(gameHtmlPath, 'utf8');
  const gameJs = fs.readFileSync(gameJsPath, 'utf8');
  const serverJs = fs.readFileSync(serverJsPath, 'utf8');

  it('game.html has a gba-emulator container div', () => {
    assert.ok(
      gameHtml.includes('id="gba-emulator"'),
      'game.html must contain a div with id="gba-emulator"'
    );
  });

  it('game.js has a loadingStarted guard variable', () => {
    assert.ok(
      gameJs.includes('loadingStarted'),
      'game.js must declare a loadingStarted guard'
    );
  });

  it('game.js checks loadingStarted before proceeding in loadRomAndStart', () => {
    const fnStart = gameJs.indexOf('async function loadRomAndStart');
    assert.ok(fnStart !== -1, 'loadRomAndStart function must exist');
    const fnBody = gameJs.substring(fnStart, fnStart + 500);
    assert.ok(
      fnBody.includes('loadingStarted'),
      'loadRomAndStart must check loadingStarted before proceeding'
    );
  });

  it('game:start handler checks loadingStarted', () => {
    const handlerStart = gameJs.indexOf("game:start");
    assert.ok(handlerStart !== -1, 'game:start handler must exist');
    const handlerBody = gameJs.substring(handlerStart, handlerStart + 500);
    assert.ok(
      handlerBody.includes('loadingStarted'),
      'game:start handler must check loadingStarted'
    );
  });

  it('start-game-btn is hidden when loading begins', () => {
    const fnStart = gameJs.indexOf('async function loadRomAndStart');
    assert.ok(fnStart !== -1);
    const fnBody = gameJs.substring(fnStart, fnStart + 1000);
    assert.ok(
      fnBody.includes("getElementById('start-game-btn')") && fnBody.includes("'none'"),
      'start-game-btn must be hidden when loading begins'
    );
  });

  it('mGBA core data file exists at node_modules/@emulatorjs/core-mgba/mgba-wasm.data', () => {
    const corePath = path.join(
      __dirname,
      '../node_modules/@emulatorjs/core-mgba/mgba-wasm.data'
    );
    assert.ok(fs.existsSync(corePath), 'mgba-wasm.data must exist in @emulatorjs/core-mgba');
  });

  it('server.js serves EmulatorJS GBA files at /emulator-gba', () => {
    assert.ok(
      serverJs.includes("'/emulator-gba'"),
      'server.js must serve EmulatorJS files at /emulator-gba'
    );
  });

  it('server.js serves mGBA core files at /emulator-gba/cores', () => {
    assert.ok(
      serverJs.includes("'/emulator-gba/cores'"),
      'server.js must serve mGBA core files at /emulator-gba/cores'
    );
  });

  it('game.js uses EJS_core = mgba', () => {
    assert.ok(
      gameJs.includes("EJS_core") && gameJs.includes("'mgba'"),
      "game.js must set EJS_core to 'mgba'"
    );
  });

  it('loadingStarted is reset on error for retry capability', () => {
    const fnStart = gameJs.indexOf('async function loadRomAndStart');
    assert.ok(fnStart !== -1);
    const fnBody = gameJs.substring(fnStart, fnStart + 8000);
    const catchIdx = fnBody.indexOf('} catch (err)');
    assert.ok(catchIdx !== -1, 'loadRomAndStart must have error handling');
    const afterCatch = fnBody.substring(catchIdx, catchIdx + 500);
    assert.ok(
      afterCatch.includes('loadingStarted = false'),
      'loadingStarted must be reset to false on error so the user can retry'
    );
  });

  it('CSP includes blob: for script-src and connect-src', () => {
    assert.ok(
      serverJs.includes("scriptSrc") && serverJs.includes('"blob:"'),
      'CSP script-src must include blob:'
    );
    assert.ok(
      serverJs.includes("connectSrc") && serverJs.includes('"blob:"'),
      'CSP connect-src must include blob:'
    );
  });

  it('game.js loads with defer', () => {
    assert.ok(
      gameHtml.includes('defer src="/js/game.js"'),
      'game.js must be loaded with the defer attribute'
    );
  });
});
