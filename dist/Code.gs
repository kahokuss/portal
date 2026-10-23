// 河北SS ポータル（Apps Script）。このファイルは tools/build-pages.js が src/*.gs をつなげて作ります。
// 更新のしかた：Apps Script のエディタで「コード.gs」の中身を全部消して、このファイルの中身を全部貼り付け、保存します。
// そのあと「デプロイ」→「デプロイを管理」→ 鉛筆 →「新バージョン」→「デプロイ」。

// ===== Bot.gs =====
/**
 * Botに聞くと答える機能（返信なので、1対1のトークなら通数はかかりません）。
 *   新着 … わが家にかかわること（次の練習・当番・エントリーの締切・新しいお知らせ・ヒヤリハット）。役員には確認待ちの休みなども
 *   今日 … 今日の予定。大会の日は、わが家の子の時刻・招集・ナンバー
 *   予定 … これからの予定5件
 *   休み … 休みの連絡（「休み 明日」「休み たろう 10/20 体調不良」）。ボタンからも選べる
 *   当番 … わが家の当番
 *   出欠 … 次の練習の休みの人
 *   エントリー … 大会のエントリーの状況と締切
 */

/** 返事の下に出すボタン（クイックリプライ） */
function quickItems_(labels) {
  return {
    items: labels.slice(0, 13).map((x) => {
      const label = typeof x === 'string' ? x : x[0];
      const text = typeof x === 'string' ? x : x[1];
      return { type: 'action', action: { type: 'message', label: label.slice(0, 20), text: text } };
    }),
  };
}

const MAIN_QUICK = ['新着', '今日', '予定', '休み', '当番', 'ポータル'];

/** 文章の配列を、最後にボタンを付けた返事にする */
function botMessages_(texts, quick) {
  const msgs = texts.filter(Boolean).slice(0, 5).map((t) => text_(t));
  if (msgs.length) msgs[msgs.length - 1].quickReply = quickItems_(quick || MAIN_QUICK);
  return msgs;
}

function botData_() {
  const today = today_();
  const races = {};
  readRows_(SHEETS.RACES).forEach((r) => (races[r.eventKey] = r));
  const events = readRows_(SHEETS.EVENTS)
    .filter((e) => e['状態'] !== '中止' && e['日付'] >= today)
    .sort(compareEvents_)
    .map((e) => ({ row: e, key: e.eventKey, date: e['日付'], title: e['タイトル'], place: e['場所'], race: !!races[e.eventKey] || (e['種別'] || guessType_(e['タイトル'])) !== '練習', detail: races[e.eventKey] ? raceToObj_(races[e.eventKey]) : null }));
  return { today: today, events: events, races: races };
}

function famLabelMap_() {
  const map = {};
  familiesList_(readRows_(SHEETS.FAMILIES), activeChildren_()).forEach((f) => (map[f.id] = f.label));
  return map;
}

/** まだ予定に反映していない、LINEの変更連絡（その予定の分） */
function pendingNotices_() {
  const out = {};
  readRows_(SHEETS.COMMENTS).forEach((c) => {
    if (c.id && c['種類'] === '変更連絡' && !c['対策'] && c.eventKey) (out[c.eventKey] = out[c.eventKey] || []).push(c);
  });
  return out;
}

function noticeLine_(list) {
  return list && list.length ? '📣 変更連絡あり（' + list[list.length - 1]['表示名'] + 'さん）：' + String(list[list.length - 1]['本文']).replace(/\s+/g, ' ').slice(0, 60) : '';
}

function whenText_(e) {
  return formatWhen_(e.row) + ' ' + e.title + (e.place ? '（' + e.place + '）' : '');
}

function dayWord_(date, today) {
  const n = Math.round((new Date(date + 'T00:00:00Z') - new Date(today + 'T00:00:00Z')) / 86400000);
  return n === 0 ? '今日' : n === 1 ? '明日' : n === 2 ? 'あさって' : 'あと' + n + '日';
}

function botUser_(ev) {
  const userId = ev.source.userId;
  const family = findFamily_(userId);
  const kids = childrenOf_(userId);
  return { userId: userId, family: family, admin: isAdmin_(family), famId: family ? famIdOf_(family) : userId, kids: kids, name: (family && family['表示名']) || '' };
}

function needRegister_(ev) {
  respond_(ev, botMessages_(['先にお子さんを登録してください。\n「登録 山田たろう 3年」と送るか、ポータルの「わが家」から登録できます。\n' + portalUrl_()], ['ヘルプ', 'ポータル']));
}

// ---- 新着 ----

function handleNews_(ev) {
  const u = botUser_(ev);
  const d = botData_();
  const lines = ['🔔 ' + CONFIG.CLUB_NAME + ' 新着（' + formatDate_(d.today) + '）'];
  const absences = readRows_(SHEETS.ABSENCES).filter((a) => a.id && a['日付'] >= d.today);
  const duties = readRows_(SHEETS.DUTIES).filter((x) => x['日付'] >= d.today);
  const labels = famLabelMap_();

  const np = d.events.find((e) => !e.race);
  if (np) {
    const off = absences.filter((a) => a['日付'] === np.date);
    const duty = duties.filter((x) => x.eventKey === np.key).map((x) => labels[x['家族ID']] || '').filter(Boolean);
    lines.push('', '🏃 次の練習（' + dayWord_(np.date, d.today) + '）', whenText_(np), '休み ' + off.length + '人' + (duty.length ? '・当番 ' + duty.join('、') : ''));
    if (duties.some((x) => x.eventKey === np.key && x['家族ID'] === u.famId) && off.length) lines.push('（当番のため表示）休む子：' + off.map((a) => a['子ども']).join('、'));
    const nl = noticeLine_(pendingNotices_()[np.key]);
    if (nl) lines.push(nl);
  }

  const mine = duties.filter((x) => x['家族ID'] === u.famId && x['日付'] <= addDays_(d.today, 14));
  if (mine.length) {
    lines.push('', '🧹 わが家の当番');
    mine.forEach((x) => { const e = d.events.find((y) => y.key === x.eventKey); if (e) lines.push('・' + formatDate_(e.date) + ' ' + x['種類'] + '当番（' + e.title + '）'); });
  }

  const entries = readRows_(SHEETS.ENTRIES);
  const todo = [];
  d.events.filter((e) => e.race && e.detail && e.detail.deadline && e.detail.deadline >= d.today).forEach((e) => {
    u.kids.forEach((k) => {
      if (!inTarget_(e.detail.target, k.grade)) return;
      if (!entries.some((x) => x.eventKey === e.key && x['子ども'] === k.name)) todo.push('・' + e.title + '：' + k.name + ' 未回答（締切 ' + formatDate_(e.detail.deadline) + '）');
    });
  });
  if (todo.length) lines.push('', '✅ エントリーの回答がまだです', ...todo.slice(0, 5));

  const seen = (u.family && u.family['新着確認']) || '';
  const notices = readRows_(SHEETS.NOTICES).filter((n) => n.id && n['日時'] > (seen || now_().slice(0, 10) + ' 00')).sort((a, b) => (a['日時'] < b['日時'] ? 1 : -1));
  const recent = notices.length ? notices : readRows_(SHEETS.NOTICES).filter((n) => n.id && n['日付'] >= addDays_(d.today, -7));
  if (recent.length) {
    lines.push('', notices.length ? '📢 新しいお知らせ' : '📢 最近のお知らせ');
    recent.slice(0, 3).forEach((n) => lines.push('・' + n['タイトル'] + (n['本文'] ? '：' + String(n['本文']).slice(0, 40) : '')));
  }

  const nm = readRows_(SHEETS.COMMENTS).filter((c) => c.id && c['種類'] === 'ヒヤリハット' && c['公開'] !== '役員' && String(c['日時']).slice(0, 10) >= addDays_(d.today, -14));
  if (nm.length) {
    lines.push('', '⚠ ヒヤリハット（2週間以内）');
    nm.slice(-3).forEach((c) => lines.push('・' + (c['場所'] ? c['場所'] + '：' : '') + String(c['本文']).slice(0, 40) + (c['対策'] ? '\n　→ 対策：' + String(c['対策']).slice(0, 40) : '（対策まだ）')));
  }

  const adminLines = [];
  if (u.admin) {
    const unack = absences.filter((a) => a['確認'] !== '済');
    if (unack.length) {
      adminLines.push('🙋 確認していない休みの連絡 ' + unack.length + '件');
      unack.slice(0, 8).forEach((a) => adminLines.push('・' + formatDate_(a['日付']) + ' ' + a['子ども'] + '（' + a['理由'] + (a['メモ'] ? '・' + a['メモ'] : '') + '）'));
    }
    const pend = readRows_(SHEETS.COMMENTS).filter((c) => c.id && c['種類'] === '変更連絡' && !c['対策']);
    if (pend.length) adminLines.push('📣 予定にまだ反映していない変更連絡 ' + pend.length + '件（ポータルの練習のページで「予定に反映する」）');
    const open = readRows_(SHEETS.COMMENTS).filter((c) => c.id && c['種類'] === 'ヒヤリハット' && !c['対策']);
    if (open.length) adminLines.push('⚠ 対策がまだのヒヤリハット ' + open.length + '件');
    const tasks = readRows_(SHEETS.TASKS);
    d.events.filter((e) => e.detail && e.detail.applyBy && e.detail.applyBy <= addDays_(d.today, 7)).forEach((e) => {
      const done = tasks.some((t) => t.eventKey === e.key && t['種類'] === 'エントリー控え' && t['状態'] === '済');
      if (!done) adminLines.push('📮 申込期限が近い：' + e.title + '（' + formatDate_(e.detail.applyBy) + '・' + dayWord_(e.detail.applyBy, d.today).replace('今日', '今日まで') + '）');
    });
    const nowStr = now_().slice(0, 16), soon = fmt_(new Date(Date.now() + 24 * 3600000), 'yyyy-MM-dd HH:mm');
    d.events.filter((e) => e.detail).forEach((e) => {
      Object.keys(e.detail.deadlines || {}).forEach((k) => {
        const at = e.detail.deadlines[k];
        if (at < nowStr || at > soon) return;
        const done = tasks.filter((t) => t.eventKey === e.key && t['種類'] === k);
        if (done.length && done.every((t) => t['状態'] === '済')) return;
        adminLines.push('⏰ ' + deadlineLabel_(k) + '：' + at.slice(5, 10).replace('-', '/') + ' ' + at.slice(11) + 'まで（' + e.title + '）');
      });
    });
    const noDuty = d.events.filter((e) => e.date <= addDays_(d.today, 14) && !duties.some((x) => x.eventKey === e.key));
    if (noDuty.length) adminLines.push('🧹 当番が決まっていない予定（2週間以内）' + noDuty.length + '件');
    if (adminLines.length) adminLines.unshift('【役員向け】');
  }

  if (lines.length === 1) lines.push('', '新しいことはありません。');
  if (u.family) withLock_(() => { const f = findFamily_(u.userId); if (f) { f['新着確認'] = now_(); updateRow_(SHEETS.FAMILIES, f); } });
  respond_(ev, botMessages_([lines.join('\n'), adminLines.length ? adminLines.join('\n') + '\n\n詳しくはポータルの管理メニューで\n' + portalUrl_() : '']));
}

// ---- 今日・予定 ----

function handleToday_(ev) {
  const u = botUser_(ev);
  const d = botData_();
  const todays = d.events.filter((e) => e.date === d.today);
  if (!todays.length) {
    const next = d.events[0];
    return respond_(ev, botMessages_(['今日の予定はありません。' + (next ? '\n次は ' + whenText_(next) + '（' + dayWord_(next.date, d.today) + '）' : '')]));
  }
  const tasks = readRows_(SHEETS.TASKS);
  const entries = readRows_(SHEETS.ENTRIES);
  const notices = pendingNotices_();
  const out = todays.map((e) => {
    const lines = ['📅 今日 ' + whenText_(e)];
    if (notices[e.key]) lines.push(noticeLine_(notices[e.key]));
    if (e.race && e.detail && (e.detail.meetTime || e.detail.meetPlace)) lines.push('集合 ' + [e.detail.meetTime, e.detail.meetPlace].filter(Boolean).join(' '));
    const jin = e.race && tasks.find((t) => t.eventKey === e.key && t['種類'] === '陣地');
    if (jin && (jin['メモ'] || jin['写真ID'])) lines.push('📍 陣地：' + (jin['メモ'] ? String(jin['メモ']).replace(/\s+/g, ' ').slice(0, 80) : '写真あり') + (jin['写真ID'] ? '（写真はポータルで）' : ''));
    if (e.race) {
      const rows = readRows_(SHEETS.TIMETABLE).filter((r) => r.id && r.eventKey === e.key);
      u.kids.forEach((k) => {
        const x = entries.find((y) => y.eventKey === e.key && y['子ども'] === k.name);
        if (!x || x['回答'] !== '参加') return;
        const bib = tasks.find((t) => t.eventKey === e.key && t['種類'] === 'ナンバー' && t['対象'] === k.name);
        lines.push('', '👟 ' + k.name + (bib && bib['メモ'] ? '（ナンバー ' + bib['メモ'] + '）' : ''));
        const mine = rows.filter((r) => splitNames_(x['種目']).some((q) => sameRaceGs_(r['種目'], q)) && groupMatchGs_(r['区分'], k)).sort((a, b) => (padTime_(a['開始']) < padTime_(b['開始']) ? -1 : 1));
        const adv = (r) => !needsAdvanceGs_(rows, r) || tasks.some((t) => t.eventKey === e.key && t['種類'] === '進出' && t['対象'] === k.name + '|' + r.id && t['状態'] === '済');
        if (!mine.length) lines.push('　種目：' + (x['種目'] || '—') + '（タイムテーブルはまだ）');
        mine.forEach((r) => {
          const lane = tasks.find((t) => t.eventKey === e.key && t['種類'] === 'レーン' && t['対象'] === k.name + '|' + r.id);
          lines.push('　' + (r['開始'] || '—') + ' ' + r['種目'] + (r['組'] ? ' ' + r['組'] : '') + (r['招集'] ? '　招集 ' + r['招集'] : '') + (lane && lane['メモ'] ? '　' + lane['メモ'] : '') + (adv(r) ? '' : '（進んだら）'));
        });
      });
    } else {
      if (e.row['ダウン']) lines.push('🏃 ダウンに入りました（' + e.row['ダウン'].replace(/^0/, '') + '）。お迎えをお願いします');
      const off = readRows_(SHEETS.ABSENCES).filter((a) => a.id && a['日付'] === e.date).map((a) => a['子ども']);
      lines.push('休み ' + off.length + '人' + (off.length ? '：' + off.join('、') : ''));
    }
    return lines.join('\n');
  });
  respond_(ev, botMessages_(out));
}

