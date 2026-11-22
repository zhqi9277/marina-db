import fs from 'node:fs';
import path from 'node:path';
import { mkdirp } from '../core/paths.js';
import { findBin } from '../install/archive.js';
import { localHttpService } from './_local_http.js';

export default {
  ...localHttpService('milvus', 'Milvus', '3', 19530),
  configName: 'user.yaml',
  startTimeoutMs: 150000,
  stopTimeoutMs: 60000,

  renderConfig() {
    return [
      'common:',
      '  storageType: local',
      'mq:',
      '  type: woodpecker',
      'woodpecker:',
      '  storage:',
      '    type: local',
      '',
    ].join('\n');
  },

  async init(ctx) {
    mkdirp(ctx.dataDir);
    mkdirp(ctx.logDir);
  },

  startCommand(ctx) {
    const configs = path.join(ctx.root, 'configs');
    fs.copyFileSync(path.join(configs, 'milvus.yaml'), path.join(ctx.etcDir, 'milvus.yaml'));
    return {
      cmd: findBin(ctx.root, this.serverBin),
      args: ['run', 'standalone'],
      cwd: ctx.dataDir,
      env: {
        MILVUSCONF: ctx.etcDir,
        MARINA_MILVUS_RUN_DIR: path.join(ctx.dataDir, 'run'),
        DEPLOY_MODE: 'STANDALONE',
        PROXY_PORT: String(ctx.port),
        PROXY_IP: '127.0.0.1',
        METRICS_PORT: '0',
        ETCD_USE_EMBED: 'true',
        ETCD_DATA_DIR: path.join(ctx.dataDir, 'etcd'),
        ETCD_CONFIG_PATH: path.join(configs, 'marina-etcd.yaml'),
        LOCALSTORAGE_PATH: path.join(ctx.dataDir, 'storage'),
      },
      foreground: true,
      recordPid: true,
      logFile: ctx.logFile,
    };
  },

  async probe(ctx) {
    return this.httpReady(ctx, '/v2/vectordb/collections/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }, (result) => result.code === 0);
  },
};
