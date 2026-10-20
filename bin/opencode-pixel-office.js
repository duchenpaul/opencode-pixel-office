#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import { execSync, execFileSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PLUGIN_NAME = "pixel-office.js";
const PLUGIN_ID = "opencode-pixel-office@latest";
const DEFAULT_PLUGIN_DIR = path.join(os.homedir(), ".opencode", "plugins");
const DEFAULT_APP_DIR = path.join(os.homedir(), ".opencode", "pixel-office");
const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".config", "opencode", "opencode.json");
const PIXEL_OFFICE_CONFIG_PATH = path.join(DEFAULT_APP_DIR, "config.json");
const CLAUDE_DIR = path.join(os.homedir(), ".claude");
const CLAUDE_HOOK_DIR = path.join(CLAUDE_DIR, "hooks");
const CLAUDE_HOOK_FILE = path.join(CLAUDE_HOOK_DIR, "opencode-pixel-office-hook.js");
const CLAUDE_SETTINGS_PATH = path.join(CLAUDE_DIR, "settings.json");
const HERMES_PLUGIN_ID = "opencode-pixel-office";

const args = process.argv.slice(2);
const command = args[0];
const shouldInstall = command === "install";
const shouldUninstall = command === "uninstall";
const shouldStart = command === "start";
const shouldStop = command === "stop";
const shouldStatus = command === "status";
const shouldVersion = args.includes("--version") || args.includes("-v");
const yesFlag = args.includes("--yes") || args.includes("-y");
const portIndex = args.findIndex((arg) => arg === "--port");
const portArg = portIndex !== -1 ? args[portIndex + 1] : null;
const profileIndex = args.indexOf("--hermes-profile");
const profileArg = profileIndex !== -1 ? args[profileIndex + 1] : null;
const nativeHermesHome = path.join(os.homedir(), ".hermes");
const hermesHome = path.resolve(process.env.HERMES_HOME || nativeHermesHome);
const relativeHome = path.relative(nativeHermesHome, hermesHome);
const hermesRoot = relativeHome === "" || (!relativeHome.startsWith(`..${path.sep}`) && relativeHome !== ".." && !path.isAbsolute(relativeHome))
  ? nativeHermesHome
  : path.basename(path.dirname(hermesHome)) === "profiles"
    ? path.dirname(path.dirname(hermesHome))
    : hermesHome;
const HERMES_HOME = profileArg
  ? profileArg === "default" ? hermesRoot : path.join(hermesRoot, "profiles", profileArg)
  : hermesHome;
const HERMES_PLUGIN_DIR = path.join(HERMES_HOME, "plugins", HERMES_PLUGIN_ID);
const HERMES_MARKER = path.join(HERMES_PLUGIN_DIR, ".pixel-office-owned.json");
const parsePort = (value) => {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("--port must be an integer between 1 and 65535");
  }
  return port;
};

