#!/usr/bin/env node
// marina — multi-engine database version & service manager.
const args = process.argv.slice(2);
// Login hooks run outside the shell which originally selected MARINA_HOME.
if (args[0]?.startsWith('--runtime-home=') && args[1] === 'start' && args[2] === '--autostart') {
  process.env.MARINA_HOME = args.shift().slice('--runtime-home='.length);
}

// Update can check the checkout without initializing a database runtime.
const command = args[0] === 'update'
  ? import('../src/update.js').then(({ runUpdate }) => runUpdate(args.slice(1)))
  : import('../src/cli.js').then(({ main }) => main(args));

command.catch((err) => {
  const msg = err && err.message ? err.message : String(err);
  if (process.env.MARINA_DEBUG) console.error(err);
  else console.error(`\x1b[31merror:\x1b[0m ${msg}`);
  process.exit(1);
});
