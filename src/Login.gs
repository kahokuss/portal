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
