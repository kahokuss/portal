/**
 * スプレッドシートを簡易データベースとして使う。
 * どのシートも1行目が見出しで、2行目以降がデータ。値はすべて文字列で保存する。
 */
const SHEETS = {
  FAMILIES: { name: '家族', headers: ['userId', '表示名', 'ポータルキー', '役員', '更新日時', 'グループ確認', '家族ID', '休み通知', '新着確認', 'コーチ', '役員申請', '係', '管理者'] },
  CHILDREN: { name: '子ども', headers: ['名前', '学年', '保護者userId', '更新日時', '性別', '名簿'] },
  EVENTS: { name: '予定', headers: ['eventKey', '日付', '開始', '終了', 'タイトル', '場所', 'カレンダーID', '種別', '状態', '更新日時', 'ダウン'] },
  RACES: { name: '大会', headers: ['eventKey', '種別', '対象', '参加費', '締切', '集合時刻', '集合場所', '種目', '持ち物', '注意', '更新日時', '主催', '申込期限', '申込方法', '支払期限', '受付', '要項URL', '手続き期限', '時刻表メモ', '時刻表下書き'] },
  ENTRIES: { name: 'エントリー', headers: ['eventKey', '子ども', '回答', '種目', '集金', '更新者', '更新日時'] },
  ABSENCES: { name: '休み', headers: ['id', '日付', '子ども', '理由', 'メモ', '連絡者userId', '連絡者', '確認', '確認者', '日時'] },
  NOTICES: { name: 'お知らせ', headers: ['id', '日付', 'タイトル', '本文', 'eventKey', '作成者', '日時', '重要'] },
  READS: { name: '既読', headers: ['お知らせid', 'userId', '日時'] },
  POLLS: { name: 'アンケート', headers: ['id', 'タイトル', '説明', '選択肢', '複数', '締切', 'eventKey', '作成者', '日時', '終了'] },
  ANSWERS: { name: '回答', headers: ['アンケートid', '家族ID', '回答', 'コメント', '更新者', '日時'] },
  FEES: { name: '集金', headers: ['id', '名前', '金額', '対象', '期限', 'メモ', '作成者', '日時', '終了'] },
  FEE_PAID: { name: '集金状況', headers: ['集金id', '子ども', '状態', '更新者', '日時'] },
  TRAINING: { name: '自主トレ', headers: ['id', '日付', '子ども', '種類', '距離km', '時間分', '回数', '調子', 'メモ', 'userId', '表示名', '日時'] },
  TRAIN_SHARE: { name: '自主トレ公開', headers: ['子ども', '公開', '更新者', '日時', '家族既読'] },
  TRAIN_COMMENTS: { name: '自主トレコメント', headers: ['id', '子ども', '本文', 'userId', '表示名', 'コーチ', '日時'] },
  APP_REQ: { name: 'アプリ連携の要望', headers: ['アプリ', 'userId', '表示名', '日時'] },
  ATTEND: { name: '出席', headers: ['日付', 'eventKey', '子ども', 'userId', '表示名', '日時'] },
  PHOTOS: { name: '写真', headers: ['日時', 'eventKey', '予定', 'userId', '表示名', 'ファイル名', 'URL', 'ファイルID', '種類'] },
  RESULTS: { name: '結果', headers: ['日時', 'eventKey', '大会・練習', '子ども', '種目', '記録', 'メモ', 'userId', '表示名', 'id', '順位', 'ラウンド', '区分'] },
  TIMETABLE: { name: 'タイムテーブル', headers: ['id', 'eventKey', '開始', '種目', '区分', '組', '招集', 'アップ', 'メモ', '更新日時'] },
  TASKS: { name: '手続き', headers: ['id', 'eventKey', '種類', '対象', '状態', 'メモ', '写真ID', '更新者', '日時'] },
  DUTIES: { name: '当番', headers: ['eventKey', '日付', '種類', '家族ID', '更新者', '更新日時'] },
  COMMENTS: { name: 'コメント', headers: ['id', 'eventKey', '種類', '本文', '場所', '公開', '写真ID', 'userId', '表示名', '日時', '対策', '対策者', '対策日時', '提案'] },
  DOCS: { name: '資料', headers: ['id', 'eventKey', '種類', '名前', 'URL', 'ファイルID', '形式', '追加者', '日時'] },
  HISTORY: { name: '履歴', headers: ['日時', 'eventKey', '表示名', '内容'] },
  LEDGER: { name: '会計', headers: ['id', '日付', 'eventKey', '種類', '金額', '相手', '但し書き', '写真ID', '記録者', '日時'] },
  SCHEDULE_INPUT: { name: '予定入力', headers: ['日付', '開始', '終了', 'タイトル', '場所', '種別', '削除', '状態', 'カレンダーID', '反映内容'] },
};

