// 見本：1年分の自主トレ（架空）を入れて、自主トレの画面とレポートを tests/screenshots/train-*.png に保存
//   node tests/demo-training.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');
const { createGas } = require('./gas-mock');

const shotDir = path.join(__dirname, 'screenshots');
const gas = createGas({ now: '2026-10-24T19:00:00+09:00' });
gas.init();
const jst = (s) => new Date(s + '+09:00');
['2026-10-06', '2026-10-08', '2026-10-13', '2026-10-15', '2026-10-20', '2026-10-22', '2026-10-27', '2026-10-29'].forEach((d) => gas.calendar.add({ title: '通常練習', start: jst(d + 'T17:00:00'), end: jst(d + 'T18:30:00'), location: '競技場' }));
gas.calendar.add({ title: '秋季記録会', start: jst('2026-10-18T00:00:00'), end: jst('2026-10-19T00:00:00'), allDay: true, location: '市営陸上競技場' });
gas.profiles.U1 = '山田';
gas.members.add('U1');
gas.line({ type: 'user', userId: 'U1' }, '登録 山田たろう 5年');
const key = gas.login('U1').key;
const api = (a, p) => gas.ctx.api(key, a, p);
// 決まった並びの「でたらめ」（毎回同じ絵になるように）
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const addDays = (s, n) => new Date(Date.parse(s + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
for (let i = 364; i >= 0; i--) {
  const date = addDays('2026-10-24', -i);
  const keen = 0.25 + 0.35 * (1 - i / 365); // だんだん増える
  if (rnd() < keen) api('saveTraining', { date, child: '山田たろう', kind: 'ランニング', km: (1.5 + rnd() * 3).toFixed(1), min: Math.round(12 + rnd() * 20), feel: ['◎', '○', '○', '△'][Math.floor(rnd() * 4)] });
  if (rnd() < keen * 0.8) api('saveTraining', { date, child: '山田たろう', kind: '腹筋', count: 20 + Math.round(rnd() * 20) });
  if (rnd() < keen * 0.5) api('saveTraining', { date, child: '山田たろう', kind: 'スクワット', count: 20 + Math.round(rnd() * 15) });
  if (rnd() < keen * 0.3) api('saveTraining', { date, child: '山田たろう', kind: '縄跳び', count: 100 + Math.round(rnd() * 200), min: 5 + Math.round(rnd() * 5) });
  if (rnd() < keen * 0.2) api('saveTraining', { date, child: '山田たろう', kind: 'ダッシュ', count: 5 + Math.round(rnd() * 5) });
}

(async () => {
  fs.mkdirSync(shotDir, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/fonts.googleapis.com/**', (r) => r.abort());
  await page.exposeFunction('__gasApi', (k, a, p) => { try { return { ok: JSON.parse(JSON.stringify(gas.ctx.api(k, a, p))) }; } catch (e) { return { err: e.message }; } });
  await page.addInitScript(() => {
    function runner() { let ok = () => {}, ng = () => {}; const r = { withSuccessHandler(f) { ok = f; return r; }, withFailureHandler(f) { ng = f; return r; }, api(...a) { window.__gasApi(...a).then((res) => (res.err ? ng(new Error(res.err)) : ok(res.ok))); } }; return r; }
    window.google = { script: { get run() { return runner(); } } };
  });
  let first = true;
  await page.route('https://portal.test/**', (r) => { const body = first ? gas.login('U1').html : gas.ctx.doGet({ parameter: {} }).getContent(); first = false; r.fulfill({ contentType: 'text/html; charset=utf-8', body }); });
  await page.goto('https://portal.test/');
  await page.waitForSelector('#nav:not([hidden])');
  await page.click('[data-nav="train"]');
  const shot = async (n) => {
    const w = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    assert.ok(w[0] <= w[1], n + ' が横にはみ出しています');
    await page.screenshot({ path: path.join(shotDir, 'train-' + n + '.png'), fullPage: true });
  };
  await shot('1-month');
  for (const [p, n] of [['3m', '2-3months'], ['6m', '3-half'], ['1y', '4-year']]) { await page.click('[data-trp="' + p + '"]'); await shot(n); }
  await page.setViewportSize({ width: 1280, height: 900 });
  await shot('5-pc');
  assert.deepStrictEqual(errors, []);
  await browser.close();
  console.log('tests/screenshots/train-*.png を作りました');
})().catch((e) => { console.error(e); process.exit(1); });