const getVersion = () => {
  try {
    const pkgPath = path.resolve(__dirname, "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
};

const printHelp = () => {
  console.log(`opencode-pixel-office v${getVersion()}\n`);
  console.log("A pixel-art office visualization for AI coding assistants.");
  console.log("Works with OpenCode, Claude Code and Hermes simultaneously.\n");
  console.log("Usage:");
  console.log("  opencode-pixel-office install [options]    Install for OpenCode, Claude & Hermes");
  console.log("  opencode-pixel-office start [options]      Start the server");
  console.log("  opencode-pixel-office stop                 Stop the server");
  console.log("  opencode-pixel-office status               Show installation status");
  console.log("  opencode-pixel-office uninstall            Uninstall completely");
  console.log("\nOptions:");
  console.log("  --port <number> Set server port (default: 5100)");
  console.log("  --hermes-profile <name> Select an existing Hermes profile for install/status/uninstall");
  console.log("  --yes, -y       Skip confirmation prompts");
  console.log("  --version, -v   Show version number");
  console.log("\nExamples:");
  console.log("  opencode-pixel-office install      # Install for OpenCode + Claude Code + Hermes");
  console.log("  opencode-pixel-office start        # Start server & open browser");
  console.log("  opencode-pixel-office status       # Check what's installed");
};

const openBrowser = (url) => {
  const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  if (openCmd === "xdg-open" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    console.log(`Dashboard: ${url} (no graphical display; browser not opened)`);
    return;
  }
  try {
    execSync(`${openCmd} ${url}`);
    console.log(`Opened ${url}`);
  } catch (error) {
    console.warn(`Could not open browser: ${error.message}`);
    console.log(`Dashboard: ${url}`);
  }
};

const loadConfig = () => {
  try {
    if (fs.existsSync(PIXEL_OFFICE_CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(PIXEL_OFFICE_CONFIG_PATH, "utf8"));
    }
  } catch {}
  return {};
};

const saveConfig = (config) => {
  fs.mkdirSync(DEFAULT_APP_DIR, { recursive: true });
  fs.writeFileSync(PIXEL_OFFICE_CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
};

const prompt = async (question) => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
};

const copyRecursiveSync = (src, dest) => {
  const exists = fs.existsSync(src);
  const stats = exists && fs.statSync(src);
  const isDirectory = exists && stats.isDirectory();
  if (isDirectory) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }
    fs.readdirSync(src).forEach((childItemName) => {
      copyRecursiveSync(path.join(src, childItemName), path.join(dest, childItemName));
    });
  } else if (exists) {
    fs.copyFileSync(src, dest);
  }
};

const stopServer = (port) => {
  try {
    const pidOutput = execSync(`lsof -t -i :${port} 2>/dev/null`).toString().trim();
    if (pidOutput) {
      const pids = pidOutput.split("\n").map((p) => parseInt(p, 10)).filter((p) => !isNaN(p) && p > 0);
      for (const pid of pids) {
        try {
          process.kill(pid);
          console.log(`✓ Stopped server (PID: ${pid})`);
        } catch {}
      }
      return pids.length > 0;
    }
  } catch {}
  return false;
};

// Check if opencode plugin is installed
const isOpencodeInstalled = () => {
  const pluginPath = path.join(DEFAULT_PLUGIN_DIR, PLUGIN_NAME);
  return fs.existsSync(pluginPath);
};

// Check if claude-code hooks are installed
const isClaudeCodeInstalled = () => {
  return fs.existsSync(CLAUDE_HOOK_FILE);
};

const hermesInstallation = () => {
  if (!fs.existsSync(HERMES_MARKER)) return null;
  const marker = JSON.parse(fs.readFileSync(HERMES_MARKER, "utf8"));
  if (marker.owner !== HERMES_PLUGIN_ID) {
    throw new Error(`Unrecognized Hermes plugin ownership marker: ${HERMES_MARKER}`);
  }
  return marker;
};

const toggleHermesPlugin = (action) => {
  const profileArgs = profileArg ? ["--profile", profileArg] : [];
  const manualCommand = `hermes ${profileArgs.length ? `--profile ${profileArg} ` : ""}plugins ${action} ${HERMES_PLUGIN_ID}`;
  try {
    execFileSync("hermes", [...profileArgs, "plugins", action, HERMES_PLUGIN_ID], {
      stdio: "pipe",
      env: { ...process.env, HERMES_HOME },
      timeout: 30000,
    });
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      console.warn(`  ! Hermes CLI not found. Run '${manualCommand}' with HERMES_HOME=${HERMES_HOME}`);
      return false;
    }
    const detail = error.stderr?.toString().trim() || error.message;
    throw new Error(`Hermes plugin ${action} failed: ${detail}. Retry '${manualCommand}'.`);
  }
};

