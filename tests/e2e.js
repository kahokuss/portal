// ポータル画面を本物のブラウザ（Playwright）で動かすテスト。
// サーバー側は src/*.gs をメモリ上のまね（gas-mock.js）で動かし、google.script.run をつなぐ。
//   node tests/e2e.js            … テストだけ
//   node tests/e2e.js --shots    … tests/screenshots/ に画面を保存
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');
const { createGas } = require('./gas-mock');

const SHOTS = process.argv.includes('--shots');
const shotDir = path.join(__dirname, 'screenshots');

function setupClub() {
  const gas = createGas();
  gas.init();
  const jst = (s) => new Date(s + '+09:00');
  [['2026-10-15', '17:00', '18:30', '第二小学校 校庭'], ['2026-10-17', '09:00', '11:00', '市民グラウンド'], ['2026-10-20', '17:00', '18:30', '第二小学校 校庭'], ['2026-10-22', '17:00', '18:30', '第二小学校 校庭']]
    .forEach((p) => gas.calendar.add({ title: '通常練習', start: jst(p[0] + 'T' + p[1] + ':00'), end: jst(p[0] + 'T' + p[2] + ':00'), location: p[3] }));
  gas.calendar.add({ title: '県小学生陸上競技大会', start: jst('2026-09-27T00:00:00'), end: jst('2026-09-28T00:00:00'), allDay: true, location: '県営陸上競技場' });
  gas.calendar.add({ title: '秋季記録会', start: jst('2026-11-01T00:00:00'), end: jst('2026-11-02T00:00:00'), allDay: true, location: '市営陸上競技場' });
  Object.assign(gas.profiles, { U1: '山田', U2: '鈴木', U3: '佐藤', X9: '部外者' });
  ['U1', 'U2', 'U3'].forEach((u) => gas.members.add(u));
  const dm = (u) => ({ type: 'user', userId: u });
  gas.line(dm('U1'), '登録 山田たろう 3年 山田はなこ 1年');
  gas.line(dm('U2'), '登録 鈴木けんた 5年');
  gas.line(dm('U3'), '登録 佐藤さくら 4年');
  gas.login('U1');
  gas.sheet('家族').data.forEach((r) => { if (r[0] === 'U1') r[3] = '○'; });
  return { gas, keys: { admin: 'U1', parent: 'U2' } };
}

