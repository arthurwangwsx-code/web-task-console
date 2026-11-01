import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const publicRoot = new URL('../public/', import.meta.url);
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
const MAX_BODY = 64 * 1024;
function fail(status, message) { return Object.assign(new Error(message), { status }); }
function equal(a, b) {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
async function readJSON(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw fail(415, '请求必须使用 application/json');
  if (Number(req.headers['content-length']) > MAX_BODY) throw fail(413, '请求内容过大');
  const parts = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw fail(413, '请求内容过大');
    parts.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw fail(400, '无效 JSON 对象'); }
}

/** Local-only synthetic console. No browser credentials or external transport. */
export async function startServer({ port = 4173, dataDir = resolve('.data'), runtime: injected } = {}) {
  if (!Number.isInteger(Number(port)) || Number(port) < 0 || Number(port) > 65535) throw fail(400, '无效端口');
  const runtime = injected ?? await (await import('./runtime.mjs')).createRuntime({ dataDir });
  const { engine, adapter } = runtime;
  const csrf = randomBytes(32).toString('hex');
  let origin;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    const send = (status, value) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value ?? { ok: true }));
    };
    try {
      if (req.headers.host !== new URL(origin).host) throw fail(403, '主机不在本地许可范围');
      if (req.headers.origin && req.headers.origin !== origin) throw fail(403, '拒绝跨来源请求');
      if (req.headers['sec-fetch-site'] === 'cross-site') throw fail(403, '拒绝跨站点请求');
      if (!req.url?.startsWith('/') || req.url.includes('\\') || req.url.includes('%')) throw fail(400, '无效路径');
      const url = new URL(req.url, origin);
      if (url.origin !== origin) throw fail(403, '拒绝跨来源目标');
      const route = url.pathname;
      if (req.method === 'GET') {
        if (route === '/api/bootstrap') return send(200, { csrfToken: csrf, mode: 'synthetic-demo', origin });
        if (route === '/api/state') return send(200, await engine.snapshot());
        const asset = assets.get(route);
        if (!asset) throw fail(404, '未找到');
        const body = await readFile(new URL(asset[0], publicRoot));
        res.writeHead(200, { 'Content-Type': asset[1] }); return res.end(body);
      }
      if (req.method !== 'POST') throw fail(405, '不支持的请求方法');
      if (req.headers.origin !== origin || !equal(req.headers['x-console-token'], csrf)) throw fail(403, '缺少同源控制授权；请刷新控制台');
      const body = await readJSON(req);
      if (route === '/api/intents') {
        if (typeof body.prompt !== 'string' || typeof body.idempotencyKey !== 'string') throw fail(400, '请输入任务内容和幂等键');
        return send(201, await engine.enqueue({ prompt: body.prompt, idempotencyKey: body.idempotencyKey }));
      }
      if (route === '/api/tick') return send(200, await engine.tick());
      if (route === '/api/pause') {
        if (typeof body.paused !== 'boolean') throw fail(400, 'paused 必须为布尔值');
        return send(200, await engine.setPaused(body.paused));
      }
      if (route === '/api/scenario') {
        if (!['success', 'lost-ack', 'router-only', 'provider-failure'].includes(body.scenario)) throw fail(400, '未知合成场景');
        if (typeof adapter.setScenario !== 'function') throw fail(409, '当前适配器不支持合成场景');
        await adapter.setScenario(body.scenario); return send(200, { scenario: body.scenario });
      }
      const intentMatch = route.match(/^\/api\/intents\/([A-Za-z0-9_-]+)\/(reconcile|cancel)$/);
      if (intentMatch) return send(200, await engine[intentMatch[2] === 'reconcile' ? 'reconcile' : 'cancelQueued'](intentMatch[1]));
      const tabMatch = route.match(/^\/api\/tabs\/([A-Za-z0-9_-]+)\/close$/);
      if (tabMatch) return send(200, await engine.closeTab(tabMatch[1]));
      throw fail(404, '未找到');
    } catch (error) {
      send(error.status ?? error.statusCode ?? 409, { error: error.message ?? '请求失败', code: error.code ?? 'REQUEST_REJECTED' });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  try {
    await new Promise((done, reject) => {
      server.once('error', reject);
      server.listen(Number(port), '127.0.0.1', () => { server.off('error', reject); done(); });
    });
  } catch (error) { await runtime.close?.(); throw error; }
  origin = `http://127.0.0.1:${server.address().port}`;
  let closing;
  return { server, runtime, origin, close() {
    closing ??= (async () => {
      await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
      await runtime.close?.();
    })();
    return closing;
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = await startServer({ port: Number(process.env.PORT ?? process.argv[2] ?? 4173), dataDir: resolve(process.env.CONSOLE_DATA_DIR ?? '.data') });
  console.log(`Web Task Console — synthetic demo only\n${app.origin}\nPress Ctrl+C to stop. No external tasks are sent.`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close().then(() => process.exit(0), error => { console.error(error.message); process.exit(1); }));
}
