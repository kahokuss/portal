/**
 * ポータル（Webアプリ）のサーバー側。
 * 画面からは google.script.run.api(key, action, payload) だけを呼ぶ。
 * key は LINE ログイン（Login.gs）でグループのメンバーと確認できた人に発行するキー。
 */
function api(key, action, payload) {
  resetMemo_();
  const family = findFamilyByKey_(key);
  if (!family) throw new Error('ログインが切れました。もう一度「LINEでログイン」を押してください。');
  ensureMember_(family);
  const handler = API_ACTIONS[action];
  if (!handler) throw new Error('不明な操作です: ' + action);
  if (handler.admin && !isAdmin_(family)) throw new Error('この操作は役員だけができます。');
  const ctx = { family: family, userId: family.userId, famId: famIdOf_(family), name: family['表示名'] || '保護者', admin: isAdmin_(family) };
  const message = handler.run(ctx, payload || {});
  // 写真などは、画面の状態ではなく結果だけを返す
  if (handler.raw) return message;
  // 家族をまとめた・外れたときは、家族IDが変わっている
  const fresh = findFamily_(ctx.userId);
  if (fresh) ctx.famId = famIdOf_(fresh);
  const state = buildState_(ctx);
  if (message) state.message = message;
  return state;
}

const API_ACTIONS = {
  bootstrap: { run: () => { syncIfStale_(); } },
  refresh: { run: () => { invalidateAllTables_(); importScheduleSafely_(); syncCalendar_(); } },
  saveChildren: { run: saveChildrenAction_ },
  inviteFamily: { raw: true, run: inviteFamilyAction_ },
  pcCode: { raw: true, run: pcCodeAction_ },
  joinFamily: { run: joinFamilyAction_ },
  leaveFamily: { run: (ctx) => { leaveFamily_(ctx.userId); return '家族のまとまりから外れました'; } },
  setNotify: { admin: true, run: setNotifyAction_ },
  setAdmin: { admin: true, run: setAdminAction_ },
  setDuty: { admin: true, run: setDutyAction_ },
  autoDuty: { admin: true, run: autoDutyAction_ },
  saveTimetable: { run: saveTimetableAction_ },
  saveTimetablePlan: { run: saveTimetablePlanAction_ },
  saveTimetableDraft: { run: saveTimetableDraftAction_ },
  setTask: { run: setTaskAction_ },
  uploadPhoto: { run: uploadPhotoAction_ },
  photo: { raw: true, run: photoAction_ },
  thumbs: { raw: true, run: thumbsAction_ },
  deletePhoto: { run: deletePhotoAction_ },
  savePractices: { admin: true, run: savePracticesAction_ },
  editEvent: { admin: true, run: editEventAction_ },
  bulkEditEvents: { admin: true, run: bulkEditEventsAction_ },
  cancelEvent: { admin: true, run: cancelEventAction_ },
  saveResult: { run: saveResultAction_ },
  broadcastInfo: { admin: true, raw: true, run: broadcastInfoAction_ },
  broadcast: { admin: true, run: broadcastAction_ },
  saveLedger: { run: saveLedgerAction_ },
  saveComment: { run: saveCommentAction_ },
  addDoc: { run: addDocAction_ },
  deleteDoc: { run: deleteDocAction_ },
  doc: { raw: true, run: docAction_ },
  setDeadline: { run: setDeadlineAction_ },
  markDown: { run: markDownAction_ },
  applyNotice: { admin: true, run: applyNoticeAction_ },
  deleteComment: { run: deleteCommentAction_ },
  setMeasure: { admin: true, run: setMeasureAction_ },
  deleteLedger: { admin: true, run: deleteLedgerAction_ },
  deleteResult: { run: deleteResultAction_ },
  addRecords: { admin: true, run: addRecordsAction_ },
  saveEntry: { run: saveEntryAction_ },
  setPaid: { admin: true, run: setPaidAction_ },
  reportAbsence: { run: reportAbsenceAction_ },
  cancelAbsence: { run: cancelAbsenceAction_ },
  ackAbsence: { admin: true, run: ackAbsenceAction_ },
  saveRace: { admin: true, run: saveRaceAction_ },
  setEventType: { admin: true, run: setEventTypeAction_ },
  saveNotice: { admin: true, run: saveNoticeAction_ },
  markRead: { raw: true, run: markReadAction_ },
  savePoll: { admin: true, run: savePollAction_ },
  closePoll: { admin: true, run: closePollAction_ },
  answerPoll: { run: answerPollAction_ },
  saveFee: { admin: true, run: saveFeeAction_ },
  closeFee: { admin: true, run: closeFeeAction_ },
  setFeePaid: { admin: true, run: setFeePaidAction_ },
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
    organizer: r['主催'] || '',
    applyBy: r['申込期限'] || '',
    applyHow: r['申込方法'] || '',
    payBy: r['支払期限'] || '',
    reception: r['受付'] || '',
    url: r['要項URL'] || '',
    deadlines: parseDeadlines_(r['手続き期限']),
    ttMemo: r['時刻表メモ'] || '',
    ttDraft: r['時刻表下書き'] || '',
  };
}

