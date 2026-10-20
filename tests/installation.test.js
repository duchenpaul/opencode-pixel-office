import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));

const fixture = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pixel-office-package-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.copyFileSync(path.join(root, "package.json"), path.join(dir, "package.json"));
  return dir;
};

const serverFixture = (t) => {
  const dir = fixture(t);
  fs.mkdirSync(path.join(dir, "server"));
  fs.copyFileSync(path.join(root, "server/index.ts"), path.join(dir, "server/index.ts"));
  fs.copyFileSync(path.join(root, "server/activity.ts"), path.join(dir, "server/activity.ts"));
  fs.symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"), "dir");
  return dir;
};

const startServer = (t, dir) => {
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "server/index.ts"], {
    cwd: dir,
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, "exit");
    }
  });
  return { child, output: () => output };
};

test("server exits with build instructions when the client is missing", async (t) => {
  const dir = serverFixture(t);
  const server = startServer(t, dir);
  const [code] = await once(server.child, "exit");
  assert.equal(code, 1, server.output());
  assert.match(server.output(), /client bundle missing.*npm run build:client/);
  assert.doesNotMatch(server.output(), /Server Running/);
});

test("server serves the built dashboard first and supports the source client fallback", async (t) => {
  for (const built of [true, false]) {
    await t.test(built ? "built client" : "source client", async (t) => {
      const dir = serverFixture(t);
      fs.mkdirSync(path.join(dir, "client"), { recursive: true });
      fs.writeFileSync(path.join(dir, "client/index.html"), "<!doctype html>\nsource client");
      if (built) {
        fs.mkdirSync(path.join(dir, "client/dist"));
        fs.writeFileSync(path.join(dir, "client/dist/index.html"), "<!doctype html>\nbuilt client");
      }
      const server = startServer(t, dir);
      for (let attempt = 0; !server.output().match(/Local:.*:(\d+)/) && attempt < 100; attempt++) {
        if (server.child.exitCode !== null) assert.fail(server.output());
        await delay(50);
      }
      const port = server.output().match(/Local:.*:(\d+)/)?.[1];
      assert.ok(port && port !== "0", server.output());
      const response = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), `<!doctype html>\n${built ? "built" : "source"} client`);
    });
  }
});

test("Hermes manifest version follows package.json during builds and version bumps", (t) => {
  const dir = fixture(t);
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.mkdirSync(path.join(dir, "plugin/hermes"), { recursive: true });
  const script = path.join(dir, "scripts/sync-hermes-version.js");
  fs.copyFileSync(path.join(root, "scripts/sync-hermes-version.js"), script);
  const manifest = path.join(dir, "plugin/hermes/plugin.yaml");
  fs.copyFileSync(path.join(root, "plugin/hermes/plugin.yaml"), manifest);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  assert.match(fs.readFileSync(manifest, "utf8"), new RegExp(`^version: "${pkg.version.replaceAll(".", "\\.")}"$`, "m"));
  assert.equal(pkg.scripts["prebuild:client"], "node scripts/sync-hermes-version.js");
  assert.equal(pkg.scripts.version, "node scripts/sync-hermes-version.js");
  assert.equal(pkg.scripts.prepare, undefined);
  assert.equal(pkg.scripts.prepublishOnly, "npm run build:client");
  pkg.version = "9.8.7";
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
  let result = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(manifest, "utf8"), /^version: "9\.8\.7"$/m);
  fs.writeFileSync(manifest, "name: opencode-pixel-office\n");
  result = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing its version field/);
});
