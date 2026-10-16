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
