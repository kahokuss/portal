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
    missionKids: boss ? missionKidStats_(today_()) : {},
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

// ---- 目標の様子（Botの「今日」・週のふりかえり・コーチの「止まっている子」で使う） ----

/** '1:01.27' '14.50' '15.2秒' → 秒、'3m20' '3.20m' → m、'45回' → 回。読めなければ null（画面の markValue と同じ） */
function markValueGs_(rec) {
  const r = toHalfWidth_(String(rec || '')).replace(/\s/g, '');
  let m;
  if ((m = r.match(/^(\d+)m(\d{1,2})$/))) return +m[1] + +m[2] / 100;
  if ((m = r.match(/^(\d+(?:\.\d+)?)m$/))) return +m[1];
  if ((m = r.match(/^(\d+)[:'分](\d{1,2}(?:\.\d+)?)"?秒?$/))) return +m[1] * 60 + +m[2];
  if ((m = r.match(/^(\d+(?:\.\d+)?)秒?$/))) return +m[1];
  if ((m = r.match(/^(\d+)回$/))) return +m[1];
  return null;
}
function higherBetterGs_(race, sample) { return /跳|投|ボール/.test(race || '') || /回$/.test(sample || ''); }
function fmtMarkGs_(v, race, sample) {
  if (/回$/.test(sample || '')) return Math.round(v) + '回';
  if (/跳|投|ボール/.test(race || '')) { let m = Math.floor(v), cm = Math.round((v - m) * 100); if (cm === 100) { m++; cm = 0; } return m + 'm' + ('0' + cm).slice(-2); }
  if (v >= 60) { const mm = Math.floor(v / 60), ss = v - mm * 60; return mm + ':' + (ss < 10 ? '0' : '') + ss.toFixed(2); }
  return v.toFixed(2);
}
function goalActs_(g) { try { return JSON.parse(g['やること'] || '[]'); } catch (err) { return []; } }

/** 子どもの記録（日付つき）。種目は sameRaceGs_ でそろえる */
function kidResults_(child) {
  return readRows_(SHEETS.RESULTS).filter((x) => x['子ども'] === child && x['記録']).map((x) => ({ date: String(x['大会・練習'] || x['日時']).slice(0, 10), race: x['種目'], record: x['記録'] }));
}
function bestOf_(results, race, sample, until) {
  let best = null;
  results.forEach((r) => {
    if (!sameRaceGs_(r.race, race) || (until && r.date > until)) return;
    const v = markValueGs_(r.record);
    if (v === null) return;
    if (best === null || (higherBetterGs_(race, sample) ? v > best.v : v < best.v)) best = { v: v, record: r.record, date: r.date };
  });
  return best;
}

/** その子の目標の様子：連続日数・この7日・最後にできた日・やることがあるか・いちばん大きい目標とペース */
function kidGoalStats_(child, today) {
  const goals = readRows_(SHEETS.GOALS).filter((g) => g.id && g['子ども'] === child);
  const logs = {};
  let last = '';
  readRows_(SHEETS.GOAL_LOG).filter((x) => x['子ども'] === child).forEach((x) => { logs[x.goalId + '|' + x['やること'] + '|' + x['日付']] = true; if (x['日付'] > last) last = x['日付']; });
  const active = (g, date) => g['状態'] !== '達成' && g['期限'] >= date && String(g['日時']).slice(0, 10) <= date;
  const todo = (date) => {
    const wd = new Date(date + 'T00:00:00Z').getUTCDay(), out = [];
    goals.filter((g) => active(g, date)).forEach((g) => goalActs_(g).forEach((a, i) => { if ((a.days || []).indexOf(wd) >= 0) out.push({ g: g, t: a.t, done: !!logs[g.id + '|' + i + '|' + date] }); }));
    return out;
  };
  let streak = 0;
  for (let n = 0; n < 60; n++) {
    const list = todo(addDays_(today, -n));
    if (!list.length) continue;
    const all = list.every((x) => x.done);
    if (n === 0 && !all) continue;
    if (!all) break;
    streak++;
  }
  let plan7 = 0, done7 = 0;
  for (let n = 0; n < 7; n++) { const l = todo(addDays_(today, -n)); plan7 += l.length; done7 += l.filter((x) => x.done).length; }
  const hasActs = goals.some((g) => active(g, today) && goalActs_(g).length);
  // いちばん大きい目標（自分の目標を先に。期間の長い順）と、いま向かっている小さい目標
  const tops = goals.filter((g) => active(g, today) && !(g['親id'] && goals.some((p) => p.id === g['親id']))).sort((a, b) => (a['種類'] === 'ミッション') - (b['種類'] === 'ミッション') || GOAL_PERIODS.indexOf(a['期間']) - GOAL_PERIODS.indexOf(b['期間']) || (a['期限'] < b['期限'] ? -1 : 1));
  const hero = tops[0] || null;
  let step = hero;
  for (let k = 0; step && k < 6; k++) { const nx = goals.filter((g) => g['親id'] === step.id && active(g, today)).sort((a, b) => (a['期限'] < b['期限'] ? -1 : 1))[0]; if (!nx) break; step = nx; }
  const pace = step ? goalPaceGs_(child, step.race ? step : hero, today) : null;
  return { streak: streak, plan7: plan7, done7: done7, last: last, hasActs: hasActs, hero: hero, step: step, pace: pace, todo: todo };
}

/** 最近120日の記録の伸びから、期限の日の記録を予想（画面の goalPace と同じ考え方） */
function goalPaceGs_(child, g, today) {
  if (!g || !g['種目'] || markValueGs_(g['目標記録']) === null) return null;
  const race = g['種目'], target = g['目標記録'], from = addDays_(today, -120), res = kidResults_(child);
  const pts = {};
  res.forEach((r) => {
    if (!sameRaceGs_(r.race, race) || r.date < from) return;
    const v = markValueGs_(r.record);
    if (v === null) return;
    if (pts[r.date] === undefined || (higherBetterGs_(race, target) ? v > pts[r.date] : v < pts[r.date])) pts[r.date] = v;
  });
  const ds = Object.keys(pts);
  if (ds.length < 2) return null;
  const day = (x) => Math.round((new Date(x + 'T00:00:00Z') - new Date(from + 'T00:00:00Z')) / 86400000);
  const xs = ds.map(day), ys = ds.map((x) => pts[x]), n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0;
  xs.forEach((x, i) => { sxx += (x - mx) * (x - mx); sxy += (x - mx) * (ys[i] - my); });
  if (!sxx) return null;
  const hb = higherBetterGs_(race, target), tv = markValueGs_(target);
  let pred = my + (sxy / sxx) * (day(g['期限']) - mx);
  const best = bestOf_(res, race, target);
  if (best && (hb ? pred < best.v : pred > best.v)) pred = best.v;
  const ok = hb ? pred >= tv : pred <= tv, gap = Math.abs(pred - tv);
  return { at: g['期限'], race: race, pred: fmtMarkGs_(pred, race, target), ok: ok, gap: /跳|投|ボール/.test(race) ? Math.round(gap * 100) + 'cm' : /回$/.test(target) ? Math.round(gap) + '回' : gap.toFixed(2) + '秒' };
}

/** 週のはじめ（月曜） */
function weekStart_(date) { const wd = new Date(date + 'T00:00:00Z').getUTCDay(); return addDays_(date, -((wd + 6) % 7)); }

/** 週のふりかえりの文（Bot用）。月曜は先週、ほかの日は今週 */
function weekReviewText_(child, today) {
  const st = kidGoalStats_(child, today);
  const mon = new Date(today + 'T00:00:00Z').getUTCDay() === 1 ? addDays_(weekStart_(today), -7) : weekStart_(today);
  const end = addDays_(mon, 6), until = end < today ? end : today;
  const acts = {};
  for (let d = mon; d <= until; d = addDays_(d, 1)) st.todo(d).forEach((x) => { const a = acts[x.t] || (acts[x.t] = { p: 0, ok: 0 }); a.p++; if (x.done) a.ok++; });
  const names = Object.keys(acts);
  const lines = ['📅 ' + child + 'の' + (mon < weekStart_(today) ? '先週' : '今週') + 'のふりかえり（' + formatDate_(mon) + '〜' + formatDate_(end) + '）'];
  if (!names.length) lines.push('この週の「やること」はありません。ポータルの「目標」で、やることと曜日を決めましょう。');
  let p = 0, ok = 0;
  names.forEach((t) => { p += acts[t].p; ok += acts[t].ok; lines.push((acts[t].ok === acts[t].p ? '◎ ' : acts[t].ok ? '○ ' : '✕ ') + t + '　' + acts[t].ok + '/' + acts[t].p); });
  if (p) lines.push('できた ' + ok + '/' + p + '（' + Math.round(ok * 100 / p) + '%）' + (ok === p ? ' 🎉 パーフェクト！' : ok / p >= 0.7 ? ' よくがんばりました' : ' 来週はできる曜日に変えてみよう'));
  // この週に出たベスト
  const res = kidResults_(child), pbs = [];
  res.filter((r) => r.date >= mon && r.date <= end).forEach((r) => {
    const before = bestOf_(res.filter((x) => x.date < mon), r.race, r.record);
    const v = markValueGs_(r.record);
    if (v !== null && (!before || (higherBetterGs_(r.race, r.record) ? v > before.v : v < before.v)) && pbs.indexOf(r.race + ' ' + r.record) < 0) pbs.push(r.race + ' ' + r.record);
  });
  if (pbs.length) lines.push('🏅 ベスト更新：' + pbs.join('、'));
  if (st.streak >= 2) lines.push('🔥 ' + st.streak + '日連続でできています');
  return lines.join('\n');
}

/** コーチ・役員用：ミッションの子ごとの、やることの様子（数だけ。中身は出さない） */
function missionKidStats_(today) {
  const kids = {};
  readRows_(SHEETS.GOALS).filter((g) => g.id && g['種類'] === 'ミッション').forEach((g) => (kids[g['子ども']] = true));
  const out = {};
  Object.keys(kids).forEach((k) => { const s = kidGoalStats_(k, today); out[k] = { plan7: s.plan7, done7: s.done7, last: s.last, hasActs: s.hasActs, streak: s.streak }; });
  return out;
}
