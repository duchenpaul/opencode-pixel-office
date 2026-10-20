import fs from "node:fs";

const { version } = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const manifestPath = new URL("../plugin/hermes/plugin.yaml", import.meta.url);
const manifest = fs.readFileSync(manifestPath, "utf8");
const versionLine = /^version:.*$/m;

if (!versionLine.test(manifest)) {
  throw new Error("Hermes plugin manifest is missing its version field");
}

fs.writeFileSync(manifestPath, manifest.replace(versionLine, `version: "${version}"`));
