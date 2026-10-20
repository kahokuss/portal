/**
 * ポータルの操作（家族・当番・大会の日・写真・予定づくり）。
 * 画面からの呼び出しの入口は Portal.gs の api()。
 */

// ---- 家族 ----

/** 夫婦などを同じ家族にまとめるための招待番号（6けた）を作る */
function inviteFamilyAction_(ctx) {
  const cache = CacheService.getScriptCache();
  let code = '';
  for (let i = 0; i < 5 && !code; i++) {
    const c = String(100000 + (parseInt(randomKey_().slice(0, 8), 16) % 900000));
    if (!cache.get('fam:' + c)) code = c;
  }
  if (!code) throw new Error('もう一度お試しください。');
  const hours = Math.min(6, CONFIG.INVITE_HOURS);
  cache.put('fam:' + code, ctx.userId, hours * 3600);
  return { code: code, hours: hours, url: portalUrl_() + (portalUrl_().indexOf('?') >= 0 ? '&' : '?') + 'join=' + code };
}

function joinFamilyAction_(ctx, p) {
  const code = toHalfWidth_(p.code || '').replace(/\D/g, '');
  const cache = CacheService.getScriptCache();
  const inviter = code.length === 6 ? cache.get('fam:' + code) : null;
  if (!inviter) throw new Error('招待番号が違うか、期限が切れています。家族の人に、もう一度番号を出してもらってください。');
  if (inviter === ctx.userId) throw new Error('自分の招待番号です。家族の人のスマホで入れてください。');
  joinFamily_(ctx.userId, inviter);
  cache.remove('fam:' + code);
  const name = (findFamily_(inviter) || {})['表示名'] || '家族';
  return name + 'さんと同じ家族になりました。お子さんの登録も共通になります';
}

/** 休みの連絡をLINEで受け取る人を切り替える（役員だけ） */
function setNotifyAction_(ctx, p) {
  withLock_(() => {
    const f = findFamily_(p.userId);
    if (!f) throw new Error('見つかりません。');
    f['休み通知'] = p.on ? '○' : '×';
    f['更新日時'] = now_();
    updateRow_(SHEETS.FAMILIES, f);
  });
  return '';
}

// ---- 当番 ----

function dutyType_(ev, races) {
  const race = races ? races[ev.eventKey] : readRows_(SHEETS.RACES).find((r) => r.eventKey === ev.eventKey);
  return race || (ev['種別'] || guessType_(ev['タイトル'])) !== '練習' ? '大会' : '練習';
}

function setDutyAction_(ctx, p) {
  const ev = findEvent_(p.key);
  if (!ev) throw new Error('予定が見つかりません。');
  const fam = String(p.fam || '');
  if (!fam) throw new Error('家族を選んでください。');
  withLock_(() => {
    const row = readRows_(SHEETS.DUTIES).find((d) => d.eventKey === p.key && d['家族ID'] === fam);
    if (p.on && !row) appendRow_(SHEETS.DUTIES, { eventKey: p.key, '日付': ev['日付'], '種類': dutyType_(ev), '家族ID': fam, '更新者': ctx.name, '更新日時': now_() });
    if (!p.on && row) clearRow_(SHEETS.DUTIES, row);
  });
  if (dutyType_(ev) === '大会') logHistory_(p.key, ctx, '当番：' + ((familiesList_(readRows_(SHEETS.FAMILIES), activeChildren_()).find((f) => f.id === fam) || {}).label || '') + (p.on ? ' に決定' : ' を外す'));
  return '';
}

/**
 * まだ当番がいない練習（または大会）に、前回の当番から日がたっている家族から順に入れる。
 * @param {{type: string, days: number, per: number}} p
 */
