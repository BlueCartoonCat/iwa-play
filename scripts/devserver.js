// Development proxy for the IWA. AirPlay itself runs in the browser; this
// server only serves app files and discovers local IPv4 addresses for setup.
const http = require('node:http');
const { readFile, stat } = require('node:fs/promises');
const { networkInterfaces } = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..', 'app');
const port = Number(process.env.PORT || 8765);
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
};

// Browsers cannot enumerate interfaces themselves. Prefer private physical
// interfaces, but return all usable addresses so mDNS can advertise them.
function localInterfaces() {
  const result = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      const octets = address.address.split('.').map(Number);
      if (octets[0] === 0 || octets[0] >= 224 ||
          (octets[0] === 169 && octets[1] === 254)) continue;
      const isPrivate = octets[0] === 10 ||
        (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
        (octets[0] === 192 && octets[1] === 168);
      const isVirtual = /^(lo|utun|tun|tap|bridge|docker|veth)/i.test(name);
      result.push({ name, address: address.address, rank: (isPrivate ? 0 : 1) + (isVirtual ? 2 : 0) });
    }
  }
  return result.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
    .map(({ name, address }) => ({ name, address }));
}

http.createServer(async (request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self' blob: https:; connect-src 'self' https:; object-src 'none'; base-uri 'none'");
  response.setHeader('X-Content-Type-Options', 'nosniff');

  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (request.method === 'GET' && pathname === '/__network/interfaces') {
      response.setHeader('Cache-Control', 'no-store');
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(localInterfaces()));
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end();
      return;
    }

    const filename = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!filename.startsWith(root + path.sep) || !(await stat(filename)).isFile()) {
      throw new Error('File not found');
    }
    response.writeHead(200, {
      'Content-Type': contentTypes[path.extname(filename)] || 'application/octet-stream',
    });
    response.end(request.method === 'HEAD' ? undefined : await readFile(filename));
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`IWA development proxy: http://localhost:${port}/`);
});
