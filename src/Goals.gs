/**
 * 目標管理：目標（いつまでに・何を）と、そのためにやること（曜日つきで毎週のスケジュールに）。
 * 種類は「自分」（家族が立てる）と「ミッション」（監督・コーチ・役員が出す）。
 * 期間は 大会／年間／半年／3ヶ月／月。大きな目標は、途中目標（半年・3ヶ月・月）に分けられる。
 * 見られる人は自主トレと同じ（家族・「コーチに見せる」ならコーチ・「みんなに見せる」ならみんな）。ミッションは出した側（コーチ・役員）も見られる。
 */

const GOAL_PERIODS = ['大会', '年間', '半年', '3ヶ月', '月', '週'];

function canMission_(ctx) { return !!(ctx.admin || ctx.coach); }

function goalsFor_(ctx, children) {
  const own = children.filter((c) => c.parents.indexOf(ctx.userId) >= 0).map((c) => c.name);
  const see = own.concat(viewableTrainKids_(ctx));
  const boss = canMission_(ctx);
  const rows = readRows_(SHEETS.GOALS).filter((g) => g.id && (see.indexOf(g['子ども']) >= 0 || (boss && g['種類'] === 'ミッション')));
  const ids = {};
  rows.forEach((g) => (ids[g.id] = true));
  const from = addDays_(today_(), -120);
  return {
    list: rows.map((g) => {
      let acts = [];
      try { acts = JSON.parse(g['やること'] || '[]'); } catch (err) { acts = []; }
      return {
        id: g.id, child: g['子ども'], kind: g['種類'] || '自分', period: g['期間'], title: g['タイトル'], race: g['種目'], target: g['目標記録'], start: g['開始記録'],
        deadline: g['期限'], key: g.eventKey, actions: acts, parent: g['親id'], done: g['状態'] === '達成', doneAt: g['達成日'], note: g['ひとこと'], by: g['出した人'], at: String(g['日時']).slice(0, 10),
        mine: own.indexOf(g['子ども']) >= 0, canEdit: g['種類'] === 'ミッション' ? boss : own.indexOf(g['子ども']) >= 0 || boss,
      };
    }),
    log: readRows_(SHEETS.GOAL_LOG).filter((x) => ids[x.goalId] && x['日付'] >= from).map((x) => ({ goal: x.goalId, act: Number(x['やること']) || 0, date: x['日付'] })),
  };
}

function cleanActions_(list) {
  return (list || []).slice(0, 8).map((a) => ({
    t: String((a && a.t) || '').trim().slice(0, 40),
    days: ((a && a.days) || []).map(Number).filter((d, i, arr) => d >= 0 && d <= 6 && arr.indexOf(d) === i).sort(),
  })).filter((a) => a.t);
}

/** 目標を立てる・直す。ミッションは children（何人でも）に同じ目標を出す */
function saveGoalAction_(ctx, p) {
  const mission = p.kind === 'ミッション';
  if (mission && !canMission_(ctx)) throw new Error('ミッションを出せるのは、監督・コーチ・役員です。');
  const kids = (mission ? p.children || [] : [p.child]).filter(Boolean);
  if (!kids.length) throw new Error('だれの目標かを選んでください。');
  const own = myKidNames_(ctx);
  if (!mission && own.indexOf(kids[0]) < 0 && !canMission_(ctx)) throw new Error('わが家のお子さんを選んでください。');
  const title = String(p.title || '').trim().slice(0, 60);
  if (!title) throw new Error('目標を書いてください（例：100mで14秒50を切る）。');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.deadline || '')) throw new Error('いつまでの目標かを選んでください。');
  const base = {
    '種類': mission ? 'ミッション' : '自分', '期間': GOAL_PERIODS.indexOf(p.period) >= 0 ? p.period : '月', 'タイトル': title,
    '種目': String(p.race || '').trim().slice(0, 30), '目標記録': String(p.target || '').trim().slice(0, 20), '期限': p.deadline, eventKey: String(p.key || '').slice(0, 40),
    'やること': JSON.stringify(cleanActions_(p.actions)), '親id': String(p.parent || '').slice(0, 20), 'ひとこと': String(p.note || '').slice(0, 200), '更新日時': now_(),
  };
  let n = 0;
  withLock_(() => {
    if (p.id) {
      const g = readRows_(SHEETS.GOALS).find((x) => x.id === p.id);
      if (!g) throw new Error('目標が見つかりません。');
      if (g['種類'] === 'ミッション' ? !canMission_(ctx) : own.indexOf(g['子ども']) < 0 && !canMission_(ctx)) throw new Error('この目標は直せません。');
      Object.assign(g, base, { '種類': g['種類'] });
      updateRow_(SHEETS.GOALS, g);
      n = 1;
      return;
    }
    kids.forEach((child) => {
      appendRow_(SHEETS.GOALS, Object.assign({ id: randomKey_().slice(0, 10), '子ども': child, '開始記録': String(p.startRecords && p.startRecords[child] || p.start || '').slice(0, 20), '状態': '', '出した人': mission ? ctx.name : '', userId: ctx.userId, '日時': now_() }, base));
      n++;
    });
  });
  return p.id ? '目標を直しました' : mission ? n + '人にミッションを出しました' : '目標を立てました：' + title;
}

