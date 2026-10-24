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
  assert.strictEqual(gas.line(group('U1'), 'ポータル'), '', 'グループには返さない');
  const r2 = gas.privateTo('U1');
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
  assert.deepStrictEqual(plain(st.me.children), [{ name: '鈴木けんた', grade: 5, sex: '' }]);
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

test('ポータル: 休みの連絡は役員がBotやポータルで見られ、理由は本人と役員だけに見える', () => {
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
  assert.strictEqual(gas.pushes().length, 0, 'LINEの通知はしない（通数を使わない）');
  assert.ok(gas.line(dm('U1'), '新着').includes('10/15(木) 鈴木けんた（家の都合・通院）'), '役員はBotの「新着」で見られる');
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
  assert.deepStrictEqual(plain(st.me.children), [{ name: '山田たろう', grade: 4, sex: '' }, { name: '山田はなこ', grade: 1, sex: '' }]);
  st = gas.ctx.api(k, 'saveChildren', { children: [{ name: '山田はなこ', grade: 1 }] });
  assert.deepStrictEqual(st.kids.map((c) => c.name), ['山田たろう', '山田はなこ'], 'もう一人の親が登録しているので残る');
});

test('家族: 招待番号で夫婦をまとめると、子どもの登録が共通になる', () => {
  const gas = setupClub();
  gas.line(dm('U1'), '登録 山田たろう 3年');
  const k1 = gas.login('U1').key;
  const k4 = gas.login('U4').key;
  const inv = gas.ctx.api(k1, 'inviteFamily');
  assert.ok(/^\d{6}$/.test(inv.code) && inv.url.includes('?join=' + inv.code));
  assert.throws(() => gas.ctx.api(k1, 'joinFamily', { code: inv.code }), /自分の招待番号/);
  assert.throws(() => gas.ctx.api(k4, 'joinFamily', { code: '000000' }), /違うか/);
  let st = gas.ctx.api(k4, 'joinFamily', { code: inv.code });
  assert.ok(st.message.includes('山田さんと同じ家族'));
  assert.deepStrictEqual(st.me.children.map((c) => c.name), ['山田たろう'], '相手の子どもが見える');
  assert.deepStrictEqual(plain(st.me.family).sort(), ['山田', '山田（父）'].sort());
  assert.throws(() => gas.ctx.api(k4, 'joinFamily', { code: inv.code }), /違うか/, '番号は1回だけ');
  st = gas.ctx.api(k4, 'saveChildren', { children: [{ name: '山田たろう', grade: 3, sex: '男' }, { name: '山田はなこ', grade: 1, sex: '女' }] });
  st = gas.ctx.api(k1, 'bootstrap');
  assert.deepStrictEqual(plain(st.me.children), [{ name: '山田たろう', grade: 3, sex: '男' }, { name: '山田はなこ', grade: 1, sex: '女' }], 'もう一人が足した子も見える');
  assert.strictEqual(st.families.length, 1);
  assert.strictEqual(st.families[0].label, '山田たろう・山田はなこ');
  st = gas.ctx.api(k4, 'leaveFamily');
  assert.strictEqual(st.me.children.length, 0);
  assert.strictEqual(gas.ctx.api(k1, 'bootstrap').me.children.length, 2);
});

test('休みの通知（オンにしたとき）: 受け取る係とその日の練習当番だけに届く。出欠はみんなに見える', () => {
  const gas = setupClub();
  gas.run('CONFIG.ABSENCE_PUSH_TO_ADMINS = true');
  gas.line(dm('U1'), '登録 山田たろう 3年');
  gas.line(dm('U2'), '登録 鈴木けんた 5年');
  gas.line(dm('U3'), '登録 佐藤さくら 2年');
  const kAdmin = gas.login('U1').key, k2 = gas.login('U2').key, k3 = gas.login('U3').key;
  gas.sheet('家族').data.forEach((r) => { if (r[0] === 'U1') r[3] = '○'; });
  let st = gas.ctx.api(kAdmin, 'bootstrap');
  const prac = st.events.find((e) => e.date === '2026-10-15');
  gas.ctx.api(kAdmin, 'setDuty', { key: prac.key, fam: 'U3', on: true });
  gas.ctx.api(k2, 'reportAbsence', { child: '鈴木けんた', date: '2026-10-15', reason: '体調不良' });
  assert.deepStrictEqual(gas.pushes().map((f) => f.payload.to).sort(), ['U1', 'U3'], '役員と、その日の当番');
  gas.ctx.api(kAdmin, 'setNotify', { userId: 'U1', on: false });
  gas.ctx.api(k2, 'reportAbsence', { child: '鈴木けんた', date: '2026-10-17', reason: '体調不良' });
  assert.strictEqual(gas.pushes().length, 2, '受け取りをやめた役員と、当番でない日は届かない');
  assert.throws(() => gas.ctx.api(k2, 'setNotify', { userId: 'U2', on: true }), /役員だけ/);
  st = gas.ctx.api(k3, 'bootstrap');
  assert.deepStrictEqual(st.absences.map((a) => a.child), ['鈴木けんた', '鈴木けんた']);
  assert.strictEqual(st.duties[0].fam, 'U3');
});

test('休み: 通知をしなくても、当番の家族はBotの「新着」で休む子が分かる', () => {
  const gas = setupClub();
  gas.line(dm('U1'), '登録 山田たろう 3年');
  gas.line(dm('U2'), '登録 鈴木けんた 5年');
  gas.line(dm('U3'), '登録 佐藤さくら 2年');
  const kAdmin = gas.login('U1').key, k2 = gas.login('U2').key;
  gas.login('U3');
  gas.sheet('家族').data.forEach((r) => { if (r[0] === 'U1') r[3] = '○'; });
  const prac = gas.ctx.api(kAdmin, 'bootstrap').events.find((e) => e.date === '2026-10-15');
  gas.ctx.api(kAdmin, 'setDuty', { key: prac.key, fam: 'U3', on: true });
  gas.line(dm('U2'), '休み 明日 体調不良');
  assert.strictEqual(gas.pushes().length, 0);
  assert.ok(gas.line(dm('U3'), '新着').includes('休む子：鈴木けんた'), '当番には名前が出る');
  assert.ok(!gas.line(dm('U3'), '新着').includes('体調不良'), '理由は出さない');
});
test('当番: 前回から日がたっている家族から順に自動で入れる', () => {
  const gas = setupClub();
  gas.line(dm('U1'), '登録 山田たろう 3年');
  gas.line(dm('U2'), '登録 鈴木けんた 5年');
  gas.line(dm('U3'), '登録 佐藤さくら 2年');
  const kAdmin = gas.login('U1').key;
  gas.login('U2'); gas.login('U3');
  gas.sheet('家族').data.forEach((r) => { if (r[0] === 'U1') r[3] = '○'; });
  let st = gas.ctx.api(kAdmin, 'bootstrap');
  const race = st.events.find((e) => e.title === '秋季記録会');
  gas.ctx.api(kAdmin, 'setDuty', { key: race.key, fam: 'U2', on: true });
  gas.sheet('当番'); appendDuty(gas, 'old', '2026-09-01', '練習', 'U1');
  st = gas.ctx.api(kAdmin, 'autoDuty', { type: '練習', days: 30, per: 1 });
  const prac = st.duties.filter((d) => d.type === '練習' && d.key !== 'old').sort((a, b) => (a.date < b.date ? -1 : 1));
  assert.deepStrictEqual(prac.map((d) => d.fam), ['U3', 'U2'], '練習当番は試合当番と別に数え、まだの家族から（9/1に入った山田家は後回し）');
  st = gas.ctx.api(kAdmin, 'autoDuty', { type: '練習', days: 30, per: 1 });
  assert.ok(st.message.includes('全部入っています'));
  assert.strictEqual(st.duties.find((d) => d.key === race.key).type, '大会');
});
function appendDuty(gas, key, date, type, fam) { gas.run(`appendRow_(SHEETS.DUTIES, { eventKey: ${JSON.stringify(key)}, '日付': ${JSON.stringify(date)}, '種類': ${JSON.stringify(type)}, '家族ID': ${JSON.stringify(fam)} })`); }

