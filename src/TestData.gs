/**
 * 本番で試すための「テスト家族」（親A〜親E）。役員が管理画面から入れて、まとめて消す。
 * userId は TEST_ で始め、LINE には送らない（グループの確認・通知の対象にしない）。
 */
// 保護者は家族ごとに1〜2人（父母・祖父母）。同じ家族ID で紐付け、子どもの保護者にも全員を入れる
// 仮の役員：親A＝会長、親B＝副会長・会計係、親C＝記録係・当番係、親D＝大会係（役員ページの係ごとの見え方を試す）
// 親E は役員でないふつうの保護者（大会ごとの「大会係」に選んで、役員でなくても入力できるかを試す）
const TEST_FAMILIES = [
  { id: 'TEST_A', role: '会長', guardians: [['TEST_A', '親A（母）'], ['TEST_A2', '親A（父）']], kids: [{ name: 'テストA', grade: 3, sex: '男' }] },
  { id: 'TEST_B', role: '副会長・会計係', guardians: [['TEST_B', '親B（母）']], kids: [{ name: 'テストB', grade: 5, sex: '女' }] },
  { id: 'TEST_C', role: '記録係・当番係', guardians: [['TEST_C', '親C（父）'], ['TEST_C2', '親C（祖母）']], kids: [{ name: 'テストC', grade: 6, sex: '男' }, { name: 'テストC2', grade: 1, sex: '女' }] },
  { id: 'TEST_D', role: '大会係', guardians: [['TEST_D', '親D（母）'], ['TEST_D2', '親D（祖父）']], kids: [{ name: 'テストD', grade: 4, sex: '女' }] },
  { id: 'TEST_E', role: '', staff: false, guardians: [['TEST_E', '親E（父）']], kids: [{ name: 'テストE', grade: 2, sex: '男' }] },
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

/** テスト家族の一覧（役員の画面用）：家族ごとに、保護者（その人として見られる）と子ども */
function testFamiliesFor_(ctx) {
  if (!ctx.admin) return [];
  const rows = readRows_(SHEETS.FAMILIES).filter((f) => isTestUser_(f.userId));
  const kids = readRows_(SHEETS.CHILDREN);
  const out = [];
  rows.forEach((f) => {
    const id = famIdOf_(f);
    let fam = out.find((x) => x.id === id);
    if (!fam) { fam = { id: id, guardians: [], kids: [], role: '' }; out.push(fam); }
    fam.guardians.push({ id: f.userId, name: f['表示名'] });
    fam.role = f['係'] || fam.role || '';
    kids.filter((c) => splitNames_(c['保護者userId']).indexOf(f.userId) >= 0).forEach((c) => { if (fam.kids.indexOf(c['名前']) < 0) fam.kids.push(c['名前']); });
  });
  return out;
}

/** 入れる（on）／まとめて消す（off） */
function testFamiliesAction_(ctx, p) {
  if (p.off) return clearTestData_();
  let added = 0;
  withLock_(() => {
    const fams = readRows_(SHEETS.FAMILIES), kids = readRows_(SHEETS.CHILDREN);
    TEST_FAMILIES.forEach((t) => {
      const ids = t.guardians.map((g) => g[0]);
      t.guardians.forEach((g) => {
        const f = fams.find((x) => x.userId === g[0]);
        // 仮の役員として、役員の印と係も入れる（親E はふつうの保護者）。入れた後に画面で係を変えたら、そのまま残す
        const mark = t.staff === false ? '' : '○';
        if (!f) { appendRow_(SHEETS.FAMILIES, { userId: g[0], '表示名': g[1], 'ポータルキー': randomKey_(), '更新日時': now_(), 'グループ確認': now_(), '家族ID': t.id, '役員': mark, '係': t.role }); added++; }
        else if (f['家族ID'] !== t.id) { f['家族ID'] = t.id; updateRow_(SHEETS.FAMILIES, f); }
      });
      // 子どもに、家族の保護者をみんな紐付ける
      t.kids.forEach((k) => {
        const c = kids.find((x) => x['名前'] === k.name);
        if (!c) appendRow_(SHEETS.CHILDREN, { '名前': k.name, '学年': String(k.grade), '保護者userId': ids.join(','), '更新日時': now_(), '性別': k.sex, '名簿': '○' });
        else if (ids.some((u) => splitNames_(c['保護者userId']).indexOf(u) < 0)) { c['保護者userId'] = splitNames_(c['保護者userId']).concat(ids).filter((u, i, a) => a.indexOf(u) === i).join(','); updateRow_(SHEETS.CHILDREN, c); }
      });
    });
  });
  return added ? 'テスト家族（親A〜親E、保護者' + added + '人）を入れました。試したら「まとめて消す」を押してください' : 'テスト家族はもう入っています';
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
        (h.indexOf('依頼家族ID') >= 0 && (isTestUser_(r['依頼家族ID']) || isTestUser_(r['代わり家族ID']))) ||
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
