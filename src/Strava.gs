/**
 * Strava との連携：家族ごとに Strava をつなぐと、子どもの名前がタイトルに入った活動（ランニング・自転車など）を
 * 自主トレに取り込む。取り込んだ記録は、Strava の決まりにあわせて「その家族だけ」に見せる（コーチ・みんなには見せない）。
 *
 * 準備（管理者が1回だけ）：https://www.strava.com/settings/api でアプリを作り、
 *   「Authorization Callback Domain」にポータルのドメイン（例：kahokuss.github.io）を入れ、
 *   Client ID と Client Secret をポータルの「自主トレ」→「Strava」に入れる。
 * 家族の Strava の鍵（トークン）は Apps Script のスクリプト プロパティに入れ、スプレッドシートには書かない。
 */

const STRAVA_API = 'https://www.strava.com';
// 取り込む活動の種類 → 自主トレの種類
const STRAVA_KINDS = {
  Run: 'ランニング', TrailRun: 'ランニング', VirtualRun: 'ランニング',
  Ride: '自転車', VirtualRide: '自転車', MountainBikeRide: '自転車', GravelRide: '自転車',
  Walk: 'ウォーキング', Hike: 'ウォーキング', Swim: '水泳',
};
const STRAVA_SYNC_MINUTES = 60;

function stravaKeys_() {
  const id = prop_('STRAVA_CLIENT_ID'), secret = prop_('STRAVA_CLIENT_SECRET');
  return id && secret ? { id: id, secret: secret } : null;
}

function stravaLoad_(famId) {
  try { return JSON.parse(prop_('SV_' + famId) || 'null'); } catch (err) { return null; }
}

function stravaSave_(famId, data) {
  if (data) setProp_('SV_' + famId, JSON.stringify(data));
  else PropertiesService.getScriptProperties().deleteProperty('SV_' + famId);
}

function stravaRedirect_() {
  return String(CONFIG.PORTAL_URL || '').replace(/\/?$/, '/') + '?strava=1';
}

/** 子どもの名前で活動を見分ける言葉：設定した言葉、空白なしの名前、名字をのぞいた名前 */
function stravaWords_(name, custom) {
  const words = String(custom || '').split(/[,、・\s]+/).filter(Boolean);
  const full = String(name).replace(/\s|　/g, '');
  words.push(full);
  const sp = String(name).trim().split(/\s|　/);
  if (sp.length > 1) words.push(sp[sp.length - 1]);
  const m = full.match(/^[一-龥々]+([ぁ-んァ-ヶー].+)$/);
  if (m) words.push(m[1]);
  return words.filter((w) => w.length >= 2);
}

