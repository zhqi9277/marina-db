// Prepare independently deployable batches and record unavailable inputs.
// Reruns resume from existing locked targets and retry missing ones.
import fs from 'node:fs';
import path from 'node:path';
import { parseBuildMatrix } from './engine-matrix.mjs';
import { sourcesFor } from './engine-sources.mjs';
import { prepareBatch } from './prepare-engine-batch.mjs';

const [inventory, outDir, engine, offsetArg = '0', limitArg] = process.argv.slice(2);
const offset = Number(offsetArg);
const limit = limitArg == null ? Infinity : Number(limitArg);
if (!inventory || !outDir || !/^[a-z]+$/.test(engine || '') || !Number.isSafeInteger(offset) ||
    offset < 0 || !(limit > 0) || (limit !== Infinity && !Number.isSafeInteger(limit))) {
  throw new Error('usage: prepare-engine-history.mjs <inventory.json> <output directory> <engine> [offset] [count]');
}
const history = JSON.parse(fs.readFileSync(inventory, 'utf8')).history?.[engine]?.versions;
if (!Array.isArray(history)) throw new Error('inventory has no ' + engine + ' history');
const remaining = history.slice(offset, offset + limit).filter((row) => row.pendingTargets?.length);
fs.mkdirSync(outDir, { recursive: true });
const report = path.join(outDir, engine + '-results.jsonl');

async function prepare(row) {
  const { version, pendingTargets } = row;
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(version)) throw new Error('invalid inventory version: ' + version);
  const key = engine + '-' + version.replaceAll('.', '-');
  const file = path.join(outDir, key + '.json');
  let existing = [];
  if (fs.existsSync(file)) {
    existing = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const entry of parseBuildMatrix(existing)) {
      if (entry.engine !== engine || entry.version !== version) throw new Error('unexpected target in ' + file);
      sourcesFor(entry);
    }
  }
  const needed = pendingTargets.filter((target) => !existing.some((row) => row.os + '-' + row.arch === target));
  if (!needed.length) return;
  const { rows, omitted } = await prepareBatch(engine, version, needed);
  if (rows.length) {
    const plan = [...existing, ...rows];
    for (const entry of parseBuildMatrix(plan)) sourcesFor(entry);
    const temp = file + '.' + process.pid + '.tmp';
    try {
      fs.writeFileSync(temp, JSON.stringify(plan, null, 2) + '\n');
      fs.renameSync(temp, file);
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }
  fs.appendFileSync(report, JSON.stringify({
    version,
    preparedTargets: rows.map((row) => row.os + '-' + row.arch),
    omitted,
  }) + '\n');
  console.log(engine + '@' + version + ' prepared ' + rows.length + ' / ' + needed.length + ' targets');
}

let next = 0;
const workers = Array.from({ length: 2 }, async () => {
  while (next < remaining.length) await prepare(remaining[next++]);
});
await Promise.all(workers);
