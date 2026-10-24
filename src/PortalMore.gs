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

/** 役員にする・外す（役員だけ）。役員が1人もいなくなる操作はしない */
function setAdminAction_(ctx, p) {
  withLock_(() => {
    const rows = readRows_(SHEETS.FAMILIES);
    const f = rows.find((x) => x.userId === p.userId);
    if (!f) throw new Error('見つかりません。');
    const id = famIdOf_(f);
    if (!p.on && !rows.some((x) => famIdOf_(x) !== id && isAdminRow_(x))) throw new Error('役員が1家族もいなくなるので、外せません。先にほかの家族を役員にしてください。');
    // 役員は家族ごと：父・母どちらの行もそろえる
    familyRowsOf_(rows, id).forEach((x) => { x['役員'] = p.on ? '○' : ''; x['役員申請'] = ''; x['更新日時'] = now_(); updateRow_(SHEETS.FAMILIES, x); });
  });
  return (p.on ? '役員にしました（家族の全員）' : '役員から外しました（家族の全員）');
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
  if (!ok) throw new Error('この操作は、役員とこの予定の当番の人だけができます。');
}

// ---- タイムテーブル ----

function cleanTime_(s) {
  const t = parseTimeCell_(s || '');
  return t ? t.replace(/^0/, '') : '';
}

