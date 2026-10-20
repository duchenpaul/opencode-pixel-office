# Installation

## Quick Install

```bash
# Install globally
npm install -g opencode-pixel-office

# Install for OpenCode, Claude Code, and Hermes
opencode-pixel-office install

# Start the server
opencode-pixel-office start
```

The dashboard opens at `http://localhost:5100`.

### Installing from git

```bash
npm install -g git+https://github.com/duchenpaul/opencode-pixel-office.git#hermes
opencode-pixel-office install
opencode-pixel-office start
curl -sf http://localhost:5100/ | head -1
```

Git and npm packages include the prebuilt client, so no development dependencies
or install-time build are needed. This avoids npm's
[global git prepare bug](https://github.com/npm/cli/issues/8440).
The verification command should print `<!doctype html>`.

`start` uses the installed app in `~/.opencode/pixel-office/` when available,
falling back to the package copy before installation. Rerun `install` after
upgrading the package to refresh the installed app. Server stdout and stderr
are appended to `~/.opencode/pixel-office/server.log`, including startup failures.
On Linux without `DISPLAY` or `WAYLAND_DISPLAY`, no browser is launched; open
the printed URL from a machine with a browser.

If startup reports `client bundle missing`, run `npm run build:client` in a
source checkout with development dependencies installed, then rerun `install`.
Do not try to build in the standalone app directory, which contains only the
built client and runtime dependencies.

## What Gets Installed

The `install` command sets up everything automatically:

| Component | Location | Purpose |
|-----------|----------|---------|
| OpenCode Plugin | `~/.opencode/plugins/pixel-office.js` | Captures OpenCode events |
| Claude Code Hooks | `~/.claude/hooks/` + `settings.json` | Captures Claude Code events |
| Hermes Plugin | `$HERMES_HOME/plugins/opencode-pixel-office/` (default `~/.hermes/plugins/opencode-pixel-office/`) | Observes Hermes lifecycle hooks |
| Server/App | `~/.opencode/pixel-office/` | Runs the dashboard |

## CLI Commands

```bash
opencode-pixel-office install      # Install everything
opencode-pixel-office start        # Start server & open browser
opencode-pixel-office stop         # Stop the server
opencode-pixel-office status       # Check what's installed
opencode-pixel-office uninstall    # Remove everything
opencode-pixel-office --version    # Show version
```

### Options

- `--port <number>` - Custom port (default: 5100)

## Using with OpenCode

After installation, just start OpenCode. Events are automatically sent to Pixel Office.

## Using with Claude Code

After installation, just use Claude Code CLI. Events are automatically sent via hooks.

## Using with Hermes

The installer runs `hermes plugins enable opencode-pixel-office` if the Hermes CLI
is available. Otherwise it installs the plugin files and reports enablement
pending. Run the enable command manually once Hermes is installed.

Start a **new Hermes session**, perform some work, and select **Hermes** in the
dashboard. Sessions, delegated subagents, tool activity/errors, and approval
requests/responses are observed without blocking agent execution. Delivery is
best-effort with a bounded background queue; failures are logged. Events are not
saved for later replay.

Set `HERMES_HOME` consistently for installation, status, uninstall, and Hermes
itself when using a custom profile. Set `PIXEL_OFFICE_URL` in the Hermes process
environment to override the server endpoint. Otherwise the plugin reads the
saved app port (`install --port` or `start --port`) when it loads, defaulting to
5100. Restart Hermes after changing that port.

The plugin does not import prompt streams, todos, or historical sessions.
Its lifecycle-hook contract follows
[Hermes Pixel Office](https://github.com/teknium1/hermes-pixel-office), but uses
this dashboard's existing server, not the reference server on port 8113.
The reference `pixel-office` plugin and its settings are not modified.

`status` shows whether the owned plugin files exist and whether enablement
succeeded at the last install; it does not query live Hermes configuration.

## Viewing the Dashboard

1. Run `opencode-pixel-office start`
2. Dashboard opens at `http://localhost:5100`
3. Use tabs to switch between **OpenCode Office**, **Claude Office**, and **Hermes Office**

## Mobile Access

1. Click the network URL in the top-right corner of the dashboard
2. Scan the QR code with your phone
3. View agents from anywhere on your local network

## Environment Variables

```bash
# Custom server URL (optional)
export PIXEL_OFFICE_URL="http://localhost:5100/events"

# Custom port (optional)
export PIXEL_OFFICE_PORT="5100"
```

## Uninstalling

```bash
opencode-pixel-office uninstall
```

This removes:
- OpenCode plugin
- Claude Code hooks
- This integration's owned Hermes plugin files (the CLI disables the plugin if
  Hermes is available; otherwise follow the printed manual disable command).
  Restart Hermes to unload the observers. Other Hermes plugins/settings are preserved.
- Server/app directory
- All configuration

## For Developers

```bash
git clone --branch hermes https://github.com/duchenpaul/opencode-pixel-office.git
cd opencode-pixel-office
npm install

# Dev mode
npm start              # Server
npm run dev:client     # Client (separate terminal)

# Build (commit client/dist alongside client source changes)
npm run build:client

# Focused integration tests
node --test tests/*.test.js
python3 -m unittest discover -s tests -p 'test_*.py'
```

`npm pack` ships the prebuilt dashboard. `npm publish` rebuilds it using
`prepublishOnly`. `package.json` is the version source: `npm version <version>`
updates the lockfile and Hermes manifest, and client builds also synchronize the
manifest.
