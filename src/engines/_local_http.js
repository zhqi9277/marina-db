import fs from 'node:fs';

export function localHttpService(key, label, defaultMajor, defaultPort) {
  return {
    key,
    label,
    kind: 'vector',
    manifestName: key,
    defaultMajor,
    defaultPort,
    markers: ['bin/' + key, key],
    serverBin: [key],
    clientBins: [],
    waitForProbe: true,
    managedAuth: false,

    endpoint(ctx) {
      return `http://127.0.0.1:${ctx.port}`;
    },

    account() {
      return { user: null, password: null, mode: 'config', note: 'authentication is managed in the engine configuration' };
    },

    readPid(ctx) {
      try {
        return Number(fs.readFileSync(ctx.pidFile, 'utf8').trim()) || null;
      } catch {
        return null;
      }
    },

    async httpReady(ctx, endpoint, options) {
      try {
        const response = await fetch(this.endpoint(ctx) + endpoint, {
          ...options,
          signal: AbortSignal.timeout(1000),
        });
        return response.ok;
      } catch {
        return false;
      }
    },
  };
}