/** 「9:00〜9:10」のような幅のある時刻も受け付ける（招集・アップ） */
function cleanTimeRange_(s) {
  const parts = toHalfWidth_(s || '').split(/\s*[〜～~\-－ー]\s*/).filter(Boolean);
  if (parts.length === 2) {
    const a = cleanTime_(parts[0]), b = cleanTime_(parts[1]);
    if (a && b) return a + '〜' + b;
  }
  return cleanTime_(s);
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
    '招集': cleanTimeRange_(r.call),
    'アップ': cleanTimeRange_(r.warm),
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
      if (kind === 'エントリー控え' || kind === 'プログラム' || kind === '参加費支払い' || kind === '陣地') t['状態'] = '済';
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
    '区分': p.kind === '公式' || p.kind === '練習' ? p.kind : dutyType_(ev) === '大会' ? '公式' : '練習',
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
function parseSuggest_(s) {
  try { return JSON.parse(s || '{}'); } catch (err) { return {}; }
}

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
        suggest: x['種類'] === '変更連絡' ? parseSuggest_(x['提案']) : null,
      };
    })
    .map((c) => {
      if (c.kind === '変更連絡' && !c.key && c.suggest && c.suggest.date) c.date = c.suggest.date;
      return c;
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

// ---- 練習のダウン（お迎えの合図） ----

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

/** 予定をまとめて直す（ポータルの「予定を表でまとめて直す」）。直せなかった行は理由を返す */
function bulkEditEventsAction_(ctx, p) {
  let ok = 0;
  const ng = [];
  (p.rows || []).slice(0, 200).forEach((r) => {
    try {
      if (r.cancel) cancelEventAction_(ctx, { key: r.key });
      else editEventAction_(ctx, r);
      ok++;
    } catch (err) {
      const ev = findEvent_(r.key);
      ng.push((ev ? formatDate_(ev['日付']) + ' ' + ev['タイトル'] : '予定') + '：' + String(err.message || err));
    }
  });
  if (ng.length && !ok) throw new Error(ng.join('\n'));
  return ok + '件を直しました' + (ng.length ? '（直せなかったもの：' + ng.join('／') + '）' : '');
}

/**
 * 過去の記録（ポータルを使う前の自己ベストなど）をまとめて入れる（役員）。大会に結びつけなくてよい
 * @param {{rows: {child: string, race: string, record: string, date: string, meet: string, place: string, round: string, memo: string}[]}} p
 */
function addRecordsAction_(ctx, p) {
  const kids = {};
  activeChildren_().forEach((c) => (kids[c.name] = true));
  const ok = [];
  const ng = [];
  // 同じ子・同じ種目・同じ記録・同じ日・同じ大会名は、もう入っていれば入れない（同じ表を2回貼っても2重にならない）
  const sig = (child, race, record, meet) => [String(child).replace(/\s|　/g, ''), String(race).trim(), String(record).trim(), String(meet).trim()].join('|');
  const have = {};
  readRows_(SHEETS.RESULTS).forEach((x) => { if (x['記録']) have[sig(x['子ども'], x['種目'], x['記録'], x['大会・練習'])] = true; });
  let dup = 0;
  (p.rows || []).slice(0, 300).forEach((r, i) => {
    const child = String(r.child || '').trim();
    const race = String(r.race || '').trim().slice(0, 30);
    const record = toHalfWidth_(r.record || '').trim().replace(/\s/g, '').slice(0, 20);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(r.date || '') ? r.date : today_();
    if (!kids[child]) return ng.push((i + 1) + '行目：「' + child + '」というお子さんが登録されていません');
    if (!race || !record) return ng.push((i + 1) + '行目：種目と記録を入れてください');
    const meet = date + ' ' + String(r.meet || '過去の記録').trim().slice(0, 60);
    const k = sig(child, race, record, meet);
    if (have[k]) { dup++; return; }
    have[k] = true;
    ok.push({
      '日時': now_(), eventKey: '', '大会・練習': meet, '子ども': child, '種目': race, '記録': record,
      '順位': String(r.place || '').replace(/[^0-9]/g, '').slice(0, 3), 'ラウンド': CHOICES.ROUNDS.indexOf(r.round) >= 0 ? r.round : '',
      '区分': (r.kind || p.kind) === '練習' ? '練習' : '公式',
      'メモ': String(r.memo || '').slice(0, 100), userId: ctx.userId, '表示名': ctx.name, id: randomKey_().slice(0, 10),
    });
  });
  if (!ok.length && dup && !ng.length) {
    const linked = linkResultsToEvents_();
    return 'どの記録も、もう入っています（' + dup + '件）。2重にはしていません' + (linked ? '。' + linked + '件を、その日の大会・練習に結びつけました' : '');
  }
  if (!ok.length) throw new Error(ng.join('\n') || '入れる記録がありません。');
  withLock_(() => ok.forEach((row) => appendRow_(SHEETS.RESULTS, row)));
  const linked = linkResultsToEvents_();
  return ok.length + '件の記録を入れました' + (linked ? '（' + linked + '件はその日の大会・練習のページにも出ます）' : '') + (dup ? '（' + dup + '件はもう入っていたので、とばしました）' : '') + (ng.length ? '（入れられなかったもの：' + ng.join('／') + '）' : '');
}

// ---- タイムテーブルづくり（コーチ・役員が事前に） ----

/**
 * タイムテーブルの表（種目・時刻・招集・アップ・出る子）をまとめて保存する（役員と当番）。
 *   ・時刻表（タイムテーブル）を入れかえる
 *   ・集合時刻を大会の案内に入れ、表の種目を案内の種目に足す
 *   ・出る子のエントリー（参加・種目）を表にそろえる（表にない種目はそのまま残す）
 * @param {{key: string, meetTime: string, rows: Object[]}} p rows の kids に、出る子の名前
 */
function saveTimetablePlanAction_(ctx, p) {
  const ev = findEvent_(p.key);
  if (!ev) throw new Error('大会が見つかりません。');
  requireManager_(ctx, p.key);
  const rows = (p.rows || []).slice(0, 200);
  saveTimetableAction_(ctx, { key: p.key, rows: rows });
  const kids = {};
  activeChildren_().forEach((c) => (kids[c.name] = c));
  const planRaces = rows.map((r) => String(r.race || '').trim()).filter((r) => r && !/全体/.test(r)).filter((r, i, a) => a.indexOf(r) === i);
  const assigned = {};
  rows.forEach((r) => (r.kids || []).forEach((n) => { if (kids[n]) (assigned[n] = assigned[n] || []).push(String(r.race).trim()); }));
  let changed = 0;
  withLock_(() => {
    let race = readRows_(SHEETS.RACES).find((r) => r.eventKey === p.key);
    if (!race) race = appendRow_(SHEETS.RACES, { eventKey: p.key, '種別': '大会', '対象': '全員', '更新日時': now_() });
    const list = splitNames_(race['種目']);
    planRaces.forEach((r) => { if (list.indexOf(r) < 0) list.push(r); });
    race['種目'] = list.join(',');
    const meet = cleanTime_(p.meetTime || '');
    if (meet) race['集合時刻'] = meet;
    race['時刻表メモ'] = String(p.memo || '').slice(0, 1000);
    race['時刻表下書き'] = '';
    race['更新日時'] = now_();
    updateRow_(SHEETS.RACES, race);
    const entries = readRows_(SHEETS.ENTRIES).filter((x) => x.eventKey === p.key);
    Object.keys(kids).forEach((name) => {
      const mine = (assigned[name] || []).filter((r, i, a) => a.indexOf(r) === i);
      const row = entries.find((x) => x['子ども'] === name);
      const before = row ? splitNames_(row['種目']) : [];
      const next = before.filter((r) => planRaces.indexOf(r) < 0).concat(mine);
      if (!row && !mine.length) return;
      if (row && next.join(',') === before.join(',') && (!mine.length || row['回答'] === '参加')) return;
      const data = { eventKey: p.key, '子ども': name, '回答': mine.length ? '参加' : row['回答'], '種目': next.join(','), '更新者': ctx.name, '更新日時': now_() };
      if (row) updateRow_(SHEETS.ENTRIES, Object.assign(row, data));
      else appendRow_(SHEETS.ENTRIES, Object.assign(data, { '集金': '' }));
      changed++;
    });
  });
  logHistory_(p.key, ctx, 'タイムテーブルを大会に反映（' + rows.length + '種目・エントリー ' + changed + '人を更新）');
  return 'タイムテーブルを大会に反映しました（' + rows.length + '件・エントリー ' + changed + '人を更新）';
}

/** タイムテーブルの下書き（まだ大会には出さない）。役員・当番 */
function saveTimetableDraftAction_(ctx, p) {
  if (!findEvent_(p.key)) throw new Error('大会が見つかりません。');
  requireManager_(ctx, p.key);
  const json = p.clear ? '' : JSON.stringify(p.draft || {});
  if (json.length > 45000) throw new Error('下書きが大きすぎます。種目を減らしてください。');
  withLock_(() => {
    let race = readRows_(SHEETS.RACES).find((r) => r.eventKey === p.key);
    if (!race) race = appendRow_(SHEETS.RACES, { eventKey: p.key, '種別': '大会', '対象': '全員', '更新日時': now_() });
    race['時刻表下書き'] = json;
    updateRow_(SHEETS.RACES, race);
  });
  return p.clear ? '下書きを消しました' : '下書きを保存しました（まだ大会には出ていません）';
}

// ---- アンケート（出欠・投票） ----

/** アンケートをつくる（役員）。選択肢はボタンで答える。家族ごとに1つの回答 */
function savePollAction_(ctx, p) {
  const title = String(p.title || '').trim().slice(0, 80);
  const options = (p.options || []).map((x) => String(x).trim().slice(0, 30)).filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).slice(0, 12);
  if (!title) throw new Error('タイトルを入れてください。');
  if (options.length < 2) throw new Error('選択肢を2つ以上入れてください。');
  withLock_(() => appendRow_(SHEETS.POLLS, {
    id: randomKey_().slice(0, 10), 'タイトル': title, '説明': String(p.body || '').slice(0, 1000), '選択肢': JSON.stringify(options), '複数': p.multi ? '○' : '',
    '締切': /^\d{4}-\d{2}-\d{2}$/.test(p.deadline || '') ? p.deadline : '', eventKey: p.key || '', '作成者': ctx.name, '日時': now_(), '終了': '',
  }));
  return 'アンケートをつくりました';
}

function closePollAction_(ctx, p) {
  withLock_(() => {
    const row = readRows_(SHEETS.POLLS).find((x) => x.id && x.id === p.id);
    if (!row) throw new Error('アンケートが見つかりません。');
    if (p.remove) clearRow_(SHEETS.POLLS, row);
    else {
      row['終了'] = p.reopen ? '' : '○';
      if (p.reopen && row['締切'] && row['締切'] < today_()) row['締切'] = '';
      updateRow_(SHEETS.POLLS, row);
    }
  });
  return p.remove ? 'アンケートを消しました' : p.reopen ? 'アンケートを再開しました' : 'アンケートを締め切りました';
}

function answerPollAction_(ctx, p) {
  const poll = readRows_(SHEETS.POLLS).find((x) => x.id && x.id === p.id);
  if (!poll) throw new Error('アンケートが見つかりません。');
  if (poll['終了'] === '○' || (poll['締切'] && today_() > poll['締切'])) throw new Error('このアンケートは締め切りました。');
  const options = JSON.parse(poll['選択肢'] || '[]');
  let ans = (p.answers || []).map(String).filter((x) => options.indexOf(x) >= 0);
  if (poll['複数'] !== '○') ans = ans.slice(0, 1);
  withLock_(() => {
    const row = readRows_(SHEETS.ANSWERS).find((x) => x['アンケートid'] === p.id && x['家族ID'] === ctx.famId);
    const data = { 'アンケートid': p.id, '家族ID': ctx.famId, '回答': JSON.stringify(ans), 'コメント': String(p.comment || '').slice(0, 200), '更新者': ctx.name, '日時': now_() };
    if (row) updateRow_(SHEETS.ANSWERS, Object.assign(row, data));
    else appendRow_(SHEETS.ANSWERS, data);
  });
  return ans.length ? '回答しました：' + ans.join('・') : '回答を取り消しました';
}

/** 画面に渡すアンケート（終わってから60日まで）。結果の数・わが家の回答。役員には未回答の家族 */
function pollsFor_(ctx, families) {
  const answers = readRows_(SHEETS.ANSWERS);
  const label = {};
  families.forEach((f) => (label[f.id] = f.label));
  return readRows_(SHEETS.POLLS).filter((x) => x.id).reverse().map((x) => {
    const options = JSON.parse(x['選択肢'] || '[]');
    const mine = answers.filter((a) => a['アンケートid'] === x.id);
    const counts = {};
    options.forEach((o) => (counts[o] = 0));
    const who = {};
    mine.forEach((a) => JSON.parse(a['回答'] || '[]').forEach((o) => { counts[o] = (counts[o] || 0) + 1; (who[o] = who[o] || []).push(label[a['家族ID']] || a['更新者']); }));
    const my = mine.find((a) => a['家族ID'] === ctx.famId);
    const closed = x['終了'] === '○' || (x['締切'] && today_() > x['締切']);
    const answered = mine.filter((a) => JSON.parse(a['回答'] || '[]').length).map((a) => a['家族ID']);
    return {
      id: x.id, title: x['タイトル'], body: x['説明'], options: options, multi: x['複数'] === '○', deadline: x['締切'], key: x.eventKey, by: x['作成者'], at: x['日時'], closed: closed,
      counts: counts, who: who, total: answered.length, families: families.length, mine: my ? JSON.parse(my['回答'] || '[]') : [], myComment: my ? my['コメント'] : '',
      unanswered: ctx.admin ? families.filter((f) => answered.indexOf(f.id) < 0).map((f) => f.label) : [],
    };
  }).filter((p) => !p.closed || String(p.at).slice(0, 10) >= addDays_(today_(), -60));
}

// ---- 集金（年会費・ユニフォーム代など） ----

function saveFeeAction_(ctx, p) {
  const name = String(p.name || '').trim().slice(0, 40);
  const amount = Number(toHalfWidth_(p.amount || '').replace(/[^0-9]/g, ''));
  if (!name) throw new Error('名前を入れてください（例：年会費）。');
  if (!amount) throw new Error('金額を入れてください。');
  withLock_(() => appendRow_(SHEETS.FEES, {
    id: randomKey_().slice(0, 10), '名前': name, '金額': String(amount), '対象': String(p.target || '全員').slice(0, 20),
    '期限': /^\d{4}-\d{2}-\d{2}$/.test(p.deadline || '') ? p.deadline : '', 'メモ': String(p.memo || '').slice(0, 200), '作成者': ctx.name, '日時': now_(), '終了': '',
  }));
  return '集金「' + name + '」をつくりました';
}

function closeFeeAction_(ctx, p) {
  withLock_(() => {
    const row = readRows_(SHEETS.FEES).find((x) => x.id && x.id === p.id);
    if (!row) throw new Error('見つかりません。');
    if (p.remove) clearRow_(SHEETS.FEES, row);
    else { row['終了'] = p.reopen ? '' : '○'; updateRow_(SHEETS.FEES, row); }
  });
  return p.remove ? '集金を消しました' : p.reopen ? '集金を再開しました' : '集金を終わりにしました';
}

function setFeePaidAction_(ctx, p) {
  withLock_(() => {
    const row = readRows_(SHEETS.FEE_PAID).find((x) => x['集金id'] === p.id && x['子ども'] === p.child);
    const data = { '集金id': p.id, '子ども': p.child, '状態': p.paid ? '済' : '', '更新者': ctx.name, '日時': now_() };
    if (row) updateRow_(SHEETS.FEE_PAID, Object.assign(row, data));
    else appendRow_(SHEETS.FEE_PAID, data);
  });
  return '';
}

/** 画面に渡す集金。対象の子ども（学年で決まる）と、済んだ子 */
function feesFor_(ctx, children) {
  const paid = readRows_(SHEETS.FEE_PAID).filter((x) => x['状態'] === '済');
  return readRows_(SHEETS.FEES).filter((x) => x.id).reverse().map((x) => {
    // 役員以外には、自分の子の分だけ見せる（だれが払ったかは役員だけ）
    const target = children.filter((c) => inTarget_(x['対象'], c.grade) && (ctx.admin || c.parents.indexOf(ctx.userId) >= 0)).map((c) => c.name);
    return {
      id: x.id, name: x['名前'], amount: Number(x['金額']) || 0, target: x['対象'], deadline: x['期限'], memo: x['メモ'], closed: x['終了'] === '○', at: x['日時'],
      kids: target, paid: paid.filter((y) => y['集金id'] === x.id && target.indexOf(y['子ども']) >= 0).map((y) => y['子ども']),
    };
  }).filter((f) => !f.closed || String(f.at).slice(0, 10) >= addDays_(today_(), -120));
}

// ---- 練習の出席（✓ を押した子）と、練習中のタイム計測 ----

function clearAttend_(date, child) {
  readRows_(SHEETS.ATTEND).filter((x) => x['日付'] === date && x['子ども'] === child).forEach((x) => clearRow_(SHEETS.ATTEND, x));
}

/** 練習に「出席」と答える（on=false で取り消し）。出席にすると、その日の休みの連絡は取り消す */
function setAttendAction_(ctx, p) {
  requireMyChild_(ctx, p.child);
  const ev = findEvent_(p.key);
  if (!ev) throw new Error('予定が見つかりません。');
  const date = ev['日付'];
  if (date < today_() && !ctx.admin) throw new Error('過ぎた日の出欠は変えられません。');
  withLock_(() => {
    clearAttend_(date, p.child);
    if (!p.on) return;
    readRows_(SHEETS.ABSENCES).filter((a) => a.id && a['日付'] === date && a['子ども'] === p.child).forEach((a) => clearRow_(SHEETS.ABSENCES, a));
    appendRow_(SHEETS.ATTEND, { '日付': date, eventKey: p.key, '子ども': p.child, userId: ctx.userId, '表示名': ctx.name, '日時': now_() });
  });
  return p.on ? p.child + '：出席にしました' : '';
}

/**
 * 練習で測ったタイムを、子どもごとの練習の記録として入れる（役員とその日の当番）。
 * 同じ練習・同じ子・同じ距離・同じ本目は上書き。記録を空にすると消す。
 * @param {{key: string, name: string, run: number, rows: {child: string, race: string, record: string}[]}} p
 */
function saveTimesAction_(ctx, p) {
  const ev = findEvent_(p.key);
  if (!ev) throw new Error('練習が見つかりません。');
  requireManager_(ctx, p.key);
  const kids = {};
  activeChildren_().forEach((c) => (kids[c.name] = true));
  const name = String(p.name || '').trim().slice(0, 20);
  const run = Math.max(1, Math.min(9, Number(p.run) || 1));
  const memo = (name ? name + ' ' : '') + run + '本目';
  let saved = 0, removed = 0;
  withLock_(() => {
    const all = readRows_(SHEETS.RESULTS);
    (p.rows || []).slice(0, 200).forEach((r) => {
      const child = String(r.child || '').trim();
      const race = String(r.race || '').trim().slice(0, 30);
      const record = toHalfWidth_(r.record || '').trim().replace(/\s/g, '').slice(0, 20);
      if (!kids[child] || !race) return;
      const old = all.find((x) => x.eventKey === p.key && x['子ども'] === child && x['メモ'] === memo);
      if (!record) { if (old) { clearRow_(SHEETS.RESULTS, old); removed++; } return; }
      if (old) {
        if (old['記録'] === record && old['種目'] === race) return;
        Object.assign(old, { '種目': race, '記録': record, '日時': now_(), userId: ctx.userId, '表示名': ctx.name });
        updateRow_(SHEETS.RESULTS, old);
      } else {
        appendRow_(SHEETS.RESULTS, {
          '日時': now_(), eventKey: p.key, '大会・練習': ev['日付'] + ' ' + (ev['タイトル'] || '練習'), '子ども': child, '種目': race, '記録': record,
          '順位': '', 'ラウンド': '', '区分': '練習', 'メモ': memo, userId: ctx.userId, '表示名': ctx.name, id: randomKey_().slice(0, 10),
        });
      }
      saved++;
    });
  });
  if (!saved && !removed) return '変わったところはありません';
  return memo + 'のタイムを' + saved + '人分保存しました' + (removed ? '（' + removed + '人分を消しました）' : '');
}

// ---- 自主トレ（ふだんの日の個人トレーニングの記録）。見られるのは、その子の家族だけ ----

function myKidNames_(ctx) {
  return childrenOf_(ctx.userId).map((c) => c.name);
}

/** 自主トレを見せる範囲：子どもの名前 → 'coach'（コーチに見せる）／'all'（みんなに見せる）。家族だけの子は入らない */
function trainShareLevels_() {
  const lv = {};
  readRows_(SHEETS.TRAIN_SHARE).forEach((x) => {
    if (!x['子ども']) return;
    const v = x['公開'] === '全員' ? 'all' : x['公開'] === '○' ? 'coach' : '';
    if (v) lv[x['子ども']] = v; else delete lv[x['子ども']];
  });
  return lv;
}

/** この人が（わが家の子のほかに）見られる子：コーチは「コーチ」「みんな」の子、ほかの人は「みんな」の子 */
function viewableTrainKids_(ctx) {
  const lv = trainShareLevels_();
  return Object.keys(lv).filter((k) => lv[k] === 'all' || (ctx.coach && lv[k] === 'coach'));
}

/** コーチとやりとりできる子（コーチに見せている子） */
function coachThreadKids_(ctx) {
  if (!ctx.coach) return [];
  const lv = trainShareLevels_();
  return Object.keys(lv);
}

/** mine：わが家の子の見せる範囲／kids：わが家のほかに見られる子（学年・範囲つき） */
function trainShareFor_(ctx, children) {
  const lv = trainShareLevels_();
  const myKids = children.filter((c) => c.parents.indexOf(ctx.userId) >= 0).map((c) => c.name);
  const view = viewableTrainKids_(ctx);
  const mine = {};
  myKids.forEach((k) => (mine[k] = lv[k] || ''));
  return {
    mine: mine,
    kids: children.filter((c) => view.indexOf(c.name) >= 0 && myKids.indexOf(c.name) < 0).map((c) => ({ name: c.name, grade: c.grade, level: lv[c.name] })),
  };
}

function setTrainShareAction_(ctx, p) {
  if (myKidNames_(ctx).indexOf(p.child) < 0) throw new Error('わが家のお子さんを選んでください。');
  const level = p.level !== undefined ? p.level : p.on ? 'coach' : '';
  const v = level === 'all' ? '全員' : level === 'coach' ? '○' : '';
  withLock_(() => {
    const row = readRows_(SHEETS.TRAIN_SHARE).find((x) => x['子ども'] === p.child);
    const data = { '子ども': p.child, '公開': v, '更新者': ctx.name, '日時': now_() };
    if (row) { Object.assign(row, data); updateRow_(SHEETS.TRAIN_SHARE, row); } else appendRow_(SHEETS.TRAIN_SHARE, data);
  });
  return p.child + 'の自主トレを、' + (v === '全員' ? 'みんなに見せる' : v ? 'コーチに見せる' : '家族だけが見る') + 'ようにしました';
}

// ---- 自主トレへのコーチのコメント（その子の家族とコーチのやりとり） ----

function canTrainThread_(ctx, child) {
  return myKidNames_(ctx).indexOf(child) >= 0 || coachThreadKids_(ctx).indexOf(child) >= 0;
}

function trainCommentsFor_(ctx, children) {
  const kids = myKidNames_(ctx).concat(coachThreadKids_(ctx));
  if (!kids.length) return { list: [], read: {} };
  const read = {};
  readRows_(SHEETS.TRAIN_SHARE).forEach((x) => { if (kids.indexOf(x['子ども']) >= 0) read[x['子ども']] = x['家族既読'] || ''; });
  const list = readRows_(SHEETS.TRAIN_COMMENTS).filter((x) => x.id && kids.indexOf(x['子ども']) >= 0).map((x) => ({
    id: x.id, child: x['子ども'], text: x['本文'], by: x['表示名'], coach: x['コーチ'] === '○', at: x['日時'], mine: x.userId === ctx.userId,
  }));
  return { list: list, read: read };
}

function addTrainCommentAction_(ctx, p) {
  if (!canTrainThread_(ctx, p.child)) throw new Error('この子の自主トレには書きこめません。');
  const text = String(p.text || '').trim().slice(0, 500);
  if (!text) throw new Error('コメントを書いてください。');
  const isFamily = myKidNames_(ctx).indexOf(p.child) >= 0;
  withLock_(() => appendRow_(SHEETS.TRAIN_COMMENTS, {
    id: randomKey_().slice(0, 10), '子ども': p.child, '本文': text, userId: ctx.userId, '表示名': ctx.name, 'コーチ': ctx.coach && !isFamily ? '○' : '', '日時': now_(),
  }));
  return 'コメントしました';
}

function deleteTrainCommentAction_(ctx, p) {
  withLock_(() => {
    const row = readRows_(SHEETS.TRAIN_COMMENTS).find((x) => x.id && x.id === p.id);
    if (!row || row.userId !== ctx.userId) throw new Error('消せるコメントが見つかりません。');
    clearRow_(SHEETS.TRAIN_COMMENTS, row);
  });
  return 'コメントを消しました';
}

/** 家族が自主トレを開いたら、コーチのコメントを「読んだ」にする */
function markTrainReadAction_(ctx, p) {
  if (myKidNames_(ctx).indexOf(p.child) < 0) return '';
  withLock_(() => {
    const row = readRows_(SHEETS.TRAIN_SHARE).find((x) => x['子ども'] === p.child);
    if (row) { row['家族既読'] = now_(); updateRow_(SHEETS.TRAIN_SHARE, row); } else appendRow_(SHEETS.TRAIN_SHARE, { '子ども': p.child, '公開': '', '更新者': ctx.name, '日時': now_(), '家族既読': now_() });
  });
  return '';
}

/** コーチにする・外す（役員だけ）。コーチは、見せてもらっている子の自主トレを見られる */
function setCoachAction_(ctx, p) {
  withLock_(() => {
    const f = findFamily_(p.userId);
    if (!f) throw new Error('見つかりません。');
    f['コーチ'] = p.on ? '○' : '';
    f['更新日時'] = now_();
    updateRow_(SHEETS.FAMILIES, f);
  });
  return p.on ? 'コーチにしました' : 'コーチから外しました';
}

function trainingFor_(ctx, children) {
  let mine = children.filter((c) => c.parents.indexOf(ctx.userId) >= 0).map((c) => c.name);
  mine = mine.concat(viewableTrainKids_(ctx));
  if (!mine.length) return [];
  const from = addDays_(today_(), -400);
  return readRows_(SHEETS.TRAINING)
    .filter((x) => x.id && mine.indexOf(x['子ども']) >= 0 && x['日付'] >= from)
    .map((x) => ({ id: x.id, date: x['日付'], child: x['子ども'], kind: x['種類'], km: Number(x['距離km']) || 0, min: Number(x['時間分']) || 0, count: Number(x['回数']) || 0, feel: x['調子'], memo: x['メモ'] }));
}

/** 自主トレを入れる・直す（id があれば直す） */
function saveTrainingAction_(ctx, p) {
  if (myKidNames_(ctx).indexOf(p.child) < 0) throw new Error('わが家のお子さんを選んでください。');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date || '')) throw new Error('日にちを選んでください。');
  if (p.date > today_()) throw new Error('先の日の記録は入れられません。');
  const kind = String(p.kind || '').trim().slice(0, 20);
  if (!kind) throw new Error('何をしたかを選んでください。');
  const num = (v, max) => { const n = Number(toHalfWidth_(String(v || '')).replace(/[^0-9.]/g, '')); return n > 0 ? Math.min(n, max) : 0; };
  const row = {
    '日付': p.date, '子ども': p.child, '種類': kind, '距離km': num(p.km, 100) ? String(Math.round(num(p.km, 100) * 100) / 100) : '',
    '時間分': num(p.min, 600) ? String(Math.round(num(p.min, 600))) : '', '回数': num(p.count, 10000) ? String(Math.round(num(p.count, 10000))) : '',
    '調子': ['◎', '○', '△'].indexOf(p.feel) >= 0 ? p.feel : '', 'メモ': String(p.memo || '').slice(0, 200), userId: ctx.userId, '表示名': ctx.name, '日時': now_(),
  };
  if (!row['距離km'] && !row['時間分'] && !row['回数'] && !row['メモ']) throw new Error('距離・時間・回数のどれかを入れてください。');
  withLock_(() => {
    const old = p.id ? readRows_(SHEETS.TRAINING).find((x) => x.id && x.id === p.id) : null;
    if (old) {
      if (myKidNames_(ctx).indexOf(old['子ども']) < 0) throw new Error('直せる記録が見つかりません。');
      Object.assign(old, row);
      updateRow_(SHEETS.TRAINING, old);
    } else {
      appendRow_(SHEETS.TRAINING, Object.assign({ id: randomKey_().slice(0, 10) }, row));
    }
  });
  return p.child + '：' + kind + 'を記録しました';
}

