import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseCatalog } from '../src/install/overlay.js';
import { readLiveVersions, summarizeHistory } from './engine-history.mjs';
import { engineTargets, parseBuildMatrix } from './engine-matrix.mjs';
import { sourcesFor } from './engine-sources.mjs';
import { prepareBatch } from './prepare-engine-batch.mjs';

const compare = (a, b) => a.localeCompare(b, 'en', { numeric: true });
const series = (engine, version) => version.split('.').slice(0, engine === 'postgres' ? 1 : 2).join('.');
const platformOf = ({ os, arch }) => os + '-' + arch;
const buildName = (engine, version, platform) => 'engine-' + [engine, version, platform].join('-');
const BUILD_LIMIT = 256;

function newestBySeries(engine, versions) {
  const newest = new Map();
  for (const version of versions) {
    const line = series(engine, version);
    const previous = newest.get(line);
    if (!previous || compare(version, previous) > 0) newest.set(line, version);
  }
  return newest;
}

export function incrementalCandidates(engine, upstream, published, snapshotVersions) {
  const installed = parseCatalog(published, { requireSize: true }).filter((row) => row.key === engine);
  const released = newestBySeries(engine, installed.map((row) => row.version));
  const known = newestBySeries(engine, snapshotVersions);
  const newestPublished = [...released.values()].sort(compare).at(-1);
  const newestKnown = [...known.values()].sort(compare).at(-1);
  const { versions } = summarizeHistory({ [engine]: upstream }, published)[engine];
  return versions.filter(({ version, pendingTargets }, index) => {
    if (!pendingTargets.length) return false;
    const line = series(engine, version);
    const lastReleased = released.get(line);
    if (lastReleased) return compare(version, lastReleased) >= 0;
    const lastKnown = known.get(line) ?? newestKnown;
    // Also offer the current upstream release when starting from an old catalog.
    return !lastKnown || compare(version, lastKnown) > 0 ||
      (index === 0 && (!newestPublished || compare(version, newestPublished) > 0));
  });
}

function activeBuilds(engine) {
  const { GITHUB_REPOSITORY, GITHUB_REF_NAME } = process.env;
  const repo = 'repos/' + GITHUB_REPOSITORY + '/actions';
  const since = new Date(Date.now() - 8 * 86400000).toISOString();
  const gh = (...args) => execFileSync('gh', ['api', '--paginate', ...args], { encoding: 'utf8' }).trim();
  const runs = gh('--method', 'GET', repo + '/workflows/build-engines.yml/runs',
    '-f', 'branch=' + GITHUB_REF_NAME, '-f', 'status=success', '-f', 'created=>=' + since,
    '-f', 'per_page=100', '--jq', '.workflow_runs[].id');
  const builds = new Map();
  for (const run of runs.split(/\s+/).filter(Boolean)) {
    const assets = new Set(gh(repo + '/runs/' + run + '/artifacts?per_page=100',
      '--jq', '.artifacts[] | select(.expired == false) | .name').split(/\s+/));
    if (!assets.has('locked-plan')) continue;
    for (const name of assets) {
      if (name.startsWith('engine-' + engine + '-') && assets.has('validated-' + name) && !builds.has(name)) {
        builds.set(name, run);
      }
    }
  }
  return builds;
}

async function main(engine, catalogFile, planFile, targetsInput = '') {
  const selectedPlatforms = targetsInput.split(',').map((target) => target.trim()).filter(Boolean);
  if (selectedPlatforms.some((platform) => !engineTargets(engine).some((target) => platformOf(target) === platform))) {
    throw new Error('unknown build target');
  }
  const published = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
  const snapshot = JSON.parse(fs.readFileSync(new URL('./engine-history.snapshot.json', import.meta.url), 'utf8'));
  const candidates = incrementalCandidates(engine, await readLiveVersions(engine), published, snapshot.versions[engine]);
  const active = candidates.length ? activeBuilds(engine) : new Map();
  const readyRuns = new Set();
  const plan = [];
  let lookupFailure;
  for (const { version, pendingTargets } of candidates) {
    const needed = pendingTargets.filter((platform) => {
      if (selectedPlatforms.length && !selectedPlatforms.includes(platform)) return false;
      const run = active.get(buildName(engine, version, platform));
      if (run) readyRuns.add(run);
      return !run;
    });
    if (!needed.length) continue;
    if (plan.length + needed.length > BUILD_LIMIT) break;
    const { rows, omitted } = await prepareBatch(engine, version, needed);
    plan.push(...rows);
    for (const { target, state, reason } of omitted) {
      const message = [engine, version, target, state, reason].join(' ');
      console.error(message);
      if (state === 'lookup-error') lookupFailure ??= message;
    }
  }
  const summary = [
    'Scheduled ' + plan.length + ' new ' + engine + ' builds.',
    ...[...readyRuns].map((run) => 'Validated artifacts already available in run ' + run + '.'),
  ].join('\n') + '\n';
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  console.error(summary.trim());
  if (!plan.length && lookupFailure) throw new Error(lookupFailure);
  for (const row of plan) sourcesFor(row);
  fs.writeFileSync(planFile, JSON.stringify(plan.length ? parseBuildMatrix(plan) : []) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(...process.argv.slice(2));
}
