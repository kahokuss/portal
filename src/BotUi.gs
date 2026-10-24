/**
 * Botのボタン操作（カレンダー・予定のカード・押すだけで休み／エントリー／アンケート）。
 * 押したボタンは postback で届く（data は「a=ev&k=…」の形。LINEの上限300文字）。
 * 1対1のトークでは、考えている間「…」を出して待たせない。
 */

const C_RACE = '#c4512f', C_PRAC = '#2f6fae', C_OK = '#237a55', C_SUB = '#5f7079', C_LINE = '#d6dfe3';

/** 1対1のトークで「…」（読み込み中）を出す。失敗しても気にしない */
function startLoading_(ev) {
  if (!ev.source || ev.source.type !== 'user') return;
  try { lineFetch_(LINE_API + '/chat/loading/start', 'post', { chatId: ev.source.userId, loadingSeconds: 10 }); } catch (err) { console.warn(err); }
}

function pbData_(o) { return Object.keys(o).map((k) => k + '=' + encodeURIComponent(o[k])).join('&').slice(0, 300); }
function pbParse_(s) {
  const o = {};
  String(s || '').split('&').forEach((kv) => { const i = kv.indexOf('='); if (i > 0) o[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1)); });
  return o;
}
function pbAction_(label, data, display) { return { type: 'postback', label: String(label).slice(0, 20), data: pbData_(data), displayText: display ? String(display).slice(0, 300) : undefined }; }
function uriAction_(label, uri) { return { type: 'uri', label: String(label).slice(0, 20), uri: uri }; }
function evUrl_(key) { const u = portalUrl_(); return u + (u.indexOf('?') >= 0 ? '&' : '?') + 'ev=' + encodeURIComponent(key); }
function flex_(alt, contents) { return { type: 'flex', altText: String(alt).slice(0, 400), contents: contents }; }
function txt_(t, o) { return Object.assign({ type: 'text', text: String(t === '' || t == null ? ' ' : t), wrap: true, size: 'sm' }, o || {}); }
function btn_(action, style, color) { return { type: 'button', action: action, style: style || 'secondary', height: 'sm', color: color }; }
function quickPb_(items) {
  return { items: items.slice(0, 13).map((x) => ({ type: 'action', action: x.type ? x : x.length === 2 && typeof x[1] === 'string' ? { type: 'message', label: x[0].slice(0, 20), text: x[1] } : pbAction_(x[0], x[1], x[2]) })) };
}

/** ボタン操作で使う「だれが」（ポータルの操作と同じ形）。グループのメンバーか確かめる */
function botCtx_(ev) {
  const family = findFamily_(ev.source.userId);
  if (!family) throw new Error('先にお子さんを登録してください（「登録 山田たろう 3年」）。');
  ensureMember_(family);
  return { family: family, userId: family.userId, famId: famIdOf_(family), name: family['表示名'] || getDisplayName_(ev.source) || '保護者', admin: isAdmin_(family), coach: isCoach_(family), owner: isOwner_(family) };
}

// ---- 予定のカード ----

