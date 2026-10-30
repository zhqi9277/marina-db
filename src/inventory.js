// Shared inventory queries used by both the plain CLI and the TUI.
import { engineList, installedVersions, buildCtx } from './registry.js';
import { status } from './lifecycle.js';
import * as state from './state.js';

// Only one version per major line can run (same socket/port/config), so runtime
// state is probed once per major and other versions are reported as inactive.
export async function versionStatus(engine, v, activePick) {
  const anotherActiveInMajor = activePick && activePick.major === v.major && activePick.version !== v.version;
  if (anotherActiveInMajor) {
    const activeStat = await status(buildCtx(engine, activePick));
    return {
      ...activeStat,
      version: v.version,
      active: false,
      pid: null,
      state: activeStat.state === 'running' || activeStat.state === 'degraded' ? 'inactive' : activeStat.state,
    };
  }
  const st = await status(buildCtx(engine, v));
  return { ...st, version: v.version, active: !!(activePick && activePick.version === v.version) };
}

/** One row per installed (engine, version), enriched with live state. */
export async function collectRows() {
  const rows = [];
  for (const engine of engineList) {
    const versions = installedVersions(engine);
    if (!versions.length) continue;
    const activeVersion = state.getActive(engine.key);
    const activePick = activeVersion
      ? versions.find((v) => v.version === activeVersion)
      : versions[versions.length - 1];
    for (const v of versions) {
      const st = await versionStatus(engine, v, activePick);
      rows.push({ ...st, label: engine.label, major: v.major, engine, ctx: buildCtx(engine, v) });
    }
  }
  return rows;
}

/** Aggregate one row per engine (dashboard view). */
export async function collectEngines() {
  const rows = await collectRows();
  const byEngine = new Map();
  for (const row of rows) {
    const cur = byEngine.get(row.key);
    if (!cur) {
      byEngine.set(row.key, { ...row, versions: [row.version] });
    } else {
      cur.versions.push(row.version);
      if (row.active) Object.assign(cur, { ...row, versions: cur.versions });
    }
  }
  return engineList.map((engine) => {
    const hit = byEngine.get(engine.key) || null;
    const installed = installedVersions(engine);
    return {
      engine,
      key: engine.key,
      label: engine.label,
      installed: installed.map((v) => v.version),
      row: hit,
      version: hit ? hit.version : null,
      major: hit ? hit.major : null,
      port: hit ? hit.port : state.portOf(engine.key, engine.defaultMajor, engine.defaultPort),
      pid: hit ? hit.pid : null,
      state: hit ? hit.state : 'absent',
      ctx: hit ? hit.ctx : null,
    };
  });
}
