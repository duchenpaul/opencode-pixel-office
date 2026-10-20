# Pixel Office

A pixel-art office visualization for AI assistants. Works with **OpenCode**, **Claude Code**, and **Hermes** simultaneously.

<img width="1455" height="824" alt="Pixel Office Screenshot" src="https://github.com/user-attachments/assets/e20e2e68-a032-4747-a027-aacca0f274e5" />

[![npm version](https://img.shields.io/npm/v/opencode-pixel-office.svg)](https://www.npmjs.com/package/opencode-pixel-office)

## Features

- **Multi-provider Support**: Works with OpenCode, Claude Code CLI, and Hermes
- **Live Visualization**: Real-time pixel-art office showing agent activity
- **Tabbed Interface**: Switch between OpenCode, Claude, and Hermes Office views
- **Mobile Ready**: Connect via local network + QR code
- **Session Tracking**: Monitor multiple sessions across different repos

## Quick Start

```bash
# Install globally
npm install -g opencode-pixel-office

# Install for OpenCode, Claude Code, and Hermes
opencode-pixel-office install

# Start the server
opencode-pixel-office start
```

That's it! The dashboard opens at `http://localhost:5100`.

## CLI Commands

| Command | Description |
|---------|-------------|
| `install` | Install integrations for OpenCode, Claude Code, and Hermes |
| `start` | Start the Pixel Office server |
| `stop` | Stop the server |
| `status` | Show installation status |
| `uninstall` | Remove everything |

### Options

- `--port <number>` - Set server port (default: 5100)
- `--version, -v` - Show version number

## How It Works

```
┌─────────────┐     ┌─────────────┐
│  OpenCode   │     │ Claude Code │
│   Plugin    │     │    Hooks    │
└──────┬──────┘     └──────┬──────┘
       │                   │
       │   HTTP POST       │
       └───────┬───────────┘
               ▼
       ┌───────────────┐
       │ Pixel Office  │
       │    Server     │
       │   :5100       │
       └───────┬───────┘
               │ WebSocket
               ▼
       ┌───────────────┐
       │    Browser    │
       │   Dashboard   │
       └───────────────┘
```

- **OpenCode Plugin** → `~/.opencode/plugins/pixel-office.js`
- **Claude Code Hooks** → `~/.claude/hooks/` + `~/.claude/settings.json`
- **Hermes Plugin** → `$HERMES_HOME/plugins/opencode-pixel-office/` (default: `~/.hermes/plugins/opencode-pixel-office/`), forwarding HTTP events to the same server
- **Server/App** → `~/.opencode/pixel-office/`

## Hermes

The installer copies a native observer plugin and runs
`hermes plugins enable opencode-pixel-office`. If Hermes is not on `PATH`, it
reports **enablement pending**; run that command once Hermes is available.
Start a **new Hermes session** after installing or enabling the plugin, then
select the **Hermes** tab in the dashboard.

Main sessions, delegated subagents, tool activity/errors, and approval waiting
states are supported. Only metadata supplied by Hermes hooks is displayed;
prompt streaming, todo synchronization, and historical sessions are not imported.
Events use a bounded, best-effort background queue so an unavailable dashboard
does not block Hermes. Delivery failures are logged, not replayed.

Set `HERMES_HOME` before installation and when running Hermes if you use a custom
profile. The plugin reads the port saved by `install --port <number>` or
`start --port <number>` when a new Hermes process loads it (default: 5100).
To override the destination, set `PIXEL_OFFICE_URL=http://127.0.0.1:5100/events`
in the Hermes process environment. Restart Hermes after changing the port.

`status` reports installed plugin files and the last installation's enablement
result, not live Hermes plugin state. `uninstall` disables this plugin when the
Hermes CLI is available and removes only its owned files; restart Hermes to
unload observers. If the CLI is unavailable, follow the printed disable command.

The hook contract is based on [Hermes Pixel Office](https://github.com/teknium1/hermes-pixel-office).
This integration does not require its Python server on port 8113. Its `pixel-office`
plugin is left untouched; if both plugins are enabled, each independently observes
Hermes activity.

## 📱 Mobile Support

Monitor your agents from your phone!

1. Click the Network URL in the top-right corner
2. Scan the QR code
3. Watch agents work from anywhere on your network

<img src="https://github.com/user-attachments/assets/c5420d78-9c87-4062-b034-21ae3defd52f" width="375" alt="Mobile View" />

## Development

```bash
# Clone the repo
git clone https://github.com/anthropics/opencode-pixel-office.git
cd opencode-pixel-office
npm install

# Run server (dev mode)
npm start

# Run client (dev mode, separate terminal)
npm run dev:client

# Build client for production
npm run build:client
```

## Project Structure

```
pixel-opencode/
├── client/                 # React + PixiJS Frontend
│   └── src/
│       ├── App.tsx         # Main app with tabs
│       ├── PixiScene.tsx   # Pixel art rendering
│       └── useOfficeState.ts
├── server/
│   └── index.ts            # Express + WebSocket server
├── plugin/
│   └── pixel-office.js     # OpenCode plugin
└── bin/
    ├── opencode-pixel-office.js  # CLI
    └── claude-code-hook.js       # Claude Code hook
```

## Credits

- **Tileset**: [Office Tileset by DonArg](https://donarg.itch.io/officetileset)
- **Icons**: Lucide React
- **Engine**: PixiJS
