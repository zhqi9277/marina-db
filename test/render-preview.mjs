// Render the TUI headlessly (no pty) so layout can be checked in CI / sandbox.
// usage: node test/render-preview.mjs [cols] [rows] [mode]
import { App } from '../src/tui/app.js';

const cols = Number(process.argv[2] || 100);
const rows = Number(process.argv[3] || 30);
const mode = process.argv[4] || 'detail';

const fake = { cols, rows, lines: [], onResize: null, draw(l) { this.lines = l; } };
const app = new App(fake);
await app.refresh();
if (mode !== 'detail') {
  app.mode = mode;
  if (mode === 'actions') app.actionSel = 0;
  if (mode === 'versions') {
    app.versionSel = 0;
    // deterministic, offline rendering check
    app.remote = {
      loading: false,
      source: 'fixture',
      versions: [
        { version: '8.4.11', kind: 'binary', source: 'upstream', supported: true, urls: ['u'] },
        { version: '8.0.29', kind: 'binary', source: 'huawei', supported: true, urls: ['u'] },
        { version: '8.0.25', kind: 'binary', source: 'aliyun', supported: false, urls: [] },
      ],
    };
  }
  if (mode === 'logs') app.loadLogs();
  if (mode === 'doctor') {
    app.doctor = [
      { name: 'platform', value: 'macOS arm64', ok: true },
      { name: 'index', value: '6 engines cached', ok: true },
      { name: 'ports', value: 'no foreign listeners', ok: true },
    ];
    app.doctorAt = Date.now();
  }
}
app.render();

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const out = fake.lines.map(strip);
console.log(out.join('\n'));

let bad = 0;
fake.lines.forEach((line, i) => {
  const w = strip(line).length;
  if (w !== cols) {
    bad++;
    console.error(`line ${i + 1}: width ${w} != ${cols}`);
  }
});
console.error(`\n[check] ${fake.lines.length} lines, ${bad} width mismatch, cols=${cols} rows=${rows}`);
process.exit(bad ? 1 : 0);
