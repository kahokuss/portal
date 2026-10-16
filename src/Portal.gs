/**
 * ポータル（Webアプリ）のサーバー側。
 * 画面からは google.script.run.api(key, action, payload) だけを呼ぶ。
 * key は LINE ログイン（Login.gs）でグループのメンバーと確認できた人に発行するキー。
 */
function api(key, action, payload) {
  const family = findFamilyByKey_(key);
  if (!family) throw new Error('ログインが切れました。もう一度「LINEでログイン」を押してください。');
  ensureMember_(family);
  const handler = API_ACTIONS[action];
  if (!handler) throw new Error('不明な操作です: ' + action);
  if (handler.admin && !isAdmin_(family)) throw new Error('この操作は役員だけができます。');
  const ctx = { family: family, userId: family.userId, name: family['表示名'] || '保護者', admin: isAdmin_(family) };
  const message = handler.run(ctx, payload || {});
  const state = buildState_(ctx);
  if (message) state.message = message;
  return state;
}

const API_ACTIONS = {
  bootstrap: { run: () => { syncIfStale_(); } },
  refresh: { run: () => { syncCalendar_(); } },
  saveChildren: { run: saveChildrenAction_ },
  saveEntry: { run: saveEntryAction_ },
  setPaid: { admin: true, run: setPaidAction_ },
  reportAbsence: { run: reportAbsenceAction_ },
  cancelAbsence: { run: cancelAbsenceAction_ },
  ackAbsence: { admin: true, run: ackAbsenceAction_ },
  saveRace: { admin: true, run: saveRaceAction_ },
  setEventType: { admin: true, run: setEventTypeAction_ },
  saveNotice: { admin: true, run: saveNoticeAction_ },
  deleteNotice: { admin: true, run: deleteNoticeAction_ },
};

// ---- 画面に渡すデータ ----

function raceToObj_(r) {
  return {
    target: r['対象'] || '全員',
    fee: Number(r['参加費']) || 0,
    deadline: r['締切'],
    meetTime: r['集合時刻'],
    meetPlace: r['集合場所'],
    races: splitNames_(r['種目']),
    items: splitNames_(r['持ち物']),
    notes: r['注意'],
  };
}

function buildState_(ctx) {
  const today = today_();
  const range = syncRange_();
  const races = {};
  readRows_(SHEETS.RACES).forEach((r) => (races[r.eventKey] = r));

  const events = readRows_(SHEETS.EVENTS)
    .filter((e) => e['日付'] >= range.first && e['日付'] <= range.last)
    .sort(compareEvents_)
    .map((e) => {
      const race = races[e.eventKey];
      return {
        key: e.eventKey,
        date: e['日付'],
        start: e['開始'],
        end: e['終了'],
        title: e['タイトル'],
        place: e['場所'],
        type: race ? race['種別'] || '大会' : e['種別'] || guessType_(e['タイトル']),
        cancelled: e['状態'] === '中止',
        detail: race ? raceToObj_(race) : null,
      };
    });
  const raceKeys = {};
  events.forEach((e) => { if (e.type !== '練習') raceKeys[e.key] = true; });

  const entries = readRows_(SHEETS.ENTRIES)
    .filter((x) => raceKeys[x.eventKey])
    .map((x) => ({ key: x.eventKey, child: x['子ども'], join: x['回答'], races: splitNames_(x['種目']), paid: x['集金'] === '済', by: x['更新者'] }));

  // だれが休みかはメンバー全員に見せる（いままでのグループのトークと同じ）。理由とひとことは本人と役員だけ
  const absences = readRows_(SHEETS.ABSENCES)
    .filter((a) => a.id && a['日付'] >= addDays_(today, -7))
    .map((a) => {
      const mine = a['連絡者userId'] === ctx.userId, full = mine || ctx.admin;
      return { id: a.id, date: a['日付'], child: a['子ども'], reason: full ? a['理由'] : '', memo: full ? a['メモ'] : '', by: full ? a['連絡者'] : '', mine: mine, ack: a['確認'] === '済', ackBy: full ? a['確認者'] : '' };
    })
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  const notices = readRows_(SHEETS.NOTICES)
    .filter((n) => n.id)
    .sort((a, b) => (a['日時'] < b['日時'] ? 1 : -1))
    .slice(0, 10)
    .map((n) => ({ id: n.id, date: n['日付'], title: n['タイトル'], body: n['本文'], key: n.eventKey, by: n['作成者'] }));

  const children = activeChildren_();
  return {
    club: CONFIG.CLUB_NAME,
    today: today,
    me: {
      name: ctx.name,
      admin: ctx.admin,
      children: children.filter((c) => c.parents.indexOf(ctx.userId) >= 0).map((c) => ({ name: c.name, grade: c.grade })),
    },
    kids: children.map((c) => ({ name: c.name, grade: c.grade })),
    events: events,
    entries: entries,
    absences: absences,
    notices: notices,
    choices: { races: CHOICES.RACES, items: CHOICES.ITEMS, targets: CHOICES.TARGETS, reasons: CHOICES.ABSENCE_REASONS, deadlineDays: CONFIG.DEADLINE_DAYS_BEFORE },
  };
}

