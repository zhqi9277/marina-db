#!/usr/bin/env node
// marina — multi-engine database version & service manager.
const args = process.argv.slice(2);
// Login hooks run outside the shell which originally selected MARINA_HOME.
if (args[0]?.startsWith('--runtime-home=') && args[1] === 'start' && args[2] === '--autostart') {
  process.env.MARINA_HOME = args.shift().slice('--runtime-home='.length);
}

import('../src/cli.js').then(({ main }) => main(args)).catch((err) => {
  const msg = err && err.message ? err.message : String(err);
  if (process.env.MARINA_DEBUG) console.error(err);
  else console.error(`\x1b[31merror:\x1b[0m ${msg}`);
  process.exit(1);
});
