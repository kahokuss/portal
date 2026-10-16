// 河北SS ポータル（Apps Script）。このファイルは tools/build-pages.js が src/*.gs をつなげて作ります。
// 更新のしかた：Apps Script のエディタで「コード.gs」の中身を全部消して、このファイルの中身を全部貼り付け、保存します。
// そのあと「デプロイ」→「デプロイを管理」→ 鉛筆 →「新バージョン」→「デプロイ」。

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
/** 使い方の文章（CONFIG を使うので、ファイルの読み込み順に左右されないよう関数にする） */
function helpText_() {
  return [
    '🏃 ' + CONFIG.CLUB_NAME + ' Botの使い方',
    '',
    'ポータル … 予定・大会のエントリー・休みの連絡ができるページのリンク（グループのメンバーだけが見られます）',
    '登録 名前 学年 … お子さんを登録（例：登録 山田たろう 3年 山田はなこ 1年）。ポータルの「わが家」からもできます',
    '結果 種目 記録 … レース結果を記録（例：結果 100m 15.2秒）',
    '記録 … お子さんの記録一覧',
    '写真 … 保存した写真フォルダのリンク',
    '',
    '📷 グループに送った写真は自動でアルバム（Googleドライブ）に保存されます。',
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
    '予定': 'portalHint', '出欠': 'portalHint', '休み': 'portalHint', 'エントリー': 'portalHint',
    '結果': 'result',
    '記録': 'records',
    '写真': 'photos', 'アルバム': 'photos',
  };
  const name = aliases[word];
  if (!name) return null;
  return { name: name, args: (m[2] || '').trim() };
}

function handleText_(ev) {
  const cmd = parseCommand_(ev.message.text);
  if (!cmd) return;
  switch (cmd.name) {
    case 'help':
      return reply_(ev.replyToken, [text_(helpText_())]);
    case 'register':
      return handleRegister_(ev, cmd.args);
    case 'portal':
      return handlePortal_(ev);
    case 'portalHint':
      return reply_(ev.replyToken, [text_('予定・大会のエントリー・休みの連絡は、ポータルからできます。\n' + portalUrl_())]);
    case 'result':
      return handleResultCommand_(ev, cmd.args);
    case 'records':
      return handleRecordsCommand_(ev, cmd.args);
    case 'photos':
      return reply_(ev.replyToken, [text_('📷 写真フォルダ\n' + photoFolderUrl_())]);
  }
}