// userId の人が LINE ログインして戻ってきた状態でポータルを開く（2回目以降の読み込みはログインなし）
async function openPortal(browser, gas, userId, name) {
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/fonts.googleapis.com/**', (r) => r.abort());
  await page.exposeFunction('__gasApi', (k, action, payload) => {
    try { return { ok: JSON.parse(JSON.stringify(gas.ctx.api(k, action, payload))) }; } catch (e) { return { err: e.message }; }
  });
  await page.addInitScript(() => {
    function runner() {
      let ok = () => {}, ng = () => {};
      const r = {
        withSuccessHandler(f) { ok = f; return r; },
        withFailureHandler(f) { ng = f; return r; },
        api(...a) { window.__gasApi(...a).then((res) => (res.err ? ng(new Error(res.err)) : ok(res.ok))); },
      };
      return r;
    }
    window.google = { script: { get run() { return runner(); } } };
  });
  let first = true;
  await page.route('https://portal.test/**', (r) => {
    const body = first && userId ? gas.login(userId).html : gas.ctx.doGet({ parameter: {} }).getContent();
    first = false;
    r.fulfill({ contentType: 'text/html; charset=utf-8', body });
  });
  await page.goto('https://portal.test/');
  if (userId) await page.waitForSelector('#nav:not([hidden])');
  page.errors = errors;
  page.shot = async (n) => { if (SHOTS) await page.screenshot({ path: path.join(shotDir, name + '-' + n + '.png'), fullPage: true }); };
  page.idle = () => page.waitForSelector('#busy[hidden]', { state: 'attached' });
  return page;
}

(async () => {
  if (SHOTS) fs.mkdirSync(shotDir, { recursive: true });
  const { gas, keys } = setupClub();
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const steps = [];
  const step = async (name, fn) => { await fn(); steps.push(name); console.log('ok   ' + name); };
  try {
    // ---- 役員 ----
    const a = await openPortal(browser, gas, keys.admin, 'admin');
    await step('役員: ホームに次の練習・次の大会が出る', async () => {
      const text = await a.textContent('#view');
      assert.ok(text.includes('10/15(木) 17:00〜18:30'), text);
      assert.ok(text.includes('秋季記録会'));
      assert.ok(await a.isVisible('[data-nav="admin"]'));
      await a.shot('1-home');
    });
    await step('役員: 案内文を貼り付けて大会をつくる', async () => {
      await a.click('[data-nav="admin"]');
      await a.click('[data-go="race"]');
      await a.click('[data-from="paste"]');
      await a.fill('#pasteIn', 'お疲れ様です\n11月22日の冬季ロードレース大会について連絡です\n\n集合時間…8時20分\n場所…東中学校(駐車場は観光駐車場などにお願いします)\n参加費…700円\n種目…2km\n持ち物…ユニフォーム、アスリートビブス、水筒\n\n寒さ対策に、ロングタイツは可です！\nよろしくお願いします');
      await a.click('#pasteForm button[type=submit]');
      assert.strictEqual(await a.inputValue('#d-title'), '冬季ロードレース大会');
      assert.strictEqual(await a.inputValue('#d-date'), '2026-11-22');
      assert.strictEqual(await a.inputValue('#d-meetTime'), '8:20');
      assert.strictEqual(await a.inputValue('#d-fee'), '700');
      assert.strictEqual(await a.inputValue('#d-deadline'), '2026-11-12');
      await a.shot('2-race-form');
      await a.click('#evForm button[type=submit]');
      await a.waitForSelector('#copyText');
      assert.ok((await a.textContent('#copyText')).includes('冬季ロードレース大会（11/22(日)）'));
      assert.ok(gas.calendar.events.some((e) => e.title === '冬季ロードレース大会'));
      const race = gas.rows('大会').find((r) => r['参加費'] === '700');
      assert.strictEqual(race['種目'], '2km');
      await a.shot('3-saved');
    });
    await step('役員: カレンダーから来た大会に案内を入れる（前回をコピー）', async () => {
      await a.click('[data-nav="events"]');
      await a.click('.ev:has-text("秋季記録会")');
      await a.click('#editRace');
      await a.fill('#d-meetPlace', '正面スタンド下');
      await a.click('[data-set="target|4年生以上"]');
      await a.click('[data-tog="races|100m"]');
      await a.click('[data-tog="races|走幅跳"]');
      await a.click('[data-set="fee|500"]');
      await a.fill('#d-meetTime', '750');
      await a.press('#d-meetTime', 'Tab');
      await a.click('#evForm button[type=submit]');
      await a.waitForSelector('#copyText');
      const row = gas.rows('大会').find((r) => r['集合場所'] === '正面スタンド下');
      assert.ok(row);
      assert.strictEqual(row['集合時刻'], '7:50');
      assert.strictEqual(row['対象'], '4年生以上');
      assert.strictEqual(row['種目'], '100m,走幅跳');
    });

    // ---- 保護者 ----
    const p = await openPortal(browser, gas, keys.parent, 'parent');
    await step('保護者: 管理メニューは出ない', async () => {
      assert.ok(!(await p.isVisible('[data-nav="admin"]')));
    });
    await step('保護者: エントリーする（参加・種目）', async () => {
      await p.click('[data-entry]');
      await p.click('[data-kid="鈴木けんた"] [data-join="参加"]');
      await p.idle();
      await p.click('[data-kid="鈴木けんた"] [data-race="100m"]');
      await p.idle();
      await p.click('[data-kid="鈴木けんた"] [data-race="走幅跳"]');
      await p.idle();
      const e = gas.rows('エントリー').find((r) => r['子ども'] === '鈴木けんた');
      assert.strictEqual(e['回答'], '参加');
      assert.strictEqual(e['種目'], '100m,走幅跳');
      const text = await p.textContent('#view');
      assert.ok(text.includes('参加費 ¥500 未払い'));
      await p.shot('1-entry');
    });
    await step('保護者: 休みを連絡する（LINEの通数は使わない）', async () => {
      await p.click('[data-nav="home"]');
      await p.click('#absBtn');
      await p.selectOption('#absDate', '2026-10-17');
      await p.selectOption('#absReason', '家の都合');
      await p.fill('#absMemo', '法事のため');
      await p.click('#absForm button[type=submit]');
      await p.waitForSelector('[data-unabs]');
      assert.strictEqual(gas.rows('休み')[0]['理由'], '家の都合');
      assert.ok(!gas.pushes().some((f) => f.payload.messages[0].text.includes('法事のため')), 'LINEの通知はしない（通数を節約）');
      await p.shot('2-absence');
    });
    await step('保護者: わが家で学年を直す', async () => {
      await p.click('[data-nav="family"]');
      await p.selectOption('[data-kg="0"]', '6');
      await p.click('#kidsForm button[type=submit]');
      await p.idle();
      assert.strictEqual(gas.rows('子ども').find((c) => c['名前'] === '鈴木けんた')['学年'], '6');
      await p.shot('3-family');
    });

    // ---- 役員：確認と集金・お知らせ ----
    await step('役員: 休みを確認・集金を済にする', async () => {
      await a.click('[data-nav="home"]');
      await a.click('#reload');
      await a.idle();
      await a.click('[data-ack]');
      await a.idle();
      assert.strictEqual(gas.rows('休み')[0]['確認'], '済');
      await a.click('[data-entry]');
      await a.click('[data-pay="鈴木けんた"]');
      await a.idle();
      assert.strictEqual(gas.rows('エントリー').find((r) => r['子ども'] === '鈴木けんた')['集金'], '済');
      await a.shot('4-entries');
    });
    await step('役員: お知らせを載せると保護者のホームに出る', async () => {
      await a.click('[data-nav="admin"]');
      await a.click('[data-go="notice"]');
      await a.click('[data-tpl="1"]');
      await a.click('#nForm button[type=submit]');
      await a.waitForSelector('#copyText');
      await a.waitForFunction(() => document.getElementById('bcInfo').textContent.includes('今月の残り'));
      a.once('dialog', (d) => d.accept());
      await a.click('#bcBtn');
      await a.idle();
      assert.ok(gas.pushes().some((f) => f.payload.to === 'G1' && f.payload.messages[0].text.includes('集合時間の変更')), 'Botからグループに送れる');
      await a.shot('5-broadcast');
      await p.click('[data-nav="home"]');
      await p.click('#reload');
      await p.idle();
      assert.ok((await p.textContent('#view')).includes('集合時間の変更'));
      await p.shot('4-home');
    });
    await step('役員: カレンダーで日にちをタップして練習をまとめてつくる', async () => {
      await a.click('[data-nav="admin"]');
      await a.click('[data-go="practice"]');
      await a.click('[data-day="2026-10-27"]');
      await a.click('[data-day="2026-10-29"]');
      await a.click('[data-ptime="18:00|19:30"]');
      await a.fill('#pr-place', '河北中学校');
      assert.ok((await a.textContent('#pracForm button[type=submit]')).includes('2日分'));
      await a.shot('5-practice');
      await a.click('#pracForm button[type=submit]');
      await a.idle();
      const made = gas.calendar.events.filter((e) => e.location === '河北中学校');
      assert.strictEqual(made.length, 2);
      assert.strictEqual(gas.ctx.Utilities.formatDate(made[0].start, '', 'HH:mm'), '18:00');
    });
    await step('役員: 練習当番を自動で入れ、大会当番をタップで決める', async () => {
      await a.click('#aBack');
      await a.click('[data-go="duty"]');
      await a.click('#autoDuty');
      await a.idle();
      assert.ok(gas.rows('当番').filter((d) => d['種類'] === '練習').length >= 5);
      await a.shot('6-duty');
      await a.click('[data-nav="events"]');
      await a.click('.ev:has-text("秋季記録会")');
      await a.click('[data-duty="U2"]');
      await a.idle();
      assert.ok(gas.rows('当番').some((d) => d['種類'] === '大会' && d['家族ID'] === 'U2'));
    });
    await step('役員: 練習の出欠（だれが休みか）が見える', async () => {
      await a.click('#back');
      await a.click('.ev:has-text("通常練習") >> nth=1');
      const text = await a.textContent('#view');
      assert.ok(text.includes('鈴木けんた 休み'), text);
      assert.ok(text.includes('練習当番'));
      await a.shot('7-practice-detail');
    });
    await step('大会当番: プログラムを貼り付けてタイムテーブルを入れる', async () => {
      await p.click('[data-nav="home"]');
      await p.click('#reload');
      await p.idle();
      assert.ok((await p.textContent('#view')).includes('わが家の当番'), 'ホームに当番のお知らせ');
      await p.click('[data-nav="events"]');
      await p.click('.ev:has-text("秋季記録会")');
      await p.click('[data-et="タイムテーブル"]');
      await p.click('#ttEdit');
      await p.fill('#ttIn', '10:30 5・6年男子 100m 2組 招集10:00\n11:20 4年女子 100m 招集10:50\n13:00 6年男子 走り幅跳び 招集 12:30\n13:10 予選 小学4.5.6年混合4X100mR 招集12:40\n8部 2km（小学生4～6年の男子） スタート9：30');
      await p.click('#ttPaste button[type=submit]');
      assert.strictEqual(await p.inputValue('[data-tt="0|group"]'), '5・6年男子');
      assert.strictEqual(await p.inputValue('[data-tt="0|call"]'), '10:00');
      assert.strictEqual(await p.inputValue('[data-tt="2|race"]'), '走り幅跳び');
      assert.deepStrictEqual(await Promise.all(['start', 'race', 'group', 'heat', 'call'].map((k) => p.inputValue('[data-tt="3|' + k + '"]'))), ['13:10', '4X100mR', '4.5.6年混合', '予選', '12:40']);
      assert.deepStrictEqual(await Promise.all(['start', 'race', 'group', 'memo'].map((k) => p.inputValue('[data-tt="4|' + k + '"]'))), ['9:30', '2km', '4~6年男子', '8部']);
      await p.click('[data-ttdel="4"]');
      await p.click('[data-ttdel="3"]');
      await p.shot('5-tt-edit');
      await p.click('#ttSave');
      await p.idle();
      assert.strictEqual(gas.rows('タイムテーブル').length, 3);
      const text = await p.textContent('#view');
      assert.ok(text.includes('招集 10:00') && text.includes('アップ 9:30頃'), text);
      assert.ok(!text.includes('4年女子'), 'わが家の子の種目だけ');
      await p.shot('6-tt-mine');
    });
    await step('保護者: 招集を報告し、プログラムの写真を付ける', async () => {
      await p.click('[data-call^="鈴木けんた|"] >> nth=0');
      await p.idle();
      assert.ok(gas.rows('手続き').some((t) => t['種類'] === '招集' && t['状態'] === '済'));
      await p.click('[data-et="手続き"]');
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
      await p.setInputFiles('[data-upl="プログラム|"]', { name: 'program.png', mimeType: 'image/png', buffer: png });
      await p.waitForSelector('.thumb img[src^="data:image"]');
      const prog = gas.rows('手続き').find((t) => t['種類'] === 'プログラム');
      assert.strictEqual(prog['状態'], '済');
      assert.ok((await p.textContent('#view')).includes('招集1/2'.replace('1/2', '')));
      await p.shot('7-tasks');
    });
    await step('保護者: レーンとナンバーを入れ、結果を記録すると自己ベストが出る', async () => {
      await p.click('[data-et="タイムテーブル"]');
      p.once('dialog', (d) => d.accept('186'));
      await p.click('[data-bib="鈴木けんた"]');
      await p.idle();
      p.once('dialog', (d) => d.accept('2組 5レーン'));
      await p.click('[data-lane^="鈴木けんた|"] >> nth=0');
      await p.idle();
      const text = await p.textContent('#view');
      assert.ok(text.includes('186') && text.includes('2組 5レーン'), text);
      await p.click('[data-et="結果"]');
      await p.click('[data-rrace="100m"]');
      await p.click('[data-rround="予選"]');
      await p.fill('#rs-rec', '15.21');
      await p.click('#resForm button[type=submit]');
      await p.idle();
      await p.click('[data-rround="決勝"]');
      await p.fill('#rs-rec', '14.98');
      await p.fill('#rs-place', '2');
      await p.click('#resForm button[type=submit]');
      await p.idle();
      assert.strictEqual(gas.rows('結果').length, 2);
      const t2 = await p.textContent('#view');
      assert.ok(/14\.98\s*2位\s*自己ベスト/.test(t2), t2);
      await p.shot('8-results');
      await p.click('[data-nav="family"]');
      assert.ok(/100m\s*14\.98/.test(await p.textContent('#view')), 'わが家の記録の表に自己ベスト');
      await p.click('[data-nav="events"]');
      await p.click('.ev:has-text("秋季記録会")');
      await p.click('[data-et="手続き"]');
      assert.ok((await p.textContent('#view')).includes('大会に払う合計'));
    });
    await step('保護者: 「写真」で、大会・練習ごとのアルバムが見られる', async () => {
      await p.click('[data-nav="album"]');
      await p.waitForSelector('.thumb img[src^="data:image"]');
      assert.ok((await p.textContent('#view')).includes('秋季記録会'));
      await p.click('.thumb');
      await p.waitForSelector('#vSave:not([hidden])');
      assert.ok(await p.isVisible('#vDel'), '自分が上げた写真は消せる');
      await p.shot('9-album');
      await p.click('#vClose');
    });
    await step('保護者: 練習のページでヒヤリハットを共有し、役員が対策を書く', async () => {
      await p.click('[data-nav="events"]');
      await p.click('.ev:has-text("通常練習") >> nth=0');
      await p.click('[data-ck="ヒヤリハット"]');
      await p.fill('#cm-place', '駐車場の出入口');
      await p.fill('#cm-body', '練習の帰り、車が急に出てきてぶつかりそうになった');
      p.once('dialog', (d) => d.accept());
      await p.click('#cmtForm button[type=submit]');
      await p.idle();
      assert.ok((await p.textContent('#view')).includes('対策：まだ'));
      await p.shot('10-nearmiss');
      await a.click('[data-nav="admin"]');
      await a.click('#reload');
      await a.idle();
      await a.click('[data-go="nearmiss"]');
      await a.fill('[data-mid]', '出入口に大人が1人立つ');
      await a.click('[data-msave]');
      await a.idle();
      assert.strictEqual(gas.rows('コメント')[0]['対策'], '出入口に大人が1人立つ');
      await a.shot('8-nearmiss');
      await p.click('[data-nav="home"]');
      await p.click('#reload');
      await p.idle();
      assert.ok((await p.textContent('#view')).includes('最近のヒヤリハット'));
    });
    await step('役員: 主催の申込期限・資料を入れると、大会の状況と履歴が見られる', async () => {
      await a.click('[data-nav="events"]');
      await a.click('.ev:has-text("秋季記録会")');
      await a.click('#editRace');
      await a.fill('#d-organizer', '市陸上競技協会');
      await a.fill('#d-applyBy', '2026-10-16');
      await a.click('[data-set="applyHow|Web"]');
      await a.fill('#d-reception', '8:00〜8:30 本部テント');
      await a.click('#evForm button[type=submit]');
      await a.waitForSelector('#copyText');
      await a.click('[data-ev]');
      let text = await a.textContent('#view');
      assert.ok(text.includes('大会の状況') && text.includes('申込期限') && text.includes('あと2日'), text);
      await a.click('#docAdd');
      await a.click('[data-dk="要項"]');
      await a.fill('#dc-name', '大会要項');
      await a.fill('#dc-url', 'https://example.com/youkou.pdf');
      await a.click('#docForm button[type=submit]');
      await a.idle();
      text = await a.textContent('#view');
      assert.ok(text.includes('大会要項') && text.includes('資料を追加：要項（大会要項）'), text);
      await a.shot('9-race-overview');
    });
    await step('役員: 種目タブでリレーのオーダーを予選・決勝に分けて入れ、締切を入れる', async () => {
      await a.click('#editRace');
      await a.click('[data-tog="races|リレー"]');
      await a.click('#evForm button[type=submit]');
      await a.waitForSelector('#copyText');
      await a.click('[data-ev]');
      await a.click('[data-et="種目"]');
      let text = await a.textContent('#view');
      assert.ok(text.includes('100m') && text.includes('走幅跳') && text.includes('オーダー提出'), text);
      a.once('dialog', (d) => d.accept('10:00'));
      await a.click('[data-dl="リレー予選"]');
      await a.idle();
      assert.ok(JSON.parse(gas.rows('大会').find((r) => r['集合場所'] === '正面スタンド下')['手続き期限'])['リレー予選'] === '2026-11-01 10:00');
      await a.click('[data-relayadd]');
      await a.fill('#rl-name', '4×100mR Aチーム');
      await a.selectOption('[data-rl="0"]', '鈴木けんた');
      await a.click('#relayForm button[type=submit]');
      await a.idle();
      await a.click('[data-relaycopy]');
      await a.idle();
      await a.click('[data-task^="リレー予選|"]');
      await a.idle();
      const rows = gas.rows('手続き').filter((t) => t['種類'].startsWith('リレー'));
      assert.deepStrictEqual(rows.map((t) => [t['種類'], t['メモ'], t['状態']]), [['リレー予選', '1走 鈴木けんた', '済'], ['リレー決勝', '1走 鈴木けんた', '']]);
      text = await a.textContent('#view');
      assert.ok(text.includes('11/1(日) 10:00まで'), text);
      await a.shot('10-races');
    });
    await step('当番: 予選と決勝がある種目は、決勝へ進んだ子だけ決勝の時刻が出る', async () => {
      await p.click('[data-nav="events"]');
      await p.click('.ev:has-text("秋季記録会")');
      await p.click('[data-et="タイムテーブル"]');
      await p.click('#ttEdit');
      await p.fill('[data-tt="0|heat"]', '予選 2組');
      await p.fill('#ttIn', '14:00 5・6年男子 100m 決勝 招集13:40');
      await p.click('#ttPaste button[type=submit]');
      await p.click('#ttSave');
      await p.idle();
      let text = await p.textContent('#view');
      assert.ok(text.includes('決勝に進んだら押してください'), text);
      assert.strictEqual(await p.isVisible('[data-call$="|' + gas.rows('タイムテーブル').find((r) => r['組'] === '決勝')['id'] + '"]'), false, '進む前は決勝の招集ボタンは出ない');
      await p.click('[data-adv][data-on="1"]');
      await p.idle();
      text = await p.textContent('#view');
      assert.ok(text.includes('決勝への進出を取り消す') && text.includes('招集 13:40'), text);
      assert.ok(gas.rows('手続き').some((t) => t['種類'] === '進出' && t['状態'] === '済'));
      await p.shot('11-final');
    });
    await step('グループの変更連絡が練習に出て、役員がボタンで予定に反映する', async () => {
      gas.line({ type: 'group', groupId: 'G1', userId: 'U2' }, '明日の練習について連絡です\n5時半から競技場で練習します');
      await a.click('[data-nav="home"]');
      await a.click('#reload');
      await a.idle();
      assert.ok((await a.textContent('#view')).includes('📣 変更連絡'));
      await a.click('[data-nav="events"]');
      await a.click('.ev:has-text("📣変更")');
      const text = await a.textContent('#view');
      assert.ok(text.includes('変更の連絡があります') && text.includes('10/15(木) 17:30〜・競技場'), text);
      await a.shot('11-notice');
      a.once('dialog', (d) => d.accept());
      await a.click('[data-apply]');
      await a.idle();
      const ce = gas.calendar.events.find((x) => x.location === '競技場');
      assert.ok(ce, 'カレンダーも直る');
      assert.ok((await a.textContent('#view')).includes('予定に反映しました'));
    });
    await step('役員（PC）: 広い画面で、予定を表でまとめて直す', async () => {
      await a.setViewportSize({ width: 1280, height: 900 });
      await a.click('[data-nav="admin"]');
      await a.click('[data-go="table"]');
      const row = a.locator('tr[data-row]').filter({ has: a.locator('input[data-f="date"][value="2026-10-20"]') });
      await row.locator('input[data-f="place"]').fill('河北中学校 体育館');
      await row.locator('input[data-f="place"]').press('Tab');
      await row.locator('input[data-f="start"]').fill('1800');
      await row.locator('input[data-f="start"]').press('Tab');
      assert.ok((await a.textContent('#tSave')).includes('1件をまとめて保存'));
      await a.shot('12-table-pc');
      await a.click('#tSave');
      await a.idle();
      assert.ok(gas.calendar.events.some((x) => x.location === '河北中学校 体育館' && gas.ctx.Utilities.formatDate(x.start, '', 'HH:mm') === '18:00'));
      await a.setViewportSize({ width: 420, height: 900 });
    });
    await step('PC: 写真・PDFをドラッグ＆ドロップで追加できる（何枚でも）', async () => {
      await a.setViewportSize({ width: 1280, height: 900 });
      await a.click('[data-nav="events"]');
      await a.click('.ev:has-text("秋季記録会")');
      await a.click('[data-et="写真"]');
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const before = gas.rows('写真').length;
      const drop = async (sel, files) => {
        const dt = await a.evaluateHandle((fs) => {
          const d = new DataTransfer();
          fs.forEach((f) => d.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: f.type })));
          return d;
        }, files);
        await a.dispatchEvent(sel, 'dragover', { dataTransfer: dt });
        await a.dispatchEvent(sel, 'drop', { dataTransfer: dt });
      };
      await drop('[data-drop-default]', [{ name: 'a.png', type: 'image/png', b64: png }, { name: 'b.png', type: 'image/png', b64: png }]);
      await a.waitForFunction(() => /2件を追加しました/.test(document.getElementById('view').textContent));
      assert.strictEqual(gas.rows('写真').length, before + 2, '2枚まとめて');
      await a.click('[data-et="概要"]');
      await drop('[data-drop^="doc|"]', [{ name: '大会要項.pdf', type: 'application/pdf', b64: 'JVBERi0xLjQ=' }]);
      await a.waitForFunction(() => /1件を追加しました/.test(document.getElementById('view').textContent));
      const doc = gas.rows('資料').find((d) => d['名前'] === '大会要項' && d['形式'] === 'pdf');
      assert.ok(doc && doc['種類'] === '要項' && doc['形式'] === 'pdf', 'ファイル名から種類を判断');
      await a.shot('13-dnd-pc');
      await a.setViewportSize({ width: 420, height: 900 });
    });
    await step('予定をカレンダーで見る（月の表・日にちを押すとその日の予定）', async () => {
      await a.click('[data-nav="events"]');
      await a.click('[data-f="カレンダー"]');
      assert.ok((await a.textContent('#view')).includes('2026年10月'));
      await a.click('[data-cd="2026-10-17"]');
      const text = await a.textContent('#view');
      assert.ok(text.includes('10/17(土)') && text.includes('市民グラウンド'), text);
      await a.click('[data-cm="1"]');
      assert.ok((await a.textContent('#view')).includes('2026年11月'));
      assert.ok(await a.isVisible('.mcal .c-race'), '大会は赤');
      await a.shot('14-calendar');
      await a.click('[data-f="一覧"]');
    });
    await step('役員: 過去の記録を貼り付けて取り込み、自己ベスト表とグラフを見る', async () => {
      await a.click('[data-nav="admin"]');
      await a.click('[data-go="records"]');
      await a.fill('#recIn', '鈴木けんた 100m 15.80 2026/6/1 春季記録会\n鈴木けんた 100m 15.45 2026/7/20 夏季記録会\nだれか 100m 14.0');
      await a.click('#recForm button[type=submit]');
      assert.ok((await a.textContent('#recSave')).includes('2件を入れる（公式）'), '名前が合わない行は入れない');
      await a.click('#recSave');
      await a.idle();
      assert.ok((await a.textContent('#view')).includes('2件の記録を入れました'));
      // 横に種目が並ぶ表（Excelからコピー）を、練習の記録として
      await a.fill('#recIn', '名前\t学年\t100m\t走幅跳\n鈴木 けんた\t6\t15.10 (10/10)\t3m60\n佐藤さくら\t4\t\t2m80');
      await a.click('[data-ikind="練習"]');
      await a.click('#recForm button[type=submit]');
      assert.ok((await a.textContent('#recSave')).includes('3件を入れる（練習）'));
      await a.click('#recSave');
      await a.idle();
      const prac = gas.rows('結果').filter((r) => r['区分'] === '練習');
      assert.deepStrictEqual(prac.map((r) => [r['子ども'], r['種目'], r['記録']]), [['鈴木けんた', '100m', '15.10'], ['鈴木けんた', '走幅跳', '3m60'], ['佐藤さくら', '走幅跳', '2m80']]);
      assert.ok(prac[0]['大会・練習'].startsWith('2026-10-10'), '（10/10）を日付として読む');
      await a.click('[data-rk="鈴木けんた"]');
      await a.waitForSelector('.rchart .pt');
      assert.strictEqual(await a.locator('.rchart .pt').count(), 5, '公式4回と練習1回の点');
      assert.ok(await a.isVisible('.legend'), '公式と練習の凡例');
      await a.click('.rchart .hit >> nth=0');
      assert.ok((await a.textContent('.rtip')).includes('春季記録会'));
      await a.shot('15-records');
      await a.click('[data-nav="events"]');
      await a.click('[data-f="カレンダー"]');
      await a.click('[data-cm="-1"]');
      assert.ok(await a.isVisible('.mcal .duty'), 'カレンダーに当番の名前');
      await a.click('[data-f="一覧"]');
    });
    await step('上のバーに「LINEへ」ボタンがある', async () => {
      assert.strictEqual(await p.getAttribute('#toLine', 'href'), 'https://line.me/R/nv/chat');
    });
    await step('再読み込みしても、ログインしたまま開ける', async () => {
      await p.reload();
      await p.waitForSelector('#nav:not([hidden])');
      assert.ok((await p.textContent('#me')).includes('鈴木'));
    });
    await step('ログアウトするとログイン画面に戻る', async () => {
      await p.click('[data-nav="family"]');
      await p.click('#logout');
      assert.ok(await p.isVisible('#loginBtn'));
      assert.ok((await p.getAttribute('#loginBtn', 'href')).startsWith('https://access.line.me/oauth2/v2.1/authorize?'));
      await p.reload();
      assert.ok(await p.isVisible('#loginBtn'), 'ログアウト後はキーが残っていない');
      await p.shot('5-login');
    });
    await step('グループのメンバーでない人は入れない', async () => {
      const x = await browser.newPage({ viewport: { width: 420, height: 900 } });
      await x.route('https://portal.test/**', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: gas.login('X9').html }));
      await x.route('**/fonts.googleapis.com/**', (r) => r.abort());
      await x.goto('https://portal.test/');
      await x.waitForSelector('#loginBtn');
      assert.ok((await x.textContent('#view')).includes('メンバーだけが見られる'));
      assert.ok(await x.isHidden('#nav'));
      if (SHOTS) await x.screenshot({ path: path.join(shotDir, 'outsider.png') });
      await x.close();
    });
    await step('GitHub Pages の画面：LINEログインして、休みの連絡まで使える', async () => {
      const PAGES = 'https://kahokuss.github.io/portal/';
      const html = fs.readFileSync(path.join(__dirname, '../docs/index.html'), 'utf8');
      const apiUrl = JSON.parse(html.match(/var API_URL = (".*?");/)[1]);
      const g = await browser.newPage({ viewport: { width: 420, height: 900 } });
      const errs = [];
      g.on('pageerror', (e) => errs.push(e.message));
      await g.route('**/fonts.googleapis.com/**', (r) => r.abort());
      await g.route(PAGES + '**', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
      // Apps Script のウェブアプリ（本物と同じ doPost を呼ぶ）
      await g.route(apiUrl, (r) => {
        const out = gas.ctx.doPost({ parameter: {}, postData: { contents: r.request().postData() } });
        r.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: out.text });
      });
      // LINE のログイン画面：すぐ「佐藤さん（U3）」として戻す
      await g.route('https://access.line.me/**', (r) => {
        const u = new URL(r.request().url());
        assert.strictEqual(u.searchParams.get('redirect_uri'), PAGES);
        const back = PAGES + '?code=login:U3&state=' + u.searchParams.get('state');
        r.fulfill({ contentType: 'text/html', body: '<script>location.replace(' + JSON.stringify(back) + ')</script>' });
      });
      await g.goto(PAGES);
      await g.click('#loginBtn');
      await g.waitForSelector('#nav:not([hidden])');
      assert.strictEqual(new URL(g.url()).search, '', 'code は URL から消す');
      assert.ok((await g.textContent('#me')).includes('佐藤'));
      await g.click('#absBtn');
      await g.click('#absForm button[type=submit]');
      await g.waitForSelector('[data-unabs]');
      assert.ok(gas.rows('休み').some((a) => a['子ども'] === '佐藤さくら'));
      await g.reload();
      await g.waitForSelector('#nav:not([hidden])');
      if (SHOTS) await g.screenshot({ path: path.join(shotDir, 'pages-home.png'), fullPage: true });
      assert.deepStrictEqual(errs, []);
      await g.close();
    });
    await step('家族: 招待番号を入れると、夫婦で子どもの登録が共通になる', async () => {
      await p.close();
      const p2 = await openPortal(browser, gas, keys.parent, 'parent2');
      await p2.click('[data-nav="family"]');
      await p2.click('#invite');
      await p2.waitForSelector('#copyText');
      const text = await p2.textContent('#copyText');
      const code = text.match(/招待番号 (\d{6})/)[1];
      assert.ok(text.includes('https://kahokuss.github.io/portal/?join=' + code));
      await p2.shot('family-invite');
      const s3 = await openPortal(browser, gas, 'U3', 'sato');
      await s3.click('[data-nav="family"]');
      await s3.fill('#joinCode', code);
      await s3.click('#joinForm button[type=submit]');
      await s3.idle();
      assert.ok((await s3.textContent('#me')).includes('鈴木けんた'));
      assert.ok((await s3.textContent('#view')).includes('鈴木さん'));
      a.errors.push(...p2.errors, ...s3.errors);
      await p2.close(); await s3.close();
    });
    await step('当番: 県スポレクの表（招集開始〜完了・アップの幅・小1女・ジャベ・全体アップ）を貼り付けて読み取る', async () => {
      const q = await openPortal(browser, gas, keys.parent, 'parent3');
      await q.click('[data-nav="events"]');
      await q.click('.ev:has-text("秋季記録会")');
      await q.click('[data-et="タイムテーブル"]');
      await q.click('#ttEdit');
      const n = await q.locator('.tte').count();
      await q.fill('#ttIn', "7:40 全体アップ 7:40〜8:40\n9:30 小1女50mタイムレース 招集9:00〜9:10 全体アップ\n10:00 小2男50mタイムレース 招集9:30〜9:40 アップ9:00〜9:20\n10:15 小3女100mタイムレース 招集9:45〜9:55 アップ9:00〜9:35\n10:35 小4女100m予選 招集10:05〜10:15 アップ9:00〜9:35\n10:50 小5女100m予選 招集10:20〜10:30 アップ9:40〜10:10\n11:05 小6女100m予選 招集10:35〜10:45 アップ9:40〜10:25\n11:20 小3男100m決勝 招集10:50〜11:00 アップ9:40〜10:25\n12:05 小6男100m予選 招集11:35〜11:45 アップ10:45〜11:25\n13:30 小男4×100mリレー予選 招集13:00〜13:10 アップ12:30〜12:50\n14:10 小女800mタイムレース 招集13:40〜13:50 アップ13:00〜13:30\n14:35 小4女100m決勝 招集14:05〜14:15 アップ13:00〜13:55\n14:40 小5女100m決勝 招集14:10〜14:20 アップ13:00〜13:55\n14:45 小6女100m決勝 招集14:15〜14:25 アップ13:00〜13:55\n15:00 小6男100m決勝 招集14:30〜14:40 アップ13:55〜14:20\n16:00 小男4×100mリレー決勝 招集15:30〜15:40 アップ14:50〜15:20\n9:30 小男幅跳び 招集8:50〜9:00 全体アップ\n9:30 小女幅跳び 招集8:50〜9:00 全体アップ\n9:30 小男ジャベ 招集8:50〜9:00 全体アップ\n9:30 小女ジャベ 招集8:50〜9:00 全体アップ\n11:00 小男高跳び 招集10:20〜10:30 アップ9:40〜10:10");
      await q.click('#ttPaste button[type=submit]');
      const row = (i) => Promise.all(['start', 'race', 'group', 'heat', 'call', 'warm', 'memo'].map((k) => q.inputValue('[data-tt="' + (n + i) + '|' + k + '"]')));
      assert.strictEqual(await q.locator('.tte').count(), n + 21, '21行');
      assert.deepStrictEqual((await row(0)).slice(0, 2), ['7:40', '全体アップ']);
      assert.deepStrictEqual(await row(1), ['9:30', '50m', '1年女子', 'タイムレース', '9:00〜9:10', '', 'アップは全体アップ']);
      assert.deepStrictEqual(await row(4), ['10:35', '100m', '4年女子', '予選', '10:05〜10:15', '9:00〜9:35', '']);
      assert.deepStrictEqual((await row(9)).slice(0, 5), ['13:30', '4×100mリレー', '男子', '予選', '13:00〜13:10']);
      assert.deepStrictEqual((await row(18)).slice(0, 3), ['9:30', 'ジャベ', '男子']);
      await q.click('#ttSave');
      await q.idle();
      assert.ok(gas.rows('タイムテーブル').some((r) => r['招集'] === '10:05〜10:15' && r['アップ'] === '9:00〜9:35'), '幅のある時刻も保存できる');
      const text = await q.textContent('#view');
      assert.ok(text.includes('全体') && text.includes('7:40〜8:40'), '全体アップが上に出る');
      assert.ok(text.includes('2種目ダブリ'), '時間の近い種目に注意が出る');
      await q.shot('12-sporec');
      a.errors.push(...q.errors);
      await q.close();
    });
    await step('PC: スマホに出した番号でログインできる（GitHub Pages の画面）', async () => {
      const PAGES = 'https://kahokuss.github.io/portal/';
      const html = fs.readFileSync(path.join(__dirname, '../docs/index.html'), 'utf8');
      const apiUrl = JSON.parse(html.match(/var API_URL = (".*?");/)[1]);
      const g = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const errs = [];
      g.on('pageerror', (e) => errs.push(e.message));
      await g.route('**/fonts.googleapis.com/**', (r) => r.abort());
      await g.route(PAGES + '**', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
      await g.route(apiUrl, (r) => r.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: gas.ctx.doPost({ parameter: {}, postData: { contents: r.request().postData() } }).text }));
      await g.goto(PAGES);
      await g.waitForSelector('#codeForm');
      const code = gas.ctx.api(gas.login('U1').key, 'pcCode').code;
      await g.fill('#pcCode', code);
      await g.click('#codeForm button');
      await g.waitForSelector('#nav:not([hidden])');
      assert.ok((await g.textContent('#me')).includes('山田'));
      if (SHOTS) await g.screenshot({ path: path.join(shotDir, 'pc-home.png') });
      assert.deepStrictEqual(errs, []);
      await g.close();
    });
    await step('画面のエラーなし', async () => {
      assert.deepStrictEqual(a.errors.concat(p.errors), []);
      assert.deepStrictEqual(gas.ctx.__errors, []);
    });
  } catch (e) {
    console.log('FAIL ' + (e.stack || e.message));
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
  if (!process.exitCode) console.log('all passed (' + steps.length + ' steps)');
})();
