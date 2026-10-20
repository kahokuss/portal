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
    .replace(/ジャベ(?:リック)?ボール(?:投げ?|スロー)|ボール(?:投げ?|スロー)|ジャベリックスロー/, 'ボール投').replace(/ハードル/, 'h').replace(/^小学|^[1-6・.]+年|男子|女子|混合/g, '');
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