/** 1件の予定のカード。わが家の休み・エントリー・当番も出して、その場で押せるようにする */
function eventBubble_(e, u, d, ctxData) {
  const dt = e.date.split('-').map(Number);
  const color = e.race ? C_RACE : C_PRAC;
  const det = e.detail || {};
  const body = [txt_(e.title, { weight: 'bold', size: 'md' }), txt_(e.row['開始'] === '終日' ? '終日' : formatWhen_(e.row).replace(/^\S+\s?/, '') || '時間は未定', { color: C_SUB })];
  if (e.place) body.push(txt_('📍 ' + e.place, { color: C_SUB }));
  const nl = noticeLine_((ctxData.notices || {})[e.key]);
  if (nl) body.push(txt_(nl, { size: 'xs', color: C_RACE }));
  if (e.race && (det.meetTime || det.meetPlace)) body.push(txt_('集合 ' + [det.meetTime, det.meetPlace].filter(Boolean).join(' ')));
  if (e.race && det.items && det.items.length) body.push(txt_('🎒 ' + det.items.join('・'), { color: C_SUB, size: 'xs' }));
  const duty = ctxData.duties.filter((x) => x.eventKey === e.key);
  if (duty.length) body.push(txt_('🧹 当番：' + duty.map((x) => ctxData.labels[x['家族ID']] || '').filter(Boolean).join('、') + (duty.some((x) => x['家族ID'] === u.famId) ? '（わが家）' : ''), { size: 'xs', color: duty.some((x) => x['家族ID'] === u.famId) ? C_RACE : C_SUB }));
  const buttons = [];
  if (e.race) {
    if (det.deadline) body.push(txt_('エントリー締切 ' + formatDate_(det.deadline) + (det.deadline < d.today ? '（締切済み）' : ''), { size: 'xs', color: det.deadline < d.today ? C_SUB : C_RACE }));
    u.kids.forEach((k) => {
      if (!inTarget_(det.target, k.grade)) return body.push(txt_(k.name + '：対象外', { size: 'xs', color: C_SUB }));
      const x = ctxData.entries.find((y) => y.eventKey === e.key && y['子ども'] === k.name);
      body.push(txt_(k.name + '：' + (x ? x['回答'] + (x['種目'] ? '（' + x['種目'].replace(/,/g, '・') + '）' : '') : '未回答'), { size: 'xs', weight: 'bold', color: x ? (x['回答'] === '参加' ? C_OK : C_SUB) : C_RACE }));
      if (!(det.deadline && det.deadline < d.today) && e.detail) {
        if (!x || x['回答'] !== '参加') buttons.push(btn_(pbAction_((u.kids.length > 1 ? short_(k.name) + ' ' : '') + '参加する', { a: 'ent', k: e.key, c: k.name, j: '参加' }, k.name + '：' + e.title + 'に参加'), 'primary', C_OK));
        if (!x || x['回答'] !== '不参加') buttons.push(btn_(pbAction_((u.kids.length > 1 ? short_(k.name) + ' ' : '') + '不参加', { a: 'ent', k: e.key, c: k.name, j: '不参加' }, k.name + '：' + e.title + 'は不参加')));
      }
    });
  } else {
    u.kids.forEach((k) => {
      const a = ctxData.absences.find((y) => y['日付'] === e.date && y['子ども'] === k.name);
      body.push(txt_(k.name + '：' + (a ? 'お休み（' + a['理由'] + '）' : '出席予定'), { size: 'xs', weight: 'bold', color: a ? C_RACE : C_OK }));
      if (a && a['連絡者userId'] === u.userId) buttons.push(btn_(pbAction_((u.kids.length > 1 ? short_(k.name) + ' ' : '') + '休みを取り消す', { a: 'absc', id: a.id }, formatDate_(e.date) + ' ' + k.name + 'の休みを取り消す')));
      else if (!a) buttons.push(btn_(pbAction_((u.kids.length > 1 ? short_(k.name) + ' ' : '') + '休みを連絡', { a: 'abs', d: e.date, c: k.name }, formatDate_(e.date) + ' ' + k.name + 'は休み')));
    });
    if (e.row['ダウン']) body.push(txt_('🏃 ダウンに入りました（' + String(e.row['ダウン']).replace(/^0/, '') + '）', { size: 'xs', color: C_RACE }));
  }
  buttons.push(btn_(uriAction_('ポータルで開く', evUrl_(e.key)), 'link'));
  return {
    type: 'bubble', size: 'kilo',
    header: { type: 'box', layout: 'horizontal', backgroundColor: color, paddingAll: '10px', contents: [
      txt_(dt[1] + '/' + dt[2] + '（' + WEEKDAYS[new Date(Date.UTC(dt[0], dt[1] - 1, dt[2])).getUTCDay()] + '）', { color: '#ffffff', weight: 'bold', size: 'lg', flex: 0 }),
      txt_((e.race ? '大会' : '練習') + '・' + dayWord_(e.date, d.today), { color: '#ffffff', size: 'xs', align: 'end', gravity: 'center' }),
    ] },
    body: { type: 'box', layout: 'vertical', spacing: 'xs', paddingAll: '12px', contents: body },
    footer: { type: 'box', layout: 'vertical', spacing: 'xs', paddingAll: '8px', contents: buttons.slice(0, 6) },
  };
}

function short_(name) { const t = String(name).trim().split(/[\s　]+/); return (t[1] || t[0]).slice(0, 4); }

function botCtxData_() {
  return {
    duties: readRows_(SHEETS.DUTIES).filter((x) => x['日付'] >= addDays_(today_(), -1)),
    labels: famLabelMap_(),
    entries: readRows_(SHEETS.ENTRIES),
    absences: readRows_(SHEETS.ABSENCES).filter((a) => a.id && a['日付'] >= today_()),
    notices: pendingNotices_(),
  };
}

