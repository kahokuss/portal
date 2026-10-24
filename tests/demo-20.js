// 見本：子ども20人のクラブで画面がはみ出さないかを見る（名前はすべて架空）。tests/screenshots/m20-*.png に保存
//   node tests/demo-20.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');
const { createGas } = require('./gas-mock');

const shotDir = path.join(__dirname, 'screenshots');
const gas = createGas();
gas.init();
const jst = (s) => new Date(s + '+09:00');
gas.calendar.add({ title: '通常練習', start: jst('2026-10-15T17:00:00'), end: jst('2026-10-15T18:30:00'), location: '競技場' });
gas.calendar.add({ title: '秋季記録会', start: jst('2026-11-01T00:00:00'), end: jst('2026-11-02T00:00:00'), allDay: true, location: '市営陸上競技場' });
const SEI = ['山田', '佐藤', '鈴木', '高橋', '田中', '伊藤', '渡辺', '中村', '小林', '加藤', '吉田', '山本', '松本', '井上', '木村', '林', '清水', '山口', '森', '池田'];
const MEI = ['たろう', 'はな', 'けんた', 'さくら', 'ゆうと', 'みお', 'そうた', 'ひなた', 'りく', 'あおい', 'はると', 'ゆい', 'かいと', 'めい', 'こうき', 'りん', 'だいち', 'あかり', 'しょう', 'ここな'];
SEI.forEach((s, i) => {
  const u = 'U' + (i + 1);
  gas.profiles[u] = s + 'ほごしゃ';
  gas.members.add(u);
  gas.line({ type: 'user', userId: u }, '登録 ' + s + MEI[i] + ' ' + ((i % 6) + 1) + '年');
});
const admin = gas.login('U1').key;
gas.sheet('家族').data.forEach((r) => { if (r[0] === 'U1') r[3] = '○'; });
const api = (a, p) => gas.ctx.api(admin, a, p);
SEI.forEach((s, i) => gas.ctx.api(gas.login('U' + (i + 1)).key, 'saveChildren', { children: [{ name: s + MEI[i], grade: (i % 6) + 1, sex: i % 2 ? '女' : '男' }] }));
let st = api('bootstrap');
const race = st.events.find((e) => e.title === '秋季記録会');
const prac = st.events.find((e) => e.title === '通常練習');
api('saveRace', { key: race.key, title: race.title, date: race.date, place: '市営陸上競技場', type: '記録会', target: '全員', fee: 500, deadline: '2026-10-25', races: ['100m', '走幅跳', 'ジャベリックボールスロー'] });
SEI.forEach((s, i) => { if (i % 4 !== 3) gas.ctx.api(gas.login('U' + (i + 1)).key, 'saveEntry', { key: race.key, child: s + MEI[i], join: i % 7 === 5 ? '不参加' : '参加', races: ['100m'] }); });
[2, 6, 9, 13, 17].forEach((i) => gas.ctx.api(gas.login('U' + (i + 1)).key, 'reportAbsence', { child: SEI[i] + MEI[i], date: prac.date, reason: '体調不良' }));
api('setDuty', { key: prac.key, fam: 'U2', on: true });
api('saveFee', { name: '年会費', amount: 3000, target: '全員' });
api('savePoll', { title: '11/1 の送迎、車を出せますか', options: ['出せる', '出せない'] });
// 1年分の記録（架空）：練習で月に1回100m・走幅跳を測り、少しずつ伸びる。大会の記録も少し
let seed = 11;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const recs = [];
SEI.forEach((s, i) => {
  const g = (i % 6) + 1, name = s + MEI[i];
  if (i % 9 === 8) return; // 記録のない子もいる
  for (let m = 11; m >= 0; m--) {
    const d = new Date(Date.UTC(2026, 9 - m, 10 + (i % 15))).toISOString().slice(0, 10);
    if (rnd() < 0.25) continue;
    const t100 = (21 - g * 0.9 - (11 - m) * 0.05 + rnd() * 0.6).toFixed(2);
    recs.push({ child: name, race: g <= 2 ? '50m' : '100m', record: g <= 2 ? (11 - g * 0.5 - (11 - m) * 0.03 + rnd() * 0.4).toFixed(2) : t100, date: d, meet: '練習', kind: '練習' });
    if (g >= 3 && rnd() < 0.6) { const cm = Math.round(220 + g * 25 + (11 - m) * 3 + rnd() * 20); recs.push({ child: name, race: '走幅跳', record: Math.floor(cm / 100) + 'm' + String(cm % 100).padStart(2, '0'), date: d, meet: '練習', kind: '練習' }); }
  }
  if (g >= 3) recs.push({ child: name, race: '100m', record: (20.5 - g * 0.9 + rnd() * 0.5).toFixed(2), date: '2026-09-27', meet: '県小学生陸上', kind: '公式' });
});
api('addRecords', { rows: recs });


(async () => {
  fs.mkdirSync(shotDir, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 375, height: 800 } });
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
  const idle = () => page.waitForSelector('#busy[hidden]', { state: 'attached' });
  // 横にはみ出していないか
  const noOverflow = async (where) => {
    const w = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    assert.ok(w[0] <= w[1], where + ' が横にはみ出しています ' + w);
  };
  const shot = async (n) => { await noOverflow(n); await page.screenshot({ path: path.join(shotDir, 'm20-' + n + '.png'), fullPage: true }); };
  await shot('1-home');
  await page.click('button.ev[data-ev]:has-text("10/15")');
  await page.click('[data-tally$="|0"]');
  await shot('2-practice');
  await page.click('#back');
  await page.click('button.ev:has-text("秋季記録会")');
  await page.click('[data-et="エントリー"]');
  await page.click('[data-tally$="|0"]');
  await shot('3-entry');
  await page.click('[data-nav="events"]');
  await page.click('[data-f="カレンダー"]');
  await shot('4-calendar');
  await page.click('[data-nav="admin"]');
  await page.click('[data-go="fees"]');
  await shot('5-fees');
  await page.click('#aBack');
  await page.click('[data-go="polls"]');
  await shot('6-polls');
  await page.click('#aBack');
  await page.click('[data-go="duty"]');
  await shot('7-duty');
  await page.click('#aBack');
  await page.click('[data-go="members"]');
  await shot('8-members');
  await page.click('#aBack');
  await page.click('[data-go="dash"]');
  await shot('9-dash');
  await page.click('[data-dk="練習"]');
  await page.click('button[data-dr="走幅跳"]');
  await shot('9b-dash-long');
  await page.setViewportSize({ width: 1280, height: 900 });
  await shot('9c-dash-pc');
  await page.click('[data-dkid="田中ゆうと"]');
  await shot('9d-dash-pc-kid');
  await page.setViewportSize({ width: 375, height: 800 });
  await idle();
  assert.deepStrictEqual(errors, []);
  await browser.close();
  console.log('tests/screenshots/m20-*.png を作りました（はみ出しなし）');
})().catch((e) => { console.error(e); process.exit(1); });
