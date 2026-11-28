import { defineHost } from './define.js';
import { linkDir, linkFile } from './fs.js';
import { POSIX_STOP, posixProcessDetails, posixShellenv, posixShimScript, signalTerminate } from './posix.js';

export const openharmony = defineHost({
  id: 'openharmony',
  label: 'HarmonyOS',
  posixSignals: true,
  exe: (name) => name,
  libInspector: () => null,
  linkDir: (target, link) => linkDir(target, link, 'dir'),
  linkFile,
  processDetails: (pid) => posixProcessDetails(pid, { proc: true }),
  terminate: signalTerminate,
  forceVerb: POSIX_STOP.forceVerb,
  killHint: POSIX_STOP.killHint,
  shimFileName: (bin) => bin,
  shimScript: posixShimScript,
  shellenv: posixShellenv,
  unitTarget: () => null,
});