/** 予定のカードを横に並べる（最大10件） */
function eventsCarousel_(events, u, d, alt) {
  const cd = botCtxData_();
  return flex_(alt || '予定', { type: 'carousel', contents: events.slice(0, 10).map((e) => eventBubble_(e, u, d, cd)) });
}

// ---- カレンダー ----

/** 月のカレンダー。予定のある日を押すと、その日の予定のカードが出る */
function calendarBubble_(ym, d) {
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
  const first = new Date(Date.UTC(y, m - 1, 1)), days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const prefix = ym + '-';
  const byDay = {};
  readRows_(SHEETS.EVENTS).filter((e) => e['状態'] !== '中止' && String(e['日付']).indexOf(prefix) === 0).forEach((e) => {
    const dd = Number(e['日付'].slice(8, 10));
    const race = d.races[e.eventKey] || (e['種別'] || guessType_(e['タイトル'])) !== '練習';
    byDay[dd] = byDay[dd] === 'race' || race ? 'race' : 'prac';
  });
  const rows = [{ type: 'box', layout: 'horizontal', contents: WEEKDAYS.map((w, i) => txt_(w, { size: 'xs', align: 'center', color: i === 0 ? C_RACE : i === 6 ? C_PRAC : C_SUB, wrap: false })) }];
  let cells = [];
  for (let i = 0; i < first.getUTCDay(); i++) cells.push({ type: 'box', layout: 'vertical', flex: 1, contents: [] });
  for (let dd = 1; dd <= days; dd++) {
    const date = prefix + ('0' + dd).slice(-2), kind = byDay[dd], today = date === d.today;
    const cell = { type: 'box', layout: 'vertical', flex: 1, paddingAll: '4px', cornerRadius: '6px', contents: [txt_(String(dd), { size: 'sm', align: 'center', wrap: false, weight: kind || today ? 'bold' : 'regular', color: kind ? '#ffffff' : today ? C_OK : '#182328' })] };
    if (kind) { cell.backgroundColor = kind === 'race' ? C_RACE : C_PRAC; cell.action = pbAction_(m + '/' + dd, { a: 'day', d: date }, m + '/' + dd + 'の予定'); }
    else if (today) { cell.borderWidth = '1px'; cell.borderColor = C_OK; }
    cells.push(cell);
    if (cells.length === 7) { rows.push({ type: 'box', layout: 'horizontal', spacing: '2px', contents: cells }); cells = []; }
  }
  if (cells.length) { while (cells.length < 7) cells.push({ type: 'box', layout: 'vertical', flex: 1, contents: [] }); rows.push({ type: 'box', layout: 'horizontal', spacing: '2px', contents: cells }); }
  const prev = fmtYm_(y, m - 1), next = fmtYm_(y, m + 1);
  return {
    type: 'bubble',
    header: { type: 'box', layout: 'horizontal', paddingAll: '10px', contents: [
      { type: 'text', text: '◀', size: 'lg', color: C_SUB, flex: 0, action: pbAction_('前の月', { a: 'cal', m: prev }) },
      txt_(y + '年' + m + '月', { weight: 'bold', size: 'lg', align: 'center' }),
      { type: 'text', text: '▶', size: 'lg', color: C_SUB, flex: 0, action: pbAction_('次の月', { a: 'cal', m: next }) },
    ] },
    body: { type: 'box', layout: 'vertical', spacing: '4px', paddingAll: '10px', contents: rows.concat([{ type: 'box', layout: 'horizontal', margin: 'md', spacing: 'sm', contents: [
      txt_('■ 練習', { size: 'xxs', color: C_PRAC, flex: 0, wrap: false }), txt_('■ 大会', { size: 'xxs', color: C_RACE, flex: 0, wrap: false }), txt_('色の日を押すと、その日の予定', { size: 'xxs', color: C_SUB }),
    ] }]) },
    footer: { type: 'box', layout: 'horizontal', spacing: 'sm', paddingAll: '8px', contents: [
      btn_({ type: 'datetimepicker', label: '日付を選ぶ', data: pbData_({ a: 'day' }), mode: 'date', initial: d.today }),
      btn_(pbAction_('これからの予定', { a: 'list' }, '予定')),
    ] },
  };
}
function fmtYm_(y, m) { const t = new Date(Date.UTC(y, m - 1, 1)); return t.getUTCFullYear() + '-' + ('0' + (t.getUTCMonth() + 1)).slice(-2); }

