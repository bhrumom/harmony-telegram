import net from 'node:net';

const recentPorts = new Map();
const RECENT_TTL_MS = 15_000;

function pruneRecentPorts(now) {
  for (const [port, ts] of recentPorts.entries()) {
    if (now - ts > RECENT_TTL_MS) {
      recentPorts.delete(port);
    }
  }
}

function bindEphemeralOnce(host) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen({ host, port: 0, exclusive: true }, () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      srv.close((closeErr) => {
        if (closeErr) {
          reject(closeErr);
          return;
        }
        resolve(port);
      });
    });
  });
}

export async function allocateFreePort(host = '127.0.0.1') {
  const now = Date.now();
  pruneRecentPorts(now);

  for (let attempt = 0; attempt < 10; attempt++) {
    const port = await bindEphemeralOnce(host);
    if (port > 0 && !recentPorts.has(port)) {
      recentPorts.set(port, Date.now());
      return port;
    }
  }

  const fallbackPort = await bindEphemeralOnce(host);
  recentPorts.set(fallbackPort, Date.now());
  return fallbackPort;
}
