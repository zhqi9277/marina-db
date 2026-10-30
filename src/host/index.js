// JVM-style host: engines and lifecycle call this object. The running OS picks
// the backend. Pure helpers on the other backends stay importable for tests.
import { darwin } from './darwin.js';
import { linux } from './linux.js';
import { win32 } from './win32.js';

const HOSTS = { linux, darwin, win32 };

export { darwin, linux, win32 };

export function hostFor(id) {
  return HOSTS[id] || null;
}

export const host = HOSTS[process.platform];
