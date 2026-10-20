import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../bin/opencode-pixel-office.js", import.meta.url));

const fixture = (t, hermes = true) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pixel-office-test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  const executable = (name, body) => {
    fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\n${body}`, { mode: 0o755 });
  };
  executable("npm", "process.exit(0)");
  executable("lsof", "process.exit(1)");
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
  };
  const plugin = path.join(env.HERMES_HOME, "plugins", "opencode-pixel-office");
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], {
    env, encoding: "utf8", timeout: 30000,
  });
  const calls = () => fs.readFileSync(env.HERMES_CALLS, "utf8").trim().split("\n").map(JSON.parse);
  return { home, env, plugin, run, calls };
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