test('大会の日: タイムテーブル・招集・手続きの写真', () => {
  const gas = setupClub();
  gas.line(dm('U1'), '登録 山田たろう 3年');
  gas.line(dm('U2'), '登録 鈴木けんた 5年');
  gas.line(dm('U3'), '登録 佐藤さくら 2年');
  const kAdmin = gas.login('U1').key, k2 = gas.login('U2').key, k3 = gas.login('U3').key;
  gas.sheet('家族').data.forEach((r) => { if (r[0] === 'U1') r[3] = '○'; });
  let st = gas.ctx.api(kAdmin, 'bootstrap');
  const race = st.events.find((e) => e.title === '秋季記録会');
  assert.throws(() => gas.ctx.api(k2, 'saveTimetable', { key: race.key, rows: [] }), /当番の人だけ/);
  gas.ctx.api(kAdmin, 'setDuty', { key: race.key, fam: 'U2', on: true });
  st = gas.ctx.api(k2, 'saveTimetable', { key: race.key, rows: [{ start: '1030', race: '100m', group: '5年男子', heat: '2組', call: '10:00' }, { start: '11:00', race: '走り幅跳び', group: '3年', call: '1030' }, { race: '' }] });
  assert.strictEqual(st.timetable.length, 2);
  assert.deepStrictEqual([st.timetable[0].start, st.timetable[0].call], ['10:30', '10:00']);
  assert.deepStrictEqual(plain(st.me.canManage), [race.key]);
  const id = st.timetable[0].id;
  st = gas.ctx.api(k2, 'saveTimetable', { key: race.key, rows: [Object.assign({}, st.timetable[0], { call: '9:55' })] });
  assert.strictEqual(st.timetable.length, 1);
  assert.strictEqual(st.timetable[0].id, id, '直しても同じ行');

  st = gas.ctx.api(k3, 'setTask', { key: race.key, kind: '招集', target: '鈴木けんた|' + id, done: true });
  assert.strictEqual(st.tasks[0].done, true, '招集はだれでも報告できる');
  assert.strictEqual(st.tasks[0].by, '佐藤');
  assert.throws(() => gas.ctx.api(k3, 'setTask', { key: race.key, kind: 'リレー予選', target: 'A', memo: 'x' }), /当番の人だけ/);
  st = gas.ctx.api(k2, 'setTask', { key: race.key, kind: 'リレー決勝', target: 'Aチーム', memo: '1走:鈴木けんた', done: true });
  assert.strictEqual(st.tasks.length, 2);

  const img = 'data:image/jpeg;base64,' + Buffer.from('jpegdata').toString('base64');
  st = gas.ctx.api(k2, 'uploadPhoto', { key: race.key, kind: 'プログラム', target: '', data: img });
  const prog = st.tasks.find((t) => t.kind === 'プログラム');
  assert.ok(prog.done && prog.photos.length === 1, 'プログラムの写真を付けると済');
  assert.strictEqual(st.photos.length, 1);
  const got = gas.ctx.api(k3, 'photo', { id: prog.photos[0] });
  assert.strictEqual(got.data, img, 'メンバーは写真を見られる');
  gas.files.secret = { getBlob: () => ({ getContentType: () => 'text/plain', getBytes: () => [] }) };
  assert.throws(() => gas.ctx.api(k3, 'photo', { id: 'secret' }), /見つかりません/, 'ほかのドライブのファイルは出さない');
  assert.throws(() => gas.ctx.api(k3, 'uploadPhoto', { key: race.key, data: 'data:text/html;base64,AAAA' }), /読み込めません/);
  st = gas.ctx.api(k3, 'uploadPhoto', { key: race.key, data: img });
  assert.strictEqual(st.photos.length, 2, '写真だけならだれでも上げられる');
});