let ss__ = null;

function ss_() {
  if (!ss__) ss__ = SpreadsheetApp.openById(requireProp_('SPREADSHEET_ID'));
  return ss__;
}

function sheet_(def) {
  const ss = ss_();
  let sh = ss.getSheetByName(def.name);
  if (!sh) {
    sh = ss.insertSheet(def.name);
    sh.getRange(1, 1, sh.getMaxRows(), def.headers.length).setNumberFormat('@');
    sh.getRange(1, 1, 1, def.headers.length).setValues([def.headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  } else if (!headersChecked__[def.name] && CacheService.getScriptCache().get('hdr:' + def.name) !== String(def.headers.length)) {
    // 前の版で作ったシートに、あとから増えた列の見出しを足す（列は右端に足すだけなので、今のデータはずれない）
    const width = Math.max(sh.getLastColumn(), 1);
    const have = sh.getRange(1, 1, 1, width).getValues()[0].map(String);
    const missing = def.headers.filter((h) => have.indexOf(h) < 0);
    if (missing.length && def.headers.slice(0, have.filter(Boolean).length).every((h, i) => h === have[i])) {
      const from = have.filter(Boolean).length + 1;
      sh.getRange(1, from, sh.getMaxRows(), missing.length).setNumberFormat('@');
      sh.getRange(1, from, 1, missing.length).setValues([missing]).setFontWeight('bold');
    }
  }
  if (!headersChecked__[def.name]) CacheService.getScriptCache().put('hdr:' + def.name, String(def.headers.length), 21600);
  headersChecked__[def.name] = true;
  return sh;
}

const headersChecked__ = {};

/** 手入力で日付や時刻に自動変換されたセルも文字列に戻す */
function cellToString_(v, header) {
  if (v instanceof Date) {
    if (header.indexOf('日時') >= 0) return fmt_(v, 'yyyy-MM-dd HH:mm:ss');
    if (['開始', '終了', '記録', '集合時刻', '招集', 'アップ'].indexOf(header) >= 0) return fmt_(v, 'H:mm');
    return fmt_(v, 'yyyy-MM-dd');
  }
  return v === null || v === undefined ? '' : String(v);
}

/**
 * 全行をオブジェクトの配列で返す。_row に行番号が入る。
 * 速くするため、読んだ表は「同じ実行の中」と「CacheService（6時間）」に覚えておく。
 * 書きこむと表の版（スクリプト プロパティ TV_シート名）を上げるので、古い表は使われない。
 * スプレッドシートを手で直したときは、onScheduleSheetEdit（編集のトリガー）が版を上げる。
 * ロックの中（書きこむ前の読みこみ）では、必ずシートから読む。
 */
function readRows_(def) {
  const name = def.name;
  if (!lockDepth__ && memo__[name]) return memo__[name].map((o) => Object.assign({}, o));
  const useCache = tableCacheOn_();
  const ver = useCache ? tableVersion_(name, !!lockDepth__) : '';
  const key = 'tbl:' + name + ':' + ver + ':' + def.headers.length;
  let rows = null;
  if (useCache && !lockDepth__) {
    try { const hit = CacheService.getScriptCache().get(key); if (hit) rows = JSON.parse(hit); } catch (err) { rows = null; }
  }
  if (!rows) {
    rows = readSheetRows_(def);
    if (useCache) {
      try { const json = JSON.stringify(rows); if (json.length < 95000) CacheService.getScriptCache().put(key, json, 21600); } catch (err) { /* 大きすぎる表は覚えない */ }
    }
  }
  memo__[name] = rows;
  return rows.map((o) => Object.assign({}, o));
}

function readSheetRows_(def) {
  const sh = sheet_(def);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const values = sh.getRange(2, 1, last - 1, def.headers.length).getValues();
  return values
    .map((r, i) => {
      const o = { _row: i + 2 };
      def.headers.forEach((h, j) => (o[h] = cellToString_(r[j], h)));
      return o;
    })
    .filter((o) => def.headers.some((h) => o[h] !== ''));
}

let memo__ = {};
let props__ = null;
let lockDepth__ = 0;

/** 実行のはじめに呼ぶ（Webアプリ・LINE・トリガーの入口） */
function resetMemo_() {
  memo__ = {};
  props__ = null;
}

function tableCacheOn_() {
  return prop_('NO_TABLE_CACHE') !== '1';
}

function tableVersion_(name, fresh) {
  if (fresh || !props__) props__ = PropertiesService.getScriptProperties().getProperties();
  return props__['TV_' + name] || '0';
}

/** 表を書きかえたら、覚えている表を捨てて版を上げる */
function invalidateTable_(name) {
  delete memo__[name];
  if (!tableCacheOn_()) return;
  const v = String(Date.now()) + Math.floor(Math.random() * 1000);
  PropertiesService.getScriptProperties().setProperty('TV_' + name, v);
  if (props__) props__['TV_' + name] = v;
}

/** すべての表を読み直させる（「更新」ボタン・手での編集） */
function invalidateAllTables_() {
  Object.keys(SHEETS).forEach((k) => invalidateTable_(SHEETS[k].name));
}

function toValues_(def, obj) {
  return def.headers.map((h) => (obj[h] === null || obj[h] === undefined ? '' : String(obj[h])));
}

function appendRow_(def, obj) {
  const sh = sheet_(def);
  const row = sh.getLastRow() + 1;
  if (row > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 100);
  // 書式を文字列にしてから書き込み、「3:20」などが時刻に化けるのを防ぐ
  sh.getRange(row, 1, 1, def.headers.length).setNumberFormat('@').setValues([toValues_(def, obj)]);
  obj._row = row;
  invalidateTable_(def.name);
  return obj;
}

function updateRow_(def, obj) {
  sheet_(def).getRange(obj._row, 1, 1, def.headers.length).setNumberFormat('@').setValues([toValues_(def, obj)]);
  invalidateTable_(def.name);
}

/** 行を空にする（行番号がずれないよう、削除ではなく空欄にする） */
function clearRow_(def, obj) {
  sheet_(def).getRange(obj._row, 1, 1, def.headers.length).setValues([def.headers.map(() => '')]);
  invalidateTable_(def.name);
}

/** 複数人が同時に操作しても行が重複しないようにロックして実行する */
function withLock_(fn) {
  if (lockDepth__) return fn();
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  lockDepth__++;
  try {
    return fn();
  } finally {
    lockDepth__--;
    lock.releaseLock();
  }
}

// ---- 家族（LINE ユーザー） ----

function findFamily_(userId) {
  return readRows_(SHEETS.FAMILIES).find((f) => f.userId === userId) || null;
}

function findFamilyByKey_(key) {
  if (!key || !/^[A-Za-z0-9]{16,64}$/.test(key)) return null;
  return readRows_(SHEETS.FAMILIES).find((f) => f['ポータルキー'] === key) || null;
}

function isCoach_(family) {
  return !!family && /^(○|◯|〇|o|yes|true|1|コーチ)$/i.test(String(family['コーチ'] || '').trim());
}

function isAdminRow_(family) {
  return !!family && /^(○|◯|〇|o|yes|true|1|役員)$/i.test(String(family['役員']).trim());
}

/** 管理者（ポータルの持ち主）。一人ずつ。管理者はいつでも役員として扱う */
function isOwner_(family) {
  return !!family && /^(○|◯|〇|o|yes|true|1|管理者)$/i.test(String(family['管理者'] || '').trim());
}

/** 役員は家族ごと：家族のだれかに ○ があれば、同じ家族の人はみな役員 */
function isAdmin_(family) {
  if (!family) return false;
  if (isAdminRow_(family) || isOwner_(family)) return true;
  const id = famIdOf_(family);
  return readRows_(SHEETS.FAMILIES).some((f) => famIdOf_(f) === id && isAdminRow_(f));
}

/** 同じ家族の行（家族ごとの設定は、全員の行にそろえて書く） */
function familyRowsOf_(rows, famId) {
  return rows.filter((f) => famIdOf_(f) === famId);
}

/** 家族のまとまり（父母・祖父母・兄姉など）。まとめていない人は userId がそのまま家族ID */
function famIdOf_(family) {
  return family['家族ID'] || family.userId;
}

/** 同じ家族の保護者の userId（自分も入る） */
function familyMembers_(userId, families) {
  const rows = families || readRows_(SHEETS.FAMILIES);
  const me = rows.find((f) => f.userId === userId);
  if (!me) return [userId];
  const id = famIdOf_(me);
  return rows.filter((f) => famIdOf_(f) === id).map((f) => f.userId);
}

/** 家族の行を用意する（なければ作る）。表示名が分かれば更新する */
function ensureFamily_(userId, displayName) {
  return withLock_(() => {
    let f = findFamily_(userId);
    if (!f) {
      f = appendRow_(SHEETS.FAMILIES, { userId: userId, '表示名': displayName || '', 'ポータルキー': '', '役員': '', '更新日時': now_() });
    } else if (displayName && f['表示名'] !== displayName) {
      f['表示名'] = displayName;
      f['更新日時'] = now_();
      updateRow_(SHEETS.FAMILIES, f);
    }
    return f;
  });
}

/** ポータルにログインした人のキー（ブラウザに保存して、次からはログインを省く）。renew が true なら作り直す */
function portalKeyFor_(userId, displayName, renew) {
  const f = ensureFamily_(userId, displayName);
  if (f['ポータルキー'] && !renew) return f['ポータルキー'];
  return withLock_(() => {
    const fresh = findFamily_(userId);
    fresh['ポータルキー'] = randomKey_();
    fresh['更新日時'] = now_();
    updateRow_(SHEETS.FAMILIES, fresh);
    return fresh['ポータルキー'];
  });
}

// ---- 子ども ----

/** 名前の空白をのぞいてくらべる（「山田 たろう」と「山田たろう」は同じ子） */
function sameKidName_(a, b) {
  return String(a || '').replace(/\s|　/g, '') === String(b || '').replace(/\s|　/g, '');
}

/** 登録されている子ども：保護者が登録した子と、役員が名簿に入れた子（保護者がまだでも） */
function activeChildren_() {
  return readRows_(SHEETS.CHILDREN)
    .filter((c) => c['名前'] && (splitNames_(c['保護者userId']).length || c['名簿'] === '○'))
    .map((c) => ({ name: c['名前'], grade: Number(c['学年']) || 0, sex: c['性別'] === '男' || c['性別'] === '女' ? c['性別'] : '', parents: splitNames_(c['保護者userId']), _row: c._row }));
}

function childrenOf_(userId) {
  return activeChildren_().filter((c) => c.parents.indexOf(userId) >= 0);
}

function allChildren_() {
  return activeChildren_().map((c) => c.name);
}

/**
 * この保護者の子どもを list の内容にそろえる。
 * 同じ名前の子がすでにいれば保護者として追加する（家族のだれが登録してもよい）。
 * @param {{name: string, grade: number}[]} list
 */
function saveChildren_(userId, list) {
  withLock_(() => {
    // 家族をまとめていれば、家族のだれが直しても両方の子どもとして登録される
    const members = familyMembers_(userId);
    const rows = readRows_(SHEETS.CHILDREN);
    const names = list.map((c) => c.name);
    rows.forEach((row) => {
      const parents = splitNames_(row['保護者userId']);
      const keep = names.some((n) => sameKidName_(n, row['名前']));
      const rest = parents.filter((u) => members.indexOf(u) < 0);
      if (!keep && rest.length !== parents.length) {
        row['保護者userId'] = rest.join(',');
        row['更新日時'] = now_();
        updateRow_(SHEETS.CHILDREN, row);
      }
    });
    list.forEach((c) => {
      // 名簿に入っている子なら、その子に保護者を足す（名前は名簿のまま）
      const row = rows.find((r) => sameKidName_(r['名前'], c.name));
      if (row) {
        const parents = splitNames_(row['保護者userId']);
        members.forEach((u) => { if (parents.indexOf(u) < 0) parents.push(u); });
        row['保護者userId'] = parents.join(',');
        if (c.grade) row['学年'] = String(c.grade);
        if (c.sex !== undefined) row['性別'] = c.sex;
        row['更新日時'] = now_();
        updateRow_(SHEETS.CHILDREN, row);
      } else {
        appendRow_(SHEETS.CHILDREN, { '名前': c.name, '学年': c.grade ? String(c.grade) : '', '保護者userId': members.join(','), '性別': c.sex || '', '更新日時': now_() });
      }
    });
  });
}

/**
 * userId の人を、inviterId の人の家族に入れる。おたがいの子どもは両方の子どもになる。
 * 当番の記録も新しい家族IDに付け替える。
 */
function joinFamily_(userId, inviterId) {
  withLock_(() => {
    const families = readRows_(SHEETS.FAMILIES);
    const me = families.find((f) => f.userId === userId);
    const inviter = families.find((f) => f.userId === inviterId);
    if (!me || !inviter) throw new Error('家族が見つかりません。');
    const newId = famIdOf_(inviter);
    const oldId = famIdOf_(me);
    if (inviter['家族ID'] !== newId) { inviter['家族ID'] = newId; updateRow_(SHEETS.FAMILIES, inviter); }
    if (oldId !== newId) {
      me['家族ID'] = newId;
      me['更新日時'] = now_();
      updateRow_(SHEETS.FAMILIES, me);
      readRows_(SHEETS.DUTIES).filter((d) => d['家族ID'] === oldId).forEach((d) => { d['家族ID'] = newId; updateRow_(SHEETS.DUTIES, d); });
    }
    const members = families.filter((f) => famIdOf_(f) === newId).map((f) => f.userId);
    readRows_(SHEETS.CHILDREN).forEach((row) => {
      const parents = splitNames_(row['保護者userId']);
      if (!parents.some((u) => members.indexOf(u) >= 0)) return;
      const all = parents.concat(members.filter((u) => parents.indexOf(u) < 0));
      if (all.length === parents.length) return;
      row['保護者userId'] = all.join(',');
      row['更新日時'] = now_();
      updateRow_(SHEETS.CHILDREN, row);
    });
  });
}

/**
 * 同じ子を、別々の家族として登録した保護者（父と母・祖父母などが招待番号を使わずにそれぞれ登録したなど）を1つの家族にまとめる。
 * 当番や家族の一覧が2つに分かれないように。祖父母・兄姉が登録しても同じ家族に入る。まとめたら true
 */
function mergeSameKidFamilies_() {
  let changed = false;
  for (let i = 0; i < 20; i++) {
    const families = readRows_(SHEETS.FAMILIES);
    const famOf = {};
    families.forEach((f) => (famOf[f.userId] = famIdOf_(f)));
    const kids = readRows_(SHEETS.CHILDREN).filter((c) => c['名前']);
    const famKids = {};
    kids.forEach((c) => splitNames_(c['保護者userId']).forEach((u) => { if (famOf[u]) (famKids[famOf[u]] = famKids[famOf[u]] || {})[c['名前']] = true; }));
    const meets = (a, b) => Object.keys(famKids[a] || {}).some((k) => (famKids[b] || {})[k]);
    // 2つの別の家族の子をどちらも登録している人（いとこの祖父母など）は、2つの家族をつながないよう自動ではまとめない
    const bridge = (f) => {
      const others = Object.keys(famKids).filter((g) => g !== f && meets(f, g));
      return others.some((g, i) => others.slice(i + 1).some((h) => !meets(g, h)));
    };
    let pair = null;
    kids.some((c) => {
      const us = splitNames_(c['保護者userId']).filter((u) => famOf[u]);
      us.some((a) => us.some((b) => {
        if (famOf[a] === famOf[b] || bridge(famOf[a]) || bridge(famOf[b])) return false;
        pair = { user: b, into: a };
        return true;
      }));
      return !!pair;
    });
    if (!pair) break;
    joinFamily_(pair.user, pair.into);
    changed = true;
  }
  return changed;
}

/** 家族のまとまりから外れる。登録した子どもは、ほかの家族の人の子どもとして残る */
function leaveFamily_(userId) {
  withLock_(() => {
    const families = readRows_(SHEETS.FAMILIES);
    const me = families.find((f) => f.userId === userId);
    if (!me || famIdOf_(me) === userId) return;
    const others = families.filter((f) => f.userId !== userId && famIdOf_(f) === famIdOf_(me));
    me['家族ID'] = '';
    me['更新日時'] = now_();
    updateRow_(SHEETS.FAMILIES, me);
    readRows_(SHEETS.CHILDREN).forEach((row) => {
      const parents = splitNames_(row['保護者userId']);
      if (parents.indexOf(userId) < 0 || !others.some((f) => parents.indexOf(f.userId) >= 0)) return;
      row['保護者userId'] = parents.filter((u) => u !== userId).join(',');
      updateRow_(SHEETS.CHILDREN, row);
    });
  });
}

// ---- 予定 ----

function findEvent_(eventKey) {
  return readRows_(SHEETS.EVENTS).find((e) => e.eventKey === eventKey) || null;
}

/** 指定日から lookbackDays 日前までで、いちばん新しい予定（写真・結果の紐づけ用） */
function recentEvent_(dateStr, lookbackDays) {
  const from = addDays_(dateStr, -lookbackDays);
  const list = readRows_(SHEETS.EVENTS)
    .filter((e) => e['状態'] !== '中止' && e['日付'] >= from && e['日付'] <= dateStr)
    .sort(compareEvents_);
  return list.length ? list[list.length - 1] : null;
}

function compareEvents_(a, b) {
  const ka = a['日付'] + ' ' + (a['開始'] === '終日' ? '' : a['開始']);
  const kb = b['日付'] + ' ' + (b['開始'] === '終日' ? '' : b['開始']);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}