function handleSchedule_(ev) {
  const d = botData_();
  const list = d.events.slice(0, 6);
  if (!list.length) return respond_(ev, botMessages_(['これからの予定はありません。']));
  const lines = ['📅 これからの予定'];
  const notices = pendingNotices_();
  list.forEach((e) => lines.push((e.race ? '🏅 ' : '・') + whenText_(e) + (e.race && e.detail && e.detail.deadline && e.detail.deadline >= d.today ? '\n　締切 ' + formatDate_(e.detail.deadline) : '') + (notices[e.key] ? '\n　' + noticeLine_(notices[e.key]) : '')));
  lines.push('', 'ぜんぶ見るときはポータルで\n' + portalUrl_());
  respond_(ev, botMessages_([lines.join('\n')]));
}

// ---- 休み ----

/** 「休み 明日」「休み たろう 10/20 体調不良 熱があります」を読み取る */
function parseAbsenceArgs_(args, kids, practiceDates, today) {
  const tokens = toHalfWidth_(args || '').trim().split(/\s+/).filter(Boolean);
  let child = kids.length === 1 ? kids[0].name : '';
  let date = '';
  let reason = '';
  const memo = [];
  tokens.forEach((t) => {
    const k = kids.find((c) => c.name === t || c.name.indexOf(t) >= 0);
    if (k && !child) { child = k.name; return; }
    if (k && child === k.name) return;
    const dd = t === '今日' ? today : t === '明日' ? addDays_(today, 1) : t === 'あさって' ? addDays_(today, 2) : parseDateCell_(t.replace(/^(\d{1,2})日$/, (m, n) => today.slice(5, 7) + '/' + n));
    if (dd && !date) { date = dd; return; }
    if (!reason && CHOICES.ABSENCE_REASONS.indexOf(t) >= 0) { reason = t; return; }
    memo.push(t);
  });
  if (!date) date = practiceDates[0] || '';
  return { child: child, date: date, reason: reason || 'その他', memo: memo.join(' ') };
}

function handleAbsence_(ev, args) {
  const u = botUser_(ev);
  if (!u.kids.length) return needRegister_(ev);
  const d = botData_();
  const practices = d.events.filter((e) => !e.race).slice(0, 4);
  if (!args) {
    const quick = [];
    practices.slice(0, u.kids.length > 1 ? 3 : 4).forEach((e) => u.kids.forEach((k) => quick.push([(u.kids.length > 1 ? k.name.slice(-3) + ' ' : '') + formatDate_(e.date), '休み ' + k.name + ' ' + e.date])));
    return respond_(ev, botMessages_(['休みの連絡をします。下のボタンから選ぶか、\n「休み 明日」「休み ' + u.kids[0].name + ' 10/20 体調不良」\nのように送ってください。\n理由とひとことは、役員と本人だけに見えます。'], quick.slice(0, 12).concat(['新着'])));
  }
  const p = parseAbsenceArgs_(args, u.kids, practices.map((e) => e.date), d.today);
  if (!p.child) return respond_(ev, botMessages_(['だれのお休みか、名前も書いてください。\n例：休み ' + u.kids[0].name + ' 明日'], u.kids.map((k) => ['休み ' + k.name.slice(-6), '休み ' + k.name + ' ' + (p.date || '')])));
  if (!p.date) return respond_(ev, botMessages_(['日にちが分かりませんでした。例：休み 明日、休み 10/20']));
  try {
    const msg = reportAbsenceAction_({ userId: u.userId, name: u.name || getDisplayName_(ev.source), admin: u.admin }, p);
    const onDay = d.events.find((e) => e.date === p.date);
    respond_(ev, botMessages_(['✅ ' + msg + '（' + p.reason + (p.memo ? '・' + p.memo : '') + '）' + (onDay ? '\n' + whenText_(onDay) : '\n※この日は予定が入っていません') + '\n取り消すときは「休み取消」と送ってください。'], ['休み取消', '新着', '予定']));
  } catch (err) {
    respond_(ev, botMessages_(['⚠ ' + String(err.message || err)]));
  }
}

function handleAbsenceCancel_(ev) {
  const u = botUser_(ev);
  const mine = readRows_(SHEETS.ABSENCES).filter((a) => a.id && a['連絡者userId'] === u.userId && a['日付'] >= today_()).sort((a, b) => (a['日時'] < b['日時'] ? 1 : -1));
  if (!mine.length) return respond_(ev, botMessages_(['取り消せる休みの連絡はありません。']));
  const a = mine[0];
  withLock_(() => clearRow_(SHEETS.ABSENCES, a));
  respond_(ev, botMessages_(['🗑 ' + formatDate_(a['日付']) + ' ' + a['子ども'] + 'の休みの連絡を取り消しました。' + (mine.length > 1 ? '\nほかにもあれば、もう一度「休み取消」と送ってください（新しい順に取り消します）。' : '')]));
}

// ---- 当番・出欠・エントリー ----

function handleDuty_(ev) {
  const u = botUser_(ev);
  const d = botData_();
  const labels = famLabelMap_();
  const duties = readRows_(SHEETS.DUTIES).filter((x) => x['日付'] >= d.today);
  const mine = duties.filter((x) => x['家族ID'] === u.famId);
  const lines = ['🧹 わが家の当番'];
  if (!mine.length) lines.push('これからの当番はありません。');
  mine.forEach((x) => { const e = d.events.find((y) => y.key === x.eventKey); if (e) lines.push('・' + formatDate_(e.date) + '（' + dayWord_(e.date, d.today) + '）' + x['種類'] + '当番\n　' + e.title + (e.place ? '・' + e.place : '')); });
  const next = d.events.slice(0, 5).map((e) => '・' + formatDate_(e.date) + ' ' + e.title + '：' + (duties.filter((x) => x.eventKey === e.key).map((x) => labels[x['家族ID']]).filter(Boolean).join('、') || '未定'));
  respond_(ev, botMessages_([lines.join('\n'), '📋 これからの当番\n' + next.join('\n')]));
}

function handleAttendance_(ev) {
  const u = botUser_(ev);
  const d = botData_();
  const np = d.events.find((e) => !e.race);
  if (!np) return respond_(ev, botMessages_(['練習の予定がありません。']));
  const off = readRows_(SHEETS.ABSENCES).filter((a) => a.id && a['日付'] === np.date);
  const all = activeChildren_();
  const lines = ['🏃 ' + whenText_(np) + '（' + dayWord_(np.date, d.today) + '）', '出席予定 ' + (all.length - off.length) + '人・休み ' + off.length + '人'];
  off.forEach((a) => lines.push('・' + a['子ども'] + (u.admin ? '（' + a['理由'] + (a['メモ'] ? '・' + a['メモ'] : '') + '）' : '')));
  respond_(ev, botMessages_([lines.join('\n')]));
}

function handleEntries_(ev) {
  const u = botUser_(ev);
  if (!u.kids.length) return needRegister_(ev);
  const d = botData_();
  const entries = readRows_(SHEETS.ENTRIES);
  const races = d.events.filter((e) => e.race).slice(0, 5);
  if (!races.length) return respond_(ev, botMessages_(['予定されている大会はありません。']));
  const lines = ['🏅 大会のエントリー'];
  races.forEach((e) => {
    const det = e.detail || {};
    lines.push('', formatDate_(e.date) + ' ' + e.title + (det.deadline ? '（締切 ' + formatDate_(det.deadline) + (det.deadline < d.today ? '・締切済み' : '') + '）' : ''));
    u.kids.forEach((k) => {
      if (!inTarget_(det.target, k.grade)) return lines.push('・' + k.name + '：対象外');
      const x = entries.find((y) => y.eventKey === e.key && y['子ども'] === k.name);
      lines.push('・' + k.name + '：' + (x ? x['回答'] + (x['種目'] ? '（' + x['種目'].replace(/,/g, '・') + '）' : '') + (det.fee && x['回答'] === '参加' ? (x['集金'] === '済' ? ' 参加費済' : ' 参加費まだ') : '') : '未回答'));
    });
  });
  lines.push('', '回答はポータルから\n' + portalUrl_());
  respond_(ev, botMessages_([lines.join('\n')]));
}

// ---- 画面と同じ照合（タイムテーブルの区分・種目） ----

const ROUND_ORDER_GS = ['予選', '準決勝', '決勝'];

function roundOfGs_(r) {
  const m = String(r['組'] || '').match(/準決勝|予選|決勝|タイムレース/);
  return m ? m[0] : '';
}

/** 同じ種目・区分に、前のラウンド（予選・準決勝）の行がある決勝・準決勝か */
function needsAdvanceGs_(rows, r) {
  const ri = ROUND_ORDER_GS.indexOf(roundOfGs_(r));
  if (ri <= 0) return false;
  const g = toHalfWidth_(r['区分'] || '').replace(/\s/g, '');
  return rows.some((x) => {
    const xi = ROUND_ORDER_GS.indexOf(roundOfGs_(x));
    return x.id !== r.id && xi >= 0 && xi < ri && sameRaceGs_(x['種目'], r['種目']) && toHalfWidth_(x['区分'] || '').replace(/\s/g, '') === g;
  });
}

function padTime_(t) {
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? ('0' + m[1]).slice(-2) + ':' + m[2] : '99:99';
}

function canonRaceGs_(r) {
  r = toHalfWidth_(r || '').toLowerCase().replace(/\s/g, '').replace(/[×x]/g, 'x').replace(/\(.*?\)/g, '');
  if (/リレー|\dx\d+m/.test(r)) return 'リレー';
  return r.replace('走り幅跳び', '走幅跳').replace('走り高跳び', '走高跳').replace(/幅跳び?$/, '幅跳').replace(/高跳び?$/, '高跳')
    .replace(/ジャベ(?:リック)?ボール(?:投げ?|スロー)|ボール(?:投げ?|スロー)|ジャベリックスロー|ジャベ$/, 'ボール投').replace(/ハードル/, 'h').replace(/^小学|^[1-6・.]+年|男子|女子|混合/g, '');
}

function sameRaceGs_(a, b) {
  a = canonRaceGs_(a);
  b = canonRaceGs_(b);
  return !!a && !!b && (a === b || a.indexOf(b) >= 0 || b.indexOf(a) >= 0);
}

function groupMatchGs_(g, k) {
  g = toHalfWidth_(g || '').replace(/[〜～]/g, '~');
  const sex = /男女|混合/.test(g) ? '' : /男/.test(g) ? '男' : /女/.test(g) ? '女' : '';
  if (sex && k.sex && sex !== k.sex) return false;
  let grades = [];
  if (/低学年/.test(g)) grades = [1, 2, 3];
  if (/中学年/.test(g)) grades = [3, 4];
  if (/高学年/.test(g)) grades = [4, 5, 6];
  const re = /([1-6](?:\s*[~\-－・.,、]\s*[1-6])*)\s*年/g;
  let m;
  while ((m = re.exec(g))) {
    const nums = m[1].match(/[1-6]/g).map(Number);
    if (/[~\-－]/.test(m[1]) && nums.length === 2) { for (let i = nums[0]; i <= nums[1]; i++) grades.push(i); }
    else grades = grades.concat(nums);
  }
  return !grades.length || !k.grade || grades.indexOf(k.grade) >= 0;
}

// ---- リッチメニュー（Botとの1対1のトークの下に出るボタン） ----

/**
 * Botとのトーク画面の下に、ボタンのメニューを出す。エディタから1回だけ実行する。
 * 画像は GitHub Pages の richmenu.png（tools/build-richmenu.js で作る）。
 */
