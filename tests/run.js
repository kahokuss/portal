// サーバー側のテスト（Apps Script のサービスはメモリ上のまねで動かす）: node tests/run.js
const assert = require('assert');
const { createGas } = require('./gas-mock');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n  ' + (e.stack || e.message)); }
}
const plain = (x) => JSON.parse(JSON.stringify(x));

function setupClub() {
  const gas = createGas();
  gas.init();
  const jst = (s) => new Date(s + '+09:00');
  gas.calendar.add({ title: '通常練習', start: jst('2026-10-15T17:00:00'), end: jst('2026-10-15T18:30:00'), location: '第二小学校' });
  gas.calendar.add({ title: '通常練習', start: jst('2026-10-17T09:00:00'), end: jst('2026-10-17T11:00:00'), location: '市民グラウンド' });
  gas.calendar.add({ title: '秋季記録会', start: jst('2026-11-01T00:00:00'), end: jst('2026-11-02T00:00:00'), allDay: true, location: '市営陸上競技場' });
  Object.assign(gas.profiles, { U1: '山田', U2: '鈴木', U3: '佐藤', U4: '山田（父）' });
  ['U1', 'U2', 'U3', 'U4'].forEach((u) => gas.members.add(u));
  return gas;
}
const dm = (userId) => ({ type: 'user', userId });
const group = (userId) => ({ type: 'group', groupId: 'G1', userId });

test('コマンド: 1語目が完全一致したときだけ反応', () => {
  const gas = createGas();
  assert.deepStrictEqual(plain(gas.run("parseCommand_('ポータル 再発行')")), { name: 'portal', args: '再発行' });
  assert.deepStrictEqual(plain(gas.run("parseCommand_('結果　100m　15.2秒')")), { name: 'result', args: '100m　15.2秒' });
  assert.strictEqual(gas.run("parseCommand_('予定は？')"), null);
  assert.strictEqual(gas.run("parseCommand_('結果どうだった？')"), null);
});

test('子どもの登録文を名前と学年に分ける', () => {
  const gas = createGas();
  assert.deepStrictEqual(plain(gas.run("parseChildrenArgs_('山田たろう 3年 山田はなこ１年')")), [{ name: '山田たろう', grade: 3 }, { name: '山田はなこ', grade: 1 }]);
  assert.deepStrictEqual(plain(gas.run("parseChildrenArgs_('たろう、はなこ（2年）')")), [{ name: 'たろう', grade: 0 }, { name: 'はなこ', grade: 2 }]);
});

test('対象学年の判定', () => {
  const gas = createGas();
  assert.strictEqual(gas.run("inTarget_('4年生以上', 3)"), false);
  assert.strictEqual(gas.run("inTarget_('4年生以上', 5)"), true);
  assert.strictEqual(gas.run("inTarget_('全員', 1)"), true);
});

test('LINEログイン: グループのメンバーだけが入れる', () => {
  const gas = setupClub();
  gas.profiles.X9 = '部外者';
  const ok = gas.login('U1');
  assert.ok(ok.key && ok.key.length === 32, ok.error);
  assert.strictEqual(gas.login('U1').key, ok.key, '同じ人には同じキー');
  const ng = gas.login('X9');
  assert.strictEqual(ng.key, null);
  assert.ok(ng.error.includes('メンバーだけ'), ng.error);
  assert.ok(!gas.rows('家族').some((f) => f.userId === 'X9'), 'メンバーでない人は記録しない');
  const html = gas.ctx.doGet({ parameter: {} }).getContent();
  const state = html.match(/state=([A-Za-z0-9]+)/)[1];
  assert.strictEqual(JSON.parse(gas.ctx.doGet({ parameter: { code: 'login:U2', state } }).getContent().match(/var KEY = (".*?");/)[1]), gas.rows('家族').find((f) => f.userId === 'U2')['ポータルキー']);
  const reused = gas.ctx.doGet({ parameter: { code: 'login:U2', state } }).getContent();
  assert.ok(reused.includes('有効期限'), '同じ state は2回使えない');
  assert.ok(gas.ctx.doGet({ parameter: { code: 'login:U2', state: 'forged' } }).getContent().includes('有効期限'));
  assert.throws(() => gas.ctx.api('A'.repeat(32), 'bootstrap'), /ログインが切れ/);
});

