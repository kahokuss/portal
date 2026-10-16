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
  });
}

function photoFolderUrl_() {
  return photoRoot_().getUrl();
}