function setupRichMenu() {
  requireOwner_();
  const W = 2500, H = 843, cw = W / 3, ch = H / 2;
  const cells = [['新着', '新着'], ['今日', '今日'], ['休み', '休み'], ['予定', '予定'], ['当番', '当番'], ['uri', portalUrl_()]];
  const menu = {
    size: { width: W, height: H }, selected: true, name: CONFIG.CLUB_NAME + ' メニュー', chatBarText: 'メニュー',
    areas: cells.map((c, i) => ({
      bounds: { x: Math.round((i % 3) * cw), y: Math.round(Math.floor(i / 3) * ch), width: Math.round(cw), height: Math.round(ch) },
      action: c[0] === 'uri' ? { type: 'uri', label: 'ポータル', uri: c[1] } : { type: 'message', label: c[0], text: c[1] },
    })),
  };
  const id = JSON.parse(lineFetch_(LINE_API + '/richmenu', 'post', menu).getContentText()).richMenuId;
  const image = UrlFetchApp.fetch(String(CONFIG.PORTAL_URL || '').replace(/\/?$/, '/') + 'richmenu.png').getBlob();
  UrlFetchApp.fetch(LINE_DATA_API + '/richmenu/' + id + '/content', {
    method: 'post', contentType: 'image/png', payload: image.getBytes(),
    headers: { Authorization: 'Bearer ' + requireProp_('LINE_CHANNEL_ACCESS_TOKEN') },
  });
  lineFetch_(LINE_API + '/user/all/richmenu/' + id, 'post');
  console.log('リッチメニューを設定しました: ' + id);
}

// ===== Calendar.gs =====
/**
 * カレンダーの予定に対応するキー。
 * 繰り返し予定は各回が同じ ID を持つので日付を足して区別する。
 */
function eventKey_(calEvent) {
  let base = calEvent.getId();
  if (calEvent.isRecurringEvent()) base += '|' + fmt_(calEvent.getStartTime(), 'yyyy-MM-dd');
  return md5Hex_(base).slice(0, 12);
}

function calendar_() {
  const calendar = CalendarApp.getCalendarById(requireProp_('CALENDAR_ID'));
  if (!calendar) throw new Error('カレンダーが見つかりません。CALENDAR_ID と共有設定を確認してください');
  return calendar;
}

/** 予定名から種別を判断する */
function guessType_(title) {
  return CONFIG.RACE_KEYWORDS.test(title) ? '大会' : '練習';
}

function calEventToRow_(ce) {
  const allDay = ce.isAllDayEvent();
  return {
    eventKey: eventKey_(ce),
    '日付': fmt_(allDay ? ce.getAllDayStartDate() : ce.getStartTime(), 'yyyy-MM-dd'),
    '開始': allDay ? '終日' : fmt_(ce.getStartTime(), 'HH:mm'),
    '終了': allDay ? '' : fmt_(ce.getEndTime(), 'HH:mm'),
    'タイトル': ce.getTitle(),
    '場所': ce.getLocation(),
    'カレンダーID': ce.getId(),
  };
}

const EVENT_FIELDS = ['日付', '開始', '終了', 'タイトル', '場所'];

function syncRange_() {
  const today = today_();
  const first = addDays_(today, -CONFIG.SYNC_DAYS_BEFORE);
  const last = addDays_(today, CONFIG.SYNC_DAYS_AHEAD);
  return { first: first, last: last, start: new Date(first + 'T00:00:00+09:00'), end: new Date(addDays_(last, 1) + 'T00:00:00+09:00') };
}

/** Google カレンダーの予定を「予定」シートに取り込む */
function syncCalendar_() {
  const range = syncRange_();
  return withLock_(() => {
    const rows = readRows_(SHEETS.EVENTS);
    const byKey = {};
    rows.forEach((r) => (byKey[r.eventKey] = r));
    const seen = {};

    calendar_().getEvents(range.start, range.end).forEach((ce) => {
      const data = calEventToRow_(ce);
      seen[data.eventKey] = true;
      const row = byKey[data.eventKey];
      if (!row) {
        appendRow_(SHEETS.EVENTS, Object.assign(data, { '種別': guessType_(data['タイトル']), '状態': '予定', '更新日時': now_() }));
        return;
      }
      const changed = EVENT_FIELDS.some((f) => row[f] !== data[f]);
      if (!changed && row['状態'] !== '中止') return;
      Object.assign(row, data, { '状態': '予定', '更新日時': now_() });
      if (!row['種別']) row['種別'] = guessType_(row['タイトル']);
      updateRow_(SHEETS.EVENTS, row);
    });

    // 期間内なのにカレンダーから消えた予定は中止扱い
    rows.forEach((r) => {
      if (seen[r.eventKey] || r['状態'] === '中止') return;
      if (r['日付'] < range.first || r['日付'] > range.last) return;
      r['状態'] = '中止';
      r['更新日時'] = now_();
      updateRow_(SHEETS.EVENTS, r);
    });
    setProp_('LAST_SYNC', String(Date.now()));
  });
}

/** 前回の同期から時間がたっていればカレンダーを読み直す */
function syncIfStale_() {
  const last = Number(prop_('LAST_SYNC') || 0);
  if (Date.now() - last < CONFIG.SYNC_INTERVAL_MINUTES * 60000) return;
  importScheduleSafely_();
  try {
    syncCalendar_();
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
  }
}

/** カレンダーの予定から「予定」シートの行を作る・直す。type を渡すと種別も決める */
function upsertEventRow_(ce, type) {
  const data = calEventToRow_(ce);
  const row = findEvent_(data.eventKey);
  if (row) {
    Object.assign(row, data, { '状態': '予定', '更新日時': now_() });
    if (type) row['種別'] = type;
    updateRow_(SHEETS.EVENTS, row);
    return row;
  }
  return appendRow_(SHEETS.EVENTS, Object.assign(data, { '種別': type || guessType_(data['タイトル']), '状態': '予定', '更新日時': now_() }));
}

function timeOn_(date, hhmm) {
  return new Date(date + 'T' + ('0' + hhmm).slice(-5) + ':00+09:00');
}

/**
 * 予定をカレンダーに作る。start が空なら終日の予定。
 * @return {CalendarEvent}
 */
function createCalEvent_(o) {
  const cal = calendar_();
  const opt = { location: o.place || '' };
  if (!o.start) return cal.createAllDayEvent(o.title, new Date(o.date + 'T00:00:00+09:00'), opt);
  return cal.createEvent(o.title, timeOn_(o.date, o.start), timeOn_(o.date, o.end || o.start), opt);
}

/** カレンダーの予定を o の内容に直す */
function updateCalEvent_(ce, o) {
  ce.setTitle(o.title);
  ce.setLocation(o.place || '');
  if (!o.start) ce.setAllDayDate(new Date(o.date + 'T00:00:00+09:00'));
  else ce.setTime(timeOn_(o.date, o.start), timeOn_(o.date, o.end || o.start));
}

/** 「予定」シートの行に対応するカレンダーの予定（繰り返し予定は直せないので null） */
function editableCalEvent_(row) {
  const ce = row && row['カレンダーID'] ? calendar_().getEventById(row['カレンダーID']) : null;
  if (!ce) return null;
  if (ce.isRecurringEvent()) throw new Error('この予定はGoogleカレンダーの「繰り返し予定」なので、カレンダーのほうで直してください。');
  return ce;
}

/**
 * ポータルで作った・直した大会をカレンダーにも反映し、「予定」シートの行を返す。
 * 大会はカレンダーでは終日の予定にする（集合時刻などはポータル側で持つ）。
 */
function upsertRaceEvent_(eventKey, title, date, place) {
  const cal = calendar_();
  const d = new Date(date + 'T00:00:00+09:00');
  let row = eventKey ? findEvent_(eventKey) : null;
  if (row) {
    const ce = cal.getEventById(row['カレンダーID']);
    if (ce && !ce.isRecurringEvent()) {
      ce.setTitle(title);
      ce.setLocation(place || '');
      ce.setAllDayDate(d);
    }
    Object.assign(row, { '日付': date, '開始': '終日', '終了': '', 'タイトル': title, '場所': place || '', '種別': '大会', '状態': '予定', '更新日時': now_() });
    updateRow_(SHEETS.EVENTS, row);
    return row;
  }
  const ce = cal.createAllDayEvent(title, d, { location: place || '' });
  const data = calEventToRow_(ce);
  return appendRow_(SHEETS.EVENTS, Object.assign(data, { '種別': '大会', '状態': '予定', '更新日時': now_() }));
}

/** 予定入力シートの反映（失敗してもポータルは開けるようにする） */
function importScheduleSafely_() {
  try {
    importScheduleSheet_();
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
  }
}

// ===== Commands.gs =====
/**
 * コマンドへの返事。1対1のトークでは、ふつうに返信する（無料）。
 * グループで送られた個人的なコマンドは、グループには出さず、送った人だけに1対1で届ける
 * （プッシュなので1通ぶん無料枠を使う。Botを友だち追加していない人には届かないので、そのときだけグループで案内する）。
 */
function respond_(ev, messages) {
  // 返事の下に、よく使うボタンを出す（押すとその言葉が送られる）
  const last = messages[messages.length - 1];
  if (last && !last.quickReply) last.quickReply = quickItems_(MAIN_QUICK);
  if (!ev.privateAnswer) return reply_(ev.replyToken, messages);
  try {
    push_(ev.source.userId, messages);
  } catch (err) {
    console.warn('個別の返事に失敗: ' + err);
    // 429 は、今月の無料の通数（プッシュ）を使い切ったとき。返信（リプライ）は無料なので、グループに案内だけ出す
    const overQuota = / 429 /.test(String(err));
    reply_(ev.replyToken, [text_(overQuota
      ? '今月のBotの無料の通数を使い切ったため、グループからは個別にお返事できません。Botとの1対1のトークで送ってください（1対1なら無料でお返事できます）。'
      : 'お返事は、送った人だけに届くようにしています。Bot「' + CONFIG.CLUB_NAME + '」を友だち追加して、1対1のトークで送ってください。')]);
  }
}

/** 使い方の文章（CONFIG を使うので、ファイルの読み込み順に左右されないよう関数にする） */
function helpText_() {
  return [
    '🏃 ' + CONFIG.CLUB_NAME + ' Botの使い方',
    '下のボタンか、メニューから選べます。',
    '',
    '新着 … 次の練習・わが家の当番・エントリーの締切・お知らせなど、まとめて',
    '今日 … 今日の予定（大会の日は、子どもの時刻・招集・ナンバー）',
    '予定 … これからの予定',
    '休み … 休みの連絡（例：休み 明日／休み たろう 10/20 体調不良）。「休み取消」で取り消し',
    '当番 … わが家の当番と、これからの当番',
    '出欠 … 次の練習で休む人',
    'エントリー … 大会のエントリーの状況',
    'ポータル … 予定・大会のエントリー・休みの連絡ができるページのリンク（グループのメンバーだけが見られます）',
    '登録 名前 学年 … お子さんを登録（例：登録 山田たろう 3年 山田はなこ 1年）。ポータルの「わが家」からもできます',
    '結果 種目 記録 … レース結果を記録（例：結果 100m 15.2秒）',
    '記録 … お子さんの記録一覧',
    '写真 … アルバム（ポータル）のリンク',
    '',
    '📷 グループに送った写真は自動で保存され、ポータルの「写真」で大会・練習ごとに見られます。',
    '🔒 Botの返事は、グループで送っても、送った人にだけ届きます（Botを友だち追加してください）。Botとの1対1のトークで送るのがおすすめです。',
  ].join('\n');
}

/**
 * 1語目をコマンドとして解釈する。普段の会話に反応しないよう、
 * 1語目がコマンド名と完全に一致したときだけ反応する。
 * @return {{name: string, args: string}|null}
 */
function parseCommand_(text) {
  const m = String(text).trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const word = toHalfWidth_(m[1]).toLowerCase();
  const aliases = {
    'ヘルプ': 'help', '使い方': 'help', 'help': 'help',
    '登録': 'register',
    'ポータル': 'portal', 'portal': 'portal',
    '新着': 'news', '確認': 'news', 'お知らせ': 'news', 'メニュー': 'help',
    '今日': 'today', 'きょう': 'today',
    '予定': 'schedule', '次': 'schedule', 'スケジュール': 'schedule',
    '休み': 'absence', '欠席': 'absence', 'やすみ': 'absence',
    '休み取消': 'absenceCancel', '取消': 'absenceCancel', '取り消し': 'absenceCancel',
    '当番': 'duty',
    '出欠': 'attendance',
    'エントリー': 'entries',
    '結果': 'result',
    '記録': 'records',
    '写真': 'photos', 'アルバム': 'photos',
  };
  const name = aliases[word];
  if (!name) return null;
  return { name: name, args: (m[2] || '').trim() };
}

/** グループで送られても、みんなに見せる返事。いまはなし（Botの返事はすべて、送った人にだけ届ける） */
const PUBLIC_COMMANDS = [];

