// One shape for every OS backend. Callers use this object and never branch on
// process.platform themselves.
import { matchesInstall } from './match.js';

export function defineHost(spec) {
  return {
    id: spec.id,
    label: spec.label,
    pathCaseInsensitive: !!spec.pathCaseInsensitive,
    capabilities: {
      unixSocket: !!spec.unixSocket,
      fork: !!spec.fork,
      posixSignals: !!spec.posixSignals,
    },
    exe: spec.exe,
    libInspector: spec.libInspector,
    linkDir: spec.linkDir,
    linkFile: spec.linkFile,
    processDetails: spec.processDetails,
    terminate: spec.terminate,
    forceVerb: spec.forceVerb,
    killHint: spec.killHint,
    matchesInstall(details, ctx) {
      return matchesInstall(details, ctx, { caseInsensitive: !!spec.pathCaseInsensitive });
    },
    shimFileName: spec.shimFileName,
    shimScript: spec.shimScript,
    shellenv: spec.shellenv,
    unitTarget: spec.unitTarget,
    renderUnit: spec.renderUnit,
    loadAutostart: spec.loadAutostart,
    unloadAutostart: spec.unloadAutostart,
    zipExtractArgs: spec.zipExtractArgs || (() => null),
  };
}
