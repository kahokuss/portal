/**
 * 会計係：年度（4月はじまり）の予算と実績、集金の催促。
 * 実績は「会計」の記録（科目つき）と、集金で受け取った分（集金の名前＝科目）から数える
 */

function fyStart_(date) {
  const y = Number(String(date).slice(0, 4)), m = Number(String(date).slice(5, 7));
  return (m >= 4 ? y : y - 1) + '-04-01';
}

function budgetFor_(ctx) {
  if (!ctx.admin) return [];
  return readRows_(SHEETS.BUDGET).filter((x) => x.id).map((x) => ({ id: x.id, fy: Number(x['年度']) || 0, kind: x['区分'] === '収入' ? '収入' : '支出', cat: x['科目'], amount: Number(x['金額']) || 0, memo: x['メモ'] || '' }));
}

/** 予算の行を入れる・直す・消す（年度・区分・科目・金額） */
function saveBudgetAction_(ctx, p) {
  if (p.remove) {
    withLock_(() => { const row = readRows_(SHEETS.BUDGET).find((x) => x.id && x.id === p.id); if (row) clearRow_(SHEETS.BUDGET, row); });
    return '予算の行を消しました';
  }
  const fy = Number(p.fy) || Number(fyStart_(today_()).slice(0, 4));
  const kind = p.kind === '収入' ? '収入' : '支出';
  const cat = String(p.cat || '').trim().slice(0, 30);
  if (!cat) throw new Error('科目を入れてください（例：年会費、大会参加費）。');
  const amount = Number(toHalfWidth_(String(p.amount || '')).replace(/[^0-9]/g, '')) || 0;
  withLock_(() => {
    const rows = readRows_(SHEETS.BUDGET);
    const row = (p.id && rows.find((x) => x.id === p.id)) || rows.find((x) => x.id && Number(x['年度']) === fy && x['区分'] === kind && x['科目'] === cat);
    const data = { '年度': String(fy), '区分': kind, '科目': cat, '金額': String(amount), 'メモ': String(p.memo || '').slice(0, 100), '更新者': ctx.name, '日時': now_() };
    if (row) updateRow_(SHEETS.BUDGET, Object.assign(row, data));
    else appendRow_(SHEETS.BUDGET, Object.assign({ id: randomKey_().slice(0, 10) }, data));
  });
  return fy + '年度の予算「' + cat + '」を保存しました';
}

/** 集金の催促：まだの子の保護者に、LINEで1人ずつ知らせる（グループには送らない）。同じ集金は1日1回まで */
function feeRemindAction_(ctx, p) {
  const today = today_();
  let sent = 0, kids = [];
  withLock_(() => {
    const fee = readRows_(SHEETS.FEES).find((x) => x.id && x.id === p.id);
    if (!fee) throw new Error('集金が見つかりません。');
    if (fee['終了'] === '○') throw new Error('終わった集金です。');
    if (fee['催促'] === today) throw new Error('この集金の催促は、今日はもう送りました（1日1回まで）。');
    const paid = readRows_(SHEETS.FEE_PAID).filter((x) => x['集金id'] === fee.id && x['状態'] === '済').map((x) => x['子ども']);
    const unpaid = activeChildren_().filter((c) => inTarget_(fee['対象'], c.grade) && paid.indexOf(c.name) < 0);
    if (!unpaid.length) throw new Error('まだの人はいません。');
    const to = {};
    unpaid.forEach((c) => c.parents.forEach((u) => { (to[u] = to[u] || []).push(c.name); }));
    const amount = Number(fee['金額']) || 0;
    Object.keys(to).forEach((u) => {
      const text = '💴 集金のお知らせ（' + CONFIG.CLUB_NAME + '）\n' + fee['名前'] + '　' + amount.toLocaleString('ja-JP') + '円／人\n' + to[u].join('・') + ' の分が、まだ確認できていません。' +
        (fee['期限'] ? '\n期限：' + formatDate_(fee['期限']) + (fee['期限'] < today ? '（過ぎています）' : '') : '') + (fee['メモ'] ? '\n' + fee['メモ'] : '') + '\nすでにお渡し済みでしたら、会計係までお知らせください。';
      try { push_(u, [text_(text)]); if (!isTestUser_(u)) sent++; } catch (e) { console.warn('催促の送信に失敗: ' + e); }
    });
    kids = unpaid.map((c) => c.name);
    fee['催促'] = today;
    updateRow_(SHEETS.FEES, fee);
  });
  return 'まだの ' + kids.length + '人の保護者に、LINEで個別に知らせました（' + sent + '通）';
}
