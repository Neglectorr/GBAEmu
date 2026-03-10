'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const gameJsPath = path.join(__dirname, '../public/js/game.js');
const gameJs     = fs.readFileSync(gameJsPath, 'utf8');

// ── Input handling – EmulatorJS manages keyboard and gamepad ────────────────
describe('Input handling – EmulatorJS delegates keyboard and gamepad', () => {
  it('game.js does NOT have a setupKeyboard function (EmulatorJS handles keyboard)', () => {
    assert.ok(
      !gameJs.includes('function setupKeyboard'),
      'game.js must NOT contain setupKeyboard – EmulatorJS handles keyboard input internally'
    );
  });

  it('game.js does NOT have a pollGamepad function (EmulatorJS handles gamepad)', () => {
    assert.ok(
      !gameJs.includes('function pollGamepad'),
      'game.js must NOT contain pollGamepad – EmulatorJS handles gamepad input internally'
    );
  });

  it('game.js configures EmulatorJS with gamepad: true in EJS_Buttons', () => {
    const buttonsStart = gameJs.indexOf('EJS_Buttons');
    assert.ok(buttonsStart !== -1, 'EJS_Buttons configuration must exist');
    const buttonsBlock = gameJs.substring(buttonsStart, buttonsStart + 800);
    assert.ok(
      buttonsBlock.includes('gamepad') && buttonsBlock.includes('true'),
      'EJS_Buttons must enable gamepad support'
    );
  });

  it('game.js configures EmulatorJS with settings: true in EJS_Buttons', () => {
    const buttonsStart = gameJs.indexOf('EJS_Buttons');
    assert.ok(buttonsStart !== -1, 'EJS_Buttons configuration must exist');
    const buttonsBlock = gameJs.substring(buttonsStart, buttonsStart + 800);
    assert.ok(
      buttonsBlock.includes('settings') && buttonsBlock.includes('true'),
      'EJS_Buttons must enable settings UI'
    );
  });

  it('EmulatorJS provides mobile touch controls (EJS_core = mgba enables this)', () => {
    assert.ok(
      gameJs.includes("EJS_core") && gameJs.includes("'mgba'"),
      "game.js must set EJS_core to 'mgba' which enables built-in mobile touch controls"
    );
  });
});