/** 手続きごとの締切（{ 'リレー予選': '2026-11-01 10:00', … }） */
function parseDeadlines_(s) {
  try {
    const o = JSON.parse(s || '{}');
    return o && typeof o === 'object' ? o : {};
  } catch (err) {
    return {};
  }
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
        down: e['日付'] === today ? e['ダウン'] || '' : '',
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
    .map((n) => ({ id: n.id, date: n['日付'], title: n['タイトル'], body: n['本文'], key: n.eventKey, by: n['作成者'], important: n['重要'] === '○' }));
  // 既読：自分が読んだか。役員には、読んだ人数と、まだの人
  const reads = readRows_(SHEETS.READS);
  const memberNames = {};
  readRows_(SHEETS.FAMILIES).forEach((f) => (memberNames[f.userId] = f['表示名'] || '（名前なし）'));
  notices.forEach((n) => {
    const who = reads.filter((r) => r['お知らせid'] === n.id).map((r) => r.userId);
    n.read = who.indexOf(ctx.userId) >= 0;
    if (ctx.admin) { n.readCount = who.length; n.members = Object.keys(memberNames).length; n.unread = Object.keys(memberNames).filter((u) => who.indexOf(u) < 0).map((u) => memberNames[u]); }
  });

  const children = activeChildren_();
  const familyRows = readRows_(SHEETS.FAMILIES);
  const families = familiesList_(familyRows, children);
  const myFam = families.find((f) => f.id === ctx.famId);
  const inRange = {};
  events.forEach((e) => (inRange[e.key] = true));

  // 当番は、前回からどれくらいたったかを見るために1年分を渡す
  const duties = readRows_(SHEETS.DUTIES)
    .filter((x) => x.eventKey && x['日付'] >= addDays_(today, -400))
    .map((x) => ({ key: x.eventKey, date: x['日付'], type: x['種類'], fam: x['家族ID'] }));

  const raceKeysAll = Object.keys(raceKeys);
  const timetable = readRows_(SHEETS.TIMETABLE)
    .filter((x) => x.id && raceKeys[x.eventKey])
    .map((x) => ({ id: x.id, key: x.eventKey, start: x['開始'], race: x['種目'], group: x['区分'], heat: x['組'], call: x['招集'], warm: x['アップ'], memo: x['メモ'] }));
  const tasks = readRows_(SHEETS.TASKS)
    .filter((x) => x.id && raceKeys[x.eventKey])
    .map((x) => ({ id: x.id, key: x.eventKey, kind: x['種類'], target: x['対象'], done: x['状態'] === '済', memo: x['メモ'], photos: splitNames_(x['写真ID']), by: x['更新者'], at: x['日時'] }));
  // アルバム：1年分の写真（LINEグループに送られた写真と、ポータルから上げた写真）
  const photos = readRows_(SHEETS.PHOTOS)
    .filter((x) => photoIdOf_(x) && ['領収書', 'ヒヤリハット', 'コメント', '資料'].indexOf(x['種類']) < 0 && String(x['日時']).slice(0, 10) >= addDays_(today, -400))
    .map((x) => ({ id: photoIdOf_(x), key: x.eventKey, title: x['予定'], date: String(x['日時']).slice(0, 10), by: x['表示名'], at: x['日時'], kind: x['種類'] || 'LINE', mine: x.userId === ctx.userId }))
    .reverse();

  // 記録はクラブの子どもの分をすべて（自己ベストを出すため）。LINEの「結果」コマンドで入れた分も入る
  const kidNames = {};
  children.forEach((c) => (kidNames[c.name] = true));
  const results = readRows_(SHEETS.RESULTS)
    .filter((x) => kidNames[x['子ども']] && x['記録'])
    .map((x, i) => ({ id: x.id || '', key: x.eventKey, meet: x['大会・練習'] || String(x['日時']).slice(0, 10), date: (x['大会・練習'] || x['日時']).slice(0, 10), child: x['子ども'], race: x['種目'], record: x['記録'], place: x['順位'], round: x['ラウンド'], memo: x['メモ'], kind: x['区分'] || (x.eventKey ? '公式' : '練習') }));

  const manageKeys = raceKeysAll.filter((k) => ctx.admin || duties.some((x) => x.key === k && x.fam === ctx.famId));
  const me = familyRows.find((f) => f.userId === ctx.userId) || {};
  return {
    club: CONFIG.CLUB_NAME,
    server: SERVER_VERSION,
    today: today,
    me: {
      name: ctx.name,
      admin: ctx.admin,
      fam: ctx.famId,
      canManage: manageKeys,
      notify: wantsAbsenceNotice_(me),
      family: myFam ? myFam.parents : [ctx.name],
      children: children.filter((c) => c.parents.indexOf(ctx.userId) >= 0).map((c) => ({ name: c.name, grade: c.grade, sex: c.sex })),
    },
    kids: children.map((c) => ({ name: c.name, grade: c.grade, sex: c.sex })),
    families: families.map((f) => ({ id: f.id, label: f.label, parents: f.parents })),
    sheetUrl: ctx.admin ? 'https://docs.google.com/spreadsheets/d/' + requireProp_('SPREADSHEET_ID') + '/edit' : '',
    photoFolderUrl: ctx.admin ? photoFolderUrl_() : '',
    parents: ctx.admin ? familyRows.map((f) => ({ id: f.userId, name: f['表示名'] || '（名前なし）', admin: isAdmin_(f), notify: wantsAbsenceNotice_(f), me: f.userId === ctx.userId, kids: children.filter((c) => c.parents.indexOf(f.userId) >= 0).map((c) => c.name), seen: f['グループ確認'] || f['更新日時'] || '' })) : [],
    events: events,
    entries: entries,
    absences: absences,
    notices: notices,
    duties: duties,
    timetable: timetable,
    tasks: tasks,
    photos: photos,
    results: results,
    ledger: ledgerFor_(ctx, manageKeys),
    comments: commentsFor_(ctx),
    polls: pollsFor_(ctx, families),
    fees: feesFor_(ctx, children),
    docs: readRows_(SHEETS.DOCS).filter((x) => x.id && raceKeys[x.eventKey]).map((x) => ({ id: x.id, key: x.eventKey, kind: x['種類'], name: x['名前'], url: x.URL, file: x['ファイルID'], type: x['形式'], by: x['追加者'], at: x['日時'] })),
    history: readRows_(SHEETS.HISTORY).filter((x) => raceKeys[x.eventKey]).map((x) => ({ key: x.eventKey, at: x['日時'], by: x['表示名'], text: x['内容'] })).reverse(),
    choices: { races: CHOICES.RACES, items: CHOICES.ITEMS, targets: CHOICES.TARGETS, reasons: CHOICES.ABSENCE_REASONS, deadlineDays: CONFIG.DEADLINE_DAYS_BEFORE, practiceTimes: CONFIG.PRACTICE_TIMES, rounds: CHOICES.ROUNDS, applyHow: CHOICES.APPLY_HOW, docKinds: CHOICES.DOC_KINDS, warmMinutes: CONFIG.WARM_UP_MINUTES_BEFORE_CALL, absencePush: CONFIG.ABSENCE_PUSH_TO_ADMINS },
  };
}