test('結果: その子の家族・役員・当番だけが入れられ、LINEで入れた分も出る', () => {
  const gas = setupClub();
  gas.line(dm('U1'), '登録 山田たろう 3年');
  gas.line(dm('U2'), '登録 鈴木けんた 5年');
  const kAdmin = gas.login('U1').key, k2 = gas.login('U2').key, k3 = gas.login('U3').key;
  gas.sheet('家族').data.forEach((r) => { if (r[0] === 'U1') r[3] = '○'; });
  const race = gas.ctx.api(kAdmin, 'bootstrap').events.find((e) => e.title === '秋季記録会');
  let st = gas.ctx.api(k2, 'saveResult', { key: race.key, child: '鈴木けんた', race: '100m', record: '１５．２１', round: '予選', place: '3位' });
  assert.deepStrictEqual([st.results[0].record, st.results[0].place, st.results[0].round], ['15.21', '3', '予選']);
  assert.throws(() => gas.ctx.api(k3, 'saveResult', { key: race.key, child: '鈴木けんた', race: '100m', record: '1' }), /当番の人だけ/);
  assert.throws(() => gas.ctx.api(k3, 'deleteResult', { id: st.results[0].id }), /当番の人だけ/);
  gas.ctx.api(kAdmin, 'saveResult', { key: race.key, child: '鈴木けんた', race: '走り幅跳び', record: '3m20' });
  gas.line(dm('U2'), '結果 100m 14.9秒');
  st = gas.ctx.api(k3, 'bootstrap');
  assert.strictEqual(st.results.length, 3, 'メンバーはみんな見られる');
  st = gas.ctx.api(k2, 'deleteResult', { id: st.results[0].id });
  assert.strictEqual(st.results.length, 2);
  st = gas.ctx.api(k3, 'setTask', { key: race.key, kind: 'ナンバー', target: '鈴木けんた', memo: '186' });
  assert.strictEqual(st.tasks[0].memo, '186', 'ナンバーはだれでも入れられる');
  assert.throws(() => gas.ctx.api(k3, 'setTask', { key: race.key, kind: '参加費支払い', target: '', done: true }), /当番の人だけ/);
});
test('会計: 大会の支払いを領収書つきで記録し、履歴に残る', () => {
  const gas = setupClub();
  gas.line(dm('U1'), '登録 山田たろう 3年');
  gas.line(dm('U2'), '登録 鈴木けんた 5年');
  const kAdmin = gas.login('U1').key, k2 = gas.login('U2').key, k3 = gas.login('U3').key;
  gas.sheet('家族').data.forEach((r) => { if (r[0] === 'U1') r[3] = '○'; });
  const race = gas.ctx.api(kAdmin, 'bootstrap').events.find((e) => e.title === '秋季記録会');
  assert.throws(() => gas.ctx.api(k2, 'saveLedger', { key: race.key, amount: 6500 }), /当番の人だけ/);
  gas.ctx.api(kAdmin, 'setDuty', { key: race.key, fam: 'U2', on: true });
  const img = 'data:image/jpeg;base64,' + Buffer.from('receipt').toString('base64');
  let st = gas.ctx.api(k2, 'saveLedger', { key: race.key, amount: '６，５００円', payee: '主催者', note: '参加料', data: img });
  assert.deepStrictEqual([st.ledger[0].amount, st.ledger[0].date, st.ledger[0].payee], [6500, '2026-11-01', '主催者']);
  assert.ok(st.tasks.find((t) => t.kind === '参加費支払い').done, '支払いを記録すると手続きも済');
  assert.strictEqual(st.photos.length, 0, '領収書はアルバムには出さない');
  assert.deepStrictEqual(gas.ctx.api(k3, 'bootstrap').ledger, [], '当番でも役員でもない人には見せない');
  assert.throws(() => gas.ctx.api(k2, 'saveLedger', { amount: 1000, note: 'ビブス' }), /役員だけ/);
  st = gas.ctx.api(kAdmin, 'saveLedger', { kind: '入金', amount: 3000, note: '年会費' });
  assert.strictEqual(st.ledger.length, 2);
  st = gas.ctx.api(kAdmin, 'deleteLedger', { id: st.ledger[0].id });
  assert.strictEqual(st.ledger.length, 1);
});
test('コメント・ヒヤリハット: みんなで共有し、役員が対策を書く', () => {
  const gas = setupClub();
  gas.line(dm('U1'), '登録 山田たろう 3年');
  gas.line(dm('U2'), '登録 鈴木けんた 5年');
  const kAdmin = gas.login('U1').key, k2 = gas.login('U2').key, k3 = gas.login('U3').key;
  gas.sheet('家族').data.forEach((r) => { if (r[0] === 'U1') r[3] = '○'; });
  const prac = gas.ctx.api(k2, 'bootstrap').events.find((e) => e.date === '2026-10-15');
  let st = gas.ctx.api(k2, 'saveComment', { key: prac.key, kind: 'ヒヤリハット', body: '駐車場から車が急に出てきた', place: '駐車場の出入口' });
  assert.ok(st.message.includes('共有しました'));
  assert.strictEqual(gas.pushes().length, 0, 'LINEの通知はしない（役員はBotの「新着」やポータルで見る）');
  assert.ok(gas.line(dm('U1'), '新着').includes('対策がまだのヒヤリハット 1件'));
  gas.ctx.api(k2, 'saveComment', { key: prac.key, body: '役員さんだけに相談です', adminOnly: true });
  st = gas.ctx.api(k3, 'bootstrap');
  assert.deepStrictEqual(st.comments.map((c) => c.kind), ['ヒヤリハット'], '「役員だけ」は、ほかの保護者には見えない');
  assert.strictEqual(gas.ctx.api(kAdmin, 'bootstrap').comments.length, 2);
  const id = st.comments[0].id;
  assert.throws(() => gas.ctx.api(k3, 'setMeasure', { id, measure: 'x' }), /役員だけ/);
  st = gas.ctx.api(kAdmin, 'setMeasure', { id, measure: '出入口にコーンを置き、大人が1人立つ' });
  assert.strictEqual(st.comments.find((c) => c.id === id).measureBy, '山田');
  assert.throws(() => gas.ctx.api(k3, 'deleteComment', { id }), /書いた人と役員/);
  assert.throws(() => gas.ctx.api(k2, 'saveComment', { key: prac.key, body: ' ' }), /書いてください/);
});
test('大会の詳細: 主催の申込期限・資料・履歴', () => {
  const gas = setupClub();
  gas.line(dm('U1'), '登録 山田たろう 3年');
  gas.line(dm('U2'), '登録 鈴木けんた 5年');
  const kAdmin = gas.login('U1').key, k2 = gas.login('U2').key, k3 = gas.login('U3').key;
  gas.sheet('家族').data.forEach((r) => { if (r[0] === 'U1') r[3] = '○'; });
  const race = gas.ctx.api(kAdmin, 'bootstrap').events.find((e) => e.title === '秋季記録会');
  let st = gas.ctx.api(kAdmin, 'saveRace', { key: race.key, title: '秋季記録会', date: '2026-11-01', deadline: '2026-10-15', organizer: '市陸上競技協会', applyBy: '2026-10-18', applyHow: 'Web', payBy: '2026-10-25', reception: '8:00〜 本部', url: 'https://example.com/youkou' });
  const det = st.events.find((e) => e.key === race.key).detail;
  assert.deepStrictEqual([det.organizer, det.applyBy, det.applyHow, det.payBy, det.reception, det.url], ['市陸上競技協会', '2026-10-18', 'Web', '2026-10-25', '8:00〜 本部', 'https://example.com/youkou']);
  assert.ok(gas.line(dm('U1'), '新着').includes('申込期限が近い：秋季記録会'), '役員の新着に出る');
  gas.ctx.api(k2, 'saveEntry', { key: race.key, child: '鈴木けんた', join: '参加', races: [] });
  assert.throws(() => gas.ctx.api(k2, 'addDoc', { key: race.key, kind: '要項', url: 'https://example.com' }), /当番の人だけ/);
  st = gas.ctx.api(kAdmin, 'addDoc', { key: race.key, kind: '申込書', name: '申込書（記入例）', url: 'https://example.com/form' });
  const pdf = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 test').toString('base64');
  st = gas.ctx.api(kAdmin, 'addDoc', { key: race.key, kind: 'プログラム', name: 'プログラム', data: pdf });
  assert.deepStrictEqual(st.docs.map((x) => x.type), ['link', 'pdf']);
  assert.strictEqual(gas.ctx.api(k3, 'doc', { id: st.docs[1].id }).data, pdf, 'メンバーは資料を見られる');
  assert.throws(() => gas.ctx.api(kAdmin, 'addDoc', { key: race.key, kind: '要項', data: 'data:text/html;base64,AAAA' }), /写真かPDF/);
  assert.strictEqual(st.photos.length, 0, '資料はアルバムに出さない');
  gas.ctx.api(kAdmin, 'setTask', { key: race.key, kind: 'エントリー控え', target: '', done: true });
  gas.ctx.api(kAdmin, 'setTask', { key: race.key, kind: '受付', target: '', done: true });
  st = gas.ctx.api(k3, 'bootstrap');
  const hist = st.history.filter((x) => x.key === race.key).map((x) => x.text);
  assert.deepStrictEqual(hist, ['受付 済', 'エントリー控え 済', '資料を追加：プログラム', '資料を追加：申込書（申込書（記入例））', 'エントリー：鈴木けんた 参加', '大会の案内をつくりました'], '新しい順');
  assert.ok(!gas.line(dm('U1'), '新着').includes('申込期限が近い'), '申込済みなら出ない');
});
test('締切: 手続きごとに日時を入れられ、役員の新着に出る', () => {
  const gas = createGas({ now: '2026-11-01T08:00:00+09:00' });
  gas.init();
  gas.calendar.add({ title: '秋季記録会', start: new Date('2026-11-01T00:00:00+09:00'), end: new Date('2026-11-02T00:00:00+09:00'), allDay: true });
  gas.profiles.U1 = '山田'; gas.profiles.U2 = '鈴木'; gas.members.add('U1'); gas.members.add('U2');
  gas.line(dm('U1'), '登録 山田たろう 3年');
  const kAdmin = gas.login('U1').key, k2 = gas.login('U2').key;
  gas.sheet('家族').data.forEach((r) => { if (r[0] === 'U1') r[3] = '○'; });
  const race = gas.ctx.api(kAdmin, 'bootstrap').events[0];
  assert.throws(() => gas.ctx.api(k2, 'setDeadline', { key: race.key, kind: 'リレー予選', at: '2026-11-01 10:00' }), /当番の人だけ/);
  assert.throws(() => gas.ctx.api(kAdmin, 'setDeadline', { key: race.key, kind: 'リレー予選', at: '10時' }), /読めません/);
  let st = gas.ctx.api(kAdmin, 'setDeadline', { key: race.key, kind: 'リレー予選', at: '2026-11-01 10:00' });
  assert.strictEqual(st.events[0].detail.deadlines['リレー予選'], '2026-11-01 10:00');
  gas.ctx.api(kAdmin, 'setTask', { key: race.key, kind: 'リレー予選', target: 'Aチーム', memo: '1走 山田たろう' });
  assert.ok(gas.line(dm('U1'), '新着').includes('⏰ リレー予選のオーダー：11/01 10:00まで'));
  gas.ctx.api(kAdmin, 'setTask', { key: race.key, kind: 'リレー予選', target: 'Aチーム', done: true });
  assert.ok(!gas.line(dm('U1'), '新着').includes('リレー予選のオーダー'), '提出済みなら出ない');
  st = gas.ctx.api(kAdmin, 'setDeadline', { key: race.key, kind: 'リレー予選', at: '' });
  assert.deepStrictEqual(plain(st.events[0].detail.deadlines), {});
  assert.ok(st.history.some((h) => h.text === '締切：リレー予選のオーダー 11/1(日) 10:00まで'));
});
test('Bot「今日」: 予選・決勝がある種目は、進むまで「（進んだら）」と出る', () => {
  const gas = createGas({ now: '2026-11-01T08:00:00+09:00' });
  gas.init();
  gas.calendar.add({ title: '秋季記録会', start: new Date('2026-11-01T00:00:00+09:00'), end: new Date('2026-11-02T00:00:00+09:00'), allDay: true });
  gas.profiles.U1 = '山田'; gas.members.add('U1');
  gas.line(dm('U1'), '登録 山田たろう 5年');
  const k = gas.login('U1').key;
  gas.sheet('家族').data.forEach((r) => { if (r[0] === 'U1') r[3] = '○'; });
  const race = gas.ctx.api(k, 'bootstrap').events[0];
  gas.ctx.api(k, 'saveRace', { key: race.key, title: '秋季記録会', date: '2026-11-01', races: ['100m'] });
  gas.ctx.api(k, 'saveEntry', { key: race.key, child: '山田たろう', join: '参加', races: ['100m'] });
  let st = gas.ctx.api(k, 'saveTimetable', { key: race.key, rows: [{ start: '10:00', race: '100m', group: '5年男子', heat: '予選 1組', call: '9:40' }, { start: '14:00', race: '100m', group: '5年男子', heat: '決勝', call: '13:40' }] });
  let r = gas.line(dm('U1'), '今日');
  assert.ok(r.includes('10:00 100m 予選 1組　招集 9:40') && r.includes('14:00 100m 決勝　招集 13:40（進んだら）'), r);
  const fin = st.timetable.find((x) => x.heat === '決勝');
  gas.ctx.api(k, 'setTask', { key: race.key, kind: '進出', target: '山田たろう|' + fin.id, done: true });
  r = gas.line(dm('U1'), '今日');
  assert.ok(!r.includes('（進んだら）'), r);
});
test('記録: 役員が過去の記録をまとめて入れられる（大会なし）', () => {
  const gas = setupClub();
  gas.line(dm('U2'), '登録 鈴木けんた 5年');
  const kAdmin = gas.login('U1').key, k2 = gas.login('U2').key;
  gas.sheet('家族').data.forEach((r) => { if (r[0] === 'U1') r[3] = '○'; });
  assert.throws(() => gas.ctx.api(k2, 'addRecords', { rows: [] }), /役員だけ/);
  const st = gas.ctx.api(kAdmin, 'addRecords', { rows: [{ child: '鈴木けんた', race: '100m', record: '１５．８０', date: '2026-06-01', meet: '春季記録会' }, { child: 'だれか', race: '100m', record: '14.0' }] });
  assert.ok(st.message.startsWith('1件の記録を入れました') && st.message.includes('登録されていません'), st.message);
  assert.deepStrictEqual([st.results[0].record, st.results[0].date, st.results[0].meet], ['15.80', '2026-06-01', '2026-06-01 春季記録会']);
});
test('記録: 大会のページで入れた結果は公式、練習の記録は練習（ベストは別々）', () => {
  const gas = setupClub();
  gas.line(dm('U2'), '登録 鈴木けんた 5年');
  const kAdmin = gas.login('U1').key, k2 = gas.login('U2').key;
  gas.sheet('家族').data.forEach((r) => { if (r[0] === 'U1') r[3] = '○'; });
  const race = gas.ctx.api(kAdmin, 'bootstrap').events.find((e) => e.title === '秋季記録会');
  let st = gas.ctx.api(k2, 'saveResult', { key: race.key, child: '鈴木けんた', race: '100m', record: '15.2' });
  assert.strictEqual(st.results[0].kind, '公式');
  st = gas.ctx.api(k2, 'saveResult', { key: race.key, child: '鈴木けんた', race: '100m', record: '14.9', kind: '練習' });
  assert.strictEqual(st.results[1].kind, '練習');
  st = gas.ctx.api(kAdmin, 'addRecords', { kind: '練習', rows: [{ child: '鈴木けんた', race: '100m', record: '14.8' }] });
  assert.strictEqual(st.results[2].kind, '練習');
});
test('予定づくり: ポータルでまとめて作る・直す・中止', () => {
  const gas = setupClub();
  gas.line(dm('U1'), '登録 山田たろう 3年');
  const k = gas.login('U1').key;
  gas.sheet('家族').data.forEach((r) => { if (r[0] === 'U1') r[3] = '○'; });
  let st = gas.ctx.api(k, 'savePractices', { dates: ['2026-10-27', '2026-10-29', '2026-10-27'], start: '17:00', end: '18:30', title: '練習', place: '第二小学校' });
  assert.ok(st.message.includes('2日分'));
  const ev = st.events.find((e) => e.date === '2026-10-27');
  assert.deepStrictEqual([ev.start, ev.end, ev.type, ev.place], ['17:00', '18:30', '練習', '第二小学校']);
  st = gas.ctx.api(k, 'editEvent', { key: ev.key, date: '2026-10-28', start: '18:00', end: '19:30', title: '練習', place: '河北中' });
  const moved = st.events.find((e) => e.key === ev.key);
  assert.deepStrictEqual([moved.date, moved.start, moved.place], ['2026-10-28', '18:00', '河北中']);
  st = gas.ctx.api(k, 'cancelEvent', { key: ev.key });
  assert.strictEqual(st.events.find((e) => e.key === ev.key).cancelled, true);
  gas.ctx.api(k, 'refresh');
  assert.strictEqual(gas.rows('予定').find((r) => r.eventKey === ev.key)['状態'], '中止', '同期しても中止のまま');
});