function deleteTrainingAction_(ctx, p) {
  withLock_(() => {
    const old = readRows_(SHEETS.TRAINING).find((x) => x.id && x.id === p.id);
    if (!old || myKidNames_(ctx).indexOf(old['子ども']) < 0) throw new Error('消せる記録が見つかりません。');
    clearRow_(SHEETS.TRAINING, old);
  });
  return '記録を消しました';
}

// ---- 練習に参加した時間の積み上げ（休みの連絡がなかった練習を、参加として数える） ----

/**
 * 子どもごとの、月ごとの練習時間（分）と、出た大会の数。1年分。
 * 役員・コーチにはクラブ全員、ほかの人にはわが家の子だけ。
 * @return {{kids: Object<string, {m: Object<string, number>, n: number, races: number}>}}
 */
function participationFor_(ctx, children) {
  const today = today_(), from = addDays_(today, -365);
  const full = ctx.admin || ctx.coach;
  const visible = (full ? children : children.filter((c) => c.parents.indexOf(ctx.userId) >= 0)).map((c) => c.name);
  const names = children.map((c) => c.name); // 平均を出すため、計算は全員分
  const out = {};
  names.forEach((n) => (out[n] = { m: {}, n: 0, races: 0 }));
  if (!visible.length) return { kids: {}, avg: {} };
  const off = {};
  readRows_(SHEETS.ABSENCES).forEach((a) => { if (a.id && a['日付'] >= from) off[a['日付'] + '|' + a['子ども']] = true; });
  const raceKeys = {};
  readRows_(SHEETS.RACES).forEach((r) => (raceKeys[r.eventKey] = true));
  const events = readRows_(SHEETS.EVENTS).filter((e) => e['日付'] >= from && e['日付'] <= today && e['状態'] !== '中止');
  events.forEach((e) => {
    const type = e['種別'] || guessType_(e['タイトル']);
    if (type !== '練習' || raceKeys[e.eventKey]) return;
    if (e['日付'] === today && e['終了'] && toMin_(e['終了']) > toMin_(fmt_(new Date(), 'HH:mm'))) return; // 今日の練習は終わってから
    const len = e['開始'] && e['開始'] !== '終日' && e['終了'] ? Math.max(0, toMin_(e['終了']) - toMin_(e['開始'])) : 90;
    if (!len) return;
    const mon = e['日付'].slice(0, 7);
    names.forEach((n) => {
      if (off[e['日付'] + '|' + n]) return;
      out[n].m[mon] = (out[n].m[mon] || 0) + len;
      out[n].n++;
    });
  });
  const past = {};
  events.forEach((e) => (past[e.eventKey] = true));
  readRows_(SHEETS.ENTRIES).forEach((x) => { if (past[x.eventKey] && x['回答'] === '参加' && out[x['子ども']]) out[x['子ども']].races++; });
  // 1年の合計時間の平均：チーム・学年・学年と男女。保護者には3人以上の組だけ（だれの時間か分からないように）
  const groups = {};
  const add = (k, v) => { const g = groups[k] || (groups[k] = { sum: 0, n: 0 }); g.sum += v; g.n++; };
  children.forEach((c) => {
    const total = Object.keys(out[c.name].m).reduce((a, m) => a + out[c.name].m[m], 0);
    add('team', total);
    if (c.grade) add('g' + c.grade, total);
    if (c.grade && c.sex) add('g' + c.grade + c.sex, total);
  });
  const avg = {};
  Object.keys(groups).forEach((k) => { if (full || groups[k].n >= 3) avg[k] = { min: Math.round(groups[k].sum / groups[k].n), n: groups[k].n }; });
  const kids = {};
  visible.forEach((n) => (kids[n] = out[n]));
  return { kids: kids, avg: avg };
}