const installHermesPlugin = () => {
  const existing = hermesInstallation();
  if (fs.existsSync(HERMES_PLUGIN_DIR) && !existing) {
    throw new Error(`Refusing to overwrite an unowned Hermes plugin: ${HERMES_PLUGIN_DIR}`);
  }
  fs.mkdirSync(HERMES_PLUGIN_DIR, { recursive: true });
  for (const name of ["__init__.py", "plugin.yaml"]) {
    fs.copyFileSync(path.resolve(__dirname, "..", "plugin", "hermes", name), path.join(HERMES_PLUGIN_DIR, name));
  }
  fs.writeFileSync(HERMES_MARKER, JSON.stringify({ owner: HERMES_PLUGIN_ID, enabled: false }));
  const enabled = toggleHermesPlugin("enable");
  fs.writeFileSync(HERMES_MARKER, JSON.stringify({ owner: HERMES_PLUGIN_ID, enabled }));
  console.log(`  ✓ Hermes plugin files installed${enabled ? " and enabled" : " (enablement pending)"}`);
  console.log(`  Hermes home: ${HERMES_HOME}`);
  console.log("  Start a new Hermes session to load the plugin.");
  return enabled;
};

const removeHermesPlugin = () => {
  if (!hermesInstallation()) {
    console.log("- Owned Hermes plugin not found; other plugins left untouched");
    return;
  }
  toggleHermesPlugin("disable");
  for (const name of ["__init__.py", "plugin.yaml"]) {
    const target = path.join(HERMES_PLUGIN_DIR, name);
    if (fs.existsSync(target)) fs.unlinkSync(target);
  }
  const remaining = fs.readdirSync(HERMES_PLUGIN_DIR).filter((name) => name !== ".pixel-office-owned.json");
  if (remaining.length === 0) {
    fs.unlinkSync(HERMES_MARKER);
    fs.rmdirSync(HERMES_PLUGIN_DIR);
  } else {
    // Retain ownership for safe reinstall when Python caches or user files remain.
    fs.writeFileSync(HERMES_MARKER, JSON.stringify({ owner: HERMES_PLUGIN_ID, enabled: false }));
  }
  console.log("✓ Removed owned Hermes plugin files (restart Hermes to unload observers)");
};

// Check if app is installed
const isAppInstalled = () => {
  return fs.existsSync(path.join(DEFAULT_APP_DIR, "server", "index.ts"));
};

// Install opencode plugin
const installOpencodePlugin = () => {
  const rootSource = path.resolve(__dirname, "..");
  const pluginSource = path.join(rootSource, "plugin", PLUGIN_NAME);

  if (!fs.existsSync(pluginSource)) {
    console.error(`  ! Plugin file not found: ${pluginSource}`);
    return false;
  }

  fs.mkdirSync(DEFAULT_PLUGIN_DIR, { recursive: true });
  const targetPluginPath = path.join(DEFAULT_PLUGIN_DIR, PLUGIN_NAME);
  fs.copyFileSync(pluginSource, targetPluginPath);
  console.log(`  ✓ OpenCode plugin installed`);
  return true;
};

// Remove opencode plugin
const removeOpencodePlugin = () => {
  const pluginPath = path.join(DEFAULT_PLUGIN_DIR, PLUGIN_NAME);
  if (fs.existsSync(pluginPath)) {
    fs.unlinkSync(pluginPath);
    console.log(`✓ Removed OpenCode plugin`);
    return true;
  }
  return false;
};