/** グループで「ダウン入ります」「ダウンに入りました」などと送られたか（返事はしない） */
const DOWN_PATTERN = /^(?:今から|いまから)?(?:クール)?ダウン(?:です|でーす|になります|します|しま|中|に入|入|はい|開始|始|スタート)/;

function handleText_(ev) {
  if (ev.source.type === 'group' && DOWN_PATTERN.test(String(ev.message.text).trim())) {
    // 保護者へのお知らせは、送った人のメッセージそのもの（通数はかからない）。Botは時刻を記録するだけ
    recordDown_(new Date(ev.timestamp), getDisplayName_(ev.source));
    return;
  }
  // 練習の変更の連絡（「次の木曜日は16時50分から競技場で練習します」など）は、記録だけして返事はしない
  // 大会の日の「場所を取りました」は、その大会の陣地（集合場所）として記録する（返事はしない）
  if (ev.source.type === 'group' && !parseCommand_(ev.message.text) && recordJinchi_(ev)) return;
  if (ev.source.type === 'group' && !parseCommand_(ev.message.text) && recordScheduleNotice_(ev)) return;
  const cmd = parseCommand_(ev.message.text);
  if (!cmd) return;
  ev.privateAnswer = CONFIG.GROUP_PRIVATE_REPLY && ev.source.type === 'group' && PUBLIC_COMMANDS.indexOf(cmd.name) < 0;
  switch (cmd.name) {
    case 'help':
      return respond_(ev, botMessages_([helpText_()]));
    case 'register':
      return handleRegister_(ev, cmd.args);
    case 'portal':
      return handlePortal_(ev);
    case 'news':
      return handleNews_(ev);
    case 'today':
      return handleToday_(ev);
    case 'schedule':
      return handleSchedule_(ev);
    case 'absence':
      return handleAbsence_(ev, cmd.args);
    case 'absenceCancel':
      return handleAbsenceCancel_(ev);
    case 'duty':
      return handleDuty_(ev);
    case 'attendance':
      return handleAttendance_(ev);
    case 'entries':
      return handleEntries_(ev);
    case 'result':
      return handleResultCommand_(ev, cmd.args);
    case 'records':
      return handleRecordsCommand_(ev, cmd.args);
    case 'photos':
      return respond_(ev, [text_('📷 アルバム（LINEグループのメンバーだけが見られます）\n' + portalUrl_() + (portalUrl_().indexOf('?') >= 0 ? '&' : '?') + 'tab=album')]);
  }
}

function handleRegister_(ev, args) {
  const userId = ev.source.userId;
  const list = parseChildrenArgs_(args);
  if (!list.length) {
    const children = childrenOf_(userId);
    return respond_(ev, [
      text_(
        children.length
          ? '登録中のお子さん：' + children.map((c) => c.name + (c.grade ? '（' + c.grade + '年）' : '')).join('、') + '\n変更するときは「登録 名前 学年」を送り直すか、ポータルの「わが家」から直してください。'
          : '「登録 山田たろう 3年」のように、お子さんの名前と学年を送ってください。'
      ),
    ]);
  }
  ensureFamily_(userId, getDisplayName_(ev.source));
  saveChildren_(userId, list);
  const noGrade = list.some((c) => !c.grade);
  respond_(ev, [
    text_('登録しました：' + list.map((c) => c.name + (c.grade ? '（' + c.grade + '年）' : '')).join('、') + (noGrade ? '\n学年はポータルの「わが家」から入れられます。' : '') +
      '\nポータル：' + portalUrl_()),
  ]);
}

/**
 * ポータルのリンクはみんな同じ。開くと LINE ログインがあり、グループのメンバーだけが入れるので、グループに出してよい。
 */
function handlePortal_(ev) {
  respond_(ev, [
    text_('🏃 ' + CONFIG.CLUB_NAME + ' ポータル\n' + portalUrl_() + '\n\n開くと「LINEでログイン」が出ます。' + CONFIG.CLUB_NAME + 'のLINEグループのメンバーだけが見られます。'),
  ]);
}

// ===== Config.gs =====
/**
 * 設定値。クラブの運用に合わせてここを書き換えてください。
 *
 * 秘密の値（アクセストークンなど）はコードに書かず、
 * 「プロジェクトの設定 > スクリプト プロパティ」に保存します。
 *   LINE_CHANNEL_ACCESS_TOKEN … LINE Developers で発行したチャネルアクセストークン（必須）
 *   CALENDAR_ID               … 練習・大会を登録する Google カレンダーの ID（必須）
 *   SPREADSHEET_ID            … setup() が自動で作成・保存します
 *   PHOTO_FOLDER_ID           … setup() が自動で作成・保存します
 *   WEBHOOK_TOKEN             … setup() が自動で作成・保存します
 *   GROUP_ID                  … Bot をグループに招待すると自動で保存されます
 *   LINE_LOGIN_CHANNEL_ID     … LINE ログインのチャネル ID（ポータルのログインに使う・必須）
 *   LINE_LOGIN_CHANNEL_SECRET … LINE ログインのチャネルシークレット（必須）
 */
/** サーバー（Apps Script）の版。tools/build-pages.js が dist/Code.gs を作るときに入れる（画面の版とくらべて、古いままなら知らせる） */
const SERVER_VERSION = '241cde6592';

const CONFIG = {
  TIMEZONE: 'Asia/Tokyo',
  CLUB_NAME: '河北SS',

  // ポータルの画面の場所（GitHub Pages）。
  // 空のときは Apps Script のウェブアプリの画面を使う
  PORTAL_URL: 'https://kahokuss.github.io/portal/',

  // カレンダーから取り込む範囲（今日から何日前〜何日先まで）
  SYNC_DAYS_BEFORE: 60,
  SYNC_DAYS_AHEAD: 180,
  // ポータルを開いたとき、前回の同期から何分たっていたらカレンダーを読み直すか
  // （ふだんは15分ごとのトリガー syncJob が裏で読み直すので、開くときは待たせない）
  SYNC_INTERVAL_MINUTES: 90,
  // 毎日カレンダーを同期する時刻
  DAILY_HOUR: 5,

  // カレンダーの予定名にこの言葉が入っていたら「大会」として扱う（ポータルで変更もできます）
  RACE_KEYWORDS: /大会|記録会|競技会|選手権|マラソン|駅伝|ロードレース|リレー/,
  // 大会を作るとき、エントリー締切を何日前に自動で入れるか
  DEADLINE_DAYS_BEFORE: 10,

  // 練習の予定をポータルで作るときの時間の候補（夏・秋〜春）
  PRACTICE_TIMES: [['17:00', '18:30'], ['18:00', '19:30']],
  // タイムテーブルで「アップ」を空にしたとき、招集の何分前を目安に出すか
  WARM_UP_MINUTES_BEFORE_CALL: 30,
  // 家族の招待番号の有効時間（時間。最大6）
  INVITE_HOURS: 6,

  // ポータルを使っている人が、まだクラブのLINEグループにいるかを何時間ごとに確かめ直すか
  MEMBER_RECHECK_HOURS: 12,

  // グループで送られたコマンドの返事を、グループに出さず、送った人にだけ1対1で返すか
  GROUP_PRIVATE_REPLY: true,

  // 休みの連絡を、役員にLINEで個別に知らせるか（1件につき役員の人数分の通数を使います）
  // （通数を節約するため、いまは止めています。役員と当番は、Botの「新着」「出欠」とポータルの出欠で確認します）
  ABSENCE_PUSH_TO_ADMINS: false,

  // ヒヤリハットが書かれたら、役員にLINEで個別に知らせるか（1件につき役員の人数分の通数を使います）
  NEAR_MISS_PUSH_TO_ADMINS: false,

  // グループに投稿された写真をすべてドライブに保存するか
  SAVE_ALL_PHOTOS: true,
  // 写真を何日前までの予定に紐づけるか（大会の翌日に写真を上げる場合など）
  PHOTO_EVENT_LOOKBACK_DAYS: 2,
  // 結果を何日前までの予定に紐づけるか
  RESULT_EVENT_LOOKBACK_DAYS: 7,
};

/** 大会の種目・持ち物・会場の候補（ポータルの入力補助に使います） */
const CHOICES = {
  RACES: ['50m', '100m', '80mH', '800m', '1000m', '走幅跳', '走高跳', 'ジャベボール投', 'リレー', '1km', '2km', '駅伝'],
  ITEMS: ['ユニフォーム', 'アスリートビブス', '弁当', '水筒', '帽子', 'レジャーシート', 'ベンチコート', 'タオル', '着替え', '雨具'],
  TARGETS: ['全員', '3年生以上', '4年生以上', '希望者'],
  ABSENCE_REASONS: ['体調不良', '家の都合', '学校行事', 'その他'],
  // 大会の手続き（チェックリスト）の種類
  TASKS: ['エントリー控え', '参加費支払い', 'プログラム', '受付', '招集', '進出', 'リレー予選', 'リレー決勝', 'レーン', 'ナンバー', 'リザルト', '陣地'],
  // だれでも報告できる手続き（会場で助け合えるように）。ほかは役員と当番だけ
  OPEN_TASKS: ['招集', '進出', 'レーン', 'ナンバー', 'リザルト', '陣地'],
  ROUNDS: ['予選', '準決勝', '決勝', 'タイムレース'],
  // 大会の申込方法と、資料の種類
  APPLY_HOW: ['Web', 'メール', 'FAX', '郵送', '持参', '当日'],
  DOC_KINDS: ['要項', '申込書', 'プログラム', '地図', 'リザルト', 'その他'],
};

function prop_(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}

function setProp_(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, value);
}

function requireProp_(key) {
  const value = prop_(key);
  if (!value) throw new Error('スクリプト プロパティ ' + key + ' が設定されていません');
  return value;
}

// ===== Decorate.gs =====
/**
 * スプレッドシートを、PCで直接さわりやすくする（setup() から呼ぶ）。
 *   ・書きかえてよい列の見出しは緑、自動で入る列は灰色。見出しにメモ
 *   ・ID などの裏方の列はかくす
 *   ・自動の列を書きかえようとすると、確認が出る（止めはしない）
 *   ・いちばん前に「使い方」シート、その次に「予定入力」シート
 */
const SHEET_GUIDE = {
  '家族': { edit: ['役員', '休み通知'], hide: ['userId', 'ポータルキー', 'グループ確認', '家族ID', '新着確認'], note: '役員には「役員」に ○。休みの連絡をLINEで受け取る人は「休み通知」に ○（受け取らないなら ×）' },
  '子ども': { edit: ['名前', '学年', '性別'], hide: ['保護者userId'], note: '4月に学年を1つ上げてください。性別は 男 か 女' },
  '予定入力': { edit: ['日付', '開始', '終了', 'タイトル', '場所', '種別', '削除'], hide: ['カレンダーID', '反映内容'], note: '1行に1つの予定。書くとすぐGoogleカレンダーとポータルに入ります' },
  '予定': { edit: [], hide: ['eventKey', 'カレンダーID'], note: 'Googleカレンダーから自動で取り込みます。直すときは「予定入力」シートかポータルで' },
  '大会': { edit: ['種別', '対象', '参加費', '締切', '集合時刻', '集合場所', '種目', '持ち物', '注意', '主催', '申込期限', '申込方法', '支払期限', '受付', '要項URL'], hide: ['eventKey', '手続き期限'], note: '大会の案内。ポータルの「案内を直す」と同じ内容です' },
  'エントリー': { edit: ['回答', '種目', '集金'], hide: ['eventKey'], note: '回答は 参加 / 不参加、集金は 済 か空欄' },
  '休み': { edit: ['理由', 'メモ', '確認'], hide: ['id', '連絡者userId'], note: '' },
  'お知らせ': { edit: ['タイトル', '本文'], hide: ['id', 'eventKey'], note: '' },
  '写真': { edit: [], hide: ['eventKey', 'userId', 'ファイルID'], note: '写真を消すときは、ポータルの「消す」で' },
  '結果': { edit: ['種目', '記録', '順位', 'ラウンド', 'メモ'], hide: ['eventKey', 'userId', 'id'], note: '' },
  'タイムテーブル': { edit: ['開始', '種目', '区分', '組', '招集', 'アップ', 'メモ'], hide: ['id', 'eventKey'], note: '' },
  '手続き': { edit: ['状態', 'メモ'], hide: ['id', 'eventKey', '写真ID'], note: '' },
  '当番': { edit: [], hide: ['eventKey'], note: '当番はポータルの「当番表」か、予定のページで決めてください' },
  'コメント': { edit: ['本文', '場所', '対策'], hide: ['id', 'eventKey', 'userId', '写真ID'], note: 'ヒヤリハットの一覧にも使えます（「種類」で絞り込み）' },
  '資料': { edit: ['種類', '名前', 'URL'], hide: ['id', 'eventKey', 'ファイルID'], note: '' },
  '履歴': { edit: [], hide: ['eventKey'], note: 'だれがいつ何をしたかの記録です' },
  '会計': { edit: ['日付', '種類', '金額', '相手', '但し書き'], hide: ['id', 'eventKey', '写真ID'], note: '' },
};

