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
