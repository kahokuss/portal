/**
 * 当番の交代：当番の家族が「交代をお願いする」→ ほかの家族が「代わりに入る」（先着1家族）で、その場で入れかわる。
 * 回数は当番表の行のとおりに数えるので、代わりに入った家族は次の自動割り当てで後回し、代わってもらった家族は先になる
 */

/** 当番表の家族ID（保護者がまだだった子は kid:名前）を、今の家族IDにする */
function dutyFamResolver_() {
  const famOfUser = {};
  readRows_(SHEETS.FAMILIES).forEach((f) => (famOfUser[f.userId] = famIdOf_(f)));
  const allKids = activeChildren_();
  return (v) => {
    if (!/^kid:/.test(v)) return v;
    const k = allKids.find((c) => c.name === v.slice(4));
    const u = k && k.parents.find((x) => famOfUser[x]);
    return u ? famOfUser[u] : v;
  };
}

/** その予定の、その家族の当番の行（大会係は除く） */
function dutyRowOf_(ev, fam) {
  const res = dutyFamResolver_();
  return readRows_(SHEETS.DUTIES).find((d) => !isRaceStaffRow_(d) && (d.eventKey === ev.eventKey || (!d.eventKey && d['日付'] === ev['日付'] && d['種類'] === dutyType_(ev))) && res(d['家族ID']) === fam);
}

function swapsFor_(today) {
  return readRows_(SHEETS.SWAPS)
    .filter((x) => x.id && x['日付'] >= addDays_(today, -1) && (x['状態'] === '募集中' || x['状態'] === '決定'))
    .map((x) => ({ id: x.id, key: x.eventKey, date: x['日付'], type: x['種類'], fam: x['依頼家族ID'], by: x['依頼者'], reason: x['理由'], status: x['状態'], to: x['代わり家族ID'], toName: x['代わり者'] }));
}

function swapRequestAction_(ctx, p) {
  const ev = findEvent_(p.key);
  if (!ev) throw new Error('予定が見つかりません。');
  if (ev['日付'] < today_()) throw new Error('終わった予定の当番は交代できません。');
  withLock_(() => {
    if (!dutyRowOf_(ev, ctx.famId)) throw new Error('この予定の当番は、わが家ではありません。');
    if (readRows_(SHEETS.SWAPS).some((x) => x.eventKey === ev.eventKey && x['依頼家族ID'] === ctx.famId && x['状態'] === '募集中')) throw new Error('もう交代をお願いしています。');
    appendRow_(SHEETS.SWAPS, { id: randomKey_().slice(0, 10), eventKey: ev.eventKey, '日付': ev['日付'], '種類': dutyType_(ev), '依頼家族ID': ctx.famId, '依頼者': ctx.name, '理由': String(p.reason || '').trim().slice(0, 200), '状態': '募集中', '日時': now_(), '更新日時': now_() });
  });
  logHistory_(ev.eventKey, ctx, '当番の交代をお願いしました');
  return '交代をお願いしました。だれかが「代わりに入る」を押すと、その家族に入れかわります';
}

function swapVolunteerAction_(ctx, p) {
  let ev = null;
  withLock_(() => {
    const sw = readRows_(SHEETS.SWAPS).find((x) => x.id === p.id);
    if (!sw || sw['状態'] !== '募集中') throw new Error('この交代の募集は、もう終わっています。');
    if (sw['依頼家族ID'] === ctx.famId) throw new Error('自分の家の当番には入れません。');
    ev = findEvent_(sw.eventKey);
    if (!ev) throw new Error('予定が見つかりません。');
    if (dutyRowOf_(ev, ctx.famId)) throw new Error('この日は、もうわが家が当番です。');
    const row = dutyRowOf_(ev, sw['依頼家族ID']);
    if (!row) throw new Error('当番が見つかりません（役員が入れかえたかもしれません）。');
    row['家族ID'] = ctx.famId; row['更新者'] = ctx.name + '（交代）'; row['更新日時'] = now_();
    updateRow_(SHEETS.DUTIES, row);
    Object.assign(sw, { '状態': '決定', '代わり家族ID': ctx.famId, '代わり者': ctx.name, '更新日時': now_() });
    updateRow_(SHEETS.SWAPS, sw);
  });
  logHistory_(ev.eventKey, ctx, '当番を交代しました（代わりに入る）');
  return '代わりに入りました。' + formatDate_(ev['日付']) + 'の当番は、わが家です。ありがとうございます';
}

function swapCancelAction_(ctx, p) {
  withLock_(() => {
    const sw = readRows_(SHEETS.SWAPS).find((x) => x.id === p.id);
    if (!sw || sw['状態'] !== '募集中') throw new Error('この交代の募集は、もう終わっています。');
    if (sw['依頼家族ID'] !== ctx.famId && !ctx.admin) throw new Error('お願いした家族と役員だけが取り消せます。');
    Object.assign(sw, { '状態': '取消', '更新日時': now_() });
    updateRow_(SHEETS.SWAPS, sw);
  });
  return '交代のお願いを取り消しました';
}