/**
 * 子どものいる家族の一覧（当番表に使う）。名前は「子どもの名前」で表す。
 * @return {{id: string, label: string, parents: string[], userIds: string[]}[]}
 */
function familiesList_(familyRows, children) {
  const byId = {};
  familyRows.forEach((f) => {
    const id = famIdOf_(f);
    const x = byId[id] || (byId[id] = { id: id, parents: [], userIds: [], kids: [] });
    x.parents.push(f['表示名'] || '保護者');
    x.userIds.push(f.userId);
  });
  children.forEach((c) => {
    Object.keys(byId).forEach((id) => {
      const x = byId[id];
      if (c.parents.some((u) => x.userIds.indexOf(u) >= 0) && x.kids.indexOf(c) < 0) x.kids.push(c);
    });
  });
  return Object.keys(byId).map((id) => byId[id]).filter((x) => x.kids.length)
    .map((x) => ({ id: x.id, label: x.kids.sort((a, b) => b.grade - a.grade).map((c) => c.name).join('・'), parents: x.parents, userIds: x.userIds }))
    .sort((a, b) => (a.label < b.label ? -1 : 1));
}

/** 休みの連絡をLINEで受け取るか。「休み通知」が ○ の人、または役員（× にした人を除く） */
function wantsAbsenceNotice_(f) {
  const v = String(f['休み通知'] || '').trim();
  if (/^(○|◯|〇|o|1|true)$/i.test(v)) return true;
  if (/^(×|x|0|false)$/i.test(v)) return false;
  return isAdmin_(f);
}

