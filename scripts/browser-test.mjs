/** Local SYNTHETIC browser only. Never attaches to an existing authenticated profile. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.mjs';
import { BrowserAdapter } from '../src/browser-adapter.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const dataDir = await mkdtemp(join(tmpdir(), 'web-console-browser-'));
const app = await startServer({ port: 0, dataDir });
let browser;
try {
  browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setViewportSize({ width: 1440, height: 1100 });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(app.origin);
  await page.locator('#connection').filter({ hasText: '本地连接正常' }).waitFor();
  const multiline = 'synthetic first line\nsecond line\n第三行';
  await page.locator('#key').fill('browser-lost-ack'); await page.locator('#prompt').fill(multiline);
  await page.locator('#scenario').selectOption('lost-ack');
  await page.getByRole('button', { name: '仅加入队列' }).click();
  await page.locator('.intent').waitFor();
  assert.equal(app.runtime.adapter.state.sends, 0);
  assert.equal(app.runtime.engine.snapshot().intents[0].prompt, multiline);
  await page.getByRole('button', { name: '推进一步' }).click();
  await page.locator('#unknown-warning').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: '受保护关闭' }).click();
  await page.locator('#error').filter({ hasText: 'TAB_PROTECTED' }).waitFor();
  await page.reload(); await page.locator('#unknown-warning').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: '推进一步' }).click(); assert.equal(app.runtime.adapter.state.sends, 1);
  await page.getByRole('button', { name: '只读回查' }).click();
  await page.locator('.state-value').filter({ hasText: /^succeeded$/ }).waitFor();
  await page.getByRole('button', { name: '受保护关闭' }).click();
  await page.locator('#metric-tabs').filter({ hasText: /^0$/ }).waitFor();
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'artifacts/mobile.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);

  // An isolated synthetic DOM fixture exercises real multiline fill/readback/click.
  // No ChatGPT selectors, credentials, network endpoints, or real tasks are used.
  let fixturePage, documentId = 'fixture-document-1', clicks = 0;
  const driver = {
    async openTab({ url }) { fixturePage = await context.newPage(); await fixturePage.goto(url); await fixturePage.setContent('<label>Prompt<textarea id="composer"></textarea></label><button id="send">Synthetic send</button>'); return { tabId: 'synthetic-tab', url, documentId }; },
    async readTab() { return { tabId: 'synthetic-tab', url: fixturePage.url(), documentId }; },
    async fillComposer({ text }) { await fixturePage.locator('#composer').fill(text); },
    async readComposer() { return fixturePage.locator('#composer').inputValue(); },
    async clickSend() { await fixturePage.locator('#send').click(); clicks++; },
    async observeAck() { throw new Error('Synthetic lost ACK'); },
    async closeTab() { await fixturePage.close(); },
  };
  const bridge = new BrowserAdapter({ driver, allowedOrigins: [app.origin] });
  const handle = await bridge.openOwned({ url: `${app.origin}/`, ownerId: 'synthetic-owner' });
  const payload = { ...handle, origin: app.origin, prompt: multiline, idempotencyKey: 'fixture-key' };
  assert.equal((await bridge.sendOnce(payload)).state, 'unknown');
  assert.equal(await fixturePage.locator('#composer').inputValue(), multiline);
  await bridge.sendOnce(payload); assert.equal(clicks, 1);
  await fixturePage.reload(); documentId = 'fixture-document-2';
  await assert.rejects(bridge.sendOnce({ ...payload, idempotencyKey: 'after-refresh' }), /navigated|Document/);
  assert.equal(clicks, 1);
  await context.close();
  console.log('PASS: real synthetic Chromium UI, multiline input, lost ACK once, refresh, unknown protection, provider recovery, owned close, mobile layout. No real platform tested.');
} finally { await browser?.close(); await app.close(); await rm(dataDir, { recursive: true, force: true }); }