// ---- 役員になる：申請して役員が承認する／合言葉（役員の番号）を入れる／役員がだれもいなければすぐ役員 ----

function adminCode_(renew) {
  const props = PropertiesService.getScriptProperties();
  let code = props.getProperty('ADMIN_CODE');
  if (!code || renew) {
    code = String(Math.floor(100000 + Math.random() * 900000));
    props.setProperty('ADMIN_CODE', code);
  }
  return code;
}

/** 役員の番号を見る・作りなおす（役員だけ） */
function adminCodeAction_(ctx, p) {
  return { code: adminCode_(!!p.renew) };
}

/** 家族ごと役員にする（父・母どちらの行も） */
function makeAdmin_(f) {
  familyRowsOf_(readRows_(SHEETS.FAMILIES), famIdOf_(f)).forEach((x) => {
    x['役員'] = '○';
    x['役員申請'] = '';
    x['更新日時'] = now_();
    updateRow_(SHEETS.FAMILIES, x);
  });
}

/**
 * 役員になりたいと申請する。code（役員の番号）が合えば、すぐ役員。
 * 役員がひとりもいないときも、すぐ役員（最初の設定のため）。cancel で申請を取り下げる
 */
function requestAdminAction_(ctx, p) {
  if (ctx.admin) return 'すでに役員です';
  const code = String(p.code || '').replace(/[^0-9]/g, '');
  return withLock_(() => {
    const rows = readRows_(SHEETS.FAMILIES);
    const f = rows.find((x) => x.userId === ctx.userId);
    if (!f) throw new Error('見つかりません。');
    if (p.cancel) { f['役員申請'] = ''; updateRow_(SHEETS.FAMILIES, f); return '役員の申請を取り下げました'; }
    if (!rows.some(isAdminRow_)) { makeAdmin_(f); return '役員がまだいなかったので、役員になりました'; }
    if (code) {
      if (code !== adminCode_(false)) throw new Error('役員の番号がちがいます。役員の人に「管理」→「メンバーと役員」で番号を見てもらってください。');
      makeAdmin_(f);
      return '役員になりました';
    }
    f['役員申請'] = now_();
    updateRow_(SHEETS.FAMILIES, f);
    return '役員の申請をしました。役員の人が「管理」→「メンバーと役員」で承認すると、「管理」が出ます';
  });
}