test('グループを抜けた人は、確認し直したときに使えなくなる', () => {
  const gas = setupClub();
  const k = gas.login('U2').key;
  assert.ok(gas.ctx.api(k, 'bootstrap'));
  gas.members.delete('U2');
  assert.ok(gas.ctx.api(k, 'bootstrap'), '確認したばかりなので、しばらくは通る');
  gas.sheet('家族').data.forEach((r) => { if (r[0] === 'U2') r[5] = '2026-10-13 09:00:00'; });
  assert.throws(() => gas.ctx.api(k, 'bootstrap'), /グループのメンバーではない/);
});

test('Bot: 登録とポータルのリンク（グループでも出してよい共通リンク）', () => {
  const gas = setupClub();
  const r1 = gas.line(dm('U1'), '登録 山田たろう 3年 山田はなこ 1年');
  assert.ok(r1.includes('山田たろう（3年）'), r1);
  const r2 = gas.line(group('U1'), 'ポータル');
  assert.ok(r2.includes('https://kahokuss.github.io/portal/'), r2);
  assert.ok(!/k=/.test(r2), '個人キーは出さない');
  const children = gas.rows('子ども');
  assert.deepStrictEqual(children.map((c) => [c['名前'], c['学年'], c['保護者userId']]), [['山田たろう', '3', 'U1'], ['山田はなこ', '1', 'U1']]);
});

test('ポータル: 予定の取り込み・エントリー・締切・集金', () => {
  const gas = setupClub();
  gas.line(dm('U1'), '登録 山田たろう 3年');
  gas.line(dm('U2'), '登録 鈴木けんた 5年');
  const kAdmin = gas.login('U1').key;
  const kParent = gas.login('U2').key;
  gas.sheet('家族').data.forEach((r) => { if (r[0] === 'U1') r[3] = '○'; });

  let st = gas.ctx.api(kParent, 'bootstrap');
  assert.strictEqual(st.me.admin, false);
  assert.deepStrictEqual(plain(st.me.children), [{ name: '鈴木けんた', grade: 5 }]);
  const race = st.events.find((e) => e.title === '秋季記録会');
  assert.strictEqual(race.type, '大会', '予定名から大会と判断');
  assert.strictEqual(st.events.filter((e) => e.type === '練習').length, 2);

  assert.throws(() => gas.ctx.api(kParent, 'saveRace', { title: 'x', date: '2026-11-01' }), /役員だけ/);
  st = gas.ctx.api(kAdmin, 'saveRace', { key: race.key, title: '秋季記録会', date: '2026-11-01', place: '市営陸上競技場', target: '4年生以上', fee: 500, deadline: '2026-10-22', races: ['100m', '走り幅跳び'], items: ['水筒'], meetTime: '7:50' });
  assert.strictEqual(st.events.find((e) => e.key === race.key).detail.target, '4年生以上');

  assert.throws(() => gas.ctx.api(kParent, 'saveEntry', { key: race.key, child: '山田たろう', join: '参加', races: [] }), /登録されていません/);
  st = gas.ctx.api(kParent, 'saveEntry', { key: race.key, child: '鈴木けんた', join: '参加', races: ['100m', '砲丸投げ'] });
  assert.deepStrictEqual(plain(st.entries[0].races), ['100m'], '大会にない種目は入れない');
  st = gas.ctx.api(kParent, 'saveEntry', { key: race.key, child: '鈴木けんた', join: '参加', races: ['100m', '走り幅跳び'] });
  assert.strictEqual(gas.rows('エントリー').length, 1, '同じ子は上書き');

  st = gas.ctx.api(kAdmin, 'setPaid', { key: race.key, child: '鈴木けんた', paid: true });
  assert.strictEqual(st.entries[0].paid, true);

  gas.ctx.api(kAdmin, 'saveRace', { key: race.key, title: '秋季記録会', date: '2026-11-01', place: '市営陸上競技場', target: '4年生以上', fee: 500, deadline: '2026-10-13', races: ['100m'] });
  assert.throws(() => gas.ctx.api(kParent, 'saveEntry', { key: race.key, child: '鈴木けんた', join: '不参加' }), /締切/);
  gas.ctx.api(kAdmin, 'saveEntry', { key: race.key, child: '鈴木けんた', join: '不参加' });
  assert.strictEqual(gas.rows('エントリー')[0]['回答'], '不参加', '役員は締切後も直せる');
});