test('予定入力シート: PCで書いた行がカレンダーに入る', () => {
  const gas = setupClub();
  assert.strictEqual(gas.run("parseDateCell_('10/20(火)')"), '2026-10-20');
  assert.strictEqual(gas.run("parseDateCell_('2月3日')"), '2027-02-03', '年を省くと近い先の日付');
  assert.strictEqual(gas.run("parseDateCell_('2026/2/30')"), '');
  assert.strictEqual(gas.run("parseTimeCell_('１８時半')"), '18:30');
  assert.strictEqual(gas.run("parseTimeCell_('1700')"), '17:00');
  assert.strictEqual(gas.run("parseTimeCell_('あさ')"), null);
  const add = (o) => gas.run('appendRow_(SHEETS.SCHEDULE_INPUT, ' + JSON.stringify(o) + ')');
  add({ '日付': '10/27', '開始': '1700', '終了': '18:30', 'タイトル': '練習', '場所': '第二小学校' });
  add({ '日付': '11/15', 'タイトル': '市民マラソン', '種別': '大会' });
  add({ '日付': 'あした', 'タイトル': '練習' });
  assert.strictEqual(gas.run('importScheduleSheet_()'), 2);
  let rows = gas.rows('予定入力');
  assert.ok(rows[0]['状態'].startsWith('✅'));
  assert.strictEqual(rows[0]['日付'], '2026-10-27', '日付の書き方をそろえる');
  assert.ok(rows[2]['状態'].includes('日付が読めません'));
  const ce = gas.calendar.events.find((e) => e.title === '練習' && e.location === '第二小学校' && !e.allDay && gas.ctx.Utilities.formatDate(e.start, '', 'yyyy-MM-dd') === '2026-10-27');
  assert.ok(ce, 'カレンダーに入った');
  assert.ok(gas.calendar.events.find((e) => e.title === '市民マラソン').allDay, '時刻なしは終日');
  assert.strictEqual(gas.rows('予定').find((r) => r['タイトル'] === '市民マラソン')['種別'], '大会');
  assert.strictEqual(gas.run('importScheduleSheet_()'), 0, '変わっていなければ何もしない');
  gas.sheet('予定入力').data[1][1] = '18:00';
  gas.sheet('予定入力').data[1][2] = '19:30';
  assert.strictEqual(gas.run('importScheduleSheet_()'), 1);
  assert.strictEqual(gas.ctx.Utilities.formatDate(ce.start, '', 'HH:mm'), '18:00', '書きかえるとカレンダーも直る');
  gas.sheet('予定入力').data[1][6] = '○';
  gas.run('importScheduleSheet_()');
  assert.ok(!gas.calendar.events.includes(ce), '削除に○でカレンダーから消える');
  assert.strictEqual(gas.rows('予定入力')[0]['状態'], '削除しました');
});

test('前の版のシートに、新しい列の見出しが足される', () => {
  const gas = createGas();
  gas.init();
  const sh = gas.sheet('家族');
  sh.data[0] = sh.data[0].slice(0, 6);
  sh.data.push(['U9', '古い人', '', '', '', '']);
  gas.run("Object.keys(headersChecked__).forEach((k) => delete headersChecked__[k]); resetMemo_();");
  Object.keys(gas.cache).filter((k) => k.startsWith('hdr:')).forEach((k) => delete gas.cache[k]);
  gas.run('readRows_(SHEETS.FAMILIES)');
  assert.deepStrictEqual(sh.data[0].slice(6), ['家族ID', '休み通知', '新着確認']);
  assert.strictEqual(gas.rows('家族')[0].userId, 'U9');
});

test('Bot: グループでの個人的なコマンドは、送った人にだけ届く', () => {
  const gas = setupClub();
  gas.line(dm('U1'), '登録 山田たろう 3年');
  const before = gas.pushes().length;
  assert.strictEqual(gas.line(group('U1'), '記録'), '', 'グループには返さない');
  assert.ok(gas.privateTo('U1').includes('山田たろうさんの記録'), '本人にだけ届く');
  assert.strictEqual(gas.line(dm('U1'), '記録').includes('山田たろうさんの記録'), true, '1対1のトークではふつうに返信（無料）');
  assert.strictEqual(gas.pushes().length, before + 1);
  gas.notFriends.add('U2');
  const r = gas.line(group('U2'), '登録 鈴木けんた 5年');
  assert.ok(r.includes('友だち追加'), '友だちでない人には、グループで案内だけ');
  assert.strictEqual(gas.line(group('U3'), 'ヘルプ'), '', 'ヘルプもグループには返さない');
  assert.ok(gas.privateTo('U3').includes('Botの使い方'), 'ヘルプは本人にだけ');
});

