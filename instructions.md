# GBA Pokémon Multiplayer – Instructions

This guide explains how to use the Lua-inspired link cable multiplayer feature for Pokémon GBA games on this portal.  The approach is modelled after [GBA-PK-multiplayer](https://github.com/TheHunterManX/GBA-PK-multiplayer) and runs entirely in the browser using EmulatorJS (mGBA core) and Socket.IO.

---

## How it works

The GBA link cable uses the **SIO Multiplay** hardware protocol:

| Player | Role | Description |
|--------|------|-------------|
| P0 (host) | **Master** | Initiates every transfer; link cable is always active |
| P1 – P3 | **Slave / Client** | Respond to the master's transfer; connect to participate |

In this portal:
1. The **first player** in the lobby (the lobby creator) is always the **master**.  Their link cable activates automatically when the game starts.
2. **Joining players** (P1 – P3) connect as **slaves**; their link cable activates when they enter the game room.
3. Data is relayed through the portal server via the `/lualink` Socket.IO namespace.
4. The JavaScript in each player's browser reads and writes GBA I/O registers (SIOCNT, SIOMULTI0-3, SIOMLT_SEND) inside the mGBA WebAssembly module – the same work that a Lua script does in mGBA desktop.

---

## Supported Pokémon games

Games are grouped by map-layout compatibility. Only games that share the same overworld maps can meaningfully connect to one another in a lobby:

| Group | Games | Compatible With |
|-------|-------|----------------|
| FRLG | Pokémon Fire Red, Leaf Green | Each other (same Kanto maps) |
| RS | Pokémon Ruby, Sapphire | Each other (same Hoenn maps) |
| Emerald | Pokémon Emerald | Standalone (expanded Hoenn maps) |
| Quetzal | Pokémon Quetzal (ROM hack) | Standalone (modified Emerald maps) |
| HGSS | Pokémon HeartGold, SoulSilver | Each other (same Johto/Kanto maps) |

> While all Gen 3 GBA titles share the same SIO Multiplay protocol for link cable trading/battling, they are split into separate lobby groups because their overworld maps differ. This ensures the player-presence overlay coordinates match correctly.
>
> Generation 1 (Red/Blue/Yellow) and Generation 2 (Gold/Silver/Crystal) games are also supported for single-version link cable play, but cross-generation trading is not possible in hardware and is therefore not supported here.

---

## Step-by-step: setting up a multiplayer session

### Requirements

- All players must be logged in with a Google account.
- The admin must have uploaded the ROM files via the Admin panel.

### 1 – Host creates a lobby

1. Go to **Lobby** (`/lobby`).
2. Click **Create Lobby**.
3. Enter a lobby name and select your Pokémon ROM (e.g. *Pokémon Fire Red*).
4. Click **Create** — you are taken to the game room automatically.
5. Wait on the start screen until your partner(s) join.

### 2 – Partner(s) join the lobby

1. The joining player navigates to `/lobby` and finds the lobby in the list.
2. Click the lobby card to enter the game room as a spectator.
3. Click **🎮 Join as Player** in the top-right toolbar.
4. **If a compatible alternative ROM is available** (e.g. *Leaf Green* for a *Fire Red* lobby), a selector appears:
   - Choose **your** game version and click **▶ Start with This Version**.
   - This lets Fire Red host and Leaf Green client play together in the same lobby.
5. The emulator loads automatically.

### 3 – Start the game (host)

1. Once at least one other player has joined, the host clicks **▶ Start Game**.
2. All players' emulators load their respective ROMs.
3. The link cable indicator (🔗) in the top bar turns **green** automatically:
   - Host: *Link Cable (Master)* — always on.
   - Client(s): *Link Cable Active* — activated automatically.

### 4 – Trade or battle

Follow the normal in-game steps for the action you want:

**Trading**
1. Both players enter a Pokémon Center and talk to the **Cable Club** attendant.
2. The host selects *Trade* → the client does the same.
3. The trading screen opens on both sides; select Pokémon and confirm.

**Battling (link battle)**
1. Both players enter a Pokémon Center and talk to the **Cable Club** attendant.
2. Select *Battle* (single or double).
3. The battle screen loads on both sides.

> ⚠️ **Important:** Both players must reach the Cable Club **before** the link cable times out (~30 seconds of inactivity triggers a disconnection in some games).  If the connection drops, leave the Cable Club and re-enter.

### 5 – Disconnecting

- Players can disconnect by clicking **🔗 Disconnect** (slaves only; the master's link cable cannot be disabled manually).
- Leaving the lobby (✕ Leave) disconnects the link cable and saves your game.

---

## Compatibility notes

| Feature | Status |
|---------|--------|
| Gen 3 trading | ✅ Supported |
| Gen 3 link battles | ✅ Supported |
| Gen 3 multi-player minigames (Union Room, etc.) | ⚠️ Experimental |
| Cross-generation trades (Gen 1 ↔ Gen 2) | ❌ Not supported |
| Colosseum / XD connectivity | ❌ Not supported |
| GBA to DS Pal Park migration | ❌ Not supported |

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Link cable indicator stays grey | Make sure the game has fully loaded before attempting to connect.  The auto-connect fires 2 seconds after the game starts. |
| "Lobby not found" error | The lobby may have been dissolved.  Return to `/lobby` and create a new one. |
| Trade/battle screen freezes | Both players' games must reach the Cable Club within a few seconds of each other.  Try leaving and re-entering the Cable Club. |
| Compatible ROM selector does not appear | This only appears when the admin has uploaded multiple Gen 3 ROM titles.  Ask the admin to upload additional versions. |
| Save data lost after trade | Save manually using **💾 Save** or the in-game *Load SAV Files* button before and after trading. |

---

## Technical details (for developers)

### Architecture

```
Browser (P0 – master)             Server              Browser (P1 – slave)
  ──────────────────────────────────────────────────────────────────
  SIOMLT_SEND changed
    ──── lua:send {word} ──────────►
                                  ──── lua:masterReady ──────────►
                                                               reads SIOMLT_SEND
                                  ◄──── lua:send {word} ───────────
    ◄──── lua:sync {words[4]} ─────────────────────────────────────►
  inject SIOMULTI0-3                                        inject SIOMULTI0-3
  fire SIO IRQ                                              fire SIO IRQ
```

### Key files

| File | Description |
|------|-------------|
| `src/socket/luaLink.js` | Server-side relay: master/slave session management |
| `public/js/game.js` | Client: register interceptor, Lua-style polling loop |
| `src/pokemon-compat.js` | ROM compatibility group definitions |
| `src/routes/roms.js` | `/api/roms/:id/compatible` endpoint |

### How the register interceptor works (Lua equivalent in JavaScript)

1. `findGbaIoBase()` locates the GBA I/O register region inside the mGBA WebAssembly heap using SOUNDBIAS and SIOMULTI pattern matching.
2. `installRegisterInterceptor(ioBase, playerIdx)` runs a polling loop:
   - **Every frame** – injects the "connected" SIOCNT value and re-injects cached SIOMULTI0-3 data so the game always sees a cable attached.
   - **On SIOMLT_SEND change (master only)** – sends the new word via `lua:send`; the server broadcasts `lua:masterReady` to slaves, then responds with `lua:sync`.
   - **On `lua:masterReady` (slaves)** – reads the current SIOMLT_SEND and responds with `lua:send`.
   - **On `lua:sync`** – injects the full 4-word packet into SIOMULTI0-3 and fires the SIO IRQ so the game's interrupt handler processes the exchange.
3. If `findGbaIoBase()` fails (e.g. the game has not yet initialised SIO), a retry timer fires every 2 seconds for up to 10 retries.