// ---- 操作 ----

function requireMyChild_(ctx, name) {
  const mine = childrenOf_(ctx.userId).some((c) => c.name === name);
  if (!mine && !ctx.admin) throw new Error(name + 'さんは、あなたのお子さんとして登録されていません。');
}

function saveChildrenAction_(ctx, p) {
  const list = (p.children || [])
    .map((c) => ({ name: String(c.name || '').trim().slice(0, 30), grade: Math.max(0, Math.min(6, Number(c.grade) || 0)) }))
    .filter((c) => c.name);
  saveChildren_(ctx.userId, list);
  return list.length ? '登録しました：' + list.map((c) => c.name).join('、') : '登録を消しました';
}

/** 大会の対象学年に入っているか */
function inTarget_(target, grade) {
  const m = String(target || '').match(/([1-6])年生?以上/);
  return !m || !grade || grade >= Number(m[1]);
}

function saveEntryAction_(ctx, p) {
  requireMyChild_(ctx, p.child);
  const ev = findEvent_(p.key);
  if (!ev) throw new Error('大会が見つかりません。');
  const race = readRows_(SHEETS.RACES).find((r) => r.eventKey === p.key);
  const detail = race ? raceToObj_(race) : { races: [], deadline: '' };
  if (!ctx.admin && detail.deadline && today_() > detail.deadline) throw new Error('エントリーの締切（' + formatDate_(detail.deadline) + '）を過ぎています。役員に連絡してください。');
  if (p.join !== '参加' && p.join !== '不参加') throw new Error('参加か不参加を選んでください。');
  const races = p.join === '参加' ? (p.races || []).filter((r) => !detail.races.length || detail.races.indexOf(r) >= 0) : [];
  withLock_(() => {
    const rows = readRows_(SHEETS.ENTRIES);
    const row = rows.find((x) => x.eventKey === p.key && x['子ども'] === p.child);
    const data = { eventKey: p.key, '子ども': p.child, '回答': p.join, '種目': races.join(','), '更新者': ctx.name, '更新日時': now_() };
    if (row) updateRow_(SHEETS.ENTRIES, Object.assign(row, data));
    else appendRow_(SHEETS.ENTRIES, Object.assign(data, { '集金': '' }));
  });
  return p.child + '：' + p.join + (races.length ? '（' + races.join('・') + '）' : '') + 'で受け付けました';
}

function setPaidAction_(ctx, p) {
  withLock_(() => {
    const row = readRows_(SHEETS.ENTRIES).find((x) => x.eventKey === p.key && x['子ども'] === p.child);
    if (!row) throw new Error('エントリーが見つかりません。');
    row['集金'] = p.paid ? '済' : '';
    row['更新日時'] = now_();
    updateRow_(SHEETS.ENTRIES, row);
  });
  return '';
}

function reportAbsenceAction_(ctx, p) {
  requireMyChild_(ctx, p.child);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date || '')) throw new Error('日にちを選んでください。');
  if (p.date < today_()) throw new Error('過ぎた日の連絡はできません。');
  const reason = CHOICES.ABSENCE_REASONS.indexOf(p.reason) >= 0 ? p.reason : 'その他';
  const memo = String(p.memo || '').slice(0, 200);
  withLock_(() => {
    appendRow_(SHEETS.ABSENCES, { id: randomKey_().slice(0, 10), '日付': p.date, '子ども': p.child, '理由': reason, 'メモ': memo, '連絡者userId': ctx.userId, '連絡者': ctx.name, '確認': '', '確認者': '', '日時': now_() });
  });
  if (CONFIG.ABSENCE_PUSH_TO_ADMINS) notifyAdmins_('🏃 休みの連絡\n' + formatDate_(p.date) + ' ' + p.child + '（' + reason + '）' + (memo ? '\n' + memo : '') + '\n連絡：' + ctx.name + 'さん', ctx.userId);
  return formatDate_(p.date) + ' ' + p.child + 'のお休みを連絡しました';
}