test('一斉通知: 役員がLINEグループに送れる。通数が足りなければ送らない', () => {
  const gas = setupClub();
  gas.line(dm('U1'), '登録 山田たろう 3年');
  const kAdmin = gas.login('U1').key, k2 = gas.login('U2').key;
  gas.sheet('家族').data.forEach((r) => { if (r[0] === 'U1') r[3] = '○'; });
  assert.deepStrictEqual(plain(gas.ctx.api(kAdmin, 'broadcastInfo')), { limit: 200, used: 0, remaining: 200, members: 4 });
  assert.throws(() => gas.ctx.api(k2, 'broadcast', { text: 'x' }), /役員だけ/);
  const st = gas.ctx.api(kAdmin, 'broadcast', { text: '📢 明日の練習は中止です' });
  assert.ok(st.message.includes('4通ぶん'));
  const sent = gas.pushes().pop();
  assert.deepStrictEqual([sent.payload.to, sent.payload.messages[0].text], ['G1', '📢 明日の練習は中止です']);
  assert.strictEqual(gas.ctx.api(kAdmin, 'broadcastInfo').remaining, 196);
  gas.quotaUsed.n = 198;
  gas.cache.pushQuota && delete gas.cache.pushQuota;
  assert.throws(() => gas.ctx.api(kAdmin, 'broadcast', { text: 'x' }), /足りません/);
});
test('写真: アルバムはポータルで見る。前の版の行も出る。消せるのは上げた人と役員', () => {
  const gas = setupClub();
  gas.line(dm('U1'), '登録 山田たろう 3年');
  const kAdmin = gas.login('U1').key, k2 = gas.login('U2').key, k3 = gas.login('U3').key;
  gas.sheet('家族').data.forEach((r) => { if (r[0] === 'U1') r[3] = '○'; });
  const img = 'data:image/jpeg;base64,' + Buffer.from('jpegdata').toString('base64');
  const prac = gas.ctx.api(k2, 'bootstrap').events.find((e) => e.date === '2026-10-15');
  let st = gas.ctx.api(k2, 'uploadPhoto', { key: prac.key, data: img });
  assert.strictEqual(st.photos.length, 1, '練習の写真もアルバムに出る');
  const old = gas.ctx.DriveApp.getFolderById().createFile({ getBytes: () => [1, 2], getContentType: () => 'image/jpeg', name: 'old.jpg' });
  gas.run(`appendRow_(SHEETS.PHOTOS, { '日時': '2026-10-01 10:00:00', eventKey: '', '予定': '', userId: 'U3', '表示名': '佐藤', 'ファイル名': 'old.jpg', URL: 'https://drive.google.com/file/d/${old.getId()}xxxxxxxxxx/view' })`);
  gas.files[old.getId() + 'xxxxxxxxxx'] = old;
  st = gas.ctx.api(k3, 'bootstrap');
  assert.strictEqual(st.photos.length, 2, '前の版（ファイルIDなし）の行も、URLから見つける');
  assert.strictEqual(st.photoFolderUrl, '', 'ドライブのリンクは役員だけ');
  const th = gas.ctx.api(k3, 'thumbs', { ids: st.photos.map((p) => p.id).concat(['secret']) });
  assert.deepStrictEqual(Object.keys(th).length, 2, 'シートにない写真は返さない');
  const mine = st.photos.find((p) => p.by === '鈴木');
  assert.throws(() => gas.ctx.api(k3, 'deletePhoto', { id: mine.id }), /上げた人と役員/);
  st = gas.ctx.api(k2, 'deletePhoto', { id: mine.id });
  assert.strictEqual(st.photos.length, 1);
  assert.ok(gas.files[mine.id].trashed, 'ドライブではゴミ箱へ');
  assert.ok(gas.ctx.api(kAdmin, 'bootstrap').photoFolderUrl);
  gas.line(group('U3'), '写真');
  const r = gas.privateTo('U3');
  assert.ok(r.includes('kahokuss.github.io/portal/?tab=album') && !r.includes('drive.google'), r);
});
test('Bot: 新着・今日・予定・休み・当番・出欠・エントリーに答える（ボタンつき）', () => {
  const gas = setupClub();
  gas.line(dm('U1'), '登録 山田たろう 3年');
  gas.line(dm('U2'), '登録 鈴木けんた 5年');
  const kAdmin = gas.login('U1').key, k2 = gas.login('U2').key;
  gas.sheet('家族').data.forEach((r) => { if (r[0] === 'U1') r[3] = '○'; });
  let st = gas.ctx.api(kAdmin, 'bootstrap');
  const race = st.events.find((e) => e.title === '秋季記録会');
  const prac = st.events.find((e) => e.date === '2026-10-15');
  gas.ctx.api(kAdmin, 'saveRace', { key: race.key, title: '秋季記録会', date: '2026-11-01', target: '全員', fee: 500, deadline: '2026-10-22', races: ['100m'] });
  gas.ctx.api(kAdmin, 'setDuty', { key: prac.key, fam: 'U2', on: true });
  gas.ctx.api(kAdmin, 'saveNotice', { title: '集合時間の変更', body: '17:15集合です' });

  const news = gas.line(dm('U2'), '新着');
  assert.ok(news.includes('次の練習') && news.includes('10/15(木)'), news);
  assert.ok(news.includes('練習当番'), 'わが家の当番');
  assert.ok(news.includes('鈴木けんた 未回答'), 'エントリーの未回答');
  assert.ok(news.includes('集合時間の変更'), '新しいお知らせ');
  const last = gas.fetches.filter((f) => /reply$/.test(f.url)).pop();
  assert.ok(last.payload.messages.slice(-1)[0].quickReply.items.some((i) => i.action.text === '休み'), 'ボタンが付く');
  assert.ok(!gas.line(dm('U2'), '新着').includes('新しいお知らせ'), '一度見たお知らせは「新しい」にしない');

  const ab = gas.line(dm('U2'), '休み');
  assert.ok(ab.includes('休みの連絡をします'));
  const btn = gas.fetches.filter((f) => /reply$/.test(f.url)).pop().payload.messages[0].quickReply.items[0].action.text;
  assert.strictEqual(btn, '休み 鈴木けんた 2026-10-15', '次の練習の日のボタン');
  const r = gas.line(dm('U2'), '休み 明日 体調不良 熱っぽい');
  assert.ok(r.includes('10/15(木) 鈴木けんたのお休みを連絡しました（体調不良・熱っぽい）'), r);
  assert.strictEqual(gas.rows('休み')[0]['メモ'], '熱っぽい');
  assert.ok(gas.line(dm('U1'), '新着').includes('確認していない休みの連絡 1件'), '役員には確認待ち');
  assert.ok(gas.line(dm('U1'), '出欠').includes('鈴木けんた（体調不良・熱っぽい）'), '役員には理由も');
  assert.ok(!gas.line(dm('U3'), '出欠').includes('体調不良'), 'ほかの人には名前だけ');
  assert.ok(gas.line(dm('U2'), '休み取消').includes('取り消しました'));
  assert.strictEqual(gas.rows('休み').length, 0);

  assert.ok(gas.line(dm('U2'), '当番').includes('10/15(木)'));
  assert.ok(gas.line(dm('U2'), '予定').includes('秋季記録会'));
  assert.ok(gas.line(dm('U2'), 'エントリー').includes('鈴木けんた：未回答'));
  assert.ok(gas.line(dm('U2'), '今日').includes('今日の予定はありません'));
  assert.ok(gas.line(dm('U3'), '休み').includes('先にお子さんを登録'));
});
test('スプレッドシート: 書きかえてよい列は緑、裏方の列はかくし、「使い方」を前に', () => {
  const gas = createGas();
  gas.init();
  gas.run('decorateSheets_(); decorateSheets_();');
  const ss = gas.ctx.SpreadsheetApp.openById(gas.props.SPREADSHEET_ID);
  assert.deepStrictEqual(ss.getSheets().slice(0, 2).map((x) => x.getName()), ['使い方', '予定入力']);
  const fam = gas.sheet('家族');
  assert.strictEqual(fam.backgrounds[4], '#d9ead3', '役員の列は緑');
  assert.strictEqual(fam.backgrounds[1], '#eeeeee', 'userId は灰色');
  assert.ok(fam.hidden.includes(1) && fam.hidden.includes(3), 'userId とポータルキーはかくす');
  assert.strictEqual(fam.protections.filter((p) => p.desc === '自動で入る列：userId').length, 1, '2回実行しても保護は1つ');
  assert.ok(gas.sheet('使い方').data[0][0].includes('ポータルとLINE Botのデータ'));
});
test('ダウン: グループの「ダウン入ります」で時刻だけ記録（返事なし）、ポータルとBotに出る', () => {
  const gas = createGas({ now: '2026-10-15T18:20:00+09:00' });
  gas.init();
  const jst = (x) => new Date(x + '+09:00');
  gas.calendar.add({ title: '通常練習', start: jst('2026-10-15T17:00:00'), end: jst('2026-10-15T18:30:00'), location: '第二小学校' });
  Object.assign(gas.profiles, { U1: '山田', U2: '鈴木', U3: '佐藤' });
  ['U1', 'U2', 'U3'].forEach((u) => gas.members.add(u));
  gas.line(dm('U1'), '登録 山田たろう 3年');
  gas.line(dm('U2'), '登録 鈴木けんた 5年');
  const kAdmin = gas.login('U1').key, k2 = gas.login('U2').key, k3 = gas.login('U3').key;
  gas.sheet('家族').data.forEach((r) => { if (r[0] === 'U1') r[3] = '○'; });
  gas.ctx.api(kAdmin, 'bootstrap');
  const before = gas.fetches.length;
  assert.strictEqual(gas.line(group('U3'), 'ダウン入ります！'), '', 'グループには返さない');
  assert.strictEqual(gas.fetches.slice(before).filter((f) => /push|reply/.test(f.url)).length, 0, '通数は使わない');
  let st = gas.ctx.api(k3, 'bootstrap');
  assert.strictEqual(st.events[0].down, '18:20');
  assert.ok(gas.line(dm('U2'), '今日').includes('ダウンに入りました（18:20）'));
  assert.strictEqual(gas.line(group('U3'), 'ダウンジャケット忘れた'), '', 'ほかの話には反応しない');
  assert.strictEqual(gas.ctx.api(k3, 'bootstrap').events[0].down, '18:20');
  assert.throws(() => gas.ctx.api(k2, 'markDown', { key: st.events[0].key }), /当番の人だけ/);
  gas.ctx.api(kAdmin, 'setDuty', { key: st.events[0].key, fam: 'U2', on: true });
  st = gas.ctx.api(k2, 'markDown', { key: st.events[0].key, clear: true });
  assert.strictEqual(st.events[0].down, '');
});
test('変更連絡: 読み取り（日にち・時刻・場所・中止）', () => {
  const gas = createGas({ now: '2026-10-20T18:40:00+09:00' });
  const parse = (x) => plain(gas.run('parseScheduleNotice_(' + JSON.stringify(x) + ', "2026-10-20")'));
  assert.deepStrictEqual(parse('次の木曜日の練習について連絡です🫡\n\n16時50分から競技場で練習します🏃\n暗くなるのが早いので、少し早めに始められたらと思います。'), { date: '2026-10-22', start: '16:50', end: '', place: '競技場', cancel: false });
  assert.deepStrictEqual(parse('明日の練習は雨のため中止です'), { date: '2026-10-21', start: '', end: '', place: '', cancel: true });
  assert.deepStrictEqual(parse('10/24(土)の練習は9時〜11時、場所：河北中学校'), { date: '2026-10-24', start: '09:00', end: '11:00', place: '河北中学校', cancel: false });
  assert.deepStrictEqual(parse('来週の火曜の練習は5時半からです'), { date: '2026-10-27', start: '17:30', end: '', place: '', cancel: false });
  assert.strictEqual(parse('今日の練習ありがとうございました！'), null, '時刻・場所・中止がなければ連絡ではない');
  assert.strictEqual(parse('お疲れ様です！用事の為お休みします'), null);
});

