/**
 * スプレッドシートを簡易データベースとして使う。
 * どのシートも1行目が見出しで、2行目以降がデータ。値はすべて文字列で保存する。
 */
const SHEETS = {
  FAMILIES: { name: '家族', headers: ['userId', '表示名', 'ポータルキー', '役員', '更新日時', 'グループ確認'] },
  CHILDREN: { name: '子ども', headers: ['名前', '学年', '保護者userId', '更新日時'] },
  EVENTS: { name: '予定', headers: ['eventKey', '日付', '開始', '終了', 'タイトル', '場所', 'カレンダーID', '種別', '状態', '更新日時'] },
  RACES: { name: '大会', headers: ['eventKey', '種別', '対象', '参加費', '締切', '集合時刻', '集合場所', '種目', '持ち物', '注意', '更新日時'] },
  ENTRIES: { name: 'エントリー', headers: ['eventKey', '子ども', '回答', '種目', '集金', '更新者', '更新日時'] },
  ABSENCES: { name: '休み', headers: ['id', '日付', '子ども', '理由', 'メモ', '連絡者userId', '連絡者', '確認', '確認者', '日時'] },
  NOTICES: { name: 'お知らせ', headers: ['id', '日付', 'タイトル', '本文', 'eventKey', '作成者', '日時'] },
  PHOTOS: { name: '写真', headers: ['日時', 'eventKey', '予定', 'userId', '表示名', 'ファイル名', 'URL'] },
  RESULTS: { name: '結果', headers: ['日時', 'eventKey', '大会・練習', '子ども', '種目', '記録', 'メモ', 'userId', '表示名'] },
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
  }
  return sh;
}

/** 手入力で日付や時刻に自動変換されたセルも文字列に戻す */
function cellToString_(v, header) {
  if (v instanceof Date) {
    if (header.indexOf('日時') >= 0) return fmt_(v, 'yyyy-MM-dd HH:mm:ss');
    if (header === '開始' || header === '終了' || header === '記録' || header === '集合時刻') return fmt_(v, 'H:mm');
    return fmt_(v, 'yyyy-MM-dd');
  }
  return v === null || v === undefined ? '' : String(v);
}

/** 全行をオブジェクトの配列で返す。_row に行番号が入る */
function readRows_(def) {
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
  return obj;
}

function updateRow_(def, obj) {
  sheet_(def).getRange(obj._row, 1, 1, def.headers.length).setNumberFormat('@').setValues([toValues_(def, obj)]);
}

/** 行を空にする（行番号がずれないよう、削除ではなく空欄にする） */
function clearRow_(def, obj) {
  sheet_(def).getRange(obj._row, 1, 1, def.headers.length).setValues([def.headers.map(() => '')]);
}

/** 複数人が同時に操作しても行が重複しないようにロックして実行する */
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return fn();
  } finally {
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

function isAdmin_(family) {
  return !!family && /^(○|◯|〇|o|yes|true|1|役員)$/i.test(String(family['役員']).trim());
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

function activeChildren_() {
  return readRows_(SHEETS.CHILDREN)
    .filter((c) => c['名前'] && splitNames_(c['保護者userId']).length)
    .map((c) => ({ name: c['名前'], grade: Number(c['学年']) || 0, parents: splitNames_(c['保護者userId']), _row: c._row }));
}

function childrenOf_(userId) {
  return activeChildren_().filter((c) => c.parents.indexOf(userId) >= 0);
}

function allChildren_() {
  return activeChildren_().map((c) => c.name);
}

/**
 * この保護者の子どもを list の内容にそろえる。
 * 同じ名前の子がすでにいれば保護者として追加する（両親とも登録できる）。
 * @param {{name: string, grade: number}[]} list
 */
function saveChildren_(userId, list) {
  withLock_(() => {
    const rows = readRows_(SHEETS.CHILDREN);
    const names = list.map((c) => c.name);
    rows.forEach((row) => {
      const parents = splitNames_(row['保護者userId']);
      const i = parents.indexOf(userId);
      const keep = names.indexOf(row['名前']) >= 0;
      if (i >= 0 && !keep) {
        parents.splice(i, 1);
        row['保護者userId'] = parents.join(',');
        row['更新日時'] = now_();
        updateRow_(SHEETS.CHILDREN, row);
      }
    });
    list.forEach((c) => {
      const row = rows.find((r) => r['名前'] === c.name);
      if (row) {
        const parents = splitNames_(row['保護者userId']);
        if (parents.indexOf(userId) < 0) parents.push(userId);
        row['保護者userId'] = parents.join(',');
        if (c.grade) row['学年'] = String(c.grade);
        row['更新日時'] = now_();
        updateRow_(SHEETS.CHILDREN, row);
      } else {
        appendRow_(SHEETS.CHILDREN, { '名前': c.name, '学年': c.grade ? String(c.grade) : '', '保護者userId': userId, '更新日時': now_() });
      }
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