function handleCalendar_(ev, ym) {
  const d = botData_();
  const m = /^\d{4}-\d{2}$/.test(ym || '') ? ym : d.today.slice(0, 7);
  respond_(ev, [flex_(Number(m.slice(5)) + '月のカレンダー', calendarBubble_(m, d))]);
}

/** その日の予定（なければカレンダーに戻るボタン） */
function handleDay_(ev, date) {
  const u = botUser_(ev);
  const d = botData_();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return handleCalendar_(ev);
  const list = readRows_(SHEETS.EVENTS).filter((e) => e['状態'] !== '中止' && e['日付'] === date).sort(compareEvents_)
    .map((e) => ({ row: e, key: e.eventKey, date: e['日付'], title: e['タイトル'], place: e['場所'], race: !!d.races[e.eventKey] || (e['種別'] || guessType_(e['タイトル'])) !== '練習', detail: d.races[e.eventKey] ? raceToObj_(d.races[e.eventKey]) : null }));
  if (!list.length) return respond_(ev, [Object.assign(text_(formatDate_(date) + 'は予定がありません。'), { quickReply: quickPb_([['カレンダー', { a: 'cal', m: date.slice(0, 7) }], ['予定', '予定'], ['新着', '新着']]) })]);
  respond_(ev, [eventsCarousel_(list, u, d, formatDate_(date) + 'の予定')]);
}

// ---- 押すだけの操作 ----

function handlePostback_(ev) {
  const p = pbParse_(ev.postback && ev.postback.data);
  const params = (ev.postback && ev.postback.params) || {};
  ev.privateAnswer = CONFIG.GROUP_PRIVATE_REPLY && ev.source.type === 'group';
  try {
    switch (p.a) {
      case 'cal': return handleCalendar_(ev, p.m);
      case 'day': return handleDay_(ev, params.date || p.d);
      case 'list': return handleSchedule_(ev);
      case 'ev': return handleOneEvent_(ev, p.k);
      case 'abs': return askAbsenceReason_(ev, p.d || params.date, p.c);
      case 'absr': return doAbsence_(ev, p.d, p.c, p.r);
      case 'absc': return doCancelAbsence_(ev, p.id);
      case 'ent': return doEntry_(ev, p.k, p.c, p.j);
      case 'race': return doRaceToggle_(ev, p.k, p.c, p.r);
      case 'poll': return doPoll_(ev, p.id, p.o);
      case 'tr': return handleTraining_(ev, p.t || '');
    }
  } catch (err) {
    respond_(ev, botMessages_(['⚠ ' + String((err && err.message) || err)]));
  }
}

function handleOneEvent_(ev, key) {
  const u = botUser_(ev);
  const d = botData_();
  const e = d.events.find((x) => x.key === key);
  if (!e) return respond_(ev, botMessages_(['この予定は見つかりません（終わったか、中止になりました）。']));
  respond_(ev, [eventsCarousel_([e], u, d, e.title)]);
}

/** 休みの理由をボタンで選んでもらう */
function askAbsenceReason_(ev, date, child) {
  const u = botUser_(ev);
  if (!u.kids.length) return needRegister_(ev);
  if (!child) child = u.kids[0].name;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return respond_(ev, botMessages_(['日にちが分かりませんでした。']));
  const items = CHOICES.ABSENCE_REASONS.map((r) => [r, { a: 'absr', d: date, c: child, r: r }, r]);
  respond_(ev, [Object.assign(text_(formatDate_(date) + ' ' + child + 'のお休み。理由を選んでください（理由は役員と本人だけに見えます）。'), { quickReply: quickPb_(items.concat([['やめる', '新着']])) })]);
}

function doAbsence_(ev, date, child, reason) {
  const ctx = botCtx_(ev);
  const msg = reportAbsenceAction_(ctx, { child: child, date: date, reason: reason });
  const d = botData_();
  const onDay = d.events.find((e) => e.date === date);
  const mine = readRows_(SHEETS.ABSENCES).filter((a) => a.id && a['連絡者userId'] === ctx.userId && a['日付'] === date && a['子ども'] === child).pop();
  respond_(ev, [Object.assign(text_('✅ ' + msg + '（' + reason + '）' + (onDay ? '\n' + whenText_(onDay) : '\n※この日は予定が入っていません')),
    { quickReply: quickPb_((mine ? [['取り消す', { a: 'absc', id: mine.id }, '休みを取り消す']] : []).concat([['ひとこと添える', '休み ' + child + ' ' + date + ' ' + reason + ' ']], [['新着', '新着'], ['カレンダー', 'カレンダー']])) })]);
}

