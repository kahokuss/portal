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