test('変更連絡: グループの連絡を練習に結びつけ（返事なし）、役員がボタンで予定に反映', () => {
  const gas = createGas({ now: '2026-10-20T18:40:00+09:00' });
  gas.init();
  const jst = (x) => new Date(x + '+09:00');
  gas.calendar.add({ title: '練習', start: jst('2026-10-22T17:00:00'), end: jst('2026-10-22T18:30:00'), location: '第二小学校' });
  gas.calendar.add({ title: '練習', start: jst('2026-10-21T17:00:00'), end: jst('2026-10-21T18:30:00'), location: '第二小学校' });
  Object.assign(gas.profiles, { U1: '山田', U2: '彩' });
  ['U1', 'U2'].forEach((u) => gas.members.add(u));
  gas.line(dm('U1'), '登録 山田たろう 3年');
  const kAdmin = gas.login('U1').key, k2 = gas.login('U2').key;
  gas.sheet('家族').data.forEach((r) => { if (r[0] === 'U1') r[3] = '○'; });
  gas.ctx.api(kAdmin, 'bootstrap');
  const before = gas.fetches.filter((f) => /push|reply/.test(f.url)).length;
  assert.strictEqual(gas.line(group('U2'), '次の木曜日の練習について連絡です\n16時50分から競技場で練習します'), '');
  gas.line(group('U2'), '明日の練習は雨のため中止です');
  gas.line(group('U2'), '10/31の練習は9時から河北中で練習します');
  assert.strictEqual(gas.fetches.filter((f) => /push|reply/.test(f.url)).length, before, '返事はしない（通数なし）');
  let st = gas.ctx.api(k2, 'bootstrap');
  const notes = st.comments.filter((c) => c.kind === '変更連絡');
  assert.strictEqual(notes.length, 3);
  const thu = st.events.find((e) => e.date === '2026-10-22');
  assert.strictEqual(notes[0].key, thu.key, '木曜の練習に結びつく');
  assert.ok(gas.line(dm('U1'), '予定').includes('📣 変更連絡あり（彩さん）'));
  assert.ok(gas.line(dm('U1'), '新着').includes('予定にまだ反映していない変更連絡 3件'));
  assert.throws(() => gas.ctx.api(k2, 'applyNotice', { id: notes[0].id }), /役員だけ/);
  st = gas.ctx.api(kAdmin, 'applyNotice', { id: notes[0].id });
  const moved = st.events.find((e) => e.key === thu.key);
  assert.deepStrictEqual([moved.start, moved.end, moved.place], ['16:50', '18:20', '競技場'], '長さはそのまま');
  st = gas.ctx.api(kAdmin, 'applyNotice', { id: notes[1].id });
  assert.strictEqual(st.events.find((e) => e.date === '2026-10-21').cancelled, true, '中止');
  st = gas.ctx.api(kAdmin, 'applyNotice', { id: notes[2].id });
  const made = st.events.find((e) => e.date === '2026-10-31');
  assert.deepStrictEqual([made.start, made.end, made.place], ['09:00', '10:30', '河北中'], '予定にない日は練習をつくる');
  assert.ok(st.comments.filter((c) => c.kind === '変更連絡').every((c) => c.measure === '予定に反映しました'));
});