function doCancelAbsence_(ev, id) {
  const ctx = botCtx_(ev);
  const a = readRows_(SHEETS.ABSENCES).find((x) => x.id === id);
  cancelAbsenceAction_(ctx, { id: id });
  respond_(ev, botMessages_(['🗑 ' + (a ? formatDate_(a['日付']) + ' ' + a['子ども'] + 'の' : '') + '休みの連絡を取り消しました。']));
}

function doEntry_(ev, key, child, join) {
  const ctx = botCtx_(ev);
  const race = readRows_(SHEETS.RACES).find((r) => r.eventKey === key);
  const det = race ? raceToObj_(race) : { races: [] };
  const old = readRows_(SHEETS.ENTRIES).find((x) => x.eventKey === key && x['子ども'] === child);
  const keep = old && old['回答'] === '参加' ? splitNames_(old['種目']) : [];
  saveEntryAction_(ctx, { key: key, child: child, join: join, races: join === '参加' ? (keep.length ? keep : det.races.length === 1 ? det.races.slice() : []) : [] });
  const ev2 = findEvent_(key);
  const title = ev2 ? ev2['タイトル'] : '大会';
  if (join === '参加' && det.races.length > 1) return askRaces_(ev, key, child, '✅ ' + child + '：' + title + 'に参加で回答しました。');
  respond_(ev, botMessages_(['✅ ' + child + '：' + title + 'に' + join + 'で回答しました。' + (join === '参加' && det.fee ? '\n参加費 ' + det.fee + '円は役員へ。' : '')], ['新着', 'エントリー', 'カレンダー']));
}

/** 出る種目をボタンで選ぶ（押すたびに付け外し） */
function askRaces_(ev, key, child, head) {
  const race = readRows_(SHEETS.RACES).find((r) => r.eventKey === key);
  const det = race ? raceToObj_(race) : { races: [] };
  const x = readRows_(SHEETS.ENTRIES).find((y) => y.eventKey === key && y['子ども'] === child);
  const chosen = x ? splitNames_(x['種目']) : [];
  const items = det.races.slice(0, 11).map((r) => [(chosen.indexOf(r) >= 0 ? '✓' : '＋') + r, { a: 'race', k: key, c: child, r: r }, (chosen.indexOf(r) >= 0 ? '外す：' : '出る：') + r]);
  respond_(ev, [Object.assign(text_((head ? head + '\n' : '') + '出る種目を押してください（もう一度押すと外れます）。\nいま：' + (chosen.length ? chosen.join('・') : 'まだ選んでいません')), { quickReply: quickPb_(items.concat([['決定', '新着']])) })]);
}

function doRaceToggle_(ev, key, child, r) {
  const ctx = botCtx_(ev);
  const x = readRows_(SHEETS.ENTRIES).find((y) => y.eventKey === key && y['子ども'] === child);
  const chosen = x && x['回答'] === '参加' ? splitNames_(x['種目']) : [];
  const next = chosen.indexOf(r) >= 0 ? chosen.filter((q) => q !== r) : chosen.concat([r]);
  saveEntryAction_(ctx, { key: key, child: child, join: '参加', races: next });
  askRaces_(ev, key, child, '');
}

// ---- アンケート・集金・お知らせ・自主トレ ----

