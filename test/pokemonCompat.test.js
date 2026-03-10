'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  POKEMON_COMPAT_GROUPS,
  getCompatGroupId,
  getCompatibleRoms,
} = require('../src/pokemon-compat');

// ── Group structure ─────────────────────────────────────────────────────────
describe('Pokemon compatibility groups – structure', () => {
  it('defines separate groups for FRLG, RS, Emerald, Quetzal, HGSS, Gen 1, Gen 2', () => {
    const ids = POKEMON_COMPAT_GROUPS.map(g => g.id);
    assert.ok(ids.includes('frlg'),    'must have frlg group');
    assert.ok(ids.includes('rs'),      'must have rs group');
    assert.ok(ids.includes('emerald'), 'must have emerald group');
    assert.ok(ids.includes('quetzal'), 'must have quetzal group');
    assert.ok(ids.includes('hgss'),    'must have hgss group');
    assert.ok(ids.includes('gen1'),    'must have gen1 group');
    assert.ok(ids.includes('gen2'),    'must have gen2 group');
  });

  it('all groups have an id, label, and keywords array', () => {
    for (const g of POKEMON_COMPAT_GROUPS) {
      assert.ok(typeof g.id === 'string' && g.id.length > 0, `group must have an id`);
      assert.ok(typeof g.label === 'string' && g.label.length > 0, `group ${g.id} must have a label`);
      assert.ok(Array.isArray(g.keywords) && g.keywords.length > 0, `group ${g.id} must have keywords`);
    }
  });
});

// ── FireRed / LeafGreen group ───────────────────────────────────────────────
describe('getCompatGroupId – FireRed / LeafGreen', () => {
  it('Fire Red → frlg', () => {
    assert.equal(getCompatGroupId('Pokemon Fire Red'), 'frlg');
  });

  it('FireRed (no space) → frlg', () => {
    assert.equal(getCompatGroupId('Pokemon FireRed'), 'frlg');
  });

  it('Leaf Green → frlg', () => {
    assert.equal(getCompatGroupId('Pokemon Leaf Green'), 'frlg');
  });

  it('LeafGreen (no space) → frlg', () => {
    assert.equal(getCompatGroupId('Pokemon LeafGreen'), 'frlg');
  });

  it('case-insensitive match', () => {
    assert.equal(getCompatGroupId('POKEMON FIRE RED'), 'frlg');
  });
});

// ── Ruby / Sapphire group ───────────────────────────────────────────────────
describe('getCompatGroupId – Ruby / Sapphire', () => {
  it('Ruby → rs', () => {
    assert.equal(getCompatGroupId('Pokemon Ruby'), 'rs');
  });

  it('Sapphire → rs', () => {
    assert.equal(getCompatGroupId('Pokemon Sapphire'), 'rs');
  });

  it('Ruby does NOT match frlg', () => {
    assert.notEqual(getCompatGroupId('Pokemon Ruby'), 'frlg');
  });
});

// ── Emerald group ───────────────────────────────────────────────────────────
describe('getCompatGroupId – Emerald', () => {
  it('Emerald → emerald', () => {
    assert.equal(getCompatGroupId('Pokemon Emerald'), 'emerald');
  });

  it('Emerald does NOT match rs', () => {
    assert.notEqual(getCompatGroupId('Pokemon Emerald'), 'rs');
  });

  it('Emerald does NOT match frlg', () => {
    assert.notEqual(getCompatGroupId('Pokemon Emerald'), 'frlg');
  });
});

// ── Quetzal group ───────────────────────────────────────────────────────────
describe('getCompatGroupId – Quetzal', () => {
  it('Quetzal → quetzal', () => {
    assert.equal(getCompatGroupId('Pokemon Quetzal'), 'quetzal');
  });

  it('Quetzal Emerald hack → quetzal (not emerald)', () => {
    // ROM names may contain both "quetzal" and "emerald"
    assert.equal(getCompatGroupId('Pokemon Quetzal (Emerald Hack)'), 'quetzal');
  });

  it('Quetzal does NOT match emerald group', () => {
    assert.notEqual(getCompatGroupId('Pokemon Quetzal'), 'emerald');
  });
});

