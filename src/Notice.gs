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