function autoDutyAction_(ctx, p) {
  const type = p.type === '大会' ? '大会' : '練習';
  const per = Math.max(1, Math.min(4, Number(p.per) || 1));
  const days = Math.max(1, Math.min(120, Number(p.days) || 30));
  const today = today_();
  const families = familiesList_(readRows_(SHEETS.FAMILIES), activeChildren_());
  if (!families.length) throw new Error('お子さんを登録している家族がいません。');
  const races = {};
  readRows_(SHEETS.RACES).forEach((r) => (races[r.eventKey] = r));
  let added = 0;
  withLock_(() => {
    const duties = readRows_(SHEETS.DUTIES);
    const last = {};
    const count = {};
    families.forEach((f) => { last[f.id] = ''; count[f.id] = 0; });
    duties.filter((d) => d['種類'] === type && d['日付'] >= addDays_(today, -400)).forEach((d) => {
      if (!(d['家族ID'] in last)) return;
      if (d['日付'] > last[d['家族ID']]) last[d['家族ID']] = d['日付'];
      count[d['家族ID']]++;
    });
    const targets = readRows_(SHEETS.EVENTS)
      .filter((e) => e['状態'] !== '中止' && e['日付'] >= today && e['日付'] <= addDays_(today, days) && dutyType_(e, races) === type)
      .sort(compareEvents_);
    targets.forEach((e) => {
      const have = duties.filter((d) => d.eventKey === e.eventKey).map((d) => d['家族ID']);
      for (let n = have.length; n < per; n++) {
        const pick = families
          .filter((f) => have.indexOf(f.id) < 0)
          .sort((a, b) => (last[a.id] < last[b.id] ? -1 : last[a.id] > last[b.id] ? 1 : count[a.id] - count[b.id] || (a.label < b.label ? -1 : 1)))[0];
        if (!pick) break;
        const row = appendRow_(SHEETS.DUTIES, { eventKey: e.eventKey, '日付': e['日付'], '種類': type, '家族ID': pick.id, '更新者': ctx.name, '更新日時': now_() });
        duties.push(row);
        have.push(pick.id);
        last[pick.id] = e['日付'];
        count[pick.id]++;
        added++;
      }
    });
  });
  return added ? added + '件の当番を入れました。前回から日がたっている家族から順番です' : '当番を入れる予定がありませんでした（もう全部入っています）';
}

/** 大会のタイムテーブル・手続きを直せる人（役員と、その大会の当番の家族） */
function requireManager_(ctx, key) {
  if (ctx.admin) return;
  const ok = readRows_(SHEETS.DUTIES).some((d) => d.eventKey === key && d['家族ID'] === ctx.famId);
  if (!ok) throw new Error('この操作は、役員とこの大会の当番の人だけができます。');
}

// ---- タイムテーブル ----

function cleanTime_(s) {
  const t = parseTimeCell_(s || '');
  return t ? t.replace(/^0/, '') : '';
}

function saveTimetableAction_(ctx, p) {
  const ev = findEvent_(p.key);
  if (!ev) throw new Error('大会が見つかりません。');
  requireManager_(ctx, p.key);
  const list = (p.rows || []).slice(0, 200).map((r) => ({
    id: /^[A-Za-z0-9]{6,12}$/.test(r.id || '') ? r.id : '',
    '開始': cleanTime_(r.start),
    '種目': String(r.race || '').trim().slice(0, 30),
    '区分': String(r.group || '').trim().slice(0, 30),
    '組': String(r.heat || '').trim().slice(0, 20),
    '招集': cleanTime_(r.call),
    'アップ': cleanTime_(r.warm),
    'メモ': String(r.memo || '').trim().slice(0, 100),
  })).filter((r) => r['種目']);
  withLock_(() => {
    const rows = readRows_(SHEETS.TIMETABLE).filter((x) => x.eventKey === p.key);
    const keep = {};
    list.forEach((r) => {
      const row = r.id && rows.find((x) => x.id === r.id);
      const data = Object.assign({}, r, { eventKey: p.key, '更新日時': now_() });
      if (row) { updateRow_(SHEETS.TIMETABLE, Object.assign(row, data)); keep[row.id] = true; }
      else appendRow_(SHEETS.TIMETABLE, Object.assign(data, { id: randomKey_().slice(0, 10) }));
    });
    rows.filter((x) => !keep[x.id]).forEach((x) => clearRow_(SHEETS.TIMETABLE, x));
  });
  logHistory_(p.key, ctx, 'タイムテーブルを保存（' + list.length + '件）');
  return 'タイムテーブルを保存しました（' + list.length + '件）';
}

// ---- 手続き（チェックリスト） ----

/** 招集・レーン・ナンバー・リザルトの写真はだれでも（会場で助け合えるように）。ほかは役員と当番 */
function requireTaskRight_(ctx, key, kind) {
  if (CHOICES.TASKS.indexOf(kind) < 0) throw new Error('不明な手続きです。');
  if (CHOICES.OPEN_TASKS.indexOf(kind) < 0) requireManager_(ctx, key);
}

function upsertTask_(ctx, key, kind, target, fn) {
  return withLock_(() => {
    const row = readRows_(SHEETS.TASKS).find((x) => x.id && x.eventKey === key && x['種類'] === kind && x['対象'] === target);
    const t = row || { id: randomKey_().slice(0, 10), eventKey: key, '種類': kind, '対象': target, '状態': '', 'メモ': '', '写真ID': '' };
    fn(t);
    t['更新者'] = ctx.name;
    t['日時'] = now_();
    if (row) updateRow_(SHEETS.TASKS, t);
    else appendRow_(SHEETS.TASKS, t);
    return t;
  });
}