const GUIDE_ROWS = [
  ['このスプレッドシートは、ポータルとLINE Botのデータです（クラブ共用アカウントのものです）'],
  [''],
  ['■ PCで書きかえてよいところ'],
  ['・見出しが緑の列は、書きかえてOKです。灰色の列は自動で入るので、さわらないでください（さわろうとすると確認が出ます）'],
  ['・「予定入力」シート：練習や大会を1行ずつ書くと、すぐGoogleカレンダーとポータルに入ります。コピー＆貼り付けでまとめて入れられます'],
  ['　　日付：2026-10-20、10/20　　開始・終了：17:00、1700（空なら終日）　　種別：練習・大会・記録会　　削除：○ でカレンダーから消える'],
  ['・「家族」シート：役員に ○、休みの連絡を受け取る人に ○'],
  ['・「子ども」シート：名前の書き間違い、4月の学年の繰り上げ、男女'],
  [''],
  ['■ 注意'],
  ['・見出し（1行目）の名前や、列の順番は変えないでください'],
  ['・かくしてある列（ID など）は、つながりを保つためのものです。表示しても書きかえないでください'],
  ['・日付は 2026-10-20、時刻は 17:00 の形で書くと確実です'],
  ['・まちがえたら「ファイル → 変更履歴」で前の状態に戻せます'],
  ['・写真や資料のファイルは、ドライブで直接消さず、ポータルの「消す」を使ってください'],
];

function decorateSheets_() {
  const ss = ss_();
  Object.keys(SHEETS).forEach((k) => {
    const def = SHEETS[k];
    const guide = SHEET_GUIDE[def.name];
    if (!guide) return;
    try {
      decorateSheet_(sheet_(def), def, guide);
    } catch (err) {
      console.warn('シートの見た目を整えられませんでした: ' + def.name + ' ' + err);
    }
  });
  try {
    let g = ss.getSheetByName('使い方');
    if (!g) g = ss.insertSheet('使い方');
    g.getRange(1, 1, GUIDE_ROWS.length, 1).setValues(GUIDE_ROWS);
    g.getRange(1, 1).setFontWeight('bold');
    g.setColumnWidth(1, 900);
    g.setTabColor('#2f6fae');
    ss.setActiveSheet(g);
    ss.moveActiveSheet(1);
    const input = ss.getSheetByName(SHEETS.SCHEDULE_INPUT.name);
    if (input) {
      input.setTabColor('#237a55');
      ss.setActiveSheet(input);
      ss.moveActiveSheet(2);
      const col = (h) => SHEETS.SCHEDULE_INPUT.headers.indexOf(h) + 1;
      const rows = Math.max(1, input.getMaxRows() - 1);
      input.getRange(2, col('種別'), rows, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['練習', '大会', '記録会'], true).setAllowInvalid(true).build());
      input.getRange(2, col('削除'), rows, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['○'], true).setAllowInvalid(true).build());
    }
    ss.setActiveSheet(g);
  } catch (err) {
    console.warn('使い方シートを作れませんでした: ' + err);
  }
}

function decorateSheet_(sh, def, guide) {
  const n = def.headers.length;
  def.headers.forEach((h, i) => {
    const editable = guide.edit.indexOf(h) >= 0;
    const cell = sh.getRange(1, i + 1);
    cell.setBackground(editable ? '#d9ead3' : '#eeeeee');
    cell.setNote(editable ? '書きかえてOK' + (i === 0 && guide.note ? '\n' + guide.note : '') : '自動で入ります。さわらないでください' + (i === 0 && guide.note ? '\n' + guide.note : ''));
  });
  if (guide.note) sh.getRange(1, 1).setNote(guide.note);
  // 前に付けた「自動の列」の保護をはずしてから付け直す（確認が出るだけで、止めはしない）
  sh.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach((p) => {
    if (String(p.getDescription()).indexOf('自動で入る列') === 0) p.remove();
  });
  def.headers.forEach((h, i) => {
    if (guide.edit.indexOf(h) >= 0) return;
    sh.getRange(1, i + 1, sh.getMaxRows(), 1).protect().setDescription('自動で入る列：' + h).setWarningOnly(true);
  });
  sh.getRange(1, 1, 1, n).protect().setDescription('自動で入る列：見出し').setWarningOnly(true);
  guide.hide.forEach((h) => {
    const i = def.headers.indexOf(h);
    if (i >= 0) sh.hideColumns(i + 1);
  });
}

// ===== Line.gs =====
const LINE_API = 'https://api.line.me/v2/bot';
const LINE_DATA_API = 'https://api-data.line.me/v2/bot';

function lineFetch_(url, method, payload) {
  const options = {
    method: method,
    headers: { Authorization: 'Bearer ' + requireProp_('LINE_CHANNEL_ACCESS_TOKEN') },
    muteHttpExceptions: true,
  };
  if (payload) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payload);
  }
  const res = UrlFetchApp.fetch(url, options);
  const code = res.getResponseCode();
  if (code >= 300) {
    throw new Error('LINE API ' + code + ' ' + url + ': ' + res.getContentText());
  }
  return res;
}

/** 返信（無料・通数にカウントされない）。メッセージは1回5件まで */
function reply_(replyToken, messages) {
  if (!replyToken || !messages || !messages.length) return;
  lineFetch_(LINE_API + '/message/reply', 'post', { replyToken: replyToken, messages: messages.slice(0, 5) });
}

/** プッシュ（無料枠の通数にカウントされる）。5件ずつ送る */
function push_(to, messages) {
  for (let i = 0; i < messages.length; i += 5) {
    lineFetch_(LINE_API + '/message/push', 'post', { to: to, messages: messages.slice(i, i + 5) });
  }
}

function getMessageContent_(messageId) {
  return lineFetch_(LINE_DATA_API + '/message/' + messageId + '/content', 'get').getBlob();
}

/** 送信者の LINE の表示名（取れなければ空文字） */
function getDisplayName_(source) {
  try {
    let url;
    if (source.type === 'group') {
      url = LINE_API + '/group/' + source.groupId + '/member/' + source.userId;
    } else if (source.type === 'room') {
      url = LINE_API + '/room/' + source.roomId + '/member/' + source.userId;
    } else {
      url = LINE_API + '/profile/' + source.userId;
    }
    return JSON.parse(lineFetch_(url, 'get').getContentText()).displayName || '';
  } catch (err) {
    console.warn(err);
    return '';
  }
}

function text_(t) {
  return { type: 'text', text: String(t).slice(0, 5000) };
}

/**
 * 今月のメッセージ通数（無料枠）と、グループの人数。グループに送ると人数分の通数を使う。
 * 10分だけ覚えておく。取れなかった値は null
 */
function pushQuota_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('pushQuota');
  if (hit) return JSON.parse(hit);
  const get = (url) => {
    try { return JSON.parse(lineFetch_(url, 'get').getContentText()); } catch (err) { console.warn(err); return null; }
  };
  const quota = get(LINE_API + '/message/quota');
  const used = get(LINE_API + '/message/quota/consumption');
  const groupId = prop_('GROUP_ID');
  const members = groupId ? get(LINE_API + '/group/' + groupId + '/members/count') : null;
  const limit = quota && quota.type === 'limited' ? Number(quota.value) : null;
  const out = {
    limit: limit,
    used: used ? Number(used.totalUsage) : null,
    remaining: limit !== null && used ? Math.max(0, limit - Number(used.totalUsage)) : null,
    members: members ? Number(members.count) : null,
  };
  cache.put('pushQuota', JSON.stringify(out), 600);
  return out;
}

// ===== Login.gs =====
/**
 * ポータルのログイン（LINEログイン）と、LINEグループのメンバー確認。
 *
 * 流れ：
 *   1. グループに貼った共通のリンク（Webアプリの URL）を開く
 *   2. 「LINEでログイン」→ LINE の画面で許可（LINEアプリ内ならほぼ自動）
 *   3. LINE から ?code=...&state=... 付きでこの Webアプリに戻ってくる
 *   4. code を ID トークンに替えて LINE のユーザー ID を確かめ、
 *      Bot が入っているクラブのグループのメンバーかどうかを Messaging API で確認する
 *   5. メンバーなら、その人用のキーを発行してポータルを表示する
 *
 * スクリプト プロパティ：
 *   LINE_LOGIN_CHANNEL_ID / LINE_LOGIN_CHANNEL_SECRET … LINE ログインのチャネル（Messaging API と同じプロバイダーに作る）
 */
const LINE_AUTH_URL = 'https://access.line.me/oauth2/v2.1/authorize';
const LINE_TOKEN_URL = 'https://api.line.me/oauth2/v2.1/token';
const LINE_VERIFY_URL = 'https://api.line.me/oauth2/v2.1/verify';

/**
 * LINE ログイン画面への URL。state は使い捨てで10分だけ有効。
 * redirectUri はログイン後に戻る画面（GitHub Pages か、Apps Script のウェブアプリ）。
 */
function loginUrl_(redirectUri) {
  const state = randomKey_();
  CacheService.getScriptCache().put('login:' + state, redirectUri, 600);
  return LINE_AUTH_URL + '?' + buildQuery_({
    response_type: 'code',
    client_id: requireProp_('LINE_LOGIN_CHANNEL_ID'),
    redirect_uri: redirectUri,
    state: state,
    scope: 'profile openid',
  });
}

function postForm_(url, form) {
  const res = UrlFetchApp.fetch(url, { method: 'post', payload: form, muteHttpExceptions: true });
  const code = res.getResponseCode();
  const body = JSON.parse(res.getContentText() || '{}');
  if (code >= 300) throw new Error('LINEログインに失敗しました（' + code + ' ' + (body.error_description || body.error || '') + '）');
  return body;
}

/**
 * LINE ログインから戻ってきたときの処理。
 * @return {{key: string}|{error: string}}
 */
function handleLoginCallback_(code, state) {
  const cache = CacheService.getScriptCache();
  const redirectUri = state ? cache.get('login:' + state) : null;
  if (!redirectUri) return { error: 'ログインの有効期限が切れました。もう一度「LINEでログイン」を押してください。' };
  cache.remove('login:' + state);
  let profile;
  try {
    const token = postForm_(LINE_TOKEN_URL, {
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: redirectUri,
      client_id: requireProp_('LINE_LOGIN_CHANNEL_ID'),
      client_secret: requireProp_('LINE_LOGIN_CHANNEL_SECRET'),
    });
    profile = postForm_(LINE_VERIFY_URL, { id_token: token.id_token, client_id: requireProp_('LINE_LOGIN_CHANNEL_ID') });
  } catch (err) {
    console.error(err);
    return { error: 'LINEログインに失敗しました。もう一度お試しください。' };
  }
  const userId = profile.sub;
  if (!userId) return { error: 'LINEのユーザーを確認できませんでした。' };
  if (!isGroupMember_(userId)) {
    return { error: CONFIG.CLUB_NAME + 'のLINEグループのメンバーだけが見られるページです。グループに入っているLINEアカウントでログインしてください。' };
  }
  const key = portalKeyFor_(userId, profile.name || '', false);
  markMemberChecked_(userId);
  return { key: key };
}

/** Bot が入っているクラブのグループに、この人がいるか */
function isGroupMember_(userId) {
  const groupId = requireProp_('GROUP_ID');
  const res = UrlFetchApp.fetch(LINE_API + '/group/' + groupId + '/member/' + userId, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + requireProp_('LINE_CHANNEL_ACCESS_TOKEN') },
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code === 200) return true;
  if (code === 404) return false;
  throw new Error('グループのメンバー確認に失敗しました（' + code + '）');
}

function markMemberChecked_(userId) {
  withLock_(() => {
    const f = findFamily_(userId);
    if (!f) return;
    f['グループ確認'] = now_();
    updateRow_(SHEETS.FAMILIES, f);
  });
}

/**
 * ポータルを使うたびに、ときどきグループのメンバーかを確かめ直す。
 * グループを抜けた人は使えなくなる。確認に失敗したとき（LINE 側の一時的なエラー）は通す。
 */
function ensureMember_(family) {
  const last = family['グループ確認'] ? new Date(family['グループ確認'].replace(' ', 'T') + '+09:00').getTime() : 0;
  if (Date.now() - last < CONFIG.MEMBER_RECHECK_HOURS * 3600000) return;
  let member;
  try {
    member = isGroupMember_(family.userId);
  } catch (err) {
    console.warn(err);
    return;
  }
  if (!member) throw new Error(CONFIG.CLUB_NAME + 'のLINEグループのメンバーではないため、ポータルを使えません。');
  markMemberChecked_(family.userId);
}

/** グループのメンバーにだけ出す共通のリンク */
function portalUrl_() {
  return CONFIG.PORTAL_URL || ScriptApp.getService().getUrl();
}

// ---- PCでのログイン（スマホに出した番号で入る） ----

/**
 * スマホでログインしている人が、PCで使うための番号（6けた・5分・1回だけ）を出す。
 * PCで番号を入れると、その人としてログインできる（パスワードは使わない）
 */
