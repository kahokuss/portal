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