// ---- 操作 ----

function requireMyChild_(ctx, name) {
  const mine = childrenOf_(ctx.userId).some((c) => c.name === name);
  if (!mine && !ctx.admin) throw new Error(name + 'さんは、あなたのお子さんとして登録されていません。');
}

function saveChildrenAction_(ctx, p) {
  const list = (p.children || [])
    .map((c) => ({ name: String(c.name || '').trim().slice(0, 30), grade: Math.max(0, Math.min(6, Number(c.grade) || 0)), sex: c.sex === '男' || c.sex === '女' ? c.sex : '' }))
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
  logHistory_(p.key, ctx, 'エントリー：' + p.child + ' ' + p.join + (races.length ? '（' + races.join('・') + '）' : ''));
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
  logHistory_(p.key, ctx, '集金：' + p.child + (p.paid ? ' 済' : ' 未にもどす'));
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
  if (CONFIG.ABSENCE_PUSH_TO_ADMINS) notifyAbsence_(p.date, '🏃 休みの連絡\n' + formatDate_(p.date) + ' ' + p.child + '（' + reason + '）' + (memo ? '\n' + memo : '') + '\n連絡：' + ctx.name + 'さん', ctx.userId);
  return formatDate_(p.date) + ' ' + p.child + 'のお休みを連絡しました';
}

/**
 * 休みの連絡を、受け取る係の人（役員など）と、その日の練習の当番の家族に、1対1のLINEで送る。
 * Botを友だち追加している人にだけ届く。1人につき1通、無料枠の通数を使う。
 */
function absenceRecipients_(date) {
  const families = readRows_(SHEETS.FAMILIES);
  const dutyFams = readRows_(SHEETS.DUTIES).filter((d) => d['日付'] === date && d['種類'] === '練習').map((d) => d['家族ID']);
  return families.filter((f) => wantsAbsenceNotice_(f) || dutyFams.indexOf(famIdOf_(f)) >= 0).map((f) => f.userId);
}

function notifyAbsence_(date, text, exceptUserId) {
  absenceRecipients_(date).filter((u) => u !== exceptUserId).forEach((u) => {
    try {
      push_(u, [text_(text)]);
    } catch (err) {
      console.warn('休みの通知に失敗: ' + u + ' ' + err);
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
  const ymd = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : '');
  const url = /^https?:\/\/\S+$/.test(String(p.url || '').trim()) ? String(p.url).trim().slice(0, 300) : '';
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
    '主催': String(p.organizer || '').trim().slice(0, 60),
    '申込期限': ymd(p.applyBy),
    '申込方法': CHOICES.APPLY_HOW.indexOf(p.applyHow) >= 0 ? p.applyHow : '',
    '支払期限': ymd(p.payBy),
    '受付': String(p.reception || '').trim().slice(0, 80),
    '要項URL': url,
  };
  let created = false;
  withLock_(() => {
    const row = readRows_(SHEETS.RACES).find((r) => r.eventKey === ev.eventKey);
    if (row) updateRow_(SHEETS.RACES, Object.assign(row, data));
    else { appendRow_(SHEETS.RACES, data); created = true; }
  });
  logHistory_(ev.eventKey, ctx, created ? '大会の案内をつくりました' : '大会の案内を直しました');
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
    appendRow_(SHEETS.NOTICES, { id: randomKey_().slice(0, 10), '日付': today_(), 'タイトル': title, '本文': String(p.body || '').slice(0, 2000), eventKey: p.key || '', '作成者': ctx.name, '日時': now_(), '重要': p.important ? '○' : '' });
  });
  return 'お知らせを載せました';
}

/** お知らせを読んだ（画面に出たら、まとめて呼ぶ） */
function markReadAction_(ctx, p) {
  const ids = (p.ids || []).slice(0, 20).map(String);
  if (!ids.length) return '';
  withLock_(() => {
    const have = readRows_(SHEETS.READS).filter((r) => r.userId === ctx.userId).map((r) => r['お知らせid']);
    ids.filter((id) => have.indexOf(id) < 0).forEach((id) => appendRow_(SHEETS.READS, { 'お知らせid': id, userId: ctx.userId, '日時': now_() }));
  });
  return '';
}

function deleteNoticeAction_(ctx, p) {
  withLock_(() => {
    const n = readRows_(SHEETS.NOTICES).find((x) => x.id && x.id === p.id);
    if (n) clearRow_(SHEETS.NOTICES, n);
  });
  return 'お知らせを消しました';
}