function pcCodeAction_(ctx) {
  const cache = CacheService.getScriptCache();
  let code = '';
  for (let i = 0; i < 5 && !code; i++) {
    const c = String(100000 + (parseInt(randomKey_().slice(0, 8), 16) % 900000));
    if (!cache.get('pc:' + c)) code = c;
  }
  if (!code) throw new Error('もう一度お試しください。');
  cache.put('pc:' + code, ctx.userId, 300);
  return { code: code, minutes: 5 };
}

/** PCで番号を入れたとき。まちがいが続いたら、しばらく受け付けない（当てずっぽうを防ぐ） */
function codeLogin_(code) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('pcFails') || 0);
  if (fails >= 20) throw new Error('番号のまちがいが続いたので、10分ほど待ってからお試しください。');
  const c = toHalfWidth_(code).replace(/\D/g, '');
  const userId = c.length === 6 ? cache.get('pc:' + c) : null;
  if (!userId) {
    cache.put('pcFails', String(fails + 1), 600);
    throw new Error('番号がちがうか、期限（5分）が切れています。スマホでもう一度番号を出してください。');
  }
  cache.remove('pc:' + c);
  const f = findFamily_(userId);
  if (!f) throw new Error('ログインできませんでした。');
  ensureMember_(f);
  return { key: portalKeyFor_(userId, '', false) };
}

// ===== Main.gs =====
/**
 * ポータルの画面を返す。
 * LINE ログインから戻ってきたとき（?code=）は、グループのメンバーか確かめてからキーを渡す。
 * それ以外は、ブラウザに保存したキーで開くか、ログインボタンを出す。
 */
function doGet(e) {
  resetMemo_();
  const p = (e && e.parameter) || {};
  let key = '';
  let error = '';
  if (p.code) {
    const r = handleLoginCallback_(p.code, p.state);
    key = r.key || '';
    error = r.error || '';
  } else if (p.error) {
    error = 'LINEログインがキャンセルされました。';
  }
  const t = HtmlService.createTemplateFromFile('Portal');
  t.key = key;
  t.error = error;
  t.login = loginUrl_(ScriptApp.getService().getUrl());
  t.apiUrl = '';
  t.build = '';
  t.server = '';
  t.home = ScriptApp.getService().getUrl();
  t.club = CONFIG.CLUB_NAME;
  return t.evaluate()
    .setTitle(CONFIG.CLUB_NAME + ' ポータル')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

/**
 * POST を受け取る。
 *   ?token=… 付き … LINE からの Webhook。Apps Script ではリクエストヘッダー（署名）を読めないため、
 *                    Webhook URL に付けた token が一致するリクエストだけを処理する
 *   token なし   … GitHub Pages のポータル画面からの操作（apiPost_）
 */
function doPost(e) {
  resetMemo_();
  const p = (e && e.parameter) || {};
  if (p.token === undefined) return apiPost_(e);
  if (p.token !== prop_('WEBHOOK_TOKEN')) return ok_();
  const body = JSON.parse(e.postData.contents);
  (body.events || []).forEach((ev) => {
    try {
      if (isDuplicate_(ev)) return;
      handleEvent_(ev);
    } catch (err) {
      console.error(err && err.stack ? err.stack : err);
    }
  });
  return ok_();
}

function ok_() {
  return ContentService.createTextOutput('OK');
}

/**
 * GitHub Pages のポータル画面からの操作。本文は {action, key, payload} の JSON。
 * 返事は {ok: …} か {error: '…'}。
 */
function apiPost_(e) {
  let out;
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (body.action === 'loginUrl') {
      out = { ok: { url: loginUrl_(portalUrl_()) } };
    } else if (body.action === 'login') {
      const r = handleLoginCallback_(String((body.payload || {}).code || ''), String((body.payload || {}).state || ''));
      out = r.key ? { ok: { key: r.key } } : { error: r.error };
    } else if (body.action === 'codeLogin') {
      out = { ok: codeLogin_(String((body.payload || {}).code || '')) };
    } else {
      out = { ok: api(body.key, body.action, body.payload) };
    }
  } catch (err) {
    out = { error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/** LINE の再送で同じイベントを二重に処理しないようにする */
function isDuplicate_(ev) {
  if (!ev.webhookEventId) return false;
  const cache = CacheService.getScriptCache();
  if (cache.get(ev.webhookEventId)) return true;
  cache.put(ev.webhookEventId, '1', 3600);
  return false;
}

function handleEvent_(ev) {
  const source = ev.source || {};

  if (ev.type === 'join') {
    if (source.type === 'group') {
      if (!prop_('GROUP_ID')) setProp_('GROUP_ID', source.groupId);
      // グループには短いあいさつだけ（使い方は1対1のトークで）
      reply_(ev.replyToken, [text_('招待ありがとうございます！' + CONFIG.CLUB_NAME + 'のBotです。\n使い方は、Botを友だち追加して、1対1のトークで「ヘルプ」と送ってください。')]);
    }
    return;
  }
  if (ev.type === 'follow') {
    reply_(ev.replyToken, [text_('友だち追加ありがとうございます！\n\n' + helpText_())]);
    return;
  }

  // 登録済みのグループ以外のグループからは反応しない（1対1のトークはOK）
  const groupId = prop_('GROUP_ID');
  if (source.type === 'group' && groupId && source.groupId !== groupId) return;
  if (source.type === 'room') return;
  if (!source.userId) return;

  if (ev.type === 'message' && ev.message.type === 'text') return handleText_(ev);
  if (ev.type === 'message' && ev.message.type === 'image' && source.type === 'group') return handleImage_(ev);
}

/** 毎日トリガーで実行：カレンダーの予定を取り込む */
/** 15分ごとのトリガー：Googleカレンダーと予定入力シートを読み直す（ポータルを開くときに待たせないため） */
function syncJob() {
  resetMemo_();
  importScheduleSafely_();
  syncCalendar_();
}

function dailyJob() {
  resetMemo_();
  importScheduleSafely_();
  syncCalendar_();
}

/**
 * Webアプリからは google.script.run で公開関数を呼べてしまうので、
 * 管理用の関数はスクリプトの持ち主（クラブ共用アカウント）がエディタから実行したときだけ動かす。
 */
function requireOwner_() {
  const active = Session.getActiveUser().getEmail();
  if (!active || active !== Session.getEffectiveUser().getEmail()) {
    throw new Error('この関数は、スクリプトの持ち主がエディタから実行してください');
  }
}

/**
 * 最初に1回だけ手動で実行する。
 * スプレッドシート・写真フォルダ・Webhook 用トークン・毎日のトリガーを用意する。
 */
function setup() {
  requireOwner_();
  requireProp_('LINE_CHANNEL_ACCESS_TOKEN');
  requireProp_('CALENDAR_ID');

  if (!prop_('SPREADSHEET_ID')) {
    setProp_('SPREADSHEET_ID', SpreadsheetApp.create(CONFIG.CLUB_NAME + ' ポータル データ').getId());
  }
  Object.keys(SHEETS).forEach((k) => sheet_(SHEETS[k]));
  const defaultSheet = ss_().getSheetByName('シート1') || ss_().getSheetByName('Sheet1');
  if (defaultSheet && ss_().getSheets().length > 1) ss_().deleteSheet(defaultSheet);
  decorateSheets_();

  if (!prop_('PHOTO_FOLDER_ID')) {
    setProp_('PHOTO_FOLDER_ID', DriveApp.createFolder(CONFIG.CLUB_NAME + ' 写真').getId());
  }
  if (!prop_('WEBHOOK_TOKEN')) {
    setProp_('WEBHOOK_TOKEN', Utilities.getUuid().replace(/-/g, ''));
  }

  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'dailyJob')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('dailyJob').timeBased().everyDays(1).atHour(CONFIG.DAILY_HOUR).create();
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'syncJob')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncJob').timeBased().everyMinutes(15).create();

  // スプレッドシートの「予定入力」シートを書きかえたら、すぐカレンダーに入れる
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'onScheduleSheetEdit')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('onScheduleSheetEdit').forSpreadsheet(ss_()).onEdit().create();

  syncCalendar_();

  console.log('スプレッドシート: ' + ss_().getUrl());
  console.log('写真フォルダ: ' + photoFolderUrl_());
  console.log('Webhook URL: <ウェブアプリのURL>?token=' + prop_('WEBHOOK_TOKEN'));
}

/** 動作確認用：カレンダーをすぐ同期する */
function syncNow() {
  syncCalendar_();
  console.log('同期しました');
}

// ===== Notice.gs =====
/**
 * グループに流れた「練習の変更の連絡」を拾って、その日の練習に結びつけて残す（Botは返事をしない）。
 *   例：「次の木曜日の練習について連絡です。16時50分から競技場で練習します」
 *       「明日の練習は雨のため中止です」
 * ポータルの練習のページとBotの「今日」「予定」「新着」に出し、役員がボタン1つで予定（カレンダー）に反映できる。
 * カレンダーを勝手には書きかえない。
 */

const WEEKDAY_CHARS = '日月火水木金土';

/**
 * 変更の連絡かどうかを読み取る。ちがえば null
 * @return {{date: string, start: string, end: string, place: string, cancel: boolean}|null}
 */
function parseScheduleNotice_(text, today) {
  const t = toHalfWidth_(text || '').replace(/\s+/g, ' ');
  if (!/練習|れんしゅう/.test(t)) return null;
  const date = noticeDate_(t, today);
  if (!date) return null;
  const cancel = /中止|練習(?:は|も)?(?:なし|ありません|お休み(?:です|にします|になります))/.test(t);
  const times = [];
  const re = /(\d{1,2})(?:時(?:(\d{1,2})分|半)?|:(\d{2}))/g;
  let m;
  while ((m = re.exec(t))) {
    let h = +m[1];
    const mi = m[2] ? +m[2] : m[3] ? +m[3] : /半/.test(m[0]) ? 30 : 0;
    if (h < 9) h += 12; // 「5時から」は夕方
    if (h <= 23 && mi <= 59) times.push(('0' + h).slice(-2) + ':' + ('0' + mi).slice(-2));
  }
  const pm = t.match(/(?:場所[はは:：]?\s*)([^\s、。]{2,15})/) || t.match(/([^\s、。]{2,15}?)(?:で|にて)(?:の)?(?:練習|集合|行い|やり|実施|します)/) || t.match(/([^\s、。]{2,15}?)に(?:集合|変更)/);
  let place = pm ? pm[1].replace(/^.*(?:から|は|、)/, '').replace(/^(?:の|で)/, '') : '';
  if (/^(?:今日|明日|次|練習|こちら|現地|いつも)/.test(place) || /\d/.test(place)) place = '';
  if (!cancel && !times.length && !place) return null;
  // 終わりの時刻は「16時〜18時」「16時から18時まで」のように幅で書かれたときだけ（「15時30分頃に連絡」などは使わない）
  const T = '(\\d{1,2})(?:時(?:(\\d{1,2})分|半)?|:(\\d{2}))';
  const rg = t.match(new RegExp(T + '\\s*(?:〜|~|-|－|ー|から)\\s*' + T + '(?:まで)?'));
  let end = '';
  if (rg && times.length >= 2) {
    const hm = (h, a, b, half) => { let x = +h; if (x < 9) x += 12; return ('0' + x).slice(-2) + ':' + ('0' + (a ? +a : b ? +b : half ? 30 : 0)).slice(-2); };
    const s0 = hm(rg[1], rg[2], rg[3], /^\d{1,2}時半/.test(rg[0])), e0 = hm(rg[4], rg[5], rg[6], /半(?:まで)?$/.test(rg[0]));
    if (s0 === times[0] && e0 > s0) end = e0;
  }
  return { date: date, start: cancel ? '' : times[0] || '', end: cancel ? '' : end, place: cancel ? '' : place, cancel: cancel };
}

/** 「今日」「明日」「あさって」「次の木曜日」「木曜」「10/23」「10月23日」「23日」を日付にする */
function noticeDate_(t, today) {
  if (/今日|本日/.test(t)) return today;
  if (/明日|あした/.test(t)) return addDays_(today, 1);
  if (/あさって|明後日/.test(t)) return addDays_(today, 2);
  let m = t.match(/(\d{1,2})[\/月](\d{1,2})日?/);
  if (m) return parseDateCell_(m[1] + '/' + m[2]);
  m = t.match(/(次の|来週の?|今週の?)?([日月火水木金土])曜/);
  if (m) {
    const want = WEEKDAY_CHARS.indexOf(m[2]);
    const now = new Date(today + 'T00:00:00Z').getUTCDay();
    if (/来週/.test(m[1] || '')) {
      const toMonday = (8 - now) % 7 || 7;
      return addDays_(today, toMonday + (want + 6) % 7);
    }
    let n = (want - now + 7) % 7;
    if (n === 0 && m[1]) n = 7;
    return addDays_(today, n);
  }
  m = t.match(/(\d{1,2})日(?:\(.\)|（.）)?の/);
  if (m) {
    const d = +m[1];
    let mo = +today.slice(5, 7);
    if (d < +today.slice(8, 10)) mo = mo % 12 + 1;
    return parseDateCell_(mo + '/' + d);
  }
  return '';
}