function findGoalFor_(ctx, id, needEdit) {
  const g = readRows_(SHEETS.GOALS).find((x) => x.id && x.id === id);
  if (!g) throw new Error('目標が見つかりません。');
  const own = myKidNames_(ctx).indexOf(g['子ども']) >= 0;
  const ok = needEdit ? (g['種類'] === 'ミッション' ? canMission_(ctx) : own || canMission_(ctx)) : own || canMission_(ctx);
  if (!ok) throw new Error('この目標は操作できません。');
  return g;
}

function deleteGoalAction_(ctx, p) {
  withLock_(() => {
    const g = findGoalFor_(ctx, p.id, true);
    readRows_(SHEETS.GOALS).filter((x) => x['親id'] === g.id).forEach((x) => { x['親id'] = g['親id'] || ''; updateRow_(SHEETS.GOALS, x); });
    clearRow_(SHEETS.GOALS, g);
  });
  return '目標を消しました';
}

/** 達成にする・もどす（家族もコーチも） */
function setGoalDoneAction_(ctx, p) {
  let t = '';
  withLock_(() => {
    const g = findGoalFor_(ctx, p.id, false);
    g['状態'] = p.done ? '達成' : '';
    g['達成日'] = p.done ? today_() : '';
    g['更新日時'] = now_();
    updateRow_(SHEETS.GOALS, g);
    t = g['タイトル'];
  });
  return p.done ? '🎉 達成！' + t : '達成をもどしました';
}

/** やることの「できた」（日付ごと）。家族だけ */
function checkGoalActionAction_(ctx, p) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(p.date || '') ? p.date : today_();
  if (date > today_()) throw new Error('先の日はまだチェックできません。');
  withLock_(() => {
    const g = readRows_(SHEETS.GOALS).find((x) => x.id && x.id === p.id);
    if (!g || myKidNames_(ctx).indexOf(g['子ども']) < 0) throw new Error('わが家の子の目標だけチェックできます。');
    const idx = String(Number(p.act) || 0);
    const row = readRows_(SHEETS.GOAL_LOG).find((x) => x.goalId === p.id && x['やること'] === idx && x['日付'] === date);
    if (p.on && !row) appendRow_(SHEETS.GOAL_LOG, { goalId: p.id, 'やること': idx, '日付': date, '子ども': g['子ども'], userId: ctx.userId, '日時': now_() });
    if (!p.on && row) clearRow_(SHEETS.GOAL_LOG, row);
  });
  return p.on ? 'できた！' : 'チェックを外しました';
}

/**
 * 大きな目標を途中目標に分ける。steps は画面で計算したもの：{deadline, target, title, unit, children: [...]}（入れ子にすると「近いほど細かく」）。
 * 記録の目標なら、今の記録から目標記録まで日にちに合わせて少しずつ近づく目標記録が入っている
 */
function splitGoalAction_(ctx, p) {
  const UNITS = ['半年', '3ヶ月', '月', '週'];
  let n = 0;
  withLock_(() => {
    const g = findGoalFor_(ctx, p.id, true);
    const make = (steps, parent, limit) => {
      (steps || []).slice(0, 30).forEach((x) => {
        const unit = x.unit || p.unit;
        if (n >= 60 || !/^\d{4}-\d{2}-\d{2}$/.test(x.deadline || '') || x.deadline > limit || UNITS.indexOf(unit) < 0) return;
        const id = randomKey_().slice(0, 10);
        appendRow_(SHEETS.GOALS, {
          id: id, '子ども': g['子ども'], '種類': g['種類'], '期間': unit, 'タイトル': String(x.title || '').slice(0, 60) || g['タイトル'],
          '種目': g['種目'], '目標記録': String(x.target || '').slice(0, 20), '開始記録': g['開始記録'], '期限': x.deadline, eventKey: '', 'やること': '[]', '親id': parent,
          '状態': '', '達成日': '', 'ひとこと': '', '出した人': g['出した人'], userId: ctx.userId, '日時': now_(), '更新日時': now_(),
        });
        n++;
        make(x.children, id, x.deadline);
      });
    };
    make(p.steps, g.id, g['期限']);
    if (!n) throw new Error('期限までが短いので、分けられません。');
  });
  return n + 'つの途中目標をつくりました';
}

/** Bot用：今日やること（わが家の子の、期限前・未達成の目標のうち今日の曜日のもの） */
function todayGoalActions_(kidNames, date) {
  const wd = new Date(date + 'T00:00:00Z').getUTCDay();
  const done = {};
  readRows_(SHEETS.GOAL_LOG).filter((x) => x['日付'] === date).forEach((x) => (done[x.goalId + '|' + x['やること']] = true));
  const out = [];
  readRows_(SHEETS.GOALS).filter((g) => g.id && kidNames.indexOf(g['子ども']) >= 0 && g['状態'] !== '達成' && g['期限'] >= date).forEach((g) => {
    let acts = [];
    try { acts = JSON.parse(g['やること'] || '[]'); } catch (err) { acts = []; }
    acts.forEach((a, i) => { if ((a.days || []).indexOf(wd) >= 0) out.push({ child: g['子ども'], goal: g['タイトル'], t: a.t, done: !!done[g.id + '|' + i], id: g.id, i: i }); });
  });
  return out;
}