function setTaskAction_(ctx, p) {
  if (!findEvent_(p.key)) throw new Error('大会が見つかりません。');
  const kind = String(p.kind || '');
  requireTaskRight_(ctx, p.key, kind);
  const target = String(p.target || '').slice(0, 60);
  upsertTask_(ctx, p.key, kind, target, (t) => {
    if (p.done !== undefined) t['状態'] = p.done ? '済' : '';
    if (p.memo !== undefined) t['メモ'] = String(p.memo).slice(0, 500);
  });
  if (kind !== 'レーン' && kind !== 'ナンバー') logHistory_(p.key, ctx, kind + (target && kind !== '招集' ? '（' + target.split('|')[0] + '）' : kind === '招集' ? '：' + target.split('|')[0] : '') + (p.done === true ? ' 済' : p.done === false ? ' 取り消し' : ' を記録'));
  return p.done ? kind + '：済にしました' : '';
}

// ---- 写真 ----

/** ポータルから写真を上げる。kind があれば、その手続きの写真として付ける */
function uploadPhotoAction_(ctx, p) {
  const ev = findEvent_(p.key);
  if (!ev) throw new Error('予定が見つかりません。');
  const kind = String(p.kind || '');
  if (kind) requireTaskRight_(ctx, p.key, kind);
  const file = savePhotoFile_(ctx, ev, p.data, kind || 'ポータル');
  if (kind) {
    upsertTask_(ctx, p.key, kind, String(p.target || '').slice(0, 60), (t) => {
      t['写真ID'] = splitNames_(t['写真ID']).concat([file.getId()]).join(',');
      if (kind === 'エントリー控え' || kind === 'プログラム' || kind === '参加費支払い') t['状態'] = '済';
    });
  }
  logHistory_(p.key, ctx, (kind ? kind + 'の' : '') + '写真を追加');
  return '写真を保存しました';
}

/** 画面から送られた写真（data URL）をドライブの予定ごとのフォルダに保存し、「写真」シートに記録する */
function savePhotoFile_(ctx, ev, data, kind) {
  const m = String(data || '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw new Error('写真を読み込めませんでした。');
  if (m[2].length > 8 * 1024 * 1024) throw new Error('写真が大きすぎます。');
  const at = now_();
  const ext = EXTENSIONS[m[1]] || 'jpg';
  const fileName = at.replace(/[-: ]/g, '').slice(0, 14) + '_' + (safeName_(kind) || 'photo') + '_' + (safeName_(ctx.name) || 'portal') + '.' + ext;
  const folder = ev ? subfolder_(photoRoot_(), ev['日付'] + ' ' + safeName_(ev['タイトル'])) : subfolder_(photoRoot_(), '会計');
  const file = folder.createFile(Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], fileName));
  appendRow_(SHEETS.PHOTOS, { '日時': at, eventKey: ev ? ev.eventKey : '', '予定': ev ? ev['タイトル'] : '', userId: ctx.userId, '表示名': ctx.name, 'ファイル名': fileName, URL: file.getUrl(), 'ファイルID': file.getId(), '種類': kind });
  return file;
}

/** 「写真」シートの行のドライブのファイルID（前の版の行は URL から取り出す） */
function photoIdOf_(row) {
  if (row['ファイルID']) return row['ファイルID'];
  const m = String(row.URL || '').match(/\/d\/([A-Za-z0-9_-]{10,})/);
  return m ? m[1] : '';
}

function photoData_(id, thumb) {
  const file = DriveApp.getFileById(id);
  let blob = thumb ? file.getThumbnail() : null;
  if (!blob) blob = file.getBlob();
  return 'data:' + (blob.getContentType() || 'image/jpeg') + ';base64,' + Utilities.base64Encode(blob.getBytes());
}

/**
 * 写真を画面に出す。「写真」シートにある写真だけ（ほかのドライブのファイルは出さない）。
 * ドライブのフォルダは共用アカウントだけのものにしておき、保護者はポータル（LINEグループのメンバーだけ）で見る。
 */
function photoAction_(ctx, p) {
  const id = String(p.id || '');
  if (!id || !readRows_(SHEETS.PHOTOS).some((x) => photoIdOf_(x) === id)) throw new Error('写真が見つかりません。');
  return { id: id, data: photoData_(id, !!p.thumb) };
}

