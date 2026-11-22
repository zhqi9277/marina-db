// Serialize writes to the config, data and runtime files shared by a version line.
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirp, runFile } from '../core/paths.js';

const held = new AsyncLocalStorage();

function acquire(file, staging) {
  for (;;) {
    let renameError;
    try {
      fs.renameSync(staging, file);
      return true;
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error;
      renameError = error;
    }

    let entries;
    try { entries = fs.readdirSync(file); } catch (error) {
      if (error.code === 'ENOENT' && renameError.code !== 'EPERM') continue;
      if (error.code === 'ENOENT') throw renameError;
      throw error;
    }
    const ownerFile = entries.find((entry) => /^pid-\d+$/.test(entry));
    if (!ownerFile && entries.length) return false;
    const owner = Number(ownerFile?.slice(4));
    if (Number.isSafeInteger(owner) && owner > 0) {
      try {
        process.kill(owner, 0);
        return false;
      } catch (error) {
        if (error.code !== 'ESRCH') return false;
      }
    }
    // Remove the old owner file first. rmdir cannot delete a new owner's file.
    try {
      if (ownerFile) fs.unlinkSync(path.join(file, ownerFile));
      fs.rmdirSync(file);
    } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error;
    }
  }
}

export async function withInstanceLock({ key, major }, action) {
  const file = runFile(key, major, 'lock');
  const inherited = held.getStore();
  if (inherited?.has(file)) return action();
  mkdirp(path.dirname(file));
  const staging = fs.mkdtempSync(`${file}-`);
  try {
    fs.writeFileSync(path.join(staging, `pid-${process.pid}`), '');
    if (!acquire(file, staging)) throw new Error(`${key}@${major} is busy — another marina command is changing this instance`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  try {
    return await held.run(new Set([...(inherited || []), file]), action);
  } finally {
    fs.rmSync(file, { recursive: true, force: true });
  }
}
