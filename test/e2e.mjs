// 実際の Chromium に拡張機能を読み込んで動かす E2E テスト。
//
//   npm install --no-save playwright && npx playwright install chromium
//   npm run test:e2e
//
// 検証すること:
//   1. 拡張機能が読み込まれ、service worker がエラーなく起動する
//   2. 設定画面の「テスト表示」でその場にトーストが出る
//      （設定画面は chrome-extension:// のためスクリプトを注入できず、
//        service worker 経由で出そうとすると何も起きない）
//   3. 新着があると、いま見ているウェブページにトーストが出てバッジが更新される
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const repo = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-toast-e2e-'));

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><meta charset="utf-8"><title>テスト用ページ</title><h1>ふつうのウェブページ</h1>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const siteUrl = `http://127.0.0.1:${server.address().port}/`;

const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', // 拡張機能は headless shell では読み込めない
  headless: true,
  viewport: { width: 900, height: 600 },
  args: [`--disable-extensions-except=${repo}`, `--load-extension=${repo}`]
});

let failed = false;
try {
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  const swErrors = [];
  sw.on('console', (m) => { if (m.type() === 'error') swErrors.push(m.text()); });

  const webPage = await ctx.newPage();
  await webPage.goto(siteUrl);

  // --- 設定画面の「テスト表示」
  const options = await ctx.newPage();
  const optionErrors = [];
  options.on('pageerror', (e) => optionErrors.push(String(e)));
  await options.goto(`chrome-extension://${extId}/src/options/options.html`);
  await options.waitForTimeout(400);
  await options.click('#test');
  await options.waitForTimeout(400);

  const testToast = await options.evaluate(() => {
    const host = document.getElementById('__gmail-atom-toast-host');
    if (!host) return null;
    const toast = host.shadowRoot.querySelector('.toast');
    const rect = toast.getBoundingClientRect();
    return {
      subject: toast.querySelector('.subject').textContent,
      bottom: Math.round(window.innerHeight - rect.bottom),
      right: Math.round(window.innerWidth - rect.right)
    };
  });
  assert.ok(testToast, '「テスト表示」で設定画面にトーストが出ること');
  assert.match(testToast.subject, /テスト表示/);
  assert.equal(testToast.bottom, 16, '既定の表示位置は右下');
  assert.equal(testToast.right, 16);
  assert.deepEqual(optionErrors, [], '設定画面でエラーが出ないこと');

  // --- 新着の通知フロー（フィードの取得だけ差し替える）
  await sw.evaluate(() => {
    const entry = (id, subject) => `<entry><title>${subject}</title><summary>本文の冒頭です。</summary>` +
      `<link rel="alternate" href="https://mail.google.com/mail/u/0?message_id=${id}"/>` +
      `<issued>2026-09-04T10:0${id}:00Z</issued><id>tag:gmail.google.com,2004:${id}</id>` +
      `<author><name>山田 太郎</name><email>y@example.com</email></author></entry>`;
    let n = 0;
    globalThis.fetch = async () => {
      n += 1;
      const body = n === 1 ? entry(1, '既存のメール')
                           : entry(2, '会議の日程について') + entry(1, '既存のメール');
      const xml = `<feed><title>Gmail - Inbox for taro@gmail.com</title>` +
        `<fullcount>${n === 1 ? 1 : 2}</fullcount>${body}</feed>`;
      return { ok: true, status: 200, text: async () => xml };
    };
  });

  await webPage.bringToFront(); // 普通のウェブページをアクティブなタブにする
  const check = () => options.evaluate(() =>
    new Promise((resolve) => chrome.runtime.sendMessage({ type: 'CHECK_NOW' }, resolve)));

  const first = await check();
  assert.equal(first.newCount, 0, '初回は既存の未読を通知しない');
  const second = await check();
  assert.equal(second.newCount, 1);

  await webPage.waitForTimeout(500);
  const toasts = await webPage.evaluate(() => {
    const host = document.getElementById('__gmail-atom-toast-host');
    if (!host) return null;
    return [...host.shadowRoot.querySelectorAll('.toast')].map((t) => ({
      subject: t.querySelector('.subject').textContent,
      sender: t.querySelector('.meta')?.textContent ?? null
    }));
  });
  assert.deepEqual(toasts, [{ subject: '会議の日程について', sender: '山田 太郎' }],
    '見ているウェブページにトーストが出ること');

  assert.equal(await sw.evaluate(() => chrome.action.getBadgeText({})), '2', 'バッジに未読件数が出ること');
  assert.deepEqual(swErrors, [], 'service worker でエラーが出ないこと');

  console.log('E2E: すべて成功しました');
} catch (e) {
  failed = true;
  console.error('E2E: 失敗しました\n', e);
} finally {
  await ctx.close();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
