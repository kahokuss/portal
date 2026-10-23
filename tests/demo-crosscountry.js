// 見本：クロスカントリーリレー大会の日のポータル（名前はすべて架空）。画面を tests/screenshots/demo-*.png に保存する
//   node tests/demo-crosscountry.js [領収書の写真のパス]
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { createGas } = require('./gas-mock');

const shotDir = path.join(__dirname, 'screenshots');
const receipt = process.argv[2];

const gas = createGas({ now: '2026-10-18T08:40:00+09:00' });
gas.init();
gas.calendar.add({ title: '打吹・羽衣クロスカントリー大会', start: new Date('2026-10-18T00:00:00+09:00'), end: new Date('2026-10-19T00:00:00+09:00'), allDay: true, location: '打吹公園' });

// 架空の子どもたち（家族ごとに1人）。[名前, 学年, 男女, 出る種目, ナンバー]
const KIDS = [
  ['山田たろう', 6, '男', 'クロスカントリーリレー', '4'], ['佐藤じろう', 6, '男', 'クロスカントリーリレー', '4'], ['鈴木さぶろう', 6, '男', 'クロスカントリーリレー', '4'], ['田中しろう', 6, '男', 'クロスカントリーリレー', '4'],
  ['高橋ごろう', 3, '男', 'クロスカントリーリレー', '21'], ['伊藤ろくろう', 4, '男', 'クロスカントリーリレー', '22'], ['渡辺しちろう', 4, '男', 'クロスカントリーリレー', '23'],
  ['中村はな', 6, '女', '900m', '5'], ['小林もも', 5, '女', '900m', '6'], ['加藤さくら', 5, '女', '900m', '7'], ['吉田ゆり', 4, '女', '900m', '8'], ['山本すみれ', 3, '女', '900m', '9'], ['松本つばき', 1, '女', '900m', '10'],
  ['井上あやめ', 2, '女', '900m', ''],
];
KIDS.forEach((k, i) => {
  const u = 'U' + (i + 1);
  gas.profiles[u] = k[0].slice(0, 2) + '（保護者）';
  gas.members.add(u);
  gas.line({ type: 'user', userId: u }, '登録 ' + k[0] + ' ' + k[1] + '年');
});
const admin = gas.login('U1').key;
gas.sheet('家族').data.forEach((r) => { if (r[0] === 'U1') r[3] = '○'; });
const api = (a, p) => gas.ctx.api(admin, a, p);
KIDS.forEach((k, i) => gas.ctx.api(gas.login('U' + (i + 1)).key, 'saveChildren', { children: [{ name: k[0], grade: k[1], sex: k[2] }] }));

let st = api('bootstrap');
const race = st.events.find((e) => e.title.includes('クロスカントリー'));
api('saveRace', { key: race.key, title: race.title, date: race.date, place: '打吹公園', type: '大会', target: '全員', fee: 500, deadline: '2026-10-08', meetTime: '8:30', meetPlace: '本部テント前', races: ['クロスカントリーリレー', '900m'], items: ['ユニフォーム', '水筒', 'ベンチコート'] });
KIDS.forEach((k) => { api('saveEntry', { key: race.key, child: k[0], join: '参加', races: [k[3]] }); api('setPaid', { key: race.key, child: k[0], paid: true }); });
api('setDuty', { key: race.key, fam: 'U1', on: true });
api('saveTimetable', { key: race.key, rows: [
  { start: '9:30', race: 'クロスカントリーリレー', group: '5・6年男子', call: '9:10', memo: '時刻は見本' },
  { start: '10:00', race: 'クロスカントリーリレー', group: '3・4年男子', call: '9:40', memo: '時刻は見本' },
  { start: '10:30', race: '900m', group: '男女', call: '10:10', memo: 'リレーに出ない人' },
] });
api('setTask', { key: race.key, kind: 'リレー決勝', target: '河北SS A（男子5・6年の部）', memo: '1区 山田たろう／2区 佐藤じろう／3区 鈴木さぶろう／4区 田中しろう', done: true });
api('setTask', { key: race.key, kind: 'リレー決勝', target: '河北SS B（男子3・4年の部）', memo: '1区 高橋ごろう／2区 伊藤ろくろう／3区 渡辺しちろう', done: true });
KIDS.forEach((k) => { if (k[4]) api('setTask', { key: race.key, kind: 'ナンバー', target: k[0], memo: k[4] }); });
api('setTask', { key: race.key, kind: 'エントリー控え', target: '', done: true });
api('setTask', { key: race.key, kind: '陣地', target: '', memo: '本部に向かって右側の階段に場所を取りました（青いシート）', done: true });
const data = receipt && fs.existsSync(receipt) ? 'data:image/jpeg;base64,' + fs.readFileSync(receipt).toString('base64') : '';
api('saveLedger', { key: race.key, amount: 6500, payee: '主催者（陸上競技協会）', note: '参加料', data: data });

(async () => {
  fs.mkdirSync(shotDir, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
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
  const shot = (n) => page.screenshot({ path: path.join(shotDir, 'demo-' + n + '.png'), fullPage: true });
  await shot('1-home');
  await page.click('[data-gott]');
  await shot('2-timetable');
  await page.click('[data-ttf="全部"]');
  await shot('3-timetable-all');
  await page.click('[data-et="種目"]');
  await page.waitForTimeout(300);
  await shot('4-races');
  await page.click('[data-et="手続き"]');
  await page.waitForTimeout(300);
  await shot('4-tasks');
  await page.click('[data-nav="admin"]');
  await page.click('[data-go="ledger"]');
  await page.waitForTimeout(300);
  await shot('5-ledger');
  await browser.close();
  console.log('tests/screenshots/demo-*.png を作りました');
})();