test('ポータル: 大会を新しく作るとカレンダーにも入る', () => {
  const gas = setupClub();
  gas.line(dm('U1'), '登録 山田たろう 3年');
  const k = gas.login('U1').key;
  gas.sheet('家族').data.forEach((r) => { if (r[0] === 'U1') r[3] = '○'; });
  const st = gas.ctx.api(k, 'saveRace', { title: '冬季ロードレース大会', date: '2026-11-22', place: '東中学校', races: ['2km'] });
  assert.ok(st.message.includes('保存'));
  const ce = gas.calendar.events.find((e) => e.title === '冬季ロードレース大会');
  assert.ok(ce && ce.allDay && ce.location === '東中学校');
  const ev = st.events.find((e) => e.title === '冬季ロードレース大会');
  assert.strictEqual(ev.date, '2026-11-22');
  gas.ctx.api(k, 'saveRace', { key: ev.key, title: '冬季ロードレース大会', date: '2026-11-29', place: '東中学校' });
  assert.strictEqual(gas.ctx.Utilities.formatDate(ce.start, 'Asia/Tokyo', 'yyyy-MM-dd'), '2026-11-29', '日付を直すとカレンダーも動く');
  gas.ctx.api(k, 'refresh');
  assert.strictEqual(gas.rows('予定').filter((r) => r['タイトル'] === '冬季ロードレース大会').length, 1, '同期しても重複しない');
});

test('ポータル: 休みの連絡は役員に届き、理由は本人と役員だけに見える', () => {
  const gas = setupClub();
  gas.line(dm('U1'), '登録 山田たろう 3年');
  gas.line(dm('U2'), '登録 鈴木けんた 5年');
  gas.line(dm('U3'), '登録 佐藤さくら 2年');
  const kAdmin = gas.login('U1').key;
  const kParent = gas.login('U2').key;
  const kOther = gas.login('U3').key;
  gas.sheet('家族').data.forEach((r) => { if (r[0] === 'U1') r[3] = '○'; });

  assert.throws(() => gas.ctx.api(kParent, 'reportAbsence', { child: '鈴木けんた', date: '2026-10-01', reason: '体調不良' }), /過ぎた日/);
  let st = gas.ctx.api(kParent, 'reportAbsence', { child: '鈴木けんた', date: '2026-10-15', reason: '家の都合', memo: '通院' });
  assert.strictEqual(st.absences.length, 1);
  const push = gas.pushes().pop();
  assert.strictEqual(push.payload.to, 'U1');
  assert.ok(push.payload.messages[0].text.includes('鈴木けんた'));
  const seen = gas.ctx.api(kOther, 'bootstrap').absences;
  assert.strictEqual(seen.length, 1, 'だれが休みかはメンバー全員に見える');
  assert.strictEqual(seen[0].child, '鈴木けんた');
  assert.strictEqual(seen[0].reason + seen[0].memo + seen[0].by, '', '理由・ひとこと・連絡者は本人と役員だけ');
  assert.strictEqual(gas.ctx.api(kAdmin, 'bootstrap').absences[0].memo, '通院');

  st = gas.ctx.api(kAdmin, 'ackAbsence', { id: st.absences[0].id });
  assert.strictEqual(st.absences[0].ack, true);
  assert.throws(() => gas.ctx.api(kOther, 'cancelAbsence', { id: st.absences[0].id }), /見つかりません/);
  st = gas.ctx.api(kParent, 'cancelAbsence', { id: st.absences[0].id });
  assert.strictEqual(st.absences.length, 0);
});