/** 役員の申請を承認する・断る（役員だけ） */
function answerAdminAction_(ctx, p) {
  return withLock_(() => {
    const f = findFamily_(p.userId);
    if (!f) throw new Error('見つかりません。');
    if (p.ok) { makeAdmin_(f); return (f['表示名'] || '') + 'さんの家族を役員にしました'; }
    familyRowsOf_(readRows_(SHEETS.FAMILIES), famIdOf_(f)).forEach((x) => { x['役員申請'] = ''; updateRow_(SHEETS.FAMILIES, x); });
    return '申請を断りました';
  });
}

/** 家族の係（会計・記録係など）を決める（役員だけ）。父・母どちらの行もそろえる */
function setRoleAction_(ctx, p) {
  const role = String(p.role || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  withLock_(() => {
    const rows = familyRowsOf_(readRows_(SHEETS.FAMILIES), String(p.fam || ''));
    if (!rows.length) throw new Error('家族が見つかりません。');
    rows.forEach((x) => { x['係'] = role; x['更新日時'] = now_(); updateRow_(SHEETS.FAMILIES, x); });
  });
  return role ? '係を「' + role + '」にしました' : '係を外しました';
}

// ---- 管理者（ポータルの持ち主）：Apps Script の setup のログに出る番号を入れた人。一人ずつ ----

function ownerCode_() {
  const props = PropertiesService.getScriptProperties();
  let code = props.getProperty('OWNER_CODE');
  if (!code) { code = String(Math.floor(10000000 + Math.random() * 90000000)); props.setProperty('OWNER_CODE', code); }
  return code;
}

/** 管理者の番号を入れて管理者になる（番号は Apps Script の持ち主だけがログで見られる） */
function becomeOwnerAction_(ctx, p) {
  const code = String(p.code || '').replace(/[^0-9]/g, '');
  const now = Date.now(), props = PropertiesService.getScriptProperties();
  const lock = Number(props.getProperty('OWNER_LOCK_' + ctx.userId) || 0);
  if (lock > now) throw new Error('まちがいが続いたので、しばらくしてからもう一度ためしてください。');
  if (!code || code !== ownerCode_()) {
    const miss = Number(props.getProperty('OWNER_MISS_' + ctx.userId) || 0) + 1;
    props.setProperty('OWNER_MISS_' + ctx.userId, String(miss));
    if (miss >= 5) { props.setProperty('OWNER_LOCK_' + ctx.userId, String(now + 30 * 60000)); props.deleteProperty('OWNER_MISS_' + ctx.userId); }
    throw new Error('管理者の番号がちがいます。Apps Script で「setup」か「showOwnerCode」を実行すると、ログに番号が出ます。');
  }
  props.deleteProperty('OWNER_MISS_' + ctx.userId);
  withLock_(() => {
    const f = findFamily_(ctx.userId);
    f['管理者'] = '○';
    f['更新日時'] = now_();
    updateRow_(SHEETS.FAMILIES, f);
  });
  return '管理者になりました';
}

/** 管理者にする・外す（管理者だけ）。管理者が一人もいなくなる操作はできない */
function setOwnerAction_(ctx, p) {
  if (!ctx.owner) throw new Error('この操作は管理者だけができます。');
  withLock_(() => {
    const rows = readRows_(SHEETS.FAMILIES);
    const f = rows.find((x) => x.userId === p.userId);
    if (!f) throw new Error('見つかりません。');
    if (!p.on && !rows.some((x) => x.userId !== f.userId && isOwner_(x))) throw new Error('管理者が一人もいなくなるので、外せません。');
    f['管理者'] = p.on ? '○' : '';
    f['更新日時'] = now_();
    updateRow_(SHEETS.FAMILIES, f);
  });
  return p.on ? '管理者にしました' : '管理者から外しました';
}

// ---- 名簿：役員が子どもの名前・学年・男女をまとめて入れる。保護者が同じ名前で登録すると、その子に結びつく ----

/** @param {{rows: {name: string, grade: number, sex: string}[]}} p */
function saveRosterAction_(ctx, p) {
  const list = (p.rows || []).slice(0, 200).map((r) => ({
    name: String(r.name || '').trim().replace(/\s+/g, ' ').slice(0, 30),
    grade: Math.max(0, Math.min(6, Number(toHalfWidth_(String(r.grade || '')).replace(/[^0-9]/g, '')) || 0)),
    sex: /男/.test(r.sex || '') ? '男' : /女/.test(r.sex || '') ? '女' : '',
  })).filter((r) => r.name);
  if (!list.length) throw new Error('名前を入れてください。');
  let added = 0, updated = 0;
  withLock_(() => {
    const rows = readRows_(SHEETS.CHILDREN);
    list.forEach((c) => {
      const row = rows.find((r) => sameKidName_(r['名前'], c.name));
      if (row) {
        row['名簿'] = '○';
        if (c.grade) row['学年'] = String(c.grade);
        if (c.sex) row['性別'] = c.sex;
        row['更新日時'] = now_();
        updateRow_(SHEETS.CHILDREN, row);
        updated++;
      } else {
        const r = { '名前': c.name, '学年': c.grade ? String(c.grade) : '', '保護者userId': '', '性別': c.sex, '更新日時': now_(), '名簿': '○' };
        appendRow_(SHEETS.CHILDREN, r);
        rows.push(r);
        added++;
      }
    });
  });
  return '名簿に' + added + '人を入れました' + (updated ? '（' + updated + '人は学年などを直しました）' : '');
}

/** 名簿から外す。保護者が登録していない子は消える（記録はスプレッドシートに残る） */
function removeRosterAction_(ctx, p) {
  withLock_(() => {
    const row = readRows_(SHEETS.CHILDREN).find((r) => r['名前'] && sameKidName_(r['名前'], p.name));
    if (!row) throw new Error('見つかりません。');
    if (splitNames_(row['保護者userId']).length) { row['名簿'] = ''; row['更新日時'] = now_(); updateRow_(SHEETS.CHILDREN, row); }
    else clearRow_(SHEETS.CHILDREN, row);
  });
  return p.name + 'を名簿から外しました';
}

/** 2重に入った記録（同じ子・種目・記録・大会名・区分）を、1つだけ残して消す（役員） */
function removeDuplicateRecordsAction_(ctx) {
  let n = 0;
  withLock_(() => {
    const seen = {};
    readRows_(SHEETS.RESULTS).forEach((x) => {
      if (!x['記録']) return;
      const k = [String(x['子ども']).replace(/\s|　/g, ''), x['種目'], x['記録'], x['大会・練習'], x['区分'], x['メモ']].join('|');
      if (seen[k]) { clearRow_(SHEETS.RESULTS, x); n++; } else seen[k] = true;
    });
  });
  return n ? '2重になっていた記録を' + n + '件消しました' : '2重になっている記録はありません';
}

/**
 * 大会・練習に結びついていない記録を、同じ日の予定に結びつける（大会のページの「結果」に出るように）。
 * 公式の記録はその日の大会に、練習の記録はその日の練習に。その日にひとつだけあるときだけ結びつける。
 * @return {number} 結びつけた件数
 */
function linkResultsToEvents_() {
  const raceKeys = {};
  readRows_(SHEETS.RACES).forEach((r) => (raceKeys[r.eventKey] = true));
  const byDate = {};
  readRows_(SHEETS.EVENTS).forEach((e) => {
    if (!e.eventKey || e['状態'] === '中止') return;
    const race = raceKeys[e.eventKey] || (e['種別'] || guessType_(e['タイトル'])) !== '練習';
    const d = byDate[e['日付']] || (byDate[e['日付']] = { race: [], prac: [] });
    d[race ? 'race' : 'prac'].push(e.eventKey);
  });
  let n = 0;
  withLock_(() => {
    readRows_(SHEETS.RESULTS).forEach((x) => {
      if (!x['記録'] || x.eventKey) return;
      const d = byDate[String(x['大会・練習'] || '').slice(0, 10)];
      if (!d) return;
      const list = x['区分'] === '練習' ? d.prac : d.race;
      if (list.length !== 1) return;
      x.eventKey = list[0];
      updateRow_(SHEETS.RESULTS, x);
      n++;
    });
  });
  return n;
}