// Install claude-code hooks
const installClaudeCodeHooks = () => {
  fs.mkdirSync(CLAUDE_HOOK_DIR, { recursive: true });

  const hookSource = path.resolve(__dirname, "claude-code-hook.js");
  if (!fs.existsSync(hookSource)) {
    console.error(`  ! Hook file not found: ${hookSource}`);
    return false;
  }

  fs.copyFileSync(hookSource, CLAUDE_HOOK_FILE);

  const hookCommand = `node ${CLAUDE_HOOK_FILE}`;
  const hooksConfig = {
    SessionStart: [{ matcher: "", hooks: [{ type: "command", command: hookCommand }] }],
    UserPromptSubmit: [{ matcher: "", hooks: [{ type: "command", command: hookCommand }] }],
    PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: hookCommand }] }],
    PostToolUse: [{ matcher: "", hooks: [{ type: "command", command: hookCommand }] }],
    PostToolUseFailure: [{ matcher: "", hooks: [{ type: "command", command: hookCommand }] }],
    PermissionRequest: [{ matcher: "", hooks: [{ type: "command", command: hookCommand }] }],
    Notification: [{ matcher: "", hooks: [{ type: "command", command: hookCommand }] }],
    SubagentStart: [{ matcher: "", hooks: [{ type: "command", command: hookCommand }] }],
    SubagentStop: [{ matcher: "", hooks: [{ type: "command", command: hookCommand }] }],
    Stop: [{ matcher: "", hooks: [{ type: "command", command: hookCommand }] }],
    PreCompact: [{ matcher: "", hooks: [{ type: "command", command: hookCommand }] }],
    SessionEnd: [{ matcher: "", hooks: [{ type: "command", command: hookCommand }] }],
  };

  let settings = { hooks: {} };
  if (fs.existsSync(CLAUDE_SETTINGS_PATH)) {
    try {
      settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, "utf8"));
    } catch {
      settings = { hooks: {} };
    }
  }

  settings.hooks = settings.hooks || {};
  Object.entries(hooksConfig).forEach(([eventName, value]) => {
    settings.hooks[eventName] = value;
  });

  fs.writeFileSync(CLAUDE_SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  console.log(`  ✓ Claude Code hooks installed`);
  return true;
};

// Remove claude-code hooks
const removeClaudeCodeHooks = () => {
  let removed = false;

  if (fs.existsSync(CLAUDE_HOOK_FILE)) {
    fs.unlinkSync(CLAUDE_HOOK_FILE);
    removed = true;
  }

  if (fs.existsSync(CLAUDE_SETTINGS_PATH)) {
    try {
      const settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, "utf8"));
      if (settings.hooks) {
        let modified = false;
        for (const eventName of Object.keys(settings.hooks)) {
          const hooks = settings.hooks[eventName];
          if (Array.isArray(hooks)) {
            const filtered = hooks.filter((h) => {
              if (Array.isArray(h.hooks)) {
                h.hooks = h.hooks.filter((inner) => !inner.command?.includes("opencode-pixel-office-hook"));
                return h.hooks.length > 0;
              }
              return !h.command?.includes("opencode-pixel-office-hook");
            });
            if (filtered.length !== hooks.length) {
              settings.hooks[eventName] = filtered;
              modified = true;
            }
            if (filtered.length === 0) {
              delete settings.hooks[eventName];
            }
          }
        }
        if (Object.keys(settings.hooks).length === 0) {
          delete settings.hooks;
        }
        if (modified) {
          fs.writeFileSync(CLAUDE_SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
        }
      }
    } catch {}
  }

  if (removed) {
    console.log(`✓ Removed Claude Code hooks`);
  }
  return removed;
};

