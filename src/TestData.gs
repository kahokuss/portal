/**
 * 本番で試すための「テスト家族」（親A〜親D）。役員が管理画面から入れて、まとめて消す。
 * userId は TEST_ で始め、LINE には送らない（グループの確認・通知の対象にしない）。
 */
const TEST_FAMILIES = [
  { id: 'TEST_A', parent: '親A', kids: [{ name: 'テストA', grade: 3, sex: '男' }] },
  { id: 'TEST_B', parent: '親B', kids: [{ name: 'テストB', grade: 5, sex: '女' }] },
  { id: 'TEST_C', parent: '親C', kids: [{ name: 'テストC', grade: 6, sex: '男' }, { name: 'テストC2', grade: 1, sex: '女' }] },
  { id: 'TEST_D', parent: '親D', kids: [{ name: 'テストD', grade: 4, sex: '女' }] },
];

function isTestUser_(userId) {
  return /^TEST_/.test(String(userId || ''));
}

function testKidNames_() {
  const names = {};
  readRows_(SHEETS.CHILDREN).forEach((c) => { if (c['名前'] && splitNames_(c['保護者userId']).some(isTestUser_)) names[c['名前']] = true; });
  TEST_FAMILIES.forEach((f) => f.kids.forEach((k) => (names[k.name] = true)));
  return names;
}

/** テスト家族の一覧（役員の画面用） */
function testFamiliesFor_(ctx) {
  if (!ctx.admin) return [];
  const fams = readRows_(SHEETS.FAMILIES).filter((f) => isTestUser_(f.userId));
  const kids = readRows_(SHEETS.CHILDREN);
  return fams.map((f) => ({ id: f.userId, name: f['表示名'], kids: kids.filter((c) => splitNames_(c['保護者userId']).indexOf(f.userId) >= 0).map((c) => c['名前']) }));
}

/** 入れる（on）／まとめて消す（off） */
function testFamiliesAction_(ctx, p) {
  if (p.off) return clearTestData_();
  let added = 0;
  withLock_(() => {
    const fams = readRows_(SHEETS.FAMILIES), kids = readRows_(SHEETS.CHILDREN);
    TEST_FAMILIES.forEach((t) => {
      if (!fams.some((f) => f.userId === t.id)) {
        appendRow_(SHEETS.FAMILIES, { userId: t.id, '表示名': t.parent, 'ポータルキー': randomKey_(), '更新日時': now_(), 'グループ確認': now_() });
        added++;
      }
      t.kids.forEach((k) => {
        if (kids.some((c) => c['名前'] === k.name)) return;
        appendRow_(SHEETS.CHILDREN, { '名前': k.name, '学年': String(k.grade), '保護者userId': t.id, '更新日時': now_(), '性別': k.sex, '名簿': '○' });
      });
    });
  });
  return added ? 'テスト家族（親A〜親D）を入れました。試したら「まとめて消す」を押してください' : 'テスト家族はもう入っています';
}

/** テスト家族と、その子・家族にかかわる行（当番・エントリー・休み・記録・手続きなど）をまとめて消す */
function clearTestData_() {
  const kidNames = testKidNames_();
  let n = 0;
  withLock_(() => {
    Object.keys(SHEETS).forEach((k) => {
      const def = SHEETS[k], h = def.headers;
      const hit = (r) =>
        (h.indexOf('userId') >= 0 && isTestUser_(r.userId)) ||
        (h.indexOf('保護者userId') >= 0 && splitNames_(r['保護者userId']).some(isTestUser_)) ||
        (h.indexOf('連絡者userId') >= 0 && isTestUser_(r['連絡者userId'])) ||
        (h.indexOf('家族ID') >= 0 && isTestUser_(r['家族ID'])) ||
        (h.indexOf('子ども') >= 0 && kidNames[r['子ども']]) ||
        (h.indexOf('対象') >= 0 && kidNames[String(r['対象'] || '').split('|')[0]]);
      readRows_(def).filter(hit).forEach((r) => { clearRow_(def, r); n++; });
    });
  });
  return 'テスト家族と、かかわるデータ ' + n + '件を消しました';
}

/** 役員が、テスト家族としてポータルを見る（その家族のキーを返す） */
function testLoginAction_(ctx, p) {
  if (!isTestUser_(p.id)) throw new Error('テスト家族だけ切りかえられます。');
  const f = readRows_(SHEETS.FAMILIES).find((x) => x.userId === p.id);
  if (!f) throw new Error('テスト家族がいません。先に「テスト家族を入れる」を押してください。');
  return { key: f['ポータルキー'], name: f['表示名'] };
}
