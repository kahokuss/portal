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
