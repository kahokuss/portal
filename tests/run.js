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

test('休みの通知: 受け取る係とその日の練習当番だけに届く。出欠はみんなに見える', () => {
  const gas = setupClub();
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
  gas.run("Object.keys(headersChecked__).forEach((k) => delete headersChecked__[k])");
  gas.run('readRows_(SHEETS.FAMILIES)');
  assert.deepStrictEqual(sh.data[0].slice(6), ['家族ID', '休み通知']);
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