/** 画面に出す、わが家の Strava の状態 */
function stravaStateFor_(ctx) {
  const s = stravaLoad_(ctx.famId);
  return {
    configured: !!stravaKeys_(),
    domain: String(CONFIG.PORTAL_URL || '').replace(/^https?:\/\//, '').replace(/\/.*$/, ''),
    connected: !!s,
    name: s ? s.name : '',
    last: s ? s.lastAt || '' : '',
    count: s ? s.count || 0 : 0,
    kw: s ? s.kw || {} : {},
  };
}

/** Client ID と Client Secret を入れる（管理者だけ） */
function setStravaKeysAction_(ctx, p) {
  if (!ctx.owner) throw new Error('この設定は管理者だけができます。');
  const id = String(p.id || '').replace(/[^0-9]/g, '');
  const secret = String(p.secret || '').trim();
  if (!id || !/^[0-9a-f]{20,}$/i.test(secret)) throw new Error('Client ID（数字）と Client Secret（英数字）を入れてください。');
  setProp_('STRAVA_CLIENT_ID', id);
  setProp_('STRAVA_CLIENT_SECRET', secret);
  return 'Strava の設定を保存しました。家族ごとに「Stravaとつなぐ」が使えます';
}

/** Strava のログイン画面の URL */
function stravaAuthUrlAction_(ctx) {
  const k = stravaKeys_();
  if (!k) throw new Error('まだ Strava の設定がされていません。管理者に設定をお願いしてください。');
  const state = 'sv' + randomKey_().slice(0, 16);
  CacheService.getScriptCache().put('strava:' + state, ctx.userId, 600);
  return {
    url: STRAVA_API + '/oauth/authorize?client_id=' + encodeURIComponent(k.id) + '&response_type=code&approval_prompt=auto&scope=activity:read_all' +
      '&redirect_uri=' + encodeURIComponent(stravaRedirect_()) + '&state=' + state,
  };
}

function stravaToken_(payload) {
  const k = stravaKeys_();
  if (!k) throw new Error('Strava の設定がありません。');
  const res = UrlFetchApp.fetch(STRAVA_API + '/oauth/token', {
    method: 'post', muteHttpExceptions: true,
    payload: Object.assign({ client_id: k.id, client_secret: k.secret }, payload),
  });
  const body = JSON.parse(res.getContentText() || '{}');
  if (res.getResponseCode() !== 200 || !body.access_token) throw new Error('Strava とつなげませんでした。もう一度ためしてください。');
  return body;
}

/** Strava のログインから戻ってきたとき：鍵を受け取って、わが家につなぐ */
function stravaConnectAction_(ctx, p) {
  if (p.error) throw new Error('Strava の許可がキャンセルされました。');
  const cache = CacheService.getScriptCache();
  const who = cache.get('strava:' + String(p.state || ''));
  if (!who || who !== ctx.userId) throw new Error('Strava とつなぐ時間が切れました。もう一度「Stravaとつなぐ」を押してください。');
  cache.remove('strava:' + p.state);
  if (!/activity:read/.test(String(p.scope || 'activity:read_all'))) throw new Error('「活動を見る」を許可してください。');
  const t = stravaToken_({ code: String(p.code || ''), grant_type: 'authorization_code' });
  const old = stravaLoad_(ctx.famId) || {};
  stravaSave_(ctx.famId, {
    athlete: t.athlete ? t.athlete.id : '', name: t.athlete ? [t.athlete.firstname, t.athlete.lastname].filter(Boolean).join(' ') : '',
    access: t.access_token, refresh: t.refresh_token, exp: t.expires_at, by: ctx.userId,
    after: Math.floor(Date.now() / 1000) - 60 * 86400, // つないだときは、60日前の活動から取り込む
    kw: old.kw || {}, count: old.count || 0,
  });
  const n = stravaSync_(ctx.famId, true);
  return 'Strava とつなぎました' + (n ? '。' + n + '件を自主トレに取り込みました' : '。子どもの名前がタイトルに入った活動を取り込みます');
}

/** 子どもごとの見分ける言葉を保存 */
function stravaKeywordsAction_(ctx, p) {
  const s = stravaLoad_(ctx.famId);
  if (!s) throw new Error('まだ Strava とつながっていません。');
  const mine = childrenOf_(ctx.userId).map((c) => c.name);
  s.kw = {};
  Object.keys(p.kw || {}).forEach((k) => { if (mine.indexOf(k) >= 0) s.kw[k] = String(p.kw[k] || '').slice(0, 40); });
  stravaSave_(ctx.famId, s);
  return '見分ける言葉を保存しました';
}

function stravaSyncAction_(ctx) {
  if (!stravaLoad_(ctx.famId)) throw new Error('まだ Strava とつながっていません。');
  const n = stravaSync_(ctx.famId, true);
  return n ? n + '件を自主トレに取り込みました' : '新しい活動はありませんでした（タイトルに子どもの名前が入った活動だけ取り込みます）';
}

function stravaDisconnectAction_(ctx, p) {
  const s = stravaLoad_(ctx.famId);
  if (s) {
    try { UrlFetchApp.fetch(STRAVA_API + '/oauth/deauthorize', { method: 'post', muteHttpExceptions: true, payload: { access_token: s.access } }); } catch (err) {}
    stravaSave_(ctx.famId, null);
  }
  let removed = 0;
  if (p.remove) {
    const mine = childrenOf_(ctx.userId).map((c) => c.name);
    withLock_(() => readRows_(SHEETS.TRAINING).forEach((x) => { if (/^sv/.test(x.id) && mine.indexOf(x['子ども']) >= 0) { clearRow_(SHEETS.TRAINING, x); removed++; } }));
  }
  return 'Strava とのつながりを切りました' + (removed ? '（取り込んだ ' + removed + '件も消しました）' : '');
}

/**
 * わが家の Strava から、新しい活動を自主トレに取り込む。取り込んだ件数を返す。
 * force でなければ、前回から STRAVA_SYNC_MINUTES たっていないときは何もしない
 */
function stravaSync_(famId, force) {
  const s = stravaLoad_(famId);
  if (!s || !stravaKeys_()) return 0;
  if (!force && s.checked && Date.now() - s.checked < STRAVA_SYNC_MINUTES * 60000) return 0;
  if (!s.exp || s.exp - 300 < Date.now() / 1000) {
    const t = stravaToken_({ grant_type: 'refresh_token', refresh_token: s.refresh });
    s.access = t.access_token; s.refresh = t.refresh_token || s.refresh; s.exp = t.expires_at;
  }
  const res = UrlFetchApp.fetch(STRAVA_API + '/api/v3/athlete/activities?per_page=100&after=' + (s.after || 0), {
    method: 'get', muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + s.access },
  });
  s.checked = Date.now();
  if (res.getResponseCode() !== 200) { stravaSave_(famId, s); return 0; }
  const acts = JSON.parse(res.getContentText() || '[]');
  // この家族の子ども
  const fam = readRows_(SHEETS.FAMILIES).filter((f) => famIdOf_(f) === famId).map((f) => f.userId);
  const kids = activeChildren_().filter((c) => c.parents.some((u) => fam.indexOf(u) >= 0));
  let n = 0, maxT = s.after || 0;
  withLock_(() => {
    const have = {};
    readRows_(SHEETS.TRAINING).forEach((x) => { if (/^sv/.test(x.id)) have[x.id] = true; });
    acts.forEach((a) => {
      const t = Math.floor(new Date(a.start_date).getTime() / 1000);
      if (t > maxT) maxT = t;
      const kind = STRAVA_KINDS[a.sport_type] || STRAVA_KINDS[a.type];
      if (!kind) return;
      const title = String(a.name || '');
      kids.filter((k) => stravaWords_(k.name, (s.kw || {})[k.name]).some((w) => title.indexOf(w) >= 0)).forEach((k) => {
        const id = 'sv' + a.id + (kids.length > 1 ? '_' + kids.indexOf(k) : '');
        if (have[id]) return;
        have[id] = true;
        const km = a.distance ? Math.round(a.distance / 10) / 100 : 0;
        const min = a.moving_time ? Math.max(1, Math.round(a.moving_time / 60)) : 0;
        appendRow_(SHEETS.TRAINING, {
          id: id, '日付': String(a.start_date_local || a.start_date || '').slice(0, 10), '子ども': k.name, '種類': kind,
          '距離km': km ? String(km) : '', '時間分': min ? String(min) : '', '回数': '', '調子': '',
          'メモ': ('Strava：' + title).slice(0, 200), userId: s.by || '', '表示名': 'Strava', '日時': now_(),
        });
        n++;
      });
    });
  });
  s.after = maxT;
  s.count = (s.count || 0) + n;
  s.lastAt = now_();
  stravaSave_(famId, s);
  return n;
}

