'use strict';
/**
 * Pokemon ROM Compatibility Groups
 *
 * Defines which Pokemon games can trade and battle with each other via the
 * link cable.  Games in the same group share the same map layouts and link
 * cable protocol so they can meaningfully connect to one another.
 *
 * Group membership is determined by case-insensitive substring matching
 * against the ROM's displayName in the database.
 *
 * Reference – GBA Gen 3:
 *   While all five Gen 3 GBA titles share the SIO Multiplay protocol for
 *   trading/battling, their overworld map layouts differ between version
 *   pairs.  To provide a sensible lobby experience (including player
 *   presence overlays that rely on matching map bank/ID coordinates), we
 *   split Gen 3 into map-compatible subgroups:
 *
 *     Fire Red  ↔ Leaf Green   – identical Kanto maps
 *     Ruby  ↔ Sapphire         – identical Hoenn maps (without Emerald extras)
 *     Emerald                  – expanded Hoenn maps (Battle Frontier, etc.)
 *
 *   Pokémon Quetzal (Emerald ROM hack) has modified maps and content,
 *   so it gets its own group.
 *
 *   (Colosseum and XD are GameCube titles and are not included here.)
 *
 * Reference – NDS Gen 4:
 *   HeartGold ↔ SoulSilver – same Johto/Kanto maps, share wireless protocol
 *
 * Reference – GB/GBC Gen 1/2:
 *     Red  ↔ Blue  ↔ Yellow
 *     Gold ↔ Silver ↔ Crystal
 *   Gen 2→Gen 1 Time Capsule trades are not supported in emulation.
 */

const POKEMON_COMPAT_GROUPS = [
  // ── Generation 3 – Fire Red / Leaf Green (GBA, Kanto) ───────────────────
  {
    id: 'frlg',
    label: 'Pokémon Fire Red / Leaf Green',
    keywords: [
      'fire red', 'firered',
      'leaf green', 'leafgreen',
    ],
  },

  // ── Generation 3 – Ruby / Sapphire (GBA, Hoenn) ─────────────────────────
  {
    id: 'rs',
    label: 'Pokémon Ruby / Sapphire',
    keywords: [
      'ruby',
      'sapphire',
    ],
  },

  // ── Pokémon Quetzal (GBA, Emerald ROM hack) ─────────────────────────────
  // Quetzal is based on Emerald but has modified maps, mechanics and
  // multiplayer features.  Players using Quetzal should only see other
  // Quetzal players.  This entry comes before Emerald so ROM names
  // containing both "quetzal" and "emerald" match Quetzal first.
  {
    id: 'quetzal',
    label: 'Pokémon Quetzal',
    keywords: [
      'quetzal',
    ],
  },

  // ── Generation 3 – Emerald (GBA, Hoenn expanded) ─────────────────────────
  // Emerald has the same base Hoenn maps as Ruby/Sapphire plus additional
  // content (Battle Frontier).  It gets its own group so the presence
  // overlay coordinates stay consistent.
  {
    id: 'emerald',
    label: 'Pokémon Emerald',
    keywords: [
      'emerald',
    ],
    // Quetzal is an Emerald hack but must NOT match here; the Quetzal
    // group above handles it.  The exclude list is a safety net.
    exclude: ['quetzal'],
  },

  // ── Generation 4 – HeartGold / SoulSilver (NDS, Johto + Kanto) ──────────
  {
    id: 'hgss',
    label: 'Pokémon HeartGold / SoulSilver',
    keywords: [
      'heart gold', 'heartgold',
      'soul silver', 'soulsilver',
    ],
  },

  // ── Generation 1 (GB / GBC) ─────────────────────────────────────────────
  {
    id: 'gen1',
    label: 'Pokémon Gen 1 (Red / Blue / Yellow)',
    keywords: [
      'pokemon red', 'pocket monsters red',
      'pokemon blue', 'pocket monsters blue',
      'pokemon yellow',
    ],
  },

  // ── Generation 2 (GBC) ──────────────────────────────────────────────────
  {
    id: 'gen2',
    label: 'Pokémon Gen 2 (Gold / Silver / Crystal)',
    keywords: [
      'pokemon gold',
      'pokemon silver',
      'pokemon crystal',
    ],
  },
];

/**
 * Return the compatibility group ID for a given ROM display name,
 * or null if the ROM is not a known Pokemon title.
 *
 * Matching is performed in array order, so more-specific groups (e.g.
 * Quetzal) must precede more-general ones (e.g. Emerald) in the
 * POKEMON_COMPAT_GROUPS array.  A group may also carry an `exclude`
 * list of keywords – if any exclusion keyword matches, the group is
 * skipped even when a positive keyword matches.
 *
 * @param {string} displayName  ROM display name from the database
 * @returns {string|null}       Group ID (e.g. 'frlg') or null
 */
function getCompatGroupId(displayName) {
  if (!displayName) return null;
  const lower = displayName.toLowerCase();
  for (const group of POKEMON_COMPAT_GROUPS) {
    const excluded = group.exclude && group.exclude.some(ex => lower.includes(ex));
    if (excluded) continue;
    if (group.keywords.some(kw => lower.includes(kw))) {
      return group.id;
    }
  }
  return null;
}

/**
 * Return all ROMs that are compatible with the given ROM's display name.
 * Compatibility means belonging to the same group.
 * The source ROM itself is included in the result so the caller does not
 * need special-case it.
 *
 * @param {string}   sourceDisplayName  Display name of the host's ROM
 * @param {object[]} allRoms            Array of ROM objects from the database
 * @returns {object[]}                  Subset of allRoms that are compatible
 */
function getCompatibleRoms(sourceDisplayName, allRoms) {
  const groupId = getCompatGroupId(sourceDisplayName);
  if (!groupId) return [];

  return allRoms.filter(rom => getCompatGroupId(rom.displayName) === groupId);
}

module.exports = { POKEMON_COMPAT_GROUPS, getCompatGroupId, getCompatibleRoms };