// Install the standalone app (server + client)
const installApp = async (port) => {
  const rootSource = path.resolve(__dirname, "..");
  const clientDist = path.join(rootSource, "client", "dist");
  if (!fs.existsSync(path.join(clientDist, "index.html"))) {
    throw new Error("client bundle missing — run `npm run build:client`");
  }

  console.log(`\nInstalling Pixel Office app...`);
  fs.mkdirSync(DEFAULT_APP_DIR, { recursive: true });

  // Copy server
  copyRecursiveSync(path.join(rootSource, "server"), path.join(DEFAULT_APP_DIR, "server"));

  // Copy client/dist
  copyRecursiveSync(clientDist, path.join(DEFAULT_APP_DIR, "client", "dist"));

  // Copy package.json
  fs.copyFileSync(path.join(rootSource, "package.json"), path.join(DEFAULT_APP_DIR, "package.json"));

  // Save config
  const configData = loadConfig();
  if (port) {
    configData.port = port;
  }
  if (profileArg) {
    configData.hermesProfile = profileArg;
  }
  saveConfig(configData);

  // npm install
  console.log("  Installing dependencies...");
  try {
    execSync("npm install --omit=dev --no-package-lock", {
      cwd: DEFAULT_APP_DIR,
      stdio: "pipe",
    });
    console.log(`  ✓ App installed`);
  } catch (e) {
    throw new Error(`Failed to install app dependencies: ${e.stderr?.toString().trim() || e.message}`);
  }
};

