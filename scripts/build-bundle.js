// Build only the public application resources; never package the signing key,
// development server, dependencies, or arbitrary files from the project.
const { readFile, writeFile } = require("node:fs/promises");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const appRoot = path.join(root, "app");
const resources = [
  ["/", "index.html", "text/html; charset=utf-8"],
  ["/index.html", "index.html", "text/html; charset=utf-8"],
  ["/.well-known/manifest.webmanifest", ".well-known/manifest.webmanifest", "application/manifest+json"],
  ["/app.css", "app.css", "text/css; charset=utf-8"],
  ["/app.js", "app.js", "text/javascript; charset=utf-8"],
  ["/airplay.js", "airplay.js", "text/javascript; charset=utf-8"],
  ["/icons/icon-192.png", "icons/icon-192.png", "image/png"],
  ["/icons/icon-512.png", "icons/icon-512.png", "image/png"],
  ["/LICENSE", "LICENSE", "text/plain; charset=utf-8"],
];

async function main() {
  const [outputFile = "iwaplay.swbn", ...extra] = process.argv.slice(2);
  const encodedKey = process.env.IWAPLAY_SIGNING_KEY_BASE64;
  const version = process.env.IWA_VERSION || "1.0.0";
  if (!encodedKey || extra.length) {
    throw new Error("Set IWAPLAY_SIGNING_KEY_BASE64 and run: node scripts/build-bundle.js [output.swbn]");
  }
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error("IWA_VERSION must be a numeric version like 1.2.3");
  }

  const { BundleBuilder } = await import("wbn");
  const { parsePemKey, WebBundleId, SignedWebBundle, NodeCryptoSigningStrategy } = await import("wbn-sign");
  const key = parsePemKey(Buffer.from(encodedKey, "base64").toString("utf8"));
  const origin = new WebBundleId(key).serializeWithIsolatedWebAppOrigin().replace(/\/$/, "");
  const builder = new BundleBuilder();

  for (const [url, file, contentType] of resources) {
    let body = await readFile(path.join(file === "LICENSE" ? root : appRoot, file));
    if (file === ".well-known/manifest.webmanifest") {
      // Version the packaged manifest without modifying the working tree.
      const manifest = JSON.parse(body.toString("utf8"));
      manifest.version = version;
      body = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
    }
    builder.addExchange(origin + url, 200, {
      "content-type": contentType,
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "require-corp",
      "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self' blob: https:; connect-src 'self' https:; object-src 'none'; base-uri 'none'",
      "x-content-type-options": "nosniff",
    }, body);
  }

  const signed = await SignedWebBundle.fromWebBundle(
    builder.createBundle(),
    [new NodeCryptoSigningStrategy(key)],
  );
  // Never silently replace an existing bundle or a private key.
  await writeFile(path.resolve(outputFile), signed.getSignedWebBundleBytes(), { flag: "wx" });
  console.log(`Signed bundle: ${path.resolve(outputFile)}`);
  console.log(`IWA origin: ${origin}`);
  console.log(`IWA version: ${version}`);
}

main().catch((error) => {
  console.error(`Bundle build failed: ${error.message}`);
  process.exitCode = 1;
});