test('変更連絡: 「今週の土曜日」「雨の場合は15時30分頃に連絡」「〜に変更です」', () => {
  const gas = createGas({ now: '2026-10-23T08:40:00+09:00' });
  const parse = (x, d) => plain(gas.run('parseScheduleNotice_(' + JSON.stringify(x) + ', ' + JSON.stringify(d) + ')'));
  assert.deepStrictEqual(parse('今週の土曜日の練習について連絡です🏃\n\nスポレク出場選手は16時から総産で練習があります。\n雨の場合は15時30分頃に有無等の連絡をします。\nよろしくお願いします', '2026-10-22'),
    { date: '2026-10-24', start: '16:00', end: '', place: '総産', cancel: false }, '15時30分は終わりの時刻ではない');
  assert.deepStrictEqual(parse('明日の練習について連絡です\n\n13時30分から河北小の体育館に変更です🏃\n\nよろしくお願いします', '2026-10-23'),
    { date: '2026-10-24', start: '13:30', end: '', place: '河北小の体育館', cancel: false });
  assert.deepStrictEqual(parse('土曜の練習は9時〜11時です', '2026-10-23'), { date: '2026-10-24', start: '09:00', end: '11:00', place: '', cancel: false }, '幅で書けば終わりの時刻も');
});
test('ダウン: 「ダウンです。」でも記録する', () => {
  const gas = createGas();
  assert.ok(gas.run("DOWN_PATTERN.test('ダウンです。')"));
  assert.ok(gas.run("DOWN_PATTERN.test('今からダウンします')"));
  assert.ok(!gas.run("DOWN_PATTERN.test('ダウンジャケット忘れた')"));
});
test('Bot: 今月の通数を使い切ったら、グループには「1対1で送って」と案内（返信は無料）', () => {
  const gas = setupClub();
  gas.line(dm('U1'), '登録 山田たろう 3年');
  gas.quotaUsed.n = 200;
  const r = gas.line(group('U1'), '新着');
  assert.ok(r.includes('無料の通数を使い切った') && !r.includes('友だち追加'), r);
  assert.ok(gas.line(dm('U1'), '新着').includes('新着'), '1対1のトークは返信なので使える');
});
test('役員: 役員がポータルでほかの人を役員にでき、最後の1人は外せない', () => {
  const gas = setupClub();
  const kAdmin = gas.login('U1').key, k2 = gas.login('U2').key;
  gas.sheet('家族').data.forEach((r) => { if (r[0] === 'U1') r[3] = '○'; });
  assert.throws(() => gas.ctx.api(k2, 'setAdmin', { userId: 'U2', on: true }), /役員だけ/);
  assert.throws(() => gas.ctx.api(kAdmin, 'setAdmin', { userId: 'U1', on: false }), /1人もいなくなる/);
  gas.ctx.api(kAdmin, 'setAdmin', { userId: 'U2', on: true });
  assert.strictEqual(gas.ctx.api(k2, 'bootstrap').me.admin, true);
  gas.ctx.api(k2, 'setAdmin', { userId: 'U1', on: false });
  assert.strictEqual(gas.ctx.api(kAdmin, 'bootstrap').me.admin, false);
});
test('予定を表でまとめて直す: 何件かまとめて直し・中止できる', () => {
  const gas = setupClub();
  const k = gas.login('U1').key, k2 = gas.login('U2').key;
  gas.sheet('家族').data.forEach((r) => { if (r[0] === 'U1') r[3] = '○'; });
  const evs = gas.ctx.api(k, 'bootstrap').events.filter((e) => e.type === '練習');
  assert.throws(() => gas.ctx.api(k2, 'bulkEditEvents', { rows: [] }), /役員だけ/);
  const st = gas.ctx.api(k, 'bulkEditEvents', { rows: [
    { key: evs[0].key, date: evs[0].date, start: '16:50', end: '18:20', title: '練習', place: '競技場' },
    { key: evs[1].key, cancel: true },
    { key: 'nope', date: '2026-10-30', title: 'x' },
  ] });
  assert.ok(st.message.startsWith('2件を直しました') && st.message.includes('直せなかったもの'), st.message);
  const a = st.events.find((e) => e.key === evs[0].key);
  assert.deepStrictEqual([a.start, a.end, a.place], ['16:50', '18:20', '競技場']);
  assert.strictEqual(st.events.find((e) => e.key === evs[1].key).cancelled, true);
});
test('PCログイン: スマホで出した番号でPCから入れる（5分・1回だけ・まちがいが続いたら止める）', () => {
  const gas = setupClub();
  const k = gas.login('U2').key;
  const post = (body) => JSON.parse(gas.ctx.doPost({ parameter: {}, postData: { contents: JSON.stringify(body) } }).text);
  const c = gas.ctx.api(k, 'pcCode');
  assert.ok(/^\d{6}$/.test(c.code));
  const r = post({ action: 'codeLogin', payload: { code: c.code } });
  assert.strictEqual(r.ok.key, k, '同じ人としてログイン');
  assert.ok(post({ action: 'codeLogin', payload: { code: c.code } }).error.includes('ちがうか'), '1回だけ');
  for (let i = 0; i < 20; i++) post({ action: 'codeLogin', payload: { code: '000000' } });
  const c2 = gas.ctx.api(k, 'pcCode');
  assert.ok(post({ action: 'codeLogin', payload: { code: c2.code } }).error.includes('待って'), 'まちがいが続いたら止める');
});
test('陣地: 大会の日の「場所を取りました」と写真が、その大会の陣地に入る（返事なし）', () => {
  const gas = createGas({ now: '2026-10-18T07:10:00+09:00' });
  gas.init();
  gas.calendar.add({ title: '打吹・羽衣クロスカントリー大会', start: new Date('2026-10-18T00:00:00+09:00'), end: new Date('2026-10-19T00:00:00+09:00'), allDay: true });
  Object.assign(gas.profiles, { U1: '山田', U2: '鈴木' });
  ['U1', 'U2'].forEach((u) => gas.members.add(u));
  gas.line(dm('U2'), '登録 鈴木けんた 5年');
  const k = gas.login('U2').key;
  gas.ctx.api(k, 'bootstrap');
  const before = gas.fetches.filter((f) => /push|reply/.test(f.url)).length;
  assert.strictEqual(gas.line(group('U1'), 'おはようございます☀\n本部に向かって右側の階段に場所を取りました。'), '');
  gas.ctx.doPost({ parameter: { token: 'hook' }, postData: { contents: JSON.stringify({ events: [{ type: 'message', webhookEventId: 'img1', replyToken: 'r', timestamp: new Date('2026-10-18T07:11:00+09:00').getTime(), source: group('U1'), message: { type: 'image', id: 'm1' } }] }) } });
  assert.strictEqual(gas.fetches.filter((f) => /push|reply/.test(f.url)).length, before, '返事はしない');
  const st = gas.ctx.api(k, 'bootstrap');
  const t = st.tasks.find((x) => x.kind === '陣地');
  assert.ok(t && t.memo.includes('右側の階段') && t.photos.length === 1, JSON.stringify(t));
  assert.ok(gas.line(dm('U2'), '今日').includes('📍 陣地：おはようございます☀ 本部に向かって右側の階段'));
  const st2 = gas.ctx.api(k, 'setTask', { key: t.key, kind: '陣地', target: '', memo: '本部の右の階段（青いシート）', done: true });
  assert.strictEqual(st2.tasks.find((x) => x.kind === '陣地').memo, '本部の右の階段（青いシート）', 'だれでも直せる');
});
test('速さ: 読んだ表を覚えて使い回し、書きこんだら版を上げて読み直す', () => {
  const gas = setupClub();
  delete gas.props.NO_TABLE_CACHE;
  gas.line(dm('U1'), '登録 山田たろう 3年');
  const k = gas.login('U1').key;
  gas.sheet('家族').data.forEach((r) => { if (r[0] === 'U1') r[3] = '○'; });
  gas.run('invalidateAllTables_()');
  let reads = 0;
  const orig = gas.sheet('予定').getRange.bind(gas.sheet('予定'));
  gas.sheet('予定').getRange = (...a) => { reads++; return orig(...a); };
  gas.ctx.api(k, 'bootstrap');
  const first = reads;
  gas.ctx.api(k, 'bootstrap');
  assert.strictEqual(reads, first, '2回目はシートを読まない');
  let st = gas.ctx.api(k, 'savePractices', { dates: ['2026-10-28'], start: '17:00', end: '18:30', title: '練習', place: 'A' });
  assert.ok(st.events.some((e) => e.date === '2026-10-28'), '書きこんだら新しい内容');
  gas.sheet('子ども').data[1][1] = '4';
  assert.strictEqual(gas.ctx.api(k, 'bootstrap').kids[0].grade, 3, '手で直しても、編集のトリガーが来るまでは前のまま');
  gas.ctx.onScheduleSheetEdit({ range: { getSheet: () => gas.sheet('子ども') } });
  assert.strictEqual(gas.ctx.api(k, 'bootstrap').kids[0].grade, 4, '編集のトリガーで読み直す');
});
test('ポータル画面: URLに付けたキーでは開けない（ログインが必要）', () => {
  const gas = setupClub();
  const k = gas.login('U1').key;
  const html = gas.ctx.doGet({ parameter: { k: k } }).getContent();
  assert.ok(html.includes('var KEY = "";'));
  assert.ok(html.includes('access.line.me/oauth2/v2.1/authorize'));
  assert.ok(html.includes(encodeURIComponent('https://script.google.com/macros/s/TEST/exec')), 'Apps Script の画面から始めたログインは Apps Script に戻る');
});

