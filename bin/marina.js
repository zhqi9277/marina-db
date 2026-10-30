#!/usr/bin/env node
// marina — multi-engine database version & service manager.
// When dist/rootfs.img is present, commands run inside the kernel guest.
import { main } from '../src/cli.js';
import { maybeEnterGuest } from '../src/kernel-guest.js';

const guestCode = await maybeEnterGuest(process.argv.slice(2));
if (guestCode !== null) process.exit(guestCode);

main(process.argv.slice(2)).catch((err) => {
  const msg = err && err.message ? err.message : String(err);
  if (process.env.MARINA_DEBUG) console.error(err);
  else console.error(`\x1b[31merror:\x1b[0m ${msg}`);
  process.exit(1);
});