function handleRegister_(ev, args) {
  const userId = ev.source.userId;
  const list = parseChildrenArgs_(args);
  if (!list.length) {
    const children = childrenOf_(userId);
    return reply_(ev.replyToken, [
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
  reply_(ev.replyToken, [
    text_('登録しました：' + list.map((c) => c.name + (c.grade ? '（' + c.grade + '年）' : '')).join('、') + (noGrade ? '\n学年はポータルの「わが家」から入れられます。' : '') +
      '\nポータル：' + portalUrl_()),
  ]);
}

/**
 * ポータルのリンクはみんな同じ。開くと LINE ログインがあり、グループのメンバーだけが入れるので、グループに出してよい。
 */
function handlePortal_(ev) {
  reply_(ev.replyToken, [
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
  SYNC_INTERVAL_MINUTES: 10,
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

  // 休みの連絡を、役員にLINEで個別に知らせるか（1件につき役員の人数分の通数を使います）
  ABSENCE_PUSH_TO_ADMINS: true,

  // グループに投稿された写真をすべてドライブに保存するか
  SAVE_ALL_PHOTOS: true,
  // 写真を何日前までの予定に紐づけるか（大会の翌日に写真を上げる場合など）
  PHOTO_EVENT_LOOKBACK_DAYS: 2,
  // 結果を何日前までの予定に紐づけるか
  RESULT_EVENT_LOOKBACK_DAYS: 7,
};

/** 大会の種目・持ち物・会場の候補（ポータルの入力補助に使います） */
const CHOICES = {
  RACES: ['100m', '50m', '走り幅跳び', 'ボール投げ', '1000m', 'リレー', '2km', '駅伝'],
  ITEMS: ['ユニフォーム', 'アスリートビブス', '弁当', '水筒', '帽子', 'レジャーシート', 'ベンチコート', 'タオル', '着替え', '雨具'],
  TARGETS: ['全員', '3年生以上', '4年生以上', '希望者'],
  ABSENCE_REASONS: ['体調不良', '家の都合', '学校行事', 'その他'],
  // 大会の手続き（チェックリスト）の種類
  TASKS: ['エントリー控え', 'プログラム', '招集', 'リレー予選', 'リレー決勝'],
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

// ===== Main.gs =====
/**
 * ポータルの画面を返す。
 * LINE ログインから戻ってきたとき（?code=）は、グループのメンバーか確かめてからキーを渡す。
 * それ以外は、ブラウザに保存したキーで開くか、ログインボタンを出す。
 */
function doGet(e) {
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
      reply_(ev.replyToken, [text_('招待ありがとうございます！\n\n' + helpText_())]);
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
function dailyJob() {
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
}

function photoFolderUrl_() {
  return photoRoot_().getUrl();
}

// ===== Portal.gs =====
/**
 * ポータル（Webアプリ）のサーバー側。
 * 画面からは google.script.run.api(key, action, payload) だけを呼ぶ。
 * key は LINE ログイン（Login.gs）でグループのメンバーと確認できた人に発行するキー。
 */
function api(key, action, payload) {
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
  refresh: { run: () => { importScheduleSafely_(); syncCalendar_(); } },
  saveChildren: { run: saveChildrenAction_ },
  inviteFamily: { raw: true, run: inviteFamilyAction_ },
  joinFamily: { run: joinFamilyAction_ },
  leaveFamily: { run: (ctx) => { leaveFamily_(ctx.userId); return '家族のまとまりから外れました'; } },
  setNotify: { admin: true, run: setNotifyAction_ },
  setDuty: { admin: true, run: setDutyAction_ },
  autoDuty: { admin: true, run: autoDutyAction_ },
  saveTimetable: { run: saveTimetableAction_ },
  setTask: { run: setTaskAction_ },
  uploadPhoto: { run: uploadPhotoAction_ },
  photo: { raw: true, run: photoAction_ },
  savePractices: { admin: true, run: savePracticesAction_ },
  editEvent: { admin: true, run: editEventAction_ },
  cancelEvent: { admin: true, run: cancelEventAction_ },
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
  };
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
  const photos = readRows_(SHEETS.PHOTOS)
    .filter((x) => x['ファイルID'] && inRange[x.eventKey])
    .map((x) => ({ id: x['ファイルID'], key: x.eventKey, by: x['表示名'], at: x['日時'], kind: x['種類'] || 'LINE' }));

  const me = familyRows.find((f) => f.userId === ctx.userId) || {};
  return {
    club: CONFIG.CLUB_NAME,
    today: today,
    me: {
      name: ctx.name,
      admin: ctx.admin,
      fam: ctx.famId,
      canManage: raceKeysAll.filter((k) => ctx.admin || duties.some((x) => x.key === k && x.fam === ctx.famId)),
      notify: wantsAbsenceNotice_(me),
      family: myFam ? myFam.parents : [ctx.name],
      children: children.filter((c) => c.parents.indexOf(ctx.userId) >= 0).map((c) => ({ name: c.name, grade: c.grade, sex: c.sex })),
    },
    kids: children.map((c) => ({ name: c.name, grade: c.grade, sex: c.sex })),
    families: families.map((f) => ({ id: f.id, label: f.label, parents: f.parents })),
    sheetUrl: ctx.admin ? ss_().getUrl() : '',
    parents: ctx.admin ? familyRows.map((f) => ({ id: f.userId, name: f['表示名'] || '（名前なし）', admin: isAdmin_(f), notify: wantsAbsenceNotice_(f) })) : [],
    events: events,
    entries: entries,
    absences: absences,
    notices: notices,
    duties: duties,
    timetable: timetable,
    tasks: tasks,
    photos: photos,
    choices: { races: CHOICES.RACES, items: CHOICES.ITEMS, targets: CHOICES.TARGETS, reasons: CHOICES.ABSENCE_REASONS, deadlineDays: CONFIG.DEADLINE_DAYS_BEFORE, practiceTimes: CONFIG.PRACTICE_TIMES, warmMinutes: CONFIG.WARM_UP_MINUTES_BEFORE_CALL },
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
  };
  withLock_(() => {
    const row = readRows_(SHEETS.RACES).find((r) => r.eventKey === ev.eventKey);
    if (row) updateRow_(SHEETS.RACES, Object.assign(row, data));
    else appendRow_(SHEETS.RACES, data);
  });
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
    '招集': cleanTime_(r.call),
    'アップ': cleanTime_(r.warm),
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
  return 'タイムテーブルを保存しました（' + list.length + '件）';
}

// ---- 手続き（チェックリスト） ----

/** 招集はだれでも（会場で助け合えるように）。ほかは役員と当番 */
function requireTaskRight_(ctx, key, kind) {
  if (CHOICES.TASKS.indexOf(kind) < 0) throw new Error('不明な手続きです。');
  if (kind !== '招集') requireManager_(ctx, key);
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
  return p.done ? kind + '：済にしました' : '';
}

// ---- 写真 ----

/** ポータルから写真を上げる。kind があれば、その手続きの写真として付ける */
function uploadPhotoAction_(ctx, p) {
  const ev = findEvent_(p.key);
  if (!ev) throw new Error('予定が見つかりません。');
  const kind = String(p.kind || '');
  if (kind) requireTaskRight_(ctx, p.key, kind);
  const m = String(p.data || '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw new Error('写真を読み込めませんでした。');
  if (m[2].length > 8 * 1024 * 1024) throw new Error('写真が大きすぎます。');
  const at = now_();
  const ext = EXTENSIONS[m[1]] || 'jpg';
  const fileName = at.replace(/[-: ]/g, '').slice(0, 14) + '_' + (safeName_(kind) || 'photo') + '_' + (safeName_(ctx.name) || 'portal') + '.' + ext;
  const folder = subfolder_(photoRoot_(), ev['日付'] + ' ' + safeName_(ev['タイトル']));
  const file = folder.createFile(Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], fileName));
  appendRow_(SHEETS.PHOTOS, { '日時': at, eventKey: ev.eventKey, '予定': ev['タイトル'], userId: ctx.userId, '表示名': ctx.name, 'ファイル名': fileName, URL: file.getUrl(), 'ファイルID': file.getId(), '種類': kind || 'ポータル' });
  if (kind) {
    upsertTask_(ctx, p.key, kind, String(p.target || '').slice(0, 60), (t) => {
      t['写真ID'] = splitNames_(t['写真ID']).concat([file.getId()]).join(',');
      if (kind === 'エントリー控え' || kind === 'プログラム') t['状態'] = '済';
    });
  }
  return '写真を保存しました';
}

/** 写真を画面に出す。「写真」シートにある写真だけ（ほかのドライブのファイルは出さない） */
function photoAction_(ctx, p) {
  const id = String(p.id || '');
  if (!id || !readRows_(SHEETS.PHOTOS).some((x) => x['ファイルID'] === id)) throw new Error('写真が見つかりません。');
  const file = DriveApp.getFileById(id);
  let blob = p.thumb ? file.getThumbnail() : null;
  if (!blob) blob = file.getBlob();
  return { id: id, data: 'data:' + (blob.getContentType() || 'image/jpeg') + ';base64,' + Utilities.base64Encode(blob.getBytes()) };
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
  if (parsed.error) return reply_(ev.replyToken, [text_(parsed.error)]);

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
  });

  let msg = '🏃 記録しました：' + parsed.child + ' ' + parsed.item + ' ' + parsed.record;
  if (event) msg += '\n（' + formatDate_(event['日付']) + ' ' + event['タイトル'] + '）';
  reply_(ev.replyToken, [text_(msg)]);
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
    return reply_(ev.replyToken, [text_('「記録 山田たろう」のように名前を書くか、先にお子さんを登録してください。')]);
  }
  const results = readRows_(SHEETS.RESULTS);
  reply_(ev.replyToken, targets.slice(0, 5).map((c) => text_(buildRecordsText_(c, results))));
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
  try {
    const sh = e && e.range && e.range.getSheet();
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
  FAMILIES: { name: '家族', headers: ['userId', '表示名', 'ポータルキー', '役員', '更新日時', 'グループ確認', '家族ID', '休み通知'] },
  CHILDREN: { name: '子ども', headers: ['名前', '学年', '保護者userId', '更新日時', '性別'] },
  EVENTS: { name: '予定', headers: ['eventKey', '日付', '開始', '終了', 'タイトル', '場所', 'カレンダーID', '種別', '状態', '更新日時'] },
  RACES: { name: '大会', headers: ['eventKey', '種別', '対象', '参加費', '締切', '集合時刻', '集合場所', '種目', '持ち物', '注意', '更新日時'] },
  ENTRIES: { name: 'エントリー', headers: ['eventKey', '子ども', '回答', '種目', '集金', '更新者', '更新日時'] },
  ABSENCES: { name: '休み', headers: ['id', '日付', '子ども', '理由', 'メモ', '連絡者userId', '連絡者', '確認', '確認者', '日時'] },
  NOTICES: { name: 'お知らせ', headers: ['id', '日付', 'タイトル', '本文', 'eventKey', '作成者', '日時'] },
  PHOTOS: { name: '写真', headers: ['日時', 'eventKey', '予定', 'userId', '表示名', 'ファイル名', 'URL', 'ファイルID', '種類'] },
  RESULTS: { name: '結果', headers: ['日時', 'eventKey', '大会・練習', '子ども', '種目', '記録', 'メモ', 'userId', '表示名'] },
  TIMETABLE: { name: 'タイムテーブル', headers: ['id', 'eventKey', '開始', '種目', '区分', '組', '招集', 'アップ', 'メモ', '更新日時'] },
  TASKS: { name: '手続き', headers: ['id', 'eventKey', '種類', '対象', '状態', 'メモ', '写真ID', '更新者', '日時'] },
  DUTIES: { name: '当番', headers: ['eventKey', '日付', '種類', '家族ID', '更新者', '更新日時'] },
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
  } else if (!headersChecked__[def.name]) {
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

/** 全行をオブジェクトの配列で返す。_row に行番号が入る */
function readRows_(def) {
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
  return obj;
}

function updateRow_(def, obj) {
  sheet_(def).getRange(obj._row, 1, 1, def.headers.length).setNumberFormat('@').setValues([toValues_(def, obj)]);
}

/** 行を空にする（行番号がずれないよう、削除ではなく空欄にする） */
function clearRow_(def, obj) {
  sheet_(def).getRange(obj._row, 1, 1, def.headers.length).setValues([def.headers.map(() => '')]);
}

/** 複数人が同時に操作しても行が重複しないようにロックして実行する */
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return fn();
  } finally {
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