/** 役員に1対1でLINEを送る（Botを友だち追加している役員にだけ届く） */
function notifyAdmins_(text, exceptUserId) {
  readRows_(SHEETS.FAMILIES).filter((f) => isAdmin_(f) && f.userId !== exceptUserId).forEach((f) => {
    try {
      push_(f.userId, [text_(text)]);
    } catch (err) {
      console.warn('役員への通知に失敗: ' + f['表示名'] + ' ' + err);
    }
  });
}

function findAbsence_(id) {
  return readRows_(SHEETS.ABSENCES).find((a) => a.id && a.id === id) || null;
}

function cancelAbsenceAction_(ctx, p) {
  withLock_(() => {
    const a = findAbsence_(p.id);
    if (!a || (a['連絡者userId'] !== ctx.userId && !ctx.admin)) throw new Error('取り消せる連絡が見つかりません。');
    clearRow_(SHEETS.ABSENCES, a);
  });
  return '休みの連絡を取り消しました';
}

function ackAbsenceAction_(ctx, p) {
  withLock_(() => {
    const a = findAbsence_(p.id);
    if (!a) throw new Error('連絡が見つかりません。');
    a['確認'] = a['確認'] === '済' ? '' : '済';
    a['確認者'] = a['確認'] ? ctx.name : '';
    updateRow_(SHEETS.ABSENCES, a);
  });
  return '';
}

function cleanList_(list, max) {
  return (list || []).map((x) => String(x).trim().slice(0, 30)).filter(Boolean).slice(0, max || 30);
}

function saveRaceAction_(ctx, p) {
  const title = String(p.title || '').trim().slice(0, 80);
  if (!title) throw new Error('大会名を入れてください。');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date || '')) throw new Error('日付を入れてください。');
  const place = String(p.place || '').trim().slice(0, 80);
  const ev = upsertRaceEvent_(p.key || '', title, p.date, place);
  const deadline = /^\d{4}-\d{2}-\d{2}$/.test(p.deadline || '') ? p.deadline : '';
  const data = {
    eventKey: ev.eventKey,
    '種別': ['大会', '記録会', '練習試合'].indexOf(p.type) >= 0 ? p.type : '大会',
    '対象': String(p.target || '全員').slice(0, 20),
    '参加費': String(Math.max(0, Number(p.fee) || 0)),
    '締切': deadline,
    '集合時刻': String(p.meetTime || '').slice(0, 10),
    '集合場所': String(p.meetPlace || '').slice(0, 80),
    '種目': cleanList_(p.races).join(','),
    '持ち物': cleanList_(p.items).join(','),
    '注意': String(p.notes || '').slice(0, 1000),
    '更新日時': now_(),
  };
  withLock_(() => {
    const row = readRows_(SHEETS.RACES).find((r) => r.eventKey === ev.eventKey);
    if (row) updateRow_(SHEETS.RACES, Object.assign(row, data));
    else appendRow_(SHEETS.RACES, data);
  });
  return '「' + title + '」を保存しました';
}

/** カレンダーから取り込んだ予定の種別（練習／大会）を直す */
function setEventTypeAction_(ctx, p) {
  withLock_(() => {
    const ev = findEvent_(p.key);
    if (!ev) throw new Error('予定が見つかりません。');
    ev['種別'] = p.type === '練習' ? '練習' : '大会';
    updateRow_(SHEETS.EVENTS, ev);
  });
  return '';
}

function saveNoticeAction_(ctx, p) {
  const title = String(p.title || '').trim().slice(0, 80);
  if (!title) throw new Error('タイトルを入れてください。');
  withLock_(() => {
    appendRow_(SHEETS.NOTICES, { id: randomKey_().slice(0, 10), '日付': today_(), 'タイトル': title, '本文': String(p.body || '').slice(0, 2000), eventKey: p.key || '', '作成者': ctx.name, '日時': now_() });
  });
  return 'お知らせを載せました';
}

function deleteNoticeAction_(ctx, p) {
  withLock_(() => {
    const n = readRows_(SHEETS.NOTICES).find((x) => x.id && x.id === p.id);
    if (n) clearRow_(SHEETS.NOTICES, n);
  });
  return 'お知らせを消しました';
}