/** アルバムの小さい写真をまとめて返す（1回に12枚まで） */
function thumbsAction_(ctx, p) {
  const known = {};
  readRows_(SHEETS.PHOTOS).forEach((x) => { const id = photoIdOf_(x); if (id) known[id] = true; });
  const out = {};
  (p.ids || []).slice(0, 12).forEach((id) => {
    if (!known[id]) return;
    try { out[id] = photoData_(id, true); } catch (err) { console.warn('写真を読めません: ' + id + ' ' + err); }
  });
  return out;
}

/** 写真を消す（上げた本人と役員）。ドライブではゴミ箱に入れる（30日は戻せる） */
function deletePhotoAction_(ctx, p) {
  withLock_(() => {
    const row = readRows_(SHEETS.PHOTOS).find((x) => photoIdOf_(x) === p.id);
    if (!row) throw new Error('写真が見つかりません。');
    if (!ctx.admin && row.userId !== ctx.userId) throw new Error('写真を消せるのは、上げた人と役員だけです。');
    try { DriveApp.getFileById(p.id).setTrashed(true); } catch (err) { console.warn(err); }
    clearRow_(SHEETS.PHOTOS, row);
    readRows_(SHEETS.TASKS).filter((t) => splitNames_(t['写真ID']).indexOf(p.id) >= 0).forEach((t) => {
      t['写真ID'] = splitNames_(t['写真ID']).filter((x) => x !== p.id).join(',');
      updateRow_(SHEETS.TASKS, t);
    });
  });
  return '写真を消しました';
}

// ---- 予定づくり（役員） ----