test('既読・アンケート・集金（未納は本人と役員だけに見える）', () => {
  const gas = setupClub();
  gas.line(dm('U1'), '登録 山田たろう 3年');
  gas.line(dm('U2'), '登録 鈴木けんた 5年');
  gas.line(dm('U3'), '登録 佐藤ゆい 2年');
  const kA = gas.login('U1').key, k2 = gas.login('U2').key, k3 = gas.login('U3').key;
  gas.sheet('家族').data.forEach((r) => { if (r[0] === 'U1') r[3] = '○'; });
  // 既読
  gas.ctx.api(kA, 'saveNotice', { title: 'ゼッケン配布', body: '次の練習で', important: true });
  let st = gas.ctx.api(k2, 'bootstrap');
  const n = st.notices[0];
  assert.ok(n.important && !n.read && n.unread === undefined, '保護者には既読の一覧を見せない');
  assert.strictEqual(gas.ctx.api(k2, 'markRead', { ids: [n.id] }), '', '既読は軽く返す');
  gas.ctx.api(k2, 'markRead', { ids: [n.id] });
  assert.ok(gas.ctx.api(k2, 'bootstrap').notices[0].read);
  st = gas.ctx.api(kA, 'bootstrap');
  assert.strictEqual(st.notices[0].readCount, 1, '2回押しても1人');
  assert.ok(st.notices[0].unread.includes('佐藤') && !st.notices[0].unread.includes('鈴木'), JSON.stringify(st.notices[0]));
  // アンケート
  assert.throws(() => gas.ctx.api(k2, 'savePoll', { title: 'x', options: ['a', 'b'] }), /役員/);
  gas.ctx.api(kA, 'savePoll', { title: '送迎の車を出せますか', options: ['出せる', '出せない'], deadline: '2026-10-30' });
  let p = gas.ctx.api(k2, 'bootstrap').polls[0];
  gas.ctx.api(k2, 'answerPoll', { id: p.id, answers: ['出せる', 'ずる'] });
  gas.ctx.api(k3, 'answerPoll', { id: p.id, answers: ['出せない'] });
  gas.ctx.api(k3, 'answerPoll', { id: p.id, answers: ['出せる'] });
  p = gas.ctx.api(kA, 'bootstrap').polls[0];
  assert.deepStrictEqual(plain(p.counts), { '出せる': 2, '出せない': 0 }, '答え直しは上書き・選択肢にないものは捨てる');
  assert.strictEqual(p.total, 2);
  assert.ok(p.unanswered.some((x) => x.includes('山田')), JSON.stringify(p.unanswered));
  gas.ctx.api(kA, 'closePoll', { id: p.id });
  assert.throws(() => gas.ctx.api(k2, 'answerPoll', { id: p.id, answers: ['出せない'] }), /締め切/);
  gas.ctx.api(kA, 'closePoll', { id: p.id, reopen: true });
  assert.ok(!gas.ctx.api(k2, 'bootstrap').polls[0].closed);
  // 集金
  gas.ctx.api(kA, 'saveFee', { name: '年会費', amount: '３,０００', target: '3年生以上', deadline: '2026-11-30' });
  let f = gas.ctx.api(kA, 'bootstrap').fees[0];
  assert.strictEqual(f.amount, 3000);
  assert.deepStrictEqual(plain(f.kids).sort(), ['山田たろう', '鈴木けんた'].sort(), '対象の学年だけ');
  gas.ctx.api(kA, 'setFeePaid', { id: f.id, child: '山田たろう', paid: true });
  assert.throws(() => gas.ctx.api(k2, 'setFeePaid', { id: f.id, child: '鈴木けんた', paid: true }), /役員/);
  const f2 = gas.ctx.api(k2, 'bootstrap').fees[0];
  assert.deepStrictEqual(plain(f2.kids), ['鈴木けんた'], '保護者には自分の子の分だけ');
  assert.deepStrictEqual(plain(f2.paid), [], 'ほかの家が払ったかは見えない');
  assert.strictEqual(gas.ctx.api(k3, 'bootstrap').fees[0].kids.length, 0, '対象外の家');
  gas.ctx.api(kA, 'setFeePaid', { id: f.id, child: '山田たろう', paid: false });
  assert.deepStrictEqual(plain(gas.ctx.api(kA, 'bootstrap').fees[0].paid), []);
});

test('練習の出席（✓）と休みは入れかわる・練習のタイムは記録になり、同じ本目は上書き', () => {
  const gas = setupClub();
  gas.line(dm('U1'), '登録 山田たろう 3年');
  gas.line(dm('U2'), '登録 鈴木けんた 1年');
  const kA = gas.login('U1').key, k2 = gas.login('U2').key;
  gas.sheet('家族').data.forEach((r) => { if (r[0] === 'U1') r[3] = '○'; });
  let st = gas.ctx.api(k2, 'bootstrap');
  const prac = st.events.find((e) => e.date === '2026-10-15');
  assert.throws(() => gas.ctx.api(k2, 'setAttend', { key: prac.key, child: '山田たろう', on: true }), /お子さん/);
  gas.ctx.api(k2, 'reportAbsence', { child: '鈴木けんた', date: prac.date, reason: '体調不良' });
  gas.ctx.api(k2, 'setAttend', { key: prac.key, child: '鈴木けんた', on: true });
  st = gas.ctx.api(k2, 'bootstrap');
  assert.deepStrictEqual(plain(st.attends.map((a) => a.child)), ['鈴木けんた']);
  assert.ok(!st.absences.some((a) => a.child === '鈴木けんた'), '出席にすると休みは消える');
  gas.ctx.api(k2, 'reportAbsence', { child: '鈴木けんた', date: prac.date, reason: '家の都合' });
  st = gas.ctx.api(k2, 'bootstrap');
  assert.strictEqual(st.attends.length, 0, '休みにすると出席は消える');
  // タイム
  assert.throws(() => gas.ctx.api(k2, 'saveTimes', { key: prac.key, name: '加速走', run: 1, rows: [{ child: '鈴木けんた', race: '50m', record: '9.43' }] }), /当番/);
  gas.ctx.api(kA, 'saveTimes', { key: prac.key, name: '加速走', run: 1, rows: [{ child: '鈴木けんた', race: '50m', record: '9.43' }, { child: '山田たろう', race: '100m', record: '１７．１４' }, { child: 'だれか', race: '50m', record: '1' }] });
  gas.ctx.api(kA, 'saveTimes', { key: prac.key, name: '加速走', run: 1, rows: [{ child: '鈴木けんた', race: '50m', record: '9.38' }, { child: '山田たろう', race: '100m', record: '' }] });
  gas.ctx.api(kA, 'saveTimes', { key: prac.key, name: '加速走', run: 2, rows: [{ child: '鈴木けんた', race: '50m', record: '9.48' }] });
  const res = gas.ctx.api(k2, 'bootstrap').results.filter((r) => r.key === prac.key);
  assert.deepStrictEqual(plain(res.map((r) => [r.child, r.race, r.record, r.memo, r.kind])).sort(), [['鈴木けんた', '50m', '9.38', '加速走 1本目', '練習'], ['鈴木けんた', '50m', '9.48', '加速走 2本目', '練習']]);
});

test('自主トレ：家族だけが見られる・直す・消す・先の日は入れられない', () => {
  const gas = setupClub();
  gas.line(dm('U1'), '登録 山田たろう 3年');
  gas.line(dm('U2'), '登録 鈴木けんた 5年');
  const kA = gas.login('U1').key, k2 = gas.login('U2').key;
  gas.sheet('家族').data.forEach((r) => { if (r[0] === 'U1') r[3] = '○'; });
  const st0 = gas.ctx.api(k2, 'bootstrap');
  assert.throws(() => gas.ctx.api(k2, 'saveTraining', { date: st0.today, child: '山田たろう', kind: 'ランニング', km: 3 }), /わが家/);
  assert.throws(() => gas.ctx.api(k2, 'saveTraining', { date: '2099-01-01', child: '鈴木けんた', kind: 'ランニング', km: 3 }), /先の日/);
  assert.throws(() => gas.ctx.api(k2, 'saveTraining', { date: st0.today, child: '鈴木けんた', kind: '腹筋' }), /どれか/);
  gas.ctx.api(k2, 'saveTraining', { date: st0.today, child: '鈴木けんた', kind: 'ランニング', km: '３．５', min: 25, feel: '◎' });
  gas.ctx.api(k2, 'saveTraining', { date: st0.today, child: '鈴木けんた', kind: '腹筋', count: 30 });
  let t = gas.ctx.api(k2, 'bootstrap').training;
  assert.strictEqual(t.length, 2);
  assert.ok(t.some((x) => x.kind === 'ランニング' && x.km === 3.5 && x.min === 25 && x.feel === '◎'));
  assert.strictEqual(gas.ctx.api(kA, 'bootstrap').training.length, 0, '役員でもほかの家の記録は見えない');
  const run = t.find((x) => x.kind === 'ランニング');
  assert.throws(() => gas.ctx.api(kA, 'deleteTraining', { id: run.id }), /見つかりません/);
  gas.ctx.api(k2, 'saveTraining', { id: run.id, date: st0.today, child: '鈴木けんた', kind: 'ランニング', km: 4 });
  t = gas.ctx.api(k2, 'bootstrap').training;
  assert.strictEqual(t.length, 2, '直すと増えない');
  assert.strictEqual(t.find((x) => x.id === run.id).km, 4);
  gas.ctx.api(k2, 'deleteTraining', { id: run.id });
  assert.strictEqual(gas.ctx.api(k2, 'bootstrap').training.length, 1);
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
