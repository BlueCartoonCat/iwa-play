// Update an IWA update manifest while preserving previously published versions.
const fs = require("node:fs");
const path = require("node:path");

const [filename, version, source] = process.argv.slice(2);
if (!filename || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version || "") || !source) {
  throw new Error("Usage: node update-manifest.js <file> <version> <https-bundle-url>");
}
const url = new URL(source);
if (url.protocol !== "https:") throw new Error("Bundle URL must use HTTPS");
const target = path.resolve(filename);
const manifest = fs.existsSync(target)
  ? JSON.parse(fs.readFileSync(target, "utf8"))
  : { versions: [] };
if (!Array.isArray(manifest.versions)) throw new Error("Invalid update manifest: versions must be an array");
const existing = manifest.versions.find((entry) => entry.version === version);
if (existing) {
  if (existing.src !== url.href) throw new Error(`Version ${version} already points to another bundle`);
  console.log(`Version ${version} is already present`);
  process.exit(0);
}
manifest.versions.push({ version, src: url.href });
fs.writeFileSync(target, JSON.stringify(manifest, null, 2) + "\n");