// ── HeartGold / SoulSilver group ────────────────────────────────────────────
describe('getCompatGroupId – HeartGold / SoulSilver', () => {
  it('HeartGold → hgss', () => {
    assert.equal(getCompatGroupId('Pokemon HeartGold'), 'hgss');
  });

  it('Heart Gold (space) → hgss', () => {
    assert.equal(getCompatGroupId('Pokemon Heart Gold'), 'hgss');
  });

  it('SoulSilver → hgss', () => {
    assert.equal(getCompatGroupId('Pokemon SoulSilver'), 'hgss');
  });

  it('Soul Silver (space) → hgss', () => {
    assert.equal(getCompatGroupId('Pokemon Soul Silver'), 'hgss');
  });
});

// ── Gen 1 / Gen 2 groups ───────────────────────────────────────────────────
describe('getCompatGroupId – Gen 1 / Gen 2', () => {
  it('Pokemon Red → gen1', () => {
    assert.equal(getCompatGroupId('Pokemon Red'), 'gen1');
  });

  it('Pokemon Gold → gen2', () => {
    assert.equal(getCompatGroupId('Pokemon Gold'), 'gen2');
  });
});

// ── Unknown ROMs ────────────────────────────────────────────────────────────
describe('getCompatGroupId – edge cases', () => {
  it('returns null for unknown ROM', () => {
    assert.equal(getCompatGroupId('Super Mario Advance'), null);
  });

  it('returns null for null input', () => {
    assert.equal(getCompatGroupId(null), null);
  });

  it('returns null for empty string', () => {
    assert.equal(getCompatGroupId(''), null);
  });
});

// ── getCompatibleRoms ───────────────────────────────────────────────────────
describe('getCompatibleRoms – filtering', () => {
  const allRoms = [
    { _id: '1', displayName: 'Pokemon Fire Red' },
    { _id: '2', displayName: 'Pokemon Leaf Green' },
    { _id: '3', displayName: 'Pokemon Ruby' },
    { _id: '4', displayName: 'Pokemon Sapphire' },
    { _id: '5', displayName: 'Pokemon Emerald' },
    { _id: '6', displayName: 'Pokemon Quetzal' },
    { _id: '7', displayName: 'Pokemon HeartGold' },
    { _id: '8', displayName: 'Pokemon SoulSilver' },
    { _id: '9', displayName: 'Super Mario Advance' },
  ];

  it('Fire Red returns only FRLG games', () => {
    const compat = getCompatibleRoms('Pokemon Fire Red', allRoms);
    const ids = compat.map(r => r._id);
    assert.deepEqual(ids.sort(), ['1', '2']);
  });

  it('Ruby returns only RS games', () => {
    const compat = getCompatibleRoms('Pokemon Ruby', allRoms);
    const ids = compat.map(r => r._id);
    assert.deepEqual(ids.sort(), ['3', '4']);
  });

  it('Emerald returns only Emerald', () => {
    const compat = getCompatibleRoms('Pokemon Emerald', allRoms);
    const ids = compat.map(r => r._id);
    assert.deepEqual(ids, ['5']);
  });

  it('Quetzal returns only Quetzal', () => {
    const compat = getCompatibleRoms('Pokemon Quetzal', allRoms);
    const ids = compat.map(r => r._id);
    assert.deepEqual(ids, ['6']);
  });

  it('HeartGold returns only HGSS games', () => {
    const compat = getCompatibleRoms('Pokemon HeartGold', allRoms);
    const ids = compat.map(r => r._id);
    assert.deepEqual(ids.sort(), ['7', '8']);
  });

  it('unknown ROM returns empty array', () => {
    const compat = getCompatibleRoms('Super Mario Advance', allRoms);
    assert.deepEqual(compat, []);
  });

  it('Emerald and Quetzal are NOT cross-compatible', () => {
    // Quetzal is an Emerald hack but has different maps
    const emeraldCompat = getCompatibleRoms('Pokemon Emerald', allRoms);
    const quetzalCompat = getCompatibleRoms('Pokemon Quetzal', allRoms);
    const emeraldIds = emeraldCompat.map(r => r._id);
    const quetzalIds = quetzalCompat.map(r => r._id);
    assert.ok(!emeraldIds.includes('6'), 'Emerald should not include Quetzal');
    assert.ok(!quetzalIds.includes('5'), 'Quetzal should not include Emerald');
  });

  it('Fire Red and Ruby are NOT cross-compatible', () => {
    const frlgCompat = getCompatibleRoms('Pokemon Fire Red', allRoms);
    const frlgIds = frlgCompat.map(r => r._id);
    assert.ok(!frlgIds.includes('3'), 'Fire Red should not include Ruby');
    assert.ok(!frlgIds.includes('4'), 'Fire Red should not include Sapphire');
    assert.ok(!frlgIds.includes('5'), 'Fire Red should not include Emerald');
  });
});