test('ポータル: わが家で子どもを直す・両親で同じ子を登録', () => {
  const gas = setupClub();
  gas.line(dm('U1'), '登録 山田たろう');
  gas.line(dm('U4'), '登録 山田たろう 3年');
  const k = gas.login('U1').key;
  assert.strictEqual(gas.rows('子ども').length, 1);
  assert.strictEqual(gas.rows('子ども')[0]['保護者userId'], 'U1,U4');
  let st = gas.ctx.api(k, 'saveChildren', { children: [{ name: '山田たろう', grade: 4 }, { name: '山田はなこ', grade: 1 }] });
  assert.deepStrictEqual(plain(st.me.children), [{ name: '山田たろう', grade: 4 }, { name: '山田はなこ', grade: 1 }]);
  st = gas.ctx.api(k, 'saveChildren', { children: [{ name: '山田はなこ', grade: 1 }] });
  assert.deepStrictEqual(st.kids.map((c) => c.name), ['山田たろう', '山田はなこ'], 'もう一人の親が登録しているので残る');
});

test('ポータル画面: URLに付けたキーでは開けない（ログインが必要）', () => {
  const gas = setupClub();
  const k = gas.login('U1').key;
  const html = gas.ctx.doGet({ parameter: { k: k } }).getContent();
  assert.ok(html.includes('var KEY = "";'));
  assert.ok(html.includes('access.line.me/oauth2/v2.1/authorize'));
  assert.ok(html.includes(encodeURIComponent('https://script.google.com/macros/s/TEST/exec')), 'Apps Script の画面から始めたログインは Apps Script に戻る');
});

test('ポータル画面（別の場所に置いた画面）からのPOSTでログインと操作ができる', () => {
  const gas = setupClub();
  const post = (body) => JSON.parse(gas.ctx.doPost({ parameter: {}, postData: { contents: JSON.stringify(body) } }).text);
  const url = post({ action: 'loginUrl' }).ok.url;
  const state = url.match(/state=([A-Za-z0-9]+)/)[1];
  assert.ok(url.includes('redirect_uri=' + encodeURIComponent('https://kahokuss.github.io/portal/')), 'GitHub Pages の画面に戻る');
  const login = post({ action: 'login', payload: { code: 'login:U2', state } });
  assert.ok(login.ok && login.ok.key, JSON.stringify(login));
  const st = post({ action: 'bootstrap', key: login.ok.key });
  assert.strictEqual(st.ok.me.name, '鈴木');
  assert.ok(post({ action: 'bootstrap', key: 'B'.repeat(32) }).error.includes('ログインが切れ'));
  assert.ok(post({ action: 'login', payload: { code: 'login:U2', state } }).error.includes('有効期限'), 'state は使い捨て');
  assert.strictEqual(gas.ctx.doPost({ parameter: { token: 'wrong' }, postData: { contents: '{}' } }).text, 'OK', 'token付きはLINEの受付として扱う');
});

test('管理用の関数はWebアプリからは動かない', () => {
  const gas = setupClub();
  assert.throws(() => gas.ctx.setup(), /持ち主/);
});

test('GitHub Pages 用の画面（docs/index.html）が最新', () => {
  require('child_process').execFileSync('node', [require('path').join(__dirname, '../tools/build-pages.js'), '--check']);
});

if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('all passed');
