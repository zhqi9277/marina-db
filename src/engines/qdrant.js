import { mkdirp } from '../core/paths.js';
import { findBin } from '../install/archive.js';
import { localHttpService } from './_local_http.js';

export default {
  ...localHttpService('qdrant', 'Qdrant', '1', 6333),
  configName: 'qdrant.yaml',

  renderConfig() {
    return [
      'service:',
      '  host: 127.0.0.1',
      '  grpc_port: null',
      'telemetry_disabled: true',
      '',
    ].join('\n');
  },

  async init(ctx) {
    mkdirp(ctx.dataDir);
    mkdirp(ctx.logDir);
  },

  startCommand(ctx) {
    return {
      cmd: findBin(ctx.root, this.serverBin),
      args: ['--config-path', ctx.confFile],
      cwd: ctx.dataDir,
      env: { QDRANT__SERVICE__HTTP_PORT: String(ctx.port), QDRANT__SERVICE__HOST: '127.0.0.1' },
      foreground: true,
      recordPid: true,
      logFile: ctx.logFile,
    };
  },

  async probe(ctx) {
    return this.httpReady(ctx, '/readyz');
  },
};
