// Shared inventory queries used by both the plain CLI and the TUI.
import { engineList, installedVersions, buildCtx } from '../core/registry.js';
import { status } from './lifecycle.js';
import * as state from '../core/state.js';

function versionRow(st, version, activePick) {
  const inactive = st.runningVersion && st.runningVersion !== version;
  return {
    ...st,
    version,
    active: activePick?.version === version,
    pid: inactive ? null : st.pid,
    state: inactive ? 'inactive' : st.state,
    healthy: !inactive && st.healthy,
    instanceState: st.state,
    instancePid: st.pid,
  };
}

export async function versionStatus(engine, v, activePick) {
  const st = await status(buildCtx(engine, v), { instance: true });
  return versionRow(st, v.version, activePick);
}

/** One row per installed (engine, version), enriched with live state. */
export async function collectRows() {
  const rows = [];
  for (const engine of engineList) {
    const versions = installedVersions(engine);
    if (!versions.length) continue;
    const activeVersion = state.getActive(engine.key);
    const activePick = versions.find((v) => v.version === activeVersion) || versions.at(-1);
    const contexts = new Map();
    const rowsForEngine = versions.map((v) => {
      const existing = contexts.get(v.major);
      const ctx = buildCtx(engine, { ...v, port: existing?.port, account: existing?.account });
      if (!existing) contexts.set(v.major, ctx);
      return ctx;
    });
    const instances = new Map();
    for (const ctx of rowsForEngine) {
      if (!instances.has(ctx.major)) instances.set(ctx.major, await status(ctx, { instance: true }));
      rows.push({ ...versionRow(instances.get(ctx.major), ctx.version, activePick), engine, ctx });
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
    return {
      engine,
      key: engine.key,
      label: engine.label,
      installed: hit?.versions || [],
      row: hit,
      version: hit ? hit.version : null,
      major: hit ? hit.major : null,
      port: hit ? hit.port : state.portOf(engine.key, engine.defaultMajor, engine.defaultPort),
      pid: hit ? hit.pid : null,
      runningVersion: hit?.runningVersion || null,
      instanceState: hit?.instanceState || 'absent',
      instancePid: hit?.instancePid || null,
      state: hit ? hit.state : 'absent',
      ctx: hit ? hit.ctx : null,
    };
  });
}