function cleanEventInput_(p, requireDate) {
  const title = String(p.title || '').trim().slice(0, 80);
  if (!title) throw new Error('タイトルを入れてください。');
  const start = parseTimeCell_(p.start || '');
  const end = parseTimeCell_(p.end || '');
  if (start === null || end === null) throw new Error('時刻が読めません。');
  if (start && end && end < start) throw new Error('終わりが始まりより前になっています。');
  const date = String(p.date || '');
  if (requireDate && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('日付を入れてください。');
  return { date: date, start: start, end: start ? end || start : '', title: title, place: String(p.place || '').trim().slice(0, 80) };
}

/** 練習の予定をまとめて作る（日付を複数選べる） */
function savePracticesAction_(ctx, p) {
  const o = cleanEventInput_(p, false);
  const dates = (p.dates || []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).filter((d, i, a) => a.indexOf(d) === i).sort();
  if (!dates.length) throw new Error('日にちを選んでください。');
  if (dates.length > 60) throw new Error('一度に作れるのは60日までです。');
  const type = p.type === '大会' || p.type === '記録会' ? p.type : '練習';
  withLock_(() => {
    dates.forEach((d) => upsertEventRow_(createCalEvent_(Object.assign({}, o, { date: d })), type));
  });
  return dates.length + '日分の「' + o.title + '」をカレンダーに入れました';
}

/** 練習などの予定の日時・場所を直す */
function editEventAction_(ctx, p) {
  const row = findEvent_(p.key);
  if (!row) throw new Error('予定が見つかりません。');
  const o = cleanEventInput_(p, true);
  const ce = editableCalEvent_(row);
  if (!ce) throw new Error('カレンダーに予定が見つかりません。「更新」を押してからやり直してください。');
  withLock_(() => {
    updateCalEvent_(ce, o);
    upsertEventRow_(ce, row['種別']);
    readRows_(SHEETS.DUTIES).filter((d) => d.eventKey === p.key && d['日付'] !== o.date).forEach((d) => { d['日付'] = o.date; updateRow_(SHEETS.DUTIES, d); });
  });
  return '「' + o.title + '」を直しました';
}

/** 予定を中止にする（カレンダーから消す。ポータルでは「中止」と表示が残る） */
function cancelEventAction_(ctx, p) {
  const row = findEvent_(p.key);
  if (!row) throw new Error('予定が見つかりません。');
  const ce = editableCalEvent_(row);
  withLock_(() => {
    if (ce) ce.deleteEvent();
    row['状態'] = '中止';
    row['更新日時'] = now_();
    updateRow_(SHEETS.EVENTS, row);
  });
  return formatDate_(row['日付']) + '「' + row['タイトル'] + '」を中止にしました';
}

// ---- 結果（記録） ----

/** 結果を入れられる人：その子の家族、役員、その大会の当番 */
function requireResultRight_(ctx, key, child) {
  if (ctx.admin) return;
  if (childrenOf_(ctx.userId).some((c) => c.name === child)) return;
  requireManager_(ctx, key);
}

function saveResultAction_(ctx, p) {
  const ev = findEvent_(p.key);
  if (!ev) throw new Error('大会が見つかりません。');
  const child = String(p.child || '');
  if (!activeChildren_().some((c) => c.name === child)) throw new Error('お子さんが見つかりません。');
  requireResultRight_(ctx, p.key, child);
  const race = String(p.race || '').trim().slice(0, 30);
  const record = toHalfWidth_(p.record || '').trim().replace(/\s/g, '').slice(0, 20);
  if (!race) throw new Error('種目を選んでください。');
  if (!record) throw new Error('記録を入れてください（例：15.21、1:01.27、3m20）。');
  const data = {
    eventKey: ev.eventKey, '大会・練習': ev['日付'] + ' ' + ev['タイトル'], '子ども': child, '種目': race, '記録': record,
    '順位': String(p.place || '').replace(/[^0-9]/g, '').slice(0, 3), 'ラウンド': CHOICES.ROUNDS.indexOf(p.round) >= 0 ? p.round : '',
    'メモ': String(p.memo || '').slice(0, 100), userId: ctx.userId, '表示名': ctx.name, '日時': now_(),
  };
  withLock_(() => {
    const row = p.id ? readRows_(SHEETS.RESULTS).find((r) => r.id && r.id === p.id) : null;
    if (row) updateRow_(SHEETS.RESULTS, Object.assign(row, data));
    else appendRow_(SHEETS.RESULTS, Object.assign(data, { id: randomKey_().slice(0, 10) }));
  });
  logHistory_(ev.eventKey, ctx, '結果：' + child + ' ' + race + ' ' + record);
  return child + ' ' + race + ' ' + record + ' を記録しました';
}

function deleteResultAction_(ctx, p) {
  withLock_(() => {
    const row = readRows_(SHEETS.RESULTS).find((r) => r.id && r.id === p.id);
    if (!row) throw new Error('記録が見つかりません。');
    requireResultRight_(ctx, row.eventKey, row['子ども']);
    clearRow_(SHEETS.RESULTS, row);
  });
  return '記録を消しました';
}

// ---- LINEグループへの一斉通知（役員） ----

function broadcastInfoAction_() {
  return pushQuota_();
}

/** LINEグループに送る。グループの人数分の通数を使うので、足りないときは送らない */
function broadcastAction_(ctx, p) {
  const groupId = requireProp_('GROUP_ID');
  const text = String(p.text || '').trim().slice(0, 2000);
  if (!text) throw new Error('送る文章がありません。');
  const q = pushQuota_();
  if (q.remaining !== null && q.members !== null && q.remaining < q.members) {
    throw new Error('今月のLINEの無料の通数が足りません（残り' + q.remaining + '通・グループ' + q.members + '人）。文章をコピーして、手でグループに貼ってください。');
  }
  push_(groupId, [text_(text)]);
  CacheService.getScriptCache().remove('pushQuota');
  return 'LINEグループに送りました' + (q.members ? '（' + q.members + '通ぶん）' : '');
}

// ---- 会計（参加費の支払い・領収書の履歴） ----

/**
 * 支払い（大会への参加費など）や入金を記録する。領収書の写真も付けられる。
 * 大会に結びつけるときは役員かその大会の当番、結びつけないときは役員だけ
 */
function saveLedgerAction_(ctx, p) {
  const ev = p.key ? findEvent_(p.key) : null;
  if (p.key && !ev) throw new Error('大会が見つかりません。');
  if (ev) requireManager_(ctx, ev.eventKey);
  else if (!ctx.admin) throw new Error('この操作は役員だけができます。');
  const amount = Number(toHalfWidth_(p.amount || '').replace(/[^0-9]/g, ''));
  if (!amount) throw new Error('金額を入れてください。');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(p.date || '') ? p.date : ev ? ev['日付'] : today_();
  const kind = p.kind === '入金' ? '入金' : '支払い';
  const photo = p.data ? savePhotoFile_(ctx, ev, p.data, '領収書').getId() : '';
  withLock_(() => {
    appendRow_(SHEETS.LEDGER, {
      id: randomKey_().slice(0, 10), '日付': date, eventKey: ev ? ev.eventKey : '', '種類': kind, '金額': String(amount),
      '相手': String(p.payee || '').trim().slice(0, 60), '但し書き': String(p.note || '').trim().slice(0, 100), '写真ID': photo, '記録者': ctx.name, '日時': now_(),
    });
  });
  if (ev) logHistory_(ev.eventKey, ctx, kind + ' ¥' + amount.toLocaleString('ja-JP') + (p.payee ? '（' + String(p.payee).slice(0, 30) + '）' : '') + (photo ? '・領収書の写真あり' : ''));
  if (ev && kind === '支払い') upsertTask_(ctx, ev.eventKey, '参加費支払い', '', (t) => { t['状態'] = '済'; if (photo) t['写真ID'] = splitNames_(t['写真ID']).concat([photo]).join(','); });
  return (kind === '入金' ? '入金' : '支払い') + ' ¥' + amount.toLocaleString('ja-JP') + ' を記録しました';
}

function deleteLedgerAction_(ctx, p) {
  withLock_(() => {
    const row = readRows_(SHEETS.LEDGER).find((x) => x.id && x.id === p.id);
    if (!row) throw new Error('記録が見つかりません。');
    clearRow_(SHEETS.LEDGER, row);
  });
  return '会計の記録を消しました';
}

/** 画面に渡す会計の記録。役員はすべて、当番は自分の大会の分だけ */
function ledgerFor_(ctx, manageKeys) {
  return readRows_(SHEETS.LEDGER)
    .filter((x) => x.id && (ctx.admin || (x.eventKey && manageKeys.indexOf(x.eventKey) >= 0)))
    .map((x) => ({ id: x.id, date: x['日付'], key: x.eventKey, kind: x['種類'], amount: Number(x['金額']) || 0, payee: x['相手'], note: x['但し書き'], photo: x['写真ID'], by: x['記録者'] }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

// ---- コメント・ヒヤリハット ----

/**
 * 練習・大会への保護者のコメント。種類が「ヒヤリハット」（けがにはならなかったが危なかったこと）のものは、
 * 目立たせて一覧にし、役員が対策を書きこむ。「役員だけ」にすると、書いた人と役員にだけ見える
 */
function saveCommentAction_(ctx, p) {
  const ev = findEvent_(p.key);
  if (!ev) throw new Error('予定が見つかりません。');
  const kind = p.kind === 'ヒヤリハット' ? 'ヒヤリハット' : 'コメント';
  const body = String(p.body || '').trim().slice(0, 1000);
  if (!body) throw new Error(kind === 'ヒヤリハット' ? '何があったかを書いてください。' : 'コメントを書いてください。');
  const photo = p.data ? savePhotoFile_(ctx, ev, p.data, kind).getId() : '';
  withLock_(() => {
    appendRow_(SHEETS.COMMENTS, {
      id: randomKey_().slice(0, 10), eventKey: ev.eventKey, '種類': kind, '本文': body, '場所': String(p.place || '').trim().slice(0, 60),
      '公開': p.adminOnly ? '役員' : '全員', '写真ID': photo, userId: ctx.userId, '表示名': ctx.name, '日時': now_(),
    });
  });
  if (kind === 'ヒヤリハット' && CONFIG.NEAR_MISS_PUSH_TO_ADMINS) {
    const text = '⚠ ヒヤリハットの報告\n' + formatDate_(ev['日付']) + ' ' + ev['タイトル'] + (p.place ? '（' + String(p.place).slice(0, 60) + '）' : '') + '\n' + body.slice(0, 300) + '\n報告：' + ctx.name + 'さん\n対策はポータルで書きこめます\n' + portalUrl_();
    readRows_(SHEETS.FAMILIES).filter((f) => isAdmin_(f) && f.userId !== ctx.userId).forEach((f) => {
      try { push_(f.userId, [text_(text)]); } catch (err) { console.warn('ヒヤリハットの通知に失敗: ' + err); }
    });
  }
  return kind === 'ヒヤリハット' ? 'ヒヤリハットを共有しました。ありがとうございます' : 'コメントを書きました';
}

function deleteCommentAction_(ctx, p) {
  withLock_(() => {
    const row = readRows_(SHEETS.COMMENTS).find((x) => x.id && x.id === p.id);
    if (!row) throw new Error('コメントが見つかりません。');
    if (!ctx.admin && row.userId !== ctx.userId) throw new Error('消せるのは、書いた人と役員だけです。');
    clearRow_(SHEETS.COMMENTS, row);
  });
  return 'コメントを消しました';
}

/** ヒヤリハットへの対策（役員） */
function setMeasureAction_(ctx, p) {
  withLock_(() => {
    const row = readRows_(SHEETS.COMMENTS).find((x) => x.id && x.id === p.id);
    if (!row) throw new Error('見つかりません。');
    row['対策'] = String(p.measure || '').trim().slice(0, 500);
    row['対策者'] = row['対策'] ? ctx.name : '';
    row['対策日時'] = row['対策'] ? now_() : '';
    updateRow_(SHEETS.COMMENTS, row);
  });
  return p.measure ? '対策を書きました' : '';
}

/** 画面に渡すコメント（1年分）。「役員だけ」のものは、書いた人と役員にだけ */
function commentsFor_(ctx) {
  const from = addDays_(today_(), -400);
  const all = {};
  readRows_(SHEETS.EVENTS).forEach((e) => (all[e.eventKey] = e));
  return readRows_(SHEETS.COMMENTS)
    .filter((x) => x.id && String(x['日時']).slice(0, 10) >= from && (x['公開'] !== '役員' || ctx.admin || x.userId === ctx.userId))
    .map((x) => {
      const ev = all[x.eventKey];
      return {
        id: x.id, key: x.eventKey, kind: x['種類'], body: x['本文'], place: x['場所'], adminOnly: x['公開'] === '役員', photo: x['写真ID'],
        by: x['表示名'], at: x['日時'], mine: x.userId === ctx.userId, measure: x['対策'], measureBy: x['対策者'],
        date: ev ? ev['日付'] : String(x['日時']).slice(0, 10), title: ev ? ev['タイトル'] : '',
      };
    });
}

// ---- 大会の資料・履歴 ----

/** 大会の履歴に1行足す（だれが・いつ・何をしたか） */
function logHistory_(eventKey, ctx, text) {
  if (!eventKey) return;
  try {
    appendRow_(SHEETS.HISTORY, { '日時': now_(), eventKey: eventKey, '表示名': (ctx && ctx.name) || '', '内容': String(text).slice(0, 200) });
  } catch (err) {
    console.warn('履歴を残せませんでした: ' + err);
  }
}

/**
 * 大会の資料（要項・申込書・プログラム・地図・リザルトなど）を足す。
 * リンク（主催者のページ）か、ファイル（写真・PDF）。メンバー全員が見られる。足せるのは役員と当番
 */
function addDocAction_(ctx, p) {
  const ev = findEvent_(p.key);
  if (!ev) throw new Error('大会が見つかりません。');
  requireManager_(ctx, p.key);
  const kind = CHOICES.DOC_KINDS.indexOf(p.kind) >= 0 ? p.kind : 'その他';
  const url = String(p.url || '').trim();
  let fileId = '';
  let type = 'link';
  if (p.data) {
    const m = String(p.data).match(/^data:(image\/(?:jpeg|png|webp)|application\/pdf);base64,([A-Za-z0-9+/=]+)$/);
    if (!m) throw new Error('写真かPDFを選んでください。');
    if (m[2].length > 14 * 1024 * 1024) throw new Error('ファイルが大きすぎます（10MBまで）。');
    if (m[1] === 'application/pdf') {
      const name = now_().replace(/[-: ]/g, '').slice(0, 14) + '_' + safeName_(kind) + '_' + safeName_(p.name || 'document') + '.pdf';
      const folder = subfolder_(photoRoot_(), ev['日付'] + ' ' + safeName_(ev['タイトル']));
      const file = folder.createFile(Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], name));
      appendRow_(SHEETS.PHOTOS, { '日時': now_(), eventKey: ev.eventKey, '予定': ev['タイトル'], userId: ctx.userId, '表示名': ctx.name, 'ファイル名': name, URL: file.getUrl(), 'ファイルID': file.getId(), '種類': '資料' });
      fileId = file.getId();
      type = 'pdf';
    } else {
      fileId = savePhotoFile_(ctx, ev, p.data, '資料').getId();
      type = 'image';
    }
  } else if (!/^https?:\/\/\S+$/.test(url)) {
    throw new Error('リンク（https://…）を入れるか、ファイルを選んでください。');
  }
  const name = String(p.name || '').trim().slice(0, 60) || kind;
  withLock_(() => {
    appendRow_(SHEETS.DOCS, { id: randomKey_().slice(0, 10), eventKey: ev.eventKey, '種類': kind, '名前': name, URL: fileId ? '' : url.slice(0, 300), 'ファイルID': fileId, '形式': type, '追加者': ctx.name, '日時': now_() });
  });
  logHistory_(ev.eventKey, ctx, '資料を追加：' + kind + (name !== kind ? '（' + name + '）' : ''));
  return '資料「' + name + '」を追加しました';
}

function deleteDocAction_(ctx, p) {
  const row = readRows_(SHEETS.DOCS).find((x) => x.id && x.id === p.id);
  if (!row) throw new Error('資料が見つかりません。');
  requireManager_(ctx, row.eventKey);
  withLock_(() => clearRow_(SHEETS.DOCS, row));
  logHistory_(row.eventKey, ctx, '資料を削除：' + row['名前']);
  return '資料を消しました';
}

/** 資料のファイル（写真・PDF）を返す。「資料」シートにあるものだけ */
function docAction_(ctx, p) {
  const row = readRows_(SHEETS.DOCS).find((x) => x.id && x.id === p.id && x['ファイルID']);
  if (!row) throw new Error('資料が見つかりません。');
  const blob = DriveApp.getFileById(row['ファイルID']).getBlob();
  return { name: row['名前'], data: 'data:' + (blob.getContentType() || 'application/octet-stream') + ';base64,' + Utilities.base64Encode(blob.getBytes()) };
}

/**
 * 手続きの締切（日時）を入れる。例：リレー予選のオーダー提出は当日10:00まで。役員と当番
 * @param {{key: string, kind: string, at: string}} p at は 'yyyy-MM-dd HH:mm'（空なら消す）
 */
function setDeadlineAction_(ctx, p) {
  const ev = findEvent_(p.key);
  if (!ev) throw new Error('大会が見つかりません。');
  requireManager_(ctx, p.key);
  if (CHOICES.TASKS.indexOf(p.kind) < 0) throw new Error('不明な手続きです。');
  const at = String(p.at || '').trim();
  if (at && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(at)) throw new Error('締切の日時が読めません。');
  withLock_(() => {
    let row = readRows_(SHEETS.RACES).find((r) => r.eventKey === p.key);
    if (!row) row = appendRow_(SHEETS.RACES, { eventKey: p.key, '種別': '大会', '対象': '全員', '更新日時': now_() });
    const d = parseDeadlines_(row['手続き期限']);
    if (at) d[p.kind] = at; else delete d[p.kind];
    row['手続き期限'] = JSON.stringify(d);
    updateRow_(SHEETS.RACES, row);
  });
  logHistory_(p.key, ctx, '締切：' + deadlineLabel_(p.kind) + (at ? ' ' + formatDate_(at.slice(0, 10)) + ' ' + at.slice(11) + 'まで' : ' を消す'));
  return at ? deadlineLabel_(p.kind) + 'の締切を入れました' : '';
}

function deadlineLabel_(kind) {
  return { 'エントリー控え': 'エントリーの提出', '参加費支払い': '参加費の支払い', 'リレー予選': 'リレー予選のオーダー', 'リレー決勝': 'リレー決勝のオーダー' }[kind] || kind;
}

// ---- 練習のダウン（お迎えの目安） ----

/**
 * 今日の練習に、ダウンに入った時刻を記録する。どの練習か分からないときは、今の時刻にいちばん近い今日の練習
 * @return {Object|null} 記録した「予定」シートの行
 */
function recordDown_(when, by, eventKey) {
  const date = fmt_(when, 'yyyy-MM-dd');
  const hm = fmt_(when, 'HH:mm');
  return withLock_(() => {
    const todays = readRows_(SHEETS.EVENTS).filter((e) => e['日付'] === date && e['状態'] !== '中止' && (eventKey ? e.eventKey === eventKey : (e['種別'] || guessType_(e['タイトル'])) === '練習'));
    if (!todays.length) return null;
    const dist = (e) => (e['開始'] && e['開始'] !== '終日' ? Math.abs(toMin_(e['終了'] || e['開始']) - toMin_(hm)) : 9999);
    const row = todays.sort((a, b) => dist(a) - dist(b))[0];
    row['ダウン'] = hm;
    updateRow_(SHEETS.EVENTS, row);
    return row;
  });
}

function toMin_(hm) {
  const m = String(hm || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? +m[1] * 60 + +m[2] : 0;
}

/** ポータルの「ダウンに入った」ボタン（役員と、その日の当番の家族）。押し直すと時刻を直せる。clear で消す */
function markDownAction_(ctx, p) {
  const ev = findEvent_(p.key);
  if (!ev) throw new Error('予定が見つかりません。');
  if (ev['日付'] !== today_()) throw new Error('今日の練習だけ記録できます。');
  if (!ctx.admin && !readRows_(SHEETS.DUTIES).some((d) => d.eventKey === p.key && d['家族ID'] === ctx.famId)) throw new Error('この操作は、役員とその日の当番の人だけができます。');
  if (p.clear) {
    withLock_(() => { const row = findEvent_(p.key); row['ダウン'] = ''; updateRow_(SHEETS.EVENTS, row); });
    return 'ダウンの記録を消しました';
  }
  const row = recordDown_(new Date(), ctx.name, p.key);
  return 'ダウン ' + row['ダウン'] + ' を記録しました';
}