/** グループのメッセージが練習の変更の連絡なら、「コメント」シートに「変更連絡」として残す */
function recordScheduleNotice_(ev) {
  const text = String(ev.message.text || '');
  const today = fmt_(new Date(ev.timestamp), 'yyyy-MM-dd');
  const p = parseScheduleNotice_(text, today);
  if (!p) return false;
  const target = readRows_(SHEETS.EVENTS).find((e) => e['日付'] === p.date && e['状態'] !== '中止' && (e['種別'] || guessType_(e['タイトル'])) === '練習');
  withLock_(() => {
    appendRow_(SHEETS.COMMENTS, {
      id: randomKey_().slice(0, 10), eventKey: target ? target.eventKey : '', '種類': '変更連絡', '本文': text.slice(0, 1000), '場所': p.place,
      '公開': '全員', '写真ID': '', userId: ev.source.userId, '表示名': getDisplayName_(ev.source), '日時': now_(), '提案': JSON.stringify(p),
    });
  });
  return true;
}

/** 変更連絡の内容で、予定（カレンダー）を直す・中止にする・ない日なら練習をつくる（役員） */
function applyNoticeAction_(ctx, p) {
  const row = readRows_(SHEETS.COMMENTS).find((x) => x.id && x.id === p.id && x['種類'] === '変更連絡');
  if (!row) throw new Error('変更連絡が見つかりません。');
  let s;
  try { s = JSON.parse(row['提案'] || '{}'); } catch (err) { s = {}; }
  if (p.start !== undefined) s.start = parseTimeCell_(p.start) || '';
  if (p.end !== undefined) s.end = parseTimeCell_(p.end) || '';
  if (p.place !== undefined) s.place = String(p.place || '').trim().slice(0, 80);
  const ev = row.eventKey ? findEvent_(row.eventKey) : null;
  let msg;
  if (s.cancel) {
    if (!ev) throw new Error('この日の練習は、もともと予定に入っていません。');
    msg = cancelEventAction_(ctx, { key: ev.eventKey });
  } else if (ev) {
    const len = ev['開始'] && ev['終了'] && ev['開始'] !== '終日' ? toMin_(ev['終了']) - toMin_(ev['開始']) : 90;
    const start = s.start || (ev['開始'] === '終日' ? '' : ev['開始']);
    const end = s.end || (s.start ? minToHm_(toMin_(s.start) + len) : ev['終了']);
    msg = editEventAction_(ctx, { key: ev.eventKey, date: ev['日付'], start: start, end: end, title: ev['タイトル'], place: s.place || ev['場所'] });
  } else {
    if (!s.start) throw new Error('時刻が分からないので、ポータルの「練習の予定をつくる」から入れてください。');
    msg = savePracticesAction_(ctx, { dates: [s.date], start: s.start, end: s.end || minToHm_(toMin_(s.start) + 90), title: '練習', place: s.place });
  }
  withLock_(() => {
    const r = readRows_(SHEETS.COMMENTS).find((x) => x.id === p.id);
    if (!r) return;
    if (!r.eventKey) {
      const made = readRows_(SHEETS.EVENTS).find((e) => e['日付'] === s.date && e['状態'] !== '中止');
      if (made) r.eventKey = made.eventKey;
    }
    r['対策'] = '予定に反映しました';
    r['対策者'] = ctx.name;
    r['対策日時'] = now_();
    updateRow_(SHEETS.COMMENTS, r);
  });
  return msg;
}

function minToHm_(n) {
  return ('0' + Math.floor(n / 60)).slice(-2) + ':' + ('0' + (n % 60)).slice(-2);
}

// ---- 大会の陣地（場所取り・集合場所） ----

const JINCHI_PATTERN = /場所(?:を)?(?:取|と)り|場所取り|陣地/;

/** その日の大会（練習でない予定） */
function raceOn_(date) {
  const races = {};
  readRows_(SHEETS.RACES).forEach((r) => (races[r.eventKey] = true));
  return readRows_(SHEETS.EVENTS).find((e) => e['日付'] === date && e['状態'] !== '中止' && (races[e.eventKey] || (e['種別'] || guessType_(e['タイトル'])) !== '練習')) || null;
}

/** 大会の日に「本部の右側の階段に場所を取りました」などと送られたら、陣地として残す */
function recordJinchi_(ev) {
  const text = String(ev.message.text || '');
  if (!JINCHI_PATTERN.test(text)) return false;
  const race = raceOn_(fmt_(new Date(ev.timestamp), 'yyyy-MM-dd'));
  if (!race) return false;
  const ctx = { name: getDisplayName_(ev.source) || '保護者' };
  upsertTask_(ctx, race.eventKey, '陣地', '', (t) => { t['メモ'] = text.slice(0, 300); t['状態'] = '済'; });
  logHistory_(race.eventKey, ctx, '陣地：' + text.slice(0, 40));
  return true;
}

/** 陣地を書いた人が、そのあと20分以内にグループに送った写真は、陣地の写真にする */
function attachJinchiPhoto_(displayName, fileId, posted) {
  if (!displayName || !fileId) return;
  const date = fmt_(posted, 'yyyy-MM-dd');
  const t = readRows_(SHEETS.TASKS).find((x) => x.id && x['種類'] === '陣地' && x['更新者'] === displayName && String(x['日時']).slice(0, 10) === date &&
    Math.abs(posted.getTime() - new Date(String(x['日時']).replace(' ', 'T') + '+09:00').getTime()) <= 20 * 60000);
  if (!t) return;
  withLock_(() => {
    const row = readRows_(SHEETS.TASKS).find((x) => x.id === t.id);
    row['写真ID'] = splitNames_(row['写真ID']).concat([fileId]).join(',');
    updateRow_(SHEETS.TASKS, row);
  });
}

// ===== Photos.gs =====
const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };

function photoRoot_() {
  return DriveApp.getFolderById(requireProp_('PHOTO_FOLDER_ID'));
}

function subfolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

/** フォルダ名に使えない文字を除く */
function safeName_(s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, '_').trim();
}

/**
 * グループに投稿された写真をドライブに保存する。
 * 直近の予定（大会・練習）ごとのフォルダに分け、なければ日付のフォルダに入れる。
 */
function handleImage_(ev) {
  if (!CONFIG.SAVE_ALL_PHOTOS) return;
  // 外部 URL の画像（LINE 以外の配信元）は対象外
  if (ev.message.contentProvider && ev.message.contentProvider.type !== 'line') return;

  const posted = new Date(ev.timestamp);
  const date = fmt_(posted, 'yyyy-MM-dd');
  const event = recentEvent_(date, CONFIG.PHOTO_EVENT_LOOKBACK_DAYS);
  const folderName = event ? event['日付'] + ' ' + safeName_(event['タイトル']) : date;
  const folder = subfolder_(photoRoot_(), folderName);

  const displayName = getDisplayName_(ev.source);
  const blob = getMessageContent_(ev.message.id);
  const ext = EXTENSIONS[blob.getContentType()] || 'jpg';
  const fileName = fmt_(posted, 'yyyyMMdd_HHmmss') + '_' + (safeName_(displayName) || 'photo') + '_' + ev.message.id + '.' + ext;
  const file = folder.createFile(blob.setName(fileName));

  appendRow_(SHEETS.PHOTOS, {
    '日時': fmt_(posted, 'yyyy-MM-dd HH:mm:ss'),
    eventKey: event ? event.eventKey : '',
    '予定': event ? event['タイトル'] : '',
    userId: ev.source.userId,
    '表示名': displayName,
    'ファイル名': fileName,
    URL: file.getUrl(),
    'ファイルID': file.getId(),
    '種類': 'LINE',
  });
  attachJinchiPhoto_(displayName, file.getId(), posted);
}

/** 写真フォルダのURL（ドライブに問い合わせず、IDから作る） */
function photoFolderUrl_() {
  return 'https://drive.google.com/drive/folders/' + requireProp_('PHOTO_FOLDER_ID');
}

// ===== Portal.gs =====
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
    .map((n) => ({ id: n.id, date: n['日付'], title: n['タイトル'], body: n['本文'], key: n.eventKey, by: n['作成者'] }));

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

// ===== PortalMore.gs =====
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
    if (!p.on && rows.filter((x) => isAdmin_(x) && x.userId !== f.userId).length === 0) throw new Error('役員が1人もいなくなるので、外せません。先にほかの人を役員にしてください。');
    f['役員'] = p.on ? '○' : '';
    f['更新日時'] = now_();
    updateRow_(SHEETS.FAMILIES, f);
  });
  return (p.on ? '役員にしました' : '役員から外しました');
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
  (p.rows || []).slice(0, 300).forEach((r, i) => {
    const child = String(r.child || '').trim();
    const race = String(r.race || '').trim().slice(0, 30);
    const record = toHalfWidth_(r.record || '').trim().replace(/\s/g, '').slice(0, 20);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(r.date || '') ? r.date : today_();
    if (!kids[child]) return ng.push((i + 1) + '行目：「' + child + '」というお子さんが登録されていません');
    if (!race || !record) return ng.push((i + 1) + '行目：種目と記録を入れてください');
    ok.push({
      '日時': now_(), eventKey: '', '大会・練習': date + ' ' + String(r.meet || '過去の記録').trim().slice(0, 60), '子ども': child, '種目': race, '記録': record,
      '順位': String(r.place || '').replace(/[^0-9]/g, '').slice(0, 3), 'ラウンド': CHOICES.ROUNDS.indexOf(r.round) >= 0 ? r.round : '',
      '区分': (r.kind || p.kind) === '練習' ? '練習' : '公式',
      'メモ': String(r.memo || '').slice(0, 100), userId: ctx.userId, '表示名': ctx.name, id: randomKey_().slice(0, 10),
    });
  });
  if (!ok.length) throw new Error(ng.join('\n') || '入れる記録がありません。');
  withLock_(() => ok.forEach((row) => appendRow_(SHEETS.RESULTS, row)));
  return ok.length + '件の記録を入れました' + (ng.length ? '（入れられなかったもの：' + ng.join('／') + '）' : '');
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
  logHistory_(p.key, ctx, 'タイムテーブルの表を保存（' + rows.length + '種目・エントリー ' + changed + '人を更新）');
  return 'タイムテーブルを保存しました（' + rows.length + '件・エントリー ' + changed + '人を更新）';
}

// ===== Results.gs =====
/**
 * 「結果」コマンドの引数を解析する。
 *   結果 100m 15.2秒           … 登録している子どもが1人ならその子の記録
 *   結果 たろう 100m 15.2秒    … 子どもの名前を指定
 *   結果 たろう 走り幅跳び 3m20 自己ベスト！ … 3つめ以降はメモ
 * @return {{child: string, item: string, record: string, note: string}|{error: string}}
 */
function parseResultArgs_(args, myChildren) {
  const tokens = splitResultTokens_(args);
  let child = '';
  if (tokens.length && myChildren.indexOf(tokens[0]) >= 0) {
    child = tokens.shift();
  } else if (myChildren.length === 1) {
    child = myChildren[0];
  } else if (myChildren.length === 0) {
    return { error: 'お子さんの名前が未登録です。先に「登録 山田たろう 3年」のように送ってください。' };
  } else {
    return { error: '誰の記録か分かるように、名前から書いてください。\n例：結果 ' + myChildren[0] + ' 100m 15.2秒' };
  }
  if (tokens.length < 2) {
    return { error: '種目と記録を書いてください。\n例：結果 100m 15.2秒' };
  }
  return {
    child: child,
    item: toHalfWidth_(tokens[0]),
    record: toHalfWidth_(tokens[1]),
    note: tokens.slice(2).join(' '),
  };
}