/** 15分ごとの同期から：つないでいる家族を、1時間ごとに取り込む */
function stravaSyncAll_() {
  if (!stravaKeys_()) return;
  const props = PropertiesService.getScriptProperties().getProperties();
  Object.keys(props).filter((k) => /^SV_/.test(k)).forEach((k) => {
    try { stravaSync_(k.slice(3), false); } catch (err) { console.warn('Strava の取り込みに失敗: ' + k + ' ' + err); }
  });
}

// ---- ほかのトレーニングアプリ：いまは「開発中」。使いたい人の数を数えて、多いものから作る ----
const APP_LIST = ['Strava', 'Garmin Connect', 'Apple ヘルスケア', 'Google ヘルスコネクト', 'Fitbit', 'Polar', 'COROS', 'Suunto', 'Nike Run Club'];

function appRequestAction_(ctx, p) {
  if (APP_LIST.indexOf(p.app) < 0) throw new Error('そのアプリは選べません。');
  withLock_(() => {
    const row = readRows_(SHEETS.APP_REQ).find((x) => x['アプリ'] === p.app && x.userId === ctx.userId);
    if (p.on && !row) appendRow_(SHEETS.APP_REQ, { 'アプリ': p.app, userId: ctx.userId, '表示名': ctx.name, '日時': now_() });
    if (!p.on && row) clearRow_(SHEETS.APP_REQ, row);
  });
  return p.on ? p.app + 'の連携を「使いたい」にしました。要望が集まったら作ります' : '';
}

/** mine：自分が「使いたい」にしたアプリ／counts：アプリごとの人数（役員・管理者だけ） */
function appRequestsFor_(ctx) {
  const rows = readRows_(SHEETS.APP_REQ).filter((x) => x['アプリ']);
  const counts = {};
  if (ctx.admin) rows.forEach((x) => (counts[x['アプリ']] = (counts[x['アプリ']] || 0) + 1));
  return { list: APP_LIST, mine: rows.filter((x) => x.userId === ctx.userId).map((x) => x['アプリ']), counts: counts };
}