function handlePolls_(ev) {
  const u = botUser_(ev);
  const today = today_();
  const polls = readRows_(SHEETS.POLLS).filter((p) => p.id && p['終了'] !== '○' && !(p['締切'] && today > p['締切']));
  if (!polls.length) return respond_(ev, botMessages_(['いま答えられるアンケートはありません。']));
  const answers = readRows_(SHEETS.ANSWERS);
  const bubbles = polls.slice(-10).map((p) => {
    const opts = JSON.parse(p['選択肢'] || '[]');
    const mine = answers.find((a) => a['アンケートid'] === p.id && a['家族ID'] === u.famId);
    const chosen = mine ? JSON.parse(mine['回答'] || '[]') : [];
    return {
      type: 'bubble', size: 'kilo',
      body: { type: 'box', layout: 'vertical', spacing: 'xs', paddingAll: '12px', contents: [
        txt_('🗳 ' + p['タイトル'], { weight: 'bold', size: 'md' }),
        p['説明'] ? txt_(String(p['説明']).slice(0, 200), { color: C_SUB, size: 'xs' }) : txt_(p['複数'] === '○' ? '（いくつでも選べます）' : '（1つ選んでください）', { color: C_SUB, size: 'xs' }),
        p['締切'] ? txt_('締切 ' + formatDate_(p['締切']), { size: 'xs', color: C_RACE }) : txt_(' ', { size: 'xxs' }),
        txt_(chosen.length ? 'わが家の回答：' + chosen.join('・') : 'まだ答えていません', { size: 'xs', weight: 'bold', color: chosen.length ? C_OK : C_RACE }),
      ] },
      footer: { type: 'box', layout: 'vertical', spacing: 'xs', paddingAll: '8px', contents: opts.slice(0, 8).map((o) => btn_(pbAction_((chosen.indexOf(o) >= 0 ? '✓ ' : '') + o, { a: 'poll', id: p.id, o: o }, p['タイトル'].slice(0, 30) + '：' + o), chosen.indexOf(o) >= 0 ? 'primary' : 'secondary', chosen.indexOf(o) >= 0 ? C_OK : undefined)) },
    };
  });
  respond_(ev, [flex_('アンケート', { type: 'carousel', contents: bubbles })]);
}

function doPoll_(ev, id, o) {
  const ctx = botCtx_(ev);
  const poll = readRows_(SHEETS.POLLS).find((x) => x.id === id);
  if (!poll) throw new Error('アンケートが見つかりません。');
  const mine = readRows_(SHEETS.ANSWERS).find((a) => a['アンケートid'] === id && a['家族ID'] === ctx.famId);
  const chosen = mine ? JSON.parse(mine['回答'] || '[]') : [];
  const next = poll['複数'] === '○' ? (chosen.indexOf(o) >= 0 ? chosen.filter((x) => x !== o) : chosen.concat([o])) : [o];
  const msg = answerPollAction_(ctx, { id: id, answers: next, comment: mine ? mine['コメント'] : '' });
  respond_(ev, botMessages_(['✅ ' + poll['タイトル'] + '：' + msg], ['アンケート', '新着']));
}

function handleFees_(ev) {
  const u = botUser_(ev);
  if (!u.kids.length) return needRegister_(ev);
  const names = u.kids.map((k) => k.name);
  const paid = readRows_(SHEETS.FEE_PAID);
  const lines = ['💴 わが家の集金'];
  readRows_(SHEETS.FEES).filter((f) => f.id && f['終了'] !== '○').forEach((f) => {
    const kids = activeChildren_().filter((k) => names.indexOf(k.name) >= 0 && (!f['対象'] || f['対象'] === '全員' || inTarget_(f['対象'], k.grade)));
    const due = kids.filter((k) => !paid.some((x) => x['集金id'] === f.id && x['子ども'] === k.name && x['状態'] === '済'));
    if (due.length) lines.push('・' + f['名前'] + ' ' + Number(f['金額']) * due.length + '円' + (due.length > 1 ? '（' + due.length + '人分）' : '') + (f['期限'] ? '　期限 ' + formatDate_(f['期限']) : ''));
  });
  const d = botData_();
  const entries = readRows_(SHEETS.ENTRIES);
  d.events.filter((e) => e.race && e.detail && Number(e.detail.fee)).forEach((e) => {
    const due = entries.filter((x) => x.eventKey === e.key && names.indexOf(x['子ども']) >= 0 && x['回答'] === '参加' && x['集金'] !== '済');
    if (due.length) lines.push('・' + e.title + ' 参加費 ' + Number(e.detail.fee) * due.length + '円（' + due.map((x) => x['子ども']).join('・') + '）');
  });
  if (lines.length === 1) lines.push('払っていないものはありません。');
  else lines.push('', '役員（集金係）に渡してください。');
  respond_(ev, botMessages_([lines.join('\n')]));
}

