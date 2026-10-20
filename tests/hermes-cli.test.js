import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../bin/opencode-pixel-office.js", import.meta.url));

const fixture = (t, hermes = true) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pixel-office-test-")));
  const tsxCalls = path.join(home, "tsx-calls");
  t.after(() => {
    if (fs.existsSync(tsxCalls)) {
      const { pid } = JSON.parse(fs.readFileSync(tsxCalls, "utf8"));
      try {
        process.kill(pid);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    fs.rmSync(home, { recursive: true, force: true });
  });
  const packageDir = path.join(home, "package");
  const root = path.resolve(path.dirname(cli), "..");
  for (const name of ["bin", "plugin", "package.json"]) {
    fs.cpSync(path.join(root, name), path.join(packageDir, name), { recursive: true });
  }
  fs.mkdirSync(path.join(packageDir, "server"));
  fs.writeFileSync(path.join(packageDir, "server/index.ts"), "// fixture server\n");
  fs.mkdirSync(path.join(packageDir, "client/dist"), { recursive: true });
  fs.writeFileSync(path.join(packageDir, "client/dist/index.html"), "<!doctype html>\n");
  const platformOverride = path.join(home, "platform.cjs");
  fs.writeFileSync(platformOverride, `
    if (process.env.TEST_PLATFORM) {
      Object.defineProperty(process, "platform", { value: process.env.TEST_PLATFORM });
    }
  `);
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  const executable = (name, body) => {
    fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\n${body}`, { mode: 0o755 });
  };
  executable("npm", `
    const fs = require("node:fs");
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    if (pkg.scripts.prepare) { console.error("runtime must not rebuild the client"); process.exit(1); }
    if (process.env.NPM_FAIL) { console.error("test dependency failure"); process.exit(1); }
  `);
  executable("lsof", 'if (process.env.SERVER_RUNNING) console.log("12345"); else process.exit(1)');
  for (const name of ["open", "xdg-open"]) {
    executable(name, 'require("node:fs").writeFileSync(process.env.BROWSER_CALLS, process.argv.slice(2).join(" "))');
  }
  executable("tsx", `
    require("node:fs").writeFileSync(process.env.TSX_CALLS, JSON.stringify({
      cwd: process.cwd(), args: process.argv.slice(2), pid: process.pid,
    }));
    console.log("fixture server stdout");
    console.error("fixture server stderr");
    if (process.env.SERVER_FAIL) process.exit(1);
    setInterval(() => {}, 1000);
  `);
  if (hermes) {
    executable("hermes", `
      const fs = require("node:fs");
      fs.appendFileSync(process.env.HERMES_CALLS, JSON.stringify(process.argv.slice(2)) + "\\n");
      if (process.env.HERMES_FAIL) { console.error("test enable failure"); process.exit(1); }
    `);
  }
  const env = {
    ...process.env, HOME: home, PATH: bin, HERMES_HOME: path.join(home, "custom-hermes"),
    HERMES_CALLS: path.join(home, "hermes-calls"),
    TSX_CALLS: tsxCalls, BROWSER_CALLS: path.join(home, "browser-calls"),
    DISPLAY: "", WAYLAND_DISPLAY: "",
  };
  const plugin = path.join(env.HERMES_HOME, "plugins", "opencode-pixel-office");
  const run = (...args) => spawnSync(process.execPath, [
    "--require", platformOverride, path.join(packageDir, "bin/opencode-pixel-office.js"), ...args,
  ], {
    env, encoding: "utf8", timeout: 30000,
  });
  const calls = () => fs.readFileSync(env.HERMES_CALLS, "utf8").trim().split("\n").map(JSON.parse);
  return { home, env, plugin, run, calls, packageDir };
};

test("install/status/reinstall/uninstall respect custom Hermes home and other plugins", (t) => {
  const f = fixture(t);
  const other = path.join(f.env.HERMES_HOME, "plugins", "pixel-office");
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, "keep"), "reference");
  const settings = path.join(f.env.HERMES_HOME, "config.yaml");
  fs.writeFileSync(settings, "plugins:\n  enabled: [pixel-office]\n");
  let result = f.run("install", "--port", "5432");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Hermes plugin files installed and enabled/);
  assert.equal(fs.existsSync(path.join(f.plugin, "__init__.py")), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.home, ".opencode/pixel-office/config.json"))).port, 5432);
  assert.match(f.run("status").stdout, /Hermes plugin:.*enabled at last install/);
  result = f.run("install");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(settings, "utf8"), "plugins:\n  enabled: [pixel-office]\n");
  result = f.run("uninstall");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(f.plugin), false);
  assert.equal(fs.readFileSync(path.join(other, "keep"), "utf8"), "reference");
  assert.deepEqual(f.calls(), [
    ["plugins", "enable", "opencode-pixel-office"],
    ["plugins", "enable", "opencode-pixel-office"],
    ["plugins", "disable", "opencode-pixel-office"],
  ]);
});

test("missing Hermes CLI leaves explicit pending enablement and manual instructions", (t) => {
  const f = fixture(t, false);
  const result = f.run("install");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /hermes plugins enable opencode-pixel-office/);
  assert.match(f.run("status").stdout, /enablement pending/);
  const removed = f.run("uninstall");
  assert.equal(removed.status, 0, removed.stderr);
  assert.match(removed.stderr, /hermes plugins disable opencode-pixel-office/);
});

test("failed enablement is not reported as success and can be retried", (t) => {
  const f = fixture(t);
  f.env.HERMES_FAIL = "1";
  const result = f.run("install");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Hermes plugin enable failed: test enable failure/);
  assert.doesNotMatch(result.stdout, /Installation complete/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.plugin, ".pixel-office-owned.json"))).enabled, false);
  delete f.env.HERMES_FAIL;
  assert.equal(f.run("install").status, 0);
});

test("an unowned plugin is neither overwritten nor removed", (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.plugin, { recursive: true });
  fs.writeFileSync(path.join(f.plugin, "__init__.py"), "unrelated");
  const result = f.run("install");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing to overwrite/);
  assert.equal(fs.readFileSync(path.join(f.plugin, "__init__.py"), "utf8"), "unrelated");
  assert.equal(f.run("uninstall").status, 0);
  assert.equal(fs.readFileSync(path.join(f.plugin, "__init__.py"), "utf8"), "unrelated");
});

test("invalid custom port fails before installing integrations", (t) => {
  const f = fixture(t);
  assert.equal(f.run("install", "--port", "5100oops").status, 1);
  assert.equal(fs.existsSync(f.plugin), false);
});

test("uninstall preserves extra files and allows reinstall with Python caches present", (t) => {
  const f = fixture(t);
  assert.equal(f.run("install").status, 0);
  const cache = path.join(f.plugin, "__pycache__");
  fs.mkdirSync(cache);
  fs.writeFileSync(path.join(cache, "__init__.cpython-311.pyc"), "bytecode");
  fs.writeFileSync(path.join(f.plugin, "user-note"), "keep");
  assert.equal(f.run("uninstall").status, 0);
  assert.equal(fs.existsSync(path.join(f.plugin, "__init__.py")), false);
  assert.equal(fs.readFileSync(path.join(f.plugin, "user-note"), "utf8"), "keep");
  assert.equal(f.run("install").status, 0);
  assert.equal(fs.existsSync(path.join(f.plugin, "__init__.py")), true);
});

test("failed disablement retains the installed plugin and reports an error", (t) => {
  const f = fixture(t);
  assert.equal(f.run("install").status, 0);
  f.env.HERMES_FAIL = "1";
  const result = f.run("uninstall");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Hermes plugin disable failed/);
  assert.equal(fs.existsSync(path.join(f.plugin, "__init__.py")), true);
});

test("Hermes home defaults to the current user's .hermes directory", (t) => {
  const f = fixture(t);
  delete f.env.HERMES_HOME;
  const result = f.run("install");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(f.home, ".hermes/plugins/opencode-pixel-office/plugin.yaml")), true);
});

test("install copies the bundle without a runtime prepare hook and propagates dependency failures", (t) => {
  const f = fixture(t);
  let result = f.run("install");
  assert.equal(result.status, 0, result.stderr);
  const appDir = path.join(f.home, ".opencode/pixel-office");
  assert.equal(fs.readFileSync(path.join(appDir, "client/dist/index.html"), "utf8"), "<!doctype html>\n");
  const appPackage = JSON.parse(fs.readFileSync(path.join(appDir, "package.json"), "utf8"));
  assert.equal(appPackage.scripts.prepare, undefined);
  assert.equal(appPackage.scripts.start, "tsx server/index.ts");
  f.env.NPM_FAIL = "1";
  result = f.run("install");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Failed to install app dependencies: test dependency failure/);
  assert.doesNotMatch(result.stdout, /Installation complete/);
});

test("install rejects a missing client bundle", (t) => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.packageDir, "client/dist/index.html"));
  const result = f.run("install");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /client bundle missing.*npm run build:client/);
  assert.doesNotMatch(result.stdout, /Installation complete/);
});

test("start prefers the installed app, keeps both output streams, and skips headless xdg-open", (t) => {
  const f = fixture(t);
  assert.equal(f.run("install").status, 0);
  f.env.TEST_PLATFORM = "linux";
  const result = f.run("start");
  assert.equal(result.status, 0, result.stderr);
  const appDir = path.join(f.home, ".opencode/pixel-office");
  const started = JSON.parse(fs.readFileSync(f.env.TSX_CALLS, "utf8"));
  assert.equal(started.cwd, appDir);
  assert.deepEqual(started.args, ["server/index.ts"]);
  assert.match(fs.readFileSync(path.join(appDir, "server.log"), "utf8"), /fixture server stdout\nfixture server stderr/);
  assert.match(result.stdout, /no graphical display; browser not opened/);
  assert.equal(fs.existsSync(f.env.BROWSER_CALLS), false);
});

test("start falls back to the package server and opens a browser with a Wayland display", (t) => {
  const f = fixture(t);
  f.env.TEST_PLATFORM = "linux";
  f.env.WAYLAND_DISPLAY = "wayland-0";
  const result = f.run("start");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(f.env.TSX_CALLS, "utf8")).cwd, f.packageDir);
  assert.equal(fs.readFileSync(f.env.BROWSER_CALLS, "utf8"), "http://localhost:5100");
  assert.match(result.stdout, /Opened http:\/\/localhost:5100/);
});

test("start skips the browser on headless Linux when the server is already running", (t) => {
  const f = fixture(t);
  f.env.TEST_PLATFORM = "linux";
  f.env.SERVER_RUNNING = "1";
  const result = f.run("start");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /already running on port 5100/);
  assert.match(result.stdout, /no graphical display; browser not opened/);
  assert.equal(fs.existsSync(f.env.BROWSER_CALLS), false);
});

test("start reports an early server crash and leaves its output in the log", (t) => {
  const f = fixture(t);
  f.env.SERVER_FAIL = "1";
  const result = f.run("start");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Server exited during startup.*server.log/);
  assert.doesNotMatch(result.stdout, /server started/);
  assert.match(fs.readFileSync(path.join(f.home, ".opencode/pixel-office/server.log"), "utf8"), /fixture server stderr/);
});
