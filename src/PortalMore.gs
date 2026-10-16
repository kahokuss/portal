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
  return 'タイムテーブルを保存しました（' + list.length + '件）';
}

// ---- 手続き（チェックリスト） ----

/** 招集はだれでも（会場で助け合えるように）。ほかは役員と当番 */
function requireTaskRight_(ctx, key, kind) {
  if (CHOICES.TASKS.indexOf(kind) < 0) throw new Error('不明な手続きです。');
  if (kind !== '招集') requireManager_(ctx, key);
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
  return p.done ? kind + '：済にしました' : '';
}

// ---- 写真 ----

/** ポータルから写真を上げる。kind があれば、その手続きの写真として付ける */
function uploadPhotoAction_(ctx, p) {
  const ev = findEvent_(p.key);
  if (!ev) throw new Error('予定が見つかりません。');
  const kind = String(p.kind || '');
  if (kind) requireTaskRight_(ctx, p.key, kind);
  const m = String(p.data || '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw new Error('写真を読み込めませんでした。');
  if (m[2].length > 8 * 1024 * 1024) throw new Error('写真が大きすぎます。');
  const at = now_();
  const ext = EXTENSIONS[m[1]] || 'jpg';
  const fileName = at.replace(/[-: ]/g, '').slice(0, 14) + '_' + (safeName_(kind) || 'photo') + '_' + (safeName_(ctx.name) || 'portal') + '.' + ext;
  const folder = subfolder_(photoRoot_(), ev['日付'] + ' ' + safeName_(ev['タイトル']));
  const file = folder.createFile(Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], fileName));
  appendRow_(SHEETS.PHOTOS, { '日時': at, eventKey: ev.eventKey, '予定': ev['タイトル'], userId: ctx.userId, '表示名': ctx.name, 'ファイル名': fileName, URL: file.getUrl(), 'ファイルID': file.getId(), '種類': kind || 'ポータル' });
  if (kind) {
    upsertTask_(ctx, p.key, kind, String(p.target || '').slice(0, 60), (t) => {
      t['写真ID'] = splitNames_(t['写真ID']).concat([file.getId()]).join(',');
      if (kind === 'エントリー控え' || kind === 'プログラム') t['状態'] = '済';
    });
  }
  return '写真を保存しました';
}

/** 写真を画面に出す。「写真」シートにある写真だけ（ほかのドライブのファイルは出さない） */
function photoAction_(ctx, p) {
  const id = String(p.id || '');
  if (!id || !readRows_(SHEETS.PHOTOS).some((x) => x['ファイルID'] === id)) throw new Error('写真が見つかりません。');
  const file = DriveApp.getFileById(id);
  let blob = p.thumb ? file.getThumbnail() : null;
  if (!blob) blob = file.getBlob();
  return { id: id, data: 'data:' + (blob.getContentType() || 'image/jpeg') + ';base64,' + Utilities.base64Encode(blob.getBytes()) };
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