const run = async () => {
  if (shouldVersion) {
    console.log(`opencode-pixel-office v${getVersion()}`);
    process.exit(0);
  }
  if (profileIndex !== -1) {
    if (!profileArg || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(profileArg)) {
      throw new Error("--hermes-profile must name an existing Hermes profile (for example, dev-team)");
    }
    if (!shouldInstall && !shouldStatus && !shouldUninstall) {
      throw new Error("--hermes-profile is supported by install, status, and uninstall");
    }
    if (!fs.existsSync(HERMES_HOME) || !fs.statSync(HERMES_HOME).isDirectory()) {
      throw new Error(`Hermes profile '${profileArg}' not found at ${HERMES_HOME}. Create it with 'hermes profile create ${profileArg}' first.`);
    }
  }

  // STATUS
  if (shouldStatus) {
    console.log(`\nPixel Office Status:\n`);
    console.log(`  OpenCode plugin:  ${isOpencodeInstalled() ? "✓ Installed" : "✗ Not installed"}`);
    console.log(`  Claude Code hooks: ${isClaudeCodeInstalled() ? "✓ Installed" : "✗ Not installed"}`);
    const hermes = hermesInstallation();
    const hermesFiles = ["__init__.py", "plugin.yaml"].every((name) =>
      fs.existsSync(path.join(HERMES_PLUGIN_DIR, name)));
    console.log(`  Hermes plugin:     ${hermes && hermesFiles
      ? `✓ Installed (${hermes.enabled ? "enabled at last install" : "enablement pending"})`
      : "✗ Not installed or incomplete"}`);
    console.log(`  Hermes home:       ${HERMES_HOME}`);
    console.log(`  App/Server:        ${isAppInstalled() ? "✓ Installed" : "✗ Not installed"}`);

    const config = loadConfig();
    const port = config.port || 5100;

    let serverRunning = false;
    try {
      const pidOutput = execSync(`lsof -t -i :${port} 2>/dev/null`).toString().trim();
      serverRunning = !!pidOutput;
    } catch {}

    console.log(`  Server:            ${serverRunning ? `✓ Running on port ${port}` : "✗ Not running"}`);
    console.log("");
    process.exit(0);
  }

  // INSTALL
  if (shouldInstall) {
    const port = portIndex !== -1 ? parsePort(portArg) : null;
    console.log(`\nInstalling Pixel Office...\n`);

    // Install OpenCode plugin
    console.log("OpenCode:");
    installOpencodePlugin();

    // Install Claude Code hooks
    console.log("\nClaude Code:");
    installClaudeCodeHooks();

    console.log("\nHermes:");
    const hermesEnabled = installHermesPlugin();

    // Install app
    await installApp(port);

    console.log("\n✓ Installation complete!");
    console.log(`\nOpenCode and Claude Code configured. Hermes ${hermesEnabled ? "enabled" : "requires manual enablement"}.`);
    console.log("Run 'opencode-pixel-office start' to launch the server.");
    process.exit(0);
  }

  // UNINSTALL
  if (shouldUninstall) {
    const config = loadConfig();
    const port = config.port || 5100;

    console.log("\nUninstalling Pixel Office...\n");

    removeHermesPlugin();

    console.log("Stopping server...");
    if (!stopServer(port)) {
      console.log("- Server not running");
    }

    // Remove OpenCode plugin
    if (!removeOpencodePlugin()) {
      console.log("- OpenCode plugin not found");
    }

    // Remove Claude Code hooks
    if (!removeClaudeCodeHooks()) {
      console.log("- Claude Code hooks not found");
    }

    // Remove app directory
    if (fs.existsSync(DEFAULT_APP_DIR)) {
      fs.rmSync(DEFAULT_APP_DIR, { recursive: true, force: true });
      console.log(`✓ Removed app directory`);
    }

    console.log("\n✓ Uninstallation complete.");
    process.exit(0);
  }

  // START
  if (shouldStart) {
    const config = loadConfig();
    const port = portIndex !== -1 ? parsePort(portArg) : config.port || 5100;
    if (portArg) {
      saveConfig({ ...config, port });
    }
    const serverScript = "server/index.ts";

    const rootSource = path.resolve(__dirname, "..");
    const localServerPath = path.join(rootSource, "server", "index.ts");
    const globalServerPath = path.join(DEFAULT_APP_DIR, "server", "index.ts");

    let serverCwd;
    if (fs.existsSync(globalServerPath)) {
      serverCwd = DEFAULT_APP_DIR;
    } else if (fs.existsSync(localServerPath)) {
      serverCwd = rootSource;
    } else {
      console.error("Server not found. Run 'opencode-pixel-office install' first.");
      process.exit(1);
    }

    // Check if already running
    try {
      const pidOutput = execSync(`lsof -t -i :${port} 2>/dev/null`).toString().trim();
      if (pidOutput) {
        console.log(`Pixel Office is already running on port ${port}`);
        const url = `http://localhost:${port}`;
        openBrowser(url);
        process.exit(0);
      }
    } catch {}

    // Resolve tsx binary
    let tsxBin = null;
    const tsxLocations = [
      path.join(serverCwd, "node_modules", ".bin", "tsx"),
      path.join(__dirname, "..", "node_modules", ".bin", "tsx"),
      path.join(DEFAULT_APP_DIR, "node_modules", ".bin", "tsx"),
    ];
    for (const loc of tsxLocations) {
      if (fs.existsSync(loc)) {
        tsxBin = loc;
        break;
      }
    }
    if (!tsxBin) {
      tsxBin = "tsx";
    }

    const { spawn } = await import("node:child_process");

    fs.mkdirSync(DEFAULT_APP_DIR, { recursive: true });
    const logPath = path.join(DEFAULT_APP_DIR, "server.log");
    const logFd = fs.openSync(logPath, "a");
    let child;
    try {
      child = spawn(tsxBin, [serverScript], {
        cwd: serverCwd,
        env: { ...process.env, PORT: String(port) },
        detached: true,
        stdio: ["ignore", logFd, logFd],
      });
    } finally {
      fs.closeSync(logFd);
    }

    child.on("error", (err) => {
      console.error(`Failed to start server: ${err.message}`);
      process.exit(1);
    });

    child.unref();

    await new Promise((r) => setTimeout(r, 1500));
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Server exited during startup. See ${logPath}`);
    }
    console.log(`Pixel Office server started on port ${port} (PID: ${child.pid})`);
    console.log(`Server log: ${logPath}`);
    const url = `http://localhost:${port}`;
    openBrowser(url);
    process.exit(0);
  }

  // STOP
  if (shouldStop) {
    const config = loadConfig();
    const port = config.port || 5100;
    console.log(`Stopping Pixel Office server on port ${port}...`);
    if (!stopServer(port)) {
      console.log(`- No server found on port ${port}`);
    }
    process.exit(0);
  }

  // DEFAULT: show help
  printHelp();
  process.exit(0);
};

run().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