function handleNotices_(ev) {
  const list = readRows_(SHEETS.NOTICES).filter((n) => n.id).sort((a, b) => (a['日時'] < b['日時'] ? 1 : -1)).slice(0, 5);
  if (!list.length) return respond_(ev, botMessages_(['お知らせはありません。']));
  respond_(ev, botMessages_(['📢 お知らせ（新しい順）\n\n' + list.map((n) => (n['重要'] === '○' ? '❗' : '・') + formatDate_(String(n['日付'] || n['日時']).slice(0, 10)) + ' ' + n['タイトル'] + (n['本文'] ? '\n　' + String(n['本文']).replace(/\s+/g, ' ').slice(0, 80) : '')).join('\n\n') + '\n\nくわしくはポータルで\n' + portalUrl_()]));
}

const BOT_TRAIN_KINDS = ['ランニング', 'ダッシュ', '坂道・階段', '縄跳び', '筋トレ', 'ストレッチ', '体幹'];

/** 「自主トレ ランニング 3km 20分」「自主トレ たろう 縄跳び 300回」 */
function handleTraining_(ev, args) {
  const u = botUser_(ev);
  if (!u.kids.length) return needRegister_(ev);
  const tokens = toHalfWidth_(args || '').trim().split(/\s+/).filter(Boolean);
  let child = u.kids.length === 1 ? u.kids[0].name : '', kind = '', km = '', min = '', count = '';
  const memo = [];
  tokens.forEach((t) => {
    const k = u.kids.find((c) => c.name === t || c.name.replace(/[\s　]/g, '').indexOf(t) >= 0);
    if (k) { child = k.name; return; }
    let m;
    if ((m = t.match(/^(\d+(?:\.\d+)?)(km|キロ)$/i))) { km = m[1]; return; }
    if ((m = t.match(/^(\d+)(分|min)$/))) { min = m[1]; return; }
    if ((m = t.match(/^(\d+)(回|本|周)$/))) { count = m[1]; return; }
    if (!kind && BOT_TRAIN_KINDS.indexOf(t) >= 0) { kind = t; return; }
    if (!kind && /^ラン|^走/.test(t)) { kind = 'ランニング'; return; }
    memo.push(t);
  });
  if (!kind || (!km && !min && !count)) {
    return respond_(ev, [Object.assign(text_('🏃 自主トレを記録します。\n「自主トレ ランニング 3km 20分」「自主トレ 縄跳び 300回」のように送ってください。' + (u.kids.length > 1 ? '\n子どもが2人以上なら名前も（例：自主トレ ' + short_(u.kids[0].name) + ' ランニング 2km）' : '') + '\n記録はポータルの「自主トレ」でグラフになります。'),
      { quickReply: quickPb_([['ランニング 2km', '自主トレ ランニング 2km 15分'], ['縄跳び 300回', '自主トレ 縄跳び 300回'], ['筋トレ 15分', '自主トレ 筋トレ 15分'], ['ダッシュ 10本', '自主トレ ダッシュ 10本']]) })]);
  }
  if (!child) return respond_(ev, botMessages_(['だれの記録か、名前も書いてください。例：自主トレ ' + short_(u.kids[0].name) + ' ' + args]));
  const ctx = botCtx_(ev);
  saveTrainingAction_(ctx, { child: child, date: today_(), kind: kind, km: km, min: min, count: count, memo: memo.join(' ') });
  respond_(ev, botMessages_(['✅ ' + child + '：' + kind + ' ' + [km && km + 'km', min && min + '分', count && count + (kind === '縄跳び' ? '回' : '本')].filter(Boolean).join(' ') + ' を記録しました（今日）。'], ['自主トレ', '新着']));
}

/** 使い方（ボタンつき） */
function helpBubble_() {
  const row = (items) => ({ type: 'box', layout: 'horizontal', spacing: 'xs', contents: items.map((x) => btn_({ type: 'message', label: x, text: x })) });
  return flex_('Botの使い方', {
    type: 'bubble',
    body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '12px', contents: [
      txt_('🏃 ' + CONFIG.CLUB_NAME + ' Bot', { weight: 'bold', size: 'md' }),
      txt_('ボタンを押すか、言葉を送ってください。予定のカードから、休み・エントリーもそのまま押せます。', { color: C_SUB, size: 'xs' }),
      row(['新着', '今日', 'カレンダー']), row(['予定', '休み', '当番']), row(['エントリー', 'アンケート', '集金']), row(['お知らせ', '自主トレ', '記録']), row(['出欠', '写真', 'ポータル']),
      txt_('そのほか：「休み 明日 体調不良」「登録 山田たろう 3年」「結果 100m 15.2秒」「自主トレ ランニング 3km 20分」', { color: C_SUB, size: 'xxs' }),
    ] },
  });
}
