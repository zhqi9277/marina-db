// HTTP download with redirects, resume, sha256 verification and progress.
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { progress, info, warn } from './ui.js';

const MAX_REDIRECTS = 6;
// some mirrors (aliyun) answer 403 to non-browser user agents
const DEFAULT_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) marina/0.1',
  accept: '*/*',
};

function request(url, opts = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { headers: { ...DEFAULT_HEADERS, ...(opts.headers || {}) } }, (res) => {
      const { statusCode, headers } = res;
      if ([301, 302, 303, 307, 308].includes(statusCode) && headers.location) {
        res.resume();
        if (redirects >= MAX_REDIRECTS) return reject(new Error(`too many redirects for ${url}`));
        const next = new URL(headers.location, url).toString();
        return resolve(request(next, opts, redirects + 1));
      }
      if (statusCode !== 200 && statusCode !== 206) {
        res.resume();
        return reject(new Error(`HTTP ${statusCode} for ${url}`));
      }
      resolve(res);
    });
    req.on('error', reject);
    req.setTimeout(opts.timeout || 30000, () => req.destroy(new Error(`timeout: ${url}`)));
  });
}

export async function fetchText(url, { timeout = 20000 } = {}) {
  const res = await request(url, { timeout });
  const chunks = [];
  for await (const chunk of res) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export async function fetchJson(url, opts) {
  const text = await fetchText(url, opts);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`invalid JSON from ${url}: ${text.slice(0, 120)}`);
  }
}

export async function headSize(url) {
  try {
    const res = await request(url, { headers: { Range: 'bytes=0-0' }, timeout: 15000 });
    const range = res.headers['content-range'];
    res.resume();
    if (range && /\/(\d+)$/.test(range)) return Number(RegExp.$1);
    return Number(res.headers['content-length'] || 0) || null;
  } catch {
    return null;
  }
}

export async function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

/**
 * Download `url` to `dest`, verifying sha256 (when provided).
 * Resumes a previous `.part` file when the server supports ranges.
 */
export async function downloadFile(url, dest, { sha256, label = path.basename(dest), retries = 2 } = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  if (fs.existsSync(dest) && sha256) {
    const got = await sha256File(dest);
    if (got === sha256) {
      info(`${label} already in cache (sha256 ok)`);
      return dest;
    }
    fs.rmSync(dest, { force: true });
  }

  const part = `${dest}.part`;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let start = fs.existsSync(part) ? fs.statSync(part).size : 0;
    try {
      const total = (await headSize(url)) ?? 0;
      const headers = start > 0 ? { Range: `bytes=${start}-` } : {};
      const res = await request(url, { headers });
      const resumed = res.statusCode === 206 && start > 0;
      if (!resumed) start = 0;
      const bytes = Number(res.headers['content-length'] || 0);
      const totalBytes = total || bytes;
      const bar = progress(label, totalBytes);
      const stream = fs.createWriteStream(part, { flags: resumed ? 'a' : 'w' });
      let received = start;
      for await (const chunk of res) {
        received += chunk.length;
        if (!stream.write(chunk)) await new Promise((r) => stream.once('drain', r));
        bar.update(received);
      }
      await new Promise((resolve, reject) => stream.end((e) => (e ? reject(e) : resolve())));
      bar.done();

      if (sha256) {
        const got = await sha256File(part);
        if (got !== sha256) {
          fs.rmSync(part, { force: true });
          throw new Error(`sha256 mismatch for ${label}\n  expected ${sha256}\n  actual   ${got}`);
        }
      }
      fs.renameSync(part, dest);
      return dest;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) warn(`${label}: ${e.message} — retrying (${attempt + 2}/${retries + 1})`);
    }
  }
  throw lastErr;
}
