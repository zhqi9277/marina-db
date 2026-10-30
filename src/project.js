// Project-level pins: one .marinarc JSON file, one entry per database.
import fs from 'node:fs';
import path from 'node:path';

export const PROJECT_FILE = '.marinarc';

export function findProjectFile(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, PROJECT_FILE);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function readProject(file = findProjectFile()) {
  if (!file) return null;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${file}: ${e.message}`);
  }
  // `.marinarc` is an object of pins; null/array/string would make the callers
  // (Object.entries) crash with a confusing TypeError
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${file}: expected a JSON object of pins`);
  }
  return { file, pins: raw };
}
