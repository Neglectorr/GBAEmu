# GBA Emulation Portal 🎮

A full-featured Game Boy Advance emulator web portal with multiplayer lobby system, authentic GBA link cable emulation, Google SSO authentication, and a modern gaming UI.

## Features

| Feature | Description |
|---|---|
| 🎮 High-accuracy emulation | Powered by [mGBA](https://mgba.io/) compiled to WebAssembly |
| 🔗 Link Cable Multiplayer | Authentic GBA SIO Multiplay protocol over WebSockets — perfect for Pokémon trades/battles |
| 🏟️ Lobby System | Create / join lobbies, chat, ready-up, spectate |
| 👁️ Spectator Mode | Watch sessions live via canvas frame streaming |
| 💾 Cloud Saves | Save files tied to Google account (persistent across devices) |
| 🔐 Google SSO | Sign in with Google — no password required |
| ⚙️ Admin Panel | Upload ROMs, manage users and admin permissions |
| 📱 Mobile Controls | On-screen D-pad and buttons for touch devices |

## Quick Start

### 1. Clone and Install

```bash
git clone https://github.com/WesleyPostmaPantheon/GBAEmulation
cd GBAEmulation
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your Google OAuth credentials
```

**Required env vars:**

```
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_CALLBACK_URL=http://localhost:3000/auth/google/callback
SESSION_SECRET=a-long-random-secret-string
```

### 3. Set up Google OAuth

1. Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Create an **OAuth 2.0 Client ID** (Web application)
3. Add authorised redirect URI: `http://localhost:3000/auth/google/callback`
4. Copy Client ID and Secret to `.env`

### 4. Run

```bash
npm start          # production
npm run dev        # development (auto-reload with nodemon)
```

Open `http://localhost:3000`

## Architecture

```
server.js                  Express + Socket.IO server
src/
  passport.js              Google OAuth2 strategy
  db/index.js              NeDB embedded database (users, roms, saves)
  middleware/auth.js        requireAuth / requireAdmin guards
  routes/
    auth.js                /auth/google, /auth/me, /auth/logout
    roms.js                GET /api/roms, GET /api/roms/:id/download
    admin.js               POST /api/admin/upload, DELETE /api/admin/roms/:id
    saves.js               GET/PUT/DELETE /api/saves/:romId
    lobbies.js             GET /api/lobbies (HTTP view)
  socket/
    lobbyManager.js        In-memory lobby state
    lobby.js               Socket.IO /lobby namespace
    linkCable.js           Socket.IO /linkcable namespace
public/
  index.html               Landing / login page
  lobby.html               Lobby browser
  game.html                Game room (emulator + sidebar)
  admin.html               Admin panel
  css/style.css            Modern dark gaming theme
  js/
    common.js              Shared utilities (toast, API, auth)
    lobby.js               Lobby browser logic
    game.js                Emulator + link cable client
    admin.js               Admin panel logic
    socket.io.min.js       Socket.IO client (bundled)
  emulator/                mGBA WASM files (served from node_modules)
```

## Link Cable Multiplayer

The link cable is emulated using the **GBA SIO Multiplay protocol** over Socket.IO:

1. Each player runs their own mGBA WASM instance in the browser
2. The emulator's SIOMLT_SEND register is monitored via `videoFrameEndedCallback`
3. When a transfer is initiated, the word is sent to the server via `lc:send`
4. The server collects all players' words (or times out after 2s) and broadcasts `lc:sync`
5. Each player's emulator receives the SIOMULTI0-3 values and completes the transfer

**Why Pokémon works well:** Pokémon GBA games use link cable at interactive menu points
(trade centers, battle arenas), not in tight real-time loops. 100-200 ms round-trip
latency is fully acceptable.

**To use:** Click **"🔗 Connect"** in the game room toolbar when another player is
in your lobby.

## Deployment (Codecubers AMP – Node.js)

1. Set environment variables in your AMP configuration:
   ```
   NODE_ENV=production
   PORT=3000
   SESSION_SECRET=<strong-random-string>
   GOOGLE_CLIENT_ID=<production-client-id>
   GOOGLE_CLIENT_SECRET=<production-secret>
   GOOGLE_CALLBACK_URL=https://yourdomain.com/auth/google/callback
   ```

2. **Important:** mGBA WASM requires **Cross-Origin Isolation** headers:
   ```
   Cross-Origin-Opener-Policy: same-origin
   Cross-Origin-Embedder-Policy: require-corp
   ```
   These are automatically set by the server for the `/emulator/` route and game page.

3. Ensure `uploads/` and `data/` directories are writable by the Node.js process.

4. The app starts with `npm start` — no build step required.

## ROM Management

- ROMs are **not included** — you must own the games you play.
- The first user to sign in becomes the **admin** automatically.
- Admins can upload ROMs via the Admin Panel.
- Supported formats: `.gba`, `.gbc`, `.gb`, `.zip` (max 64 MB)

## Save Files

- Saves are stored server-side, linked to your Google account.
- Auto-saves every 30 seconds and when leaving a game session.
- Saves are per-user per-ROM — each player has their own save file.

## Technology Stack

| Component | Technology |
|---|---|
| Backend | Node.js + Express 4 + Socket.IO 4 |
| Database | NeDB (embedded, no setup required) |
| Authentication | Passport.js + Google OAuth 2.0 |
| File uploads | Multer v2 |
| Sessions | express-session + memorystore |
| Emulator | mGBA WASM (@thenick775/mgba-wasm) |
| Frontend | Vanilla JavaScript + modern CSS |
| Fonts | Google Fonts (Rajdhani, Exo 2, Share Tech Mono) |

## License

This project is licensed under MIT. The bundled mGBA WebAssembly core is licensed
under [GPL-2.0](https://mgba.io/license.html).

> **Legal note:** Only play games you legally own. ROMs provided by the portal
> administrator must comply with applicable copyright laws.