function splitResultTokens_(args) {
  return String(args || '')
    .replace(/　/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function handleResultCommand_(ev, args) {
  const userId = ev.source.userId;
  const parsed = parseResultArgs_(args, childrenOf_(userId).map((c) => c.name));
  if (parsed.error) return respond_(ev, [text_(parsed.error)]);

  const event = recentEvent_(today_(), CONFIG.RESULT_EVENT_LOOKBACK_DAYS);
  appendRow_(SHEETS.RESULTS, {
    '日時': now_(),
    eventKey: event ? event.eventKey : '',
    '大会・練習': event ? event['日付'] + ' ' + event['タイトル'] : '',
    '子ども': parsed.child,
    '種目': parsed.item,
    '記録': parsed.record,
    'メモ': parsed.note,
    userId: userId,
    '表示名': getDisplayName_(ev.source),
    id: randomKey_().slice(0, 10),
    '区分': event && dutyType_(event) === '大会' ? '公式' : '練習',
  });

  let msg = '🏃 記録しました：' + parsed.child + ' ' + parsed.item + ' ' + parsed.record;
  if (event) msg += '\n（' + formatDate_(event['日付']) + ' ' + event['タイトル'] + '）';
  respond_(ev, [text_(msg)]);
}

/** 子どもごとの記録一覧（新しい順に10件） */
function buildRecordsText_(child, results) {
  const mine = results.filter((r) => r['子ども'] === child).reverse().slice(0, 10);
  if (!mine.length) return child + 'さんの記録はまだありません。';
  const lines = ['🏅 ' + child + 'さんの記録'];
  mine.forEach((r) => {
    const when = r['大会・練習'] || r['日時'].slice(0, 10);
    lines.push('・' + r['種目'] + ' ' + r['記録'] + '（' + when + '）' + (r['メモ'] ? ' ' + r['メモ'] : ''));
  });
  return lines.join('\n');
}

function handleRecordsCommand_(ev, args) {
  const names = splitNames_(args);
  const targets = names.length ? names : childrenOf_(ev.source.userId).map((c) => c.name);
  if (!targets.length) {
    return respond_(ev, [text_('「記録 山田たろう」のように名前を書くか、先にお子さんを登録してください。')]);
  }
  const results = readRows_(SHEETS.RESULTS);
  respond_(ev, targets.slice(0, 5).map((c) => text_(buildRecordsText_(c, results))));
}

// ===== Schedule.gs =====
/**
 * スプレッドシートの「予定入力」シートに書いた予定を、Googleカレンダーに入れる。
 * PCでまとめて入れたいとき用。1行が1つの予定。
 *
 *   日付     … 2026-10-20 / 2026/10/20 / 10/20 / 10月20日（年を省くと近い日付）
 *   開始・終了 … 18:00 / 1800 / 18時30分。空なら終日の予定
 *   タイトル  … 例：練習、秋季記録会
 *   場所     … なくてもOK
 *   種別     … 練習 / 大会 / 記録会（空ならタイトルから判断）
 *   削除     … ○ を入れると、カレンダーから消す
 *   状態・カレンダーID・反映内容 … 自動で入ります。さわらないでください
 *
 * 書いたらすぐ（編集のたびに）反映されます。ポータルを開いたときや毎朝の同期でも反映します。
 */

/** 予定入力シートの1行を読み取る。読み取れなければ {error} */
function parseScheduleRow_(row) {
  const date = parseDateCell_(row['日付']);
  if (!date) return { error: '日付が読めません（例：2026-10-20、10/20）' };
  const title = String(row['タイトル'] || '').trim().slice(0, 80);
  if (!title) return { error: 'タイトルを入れてください' };
  const start = parseTimeCell_(row['開始']);
  const end = parseTimeCell_(row['終了']);
  if (start === null || end === null) return { error: '時刻が読めません（例：18:00、1800）' };
  if (!start && end) return { error: '開始の時刻も入れてください' };
  if (start && end && end < start) return { error: '終了が開始より前になっています' };
  const typeText = String(row['種別'] || '').trim();
  const type = typeText ? (/練習/.test(typeText) ? '練習' : /記録会/.test(typeText) ? '記録会' : '大会') : '';
  return { date: date, start: start, end: start ? end || start : '', title: title, place: String(row['場所'] || '').trim().slice(0, 80), type: type };
}

/** 年を省いた日付は、今日の2か月前から10か月後までに入る年にする */
function parseDateCell_(v) {
  const s = toHalfWidth_(v).trim().replace(/\(.\)|（.）/g, '');
  let m = s.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/);
  let y, mo, d;
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if ((m = s.match(/^(\d{1,2})[/.月](\d{1,2})日?$/))) {
    mo = +m[1]; d = +m[2];
    const today = today_();
    y = +today.slice(0, 4);
    const pad = (n) => ('0' + n).slice(-2);
    if (y + '-' + pad(mo) + '-' + pad(d) < addDays_(today, -61)) y += 1;
  } else return '';
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return '';
  return dt.toISOString().slice(0, 10);
}

/** '18:00' '1800' '18時30分' '6:00pm' → '18:00'。空なら ''、読めなければ null */
function parseTimeCell_(v) {
  let s = toHalfWidth_(v).trim().replace(/\s/g, '');
  if (!s || s === '終日') return '';
  const pm = /pm|午後/i.test(s);
  s = s.replace(/am|pm|午前|午後/gi, '');
  const m = s.match(/^(\d{1,2})(?:[:：時.]?(\d{2}))?分?$/) || s.match(/^(\d{1,2})時半$/);
  if (!m) return null;
  let h = +m[1];
  const mi = /半$/.test(s) ? 30 : +(m[2] || 0);
  if (pm && h < 12) h += 12;
  if (h > 23 || mi > 59) return null;
  return ('0' + h).slice(-2) + ':' + ('0' + mi).slice(-2);
}

/** 予定入力シートをカレンダーに反映する。反映した件数を返す */
function importScheduleSheet_() {
  return withLock_(() => {
    let count = 0;
    let cal = null;
    readRows_(SHEETS.SCHEDULE_INPUT).forEach((row) => {
      const del = /^(○|◯|〇|o|x|×|削除|1|true)$/i.test(String(row['削除']).trim());
      if (del) {
        if (!row['カレンダーID'] && row['状態'] === '削除しました') return;
        cal = cal || calendar_();
        const ce = row['カレンダーID'] ? cal.getEventById(row['カレンダーID']) : null;
        if (ce) ce.deleteEvent();
        Object.assign(row, { '状態': '削除しました', 'カレンダーID': '', '反映内容': '' });
        updateRow_(SHEETS.SCHEDULE_INPUT, row);
        count++;
        return;
      }
      if (!row['日付'] && !row['タイトル']) return;
      const o = parseScheduleRow_(row);
      if (o.error) {
        if (row['状態'] !== '⚠ ' + o.error) { row['状態'] = '⚠ ' + o.error; updateRow_(SHEETS.SCHEDULE_INPUT, row); }
        return;
      }
      const sig = [o.date, o.start, o.end, o.title, o.place, o.type].join('|');
      if (row['カレンダーID'] && row['反映内容'] === sig) return;
      cal = cal || calendar_();
      let ce = row['カレンダーID'] ? cal.getEventById(row['カレンダーID']) : null;
      if (row['カレンダーID'] && !ce) {
        // ポータルやカレンダーで消した予定は、作り直さずに「削除」にする
        Object.assign(row, { '削除': '○', '状態': 'カレンダーで消されていたので、削除にしました', 'カレンダーID': '', '反映内容': '' });
        updateRow_(SHEETS.SCHEDULE_INPUT, row);
        return;
      }
      if (ce && ce.isRecurringEvent()) ce = null;
      if (ce) updateCalEvent_(ce, o);
      else ce = createCalEvent_(o);
      upsertEventRow_(ce, o.type);
      Object.assign(row, {
        '日付': o.date, '開始': o.start, '終了': o.end, 'タイトル': o.title, '場所': o.place,
        '状態': '✅ カレンダーに入れました（' + fmt_(new Date(), 'M/d H:mm') + '）', 'カレンダーID': ce.getId(), '反映内容': sig,
      });
      updateRow_(SHEETS.SCHEDULE_INPUT, row);
      count++;
    });
    return count;
  });
}

/** 予定入力シートを編集したとき（setup() で作るトリガーから呼ばれる） */
function onScheduleSheetEdit(e) {
  resetMemo_();
  try {
    const sh = e && e.range && e.range.getSheet();
    // スプレッドシートを手で直したら、ポータルが覚えている表を捨てる
    if (sh) invalidateTable_(sh.getName());
    if (sh && sh.getName() !== SHEETS.SCHEDULE_INPUT.name) return;
    importScheduleSheet_();
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
  }
}

// ===== Sheet.gs =====
/**
 * スプレッドシートを簡易データベースとして使う。
 * どのシートも1行目が見出しで、2行目以降がデータ。値はすべて文字列で保存する。
 */
const SHEETS = {
  FAMILIES: { name: '家族', headers: ['userId', '表示名', 'ポータルキー', '役員', '更新日時', 'グループ確認', '家族ID', '休み通知', '新着確認'] },
  CHILDREN: { name: '子ども', headers: ['名前', '学年', '保護者userId', '更新日時', '性別'] },
  EVENTS: { name: '予定', headers: ['eventKey', '日付', '開始', '終了', 'タイトル', '場所', 'カレンダーID', '種別', '状態', '更新日時', 'ダウン'] },
  RACES: { name: '大会', headers: ['eventKey', '種別', '対象', '参加費', '締切', '集合時刻', '集合場所', '種目', '持ち物', '注意', '更新日時', '主催', '申込期限', '申込方法', '支払期限', '受付', '要項URL', '手続き期限'] },
  ENTRIES: { name: 'エントリー', headers: ['eventKey', '子ども', '回答', '種目', '集金', '更新者', '更新日時'] },
  ABSENCES: { name: '休み', headers: ['id', '日付', '子ども', '理由', 'メモ', '連絡者userId', '連絡者', '確認', '確認者', '日時'] },
  NOTICES: { name: 'お知らせ', headers: ['id', '日付', 'タイトル', '本文', 'eventKey', '作成者', '日時'] },
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

function isAdmin_(family) {
  return !!family && /^(○|◯|〇|o|yes|true|1|役員)$/i.test(String(family['役員']).trim());
}

/** 家族のまとまり（夫婦など）。まとめていない人は userId がそのまま家族ID */
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

function activeChildren_() {
  return readRows_(SHEETS.CHILDREN)
    .filter((c) => c['名前'] && splitNames_(c['保護者userId']).length)
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
 * 同じ名前の子がすでにいれば保護者として追加する（両親とも登録できる）。
 * @param {{name: string, grade: number}[]} list
 */
function saveChildren_(userId, list) {
  withLock_(() => {
    // 家族をまとめていれば、夫婦のどちらが直しても両方の子どもとして登録される
    const members = familyMembers_(userId);
    const rows = readRows_(SHEETS.CHILDREN);
    const names = list.map((c) => c.name);
    rows.forEach((row) => {
      const parents = splitNames_(row['保護者userId']);
      const keep = names.indexOf(row['名前']) >= 0;
      const rest = parents.filter((u) => members.indexOf(u) < 0);
      if (!keep && rest.length !== parents.length) {
        row['保護者userId'] = rest.join(',');
        row['更新日時'] = now_();
        updateRow_(SHEETS.CHILDREN, row);
      }
    });
    list.forEach((c) => {
      const row = rows.find((r) => r['名前'] === c.name);
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

// ===== Util.gs =====
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

function fmt_(date, pattern) {
  return Utilities.formatDate(date, CONFIG.TIMEZONE, pattern);
}

function today_() {
  return fmt_(new Date(), 'yyyy-MM-dd');
}

function now_() {
  return fmt_(new Date(), 'yyyy-MM-dd HH:mm:ss');
}

/** 'yyyy-MM-dd' の日付文字列に n 日足す */
function addDays_(dateStr, n) {
  const p = dateStr.split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
  return d.toISOString().slice(0, 10);
}

/** '2026-10-18' → '10/18(日)' */
function formatDate_(dateStr) {
  const p = dateStr.split('-').map(Number);
  const wd = WEEKDAYS[new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay()];
  return p[1] + '/' + p[2] + '(' + wd + ')';
}

/** 予定の日時を「10/18(日) 9:00〜12:00」の形にする */
function formatWhen_(ev) {
  let s = formatDate_(ev['日付']);
  if (ev['開始'] && ev['開始'] !== '終日') {
    s += ' ' + ev['開始'].replace(/^0/, '');
    if (ev['終了']) s += '〜' + ev['終了'].replace(/^0/, '');
  }
  return s;
}

/** 全角英数字・記号・スペースを半角にする */
function toHalfWidth_(s) {
  return String(s)
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ');
}

/** 「太郎 花子」「太郎、花子」などを名前の配列にする */
function splitNames_(s) {
  return String(s || '')
    .split(/[\s,、，・]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** 'a=att&e=xxx&s=yes' → { a: 'att', e: 'xxx', s: 'yes' } */
function parseQuery_(data) {
  const out = {};
  String(data || '').split('&').forEach((pair) => {
    if (!pair) return;
    const i = pair.indexOf('=');
    const k = i < 0 ? pair : pair.slice(0, i);
    const v = i < 0 ? '' : pair.slice(i + 1);
    out[decodeURIComponent(k)] = decodeURIComponent(v);
  });
  return out;
}

function buildQuery_(obj) {
  return Object.keys(obj)
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]))
    .join('&');
}

function md5Hex_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s, Utilities.Charset.UTF_8)
    .map((b) => ('0' + (b & 0xff).toString(16)).slice(-2))
    .join('');
}

/** ポータルの個人リンク用のキー（英数字32文字） */
function randomKey_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').slice(0, 32);
}

/**
 * 「たろう 3年 はなこ 1年」「たろう3年、はなこ」などを子どもの一覧にする。学年は省略できる。
 * @return {{name: string, grade: number}[]}
 */
function parseChildrenArgs_(s) {
  const out = [];
  splitNames_(toHalfWidth_(s)).forEach((token) => {
    const onlyGrade = token.match(/^([1-6])年?生?$/);
    if (onlyGrade) {
      if (out.length && !out[out.length - 1].grade) out[out.length - 1].grade = Number(onlyGrade[1]);
      return;
    }
    const withGrade = token.match(/^(.+?)[(（]?([1-6])年生?[)）]?$/);
    if (withGrade) out.push({ name: withGrade[1], grade: Number(withGrade[2]) });
    else out.push({ name: token, grade: 0 });
  });
  return out;
}
