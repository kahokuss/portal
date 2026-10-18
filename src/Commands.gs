/**
 * コマンドへの返事。1対1のトークでは、ふつうに返信する（無料）。
 * グループで送られた個人的なコマンドは、グループには出さず、送った人だけに1対1で届ける
 * （プッシュなので1通ぶん無料枠を使う。Botを友だち追加していない人には届かないので、そのときだけグループで案内する）。
 */
function respond_(ev, messages) {
  // 返事の下に、よく使うボタンを出す（押すとその言葉が送られる）
  const last = messages[messages.length - 1];
  if (last && !last.quickReply) last.quickReply = quickItems_(MAIN_QUICK);
  if (!ev.privateAnswer) return reply_(ev.replyToken, messages);
  try {
    push_(ev.source.userId, messages);
  } catch (err) {
    console.warn('個別の返事に失敗（友だち追加されていない？）: ' + err);
    reply_(ev.replyToken, [text_('お返事は、送った人だけに届くようにしています。Bot「' + CONFIG.CLUB_NAME + '」を友だち追加して、1対1のトークで送ってください。')]);
  }
}

/** 使い方の文章（CONFIG を使うので、ファイルの読み込み順に左右されないよう関数にする） */
function helpText_() {
  return [
    '🏃 ' + CONFIG.CLUB_NAME + ' Botの使い方',
    '下のボタンか、メニューから選べます。',
    '',
    '新着 … 次の練習・わが家の当番・エントリーの締切・お知らせなど、まとめて',
    '今日 … 今日の予定（大会の日は、子どもの時刻・招集・ナンバー）',
    '予定 … これからの予定',
    '休み … 休みの連絡（例：休み 明日／休み たろう 10/20 体調不良）。「休み取消」で取り消し',
    '当番 … わが家の当番と、これからの当番',
    '出欠 … 次の練習で休む人',
    'エントリー … 大会のエントリーの状況',
    'ポータル … 予定・大会のエントリー・休みの連絡ができるページのリンク（グループのメンバーだけが見られます）',
    '登録 名前 学年 … お子さんを登録（例：登録 山田たろう 3年 山田はなこ 1年）。ポータルの「わが家」からもできます',
    '結果 種目 記録 … レース結果を記録（例：結果 100m 15.2秒）',
    '記録 … お子さんの記録一覧',
    '写真 … アルバム（ポータル）のリンク',
    '',
    '📷 グループに送った写真は自動で保存され、ポータルの「写真」で大会・練習ごとに見られます。',
    '🔒 Botの返事は、グループで送っても、送った人にだけ届きます（Botを友だち追加してください）。Botとの1対1のトークで送るのがおすすめです。',
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
    '新着': 'news', '確認': 'news', 'お知らせ': 'news', 'メニュー': 'help',
    '今日': 'today', 'きょう': 'today',
    '予定': 'schedule', '次': 'schedule', 'スケジュール': 'schedule',
    '休み': 'absence', '欠席': 'absence', 'やすみ': 'absence',
    '休み取消': 'absenceCancel', '取消': 'absenceCancel', '取り消し': 'absenceCancel',
    '当番': 'duty',
    '出欠': 'attendance',
    'エントリー': 'entries',
    '結果': 'result',
    '記録': 'records',
    '写真': 'photos', 'アルバム': 'photos',
  };
  const name = aliases[word];
  if (!name) return null;
  return { name: name, args: (m[2] || '').trim() };
}

/** グループで送られても、みんなに見せる返事。いまはなし（Botの返事はすべて、送った人にだけ届ける） */
const PUBLIC_COMMANDS = [];

function handleText_(ev) {
  const cmd = parseCommand_(ev.message.text);
  if (!cmd) return;
  ev.privateAnswer = CONFIG.GROUP_PRIVATE_REPLY && ev.source.type === 'group' && PUBLIC_COMMANDS.indexOf(cmd.name) < 0;
  switch (cmd.name) {
    case 'help':
      return respond_(ev, botMessages_([helpText_()]));
    case 'register':
      return handleRegister_(ev, cmd.args);
    case 'portal':
      return handlePortal_(ev);
    case 'news':
      return handleNews_(ev);
    case 'today':
      return handleToday_(ev);
    case 'schedule':
      return handleSchedule_(ev);
    case 'absence':
      return handleAbsence_(ev, cmd.args);
    case 'absenceCancel':
      return handleAbsenceCancel_(ev);
    case 'duty':
      return handleDuty_(ev);
    case 'attendance':
      return handleAttendance_(ev);
    case 'entries':
      return handleEntries_(ev);
    case 'result':
      return handleResultCommand_(ev, cmd.args);
    case 'records':
      return handleRecordsCommand_(ev, cmd.args);
    case 'photos':
      return respond_(ev, [text_('📷 アルバム（LINEグループのメンバーだけが見られます）\n' + portalUrl_() + (portalUrl_().indexOf('?') >= 0 ? '&' : '?') + 'tab=album')]);
  }
}

function handleRegister_(ev, args) {
  const userId = ev.source.userId;
  const list = parseChildrenArgs_(args);
  if (!list.length) {
    const children = childrenOf_(userId);
    return respond_(ev, [
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
  respond_(ev, [
    text_('登録しました：' + list.map((c) => c.name + (c.grade ? '（' + c.grade + '年）' : '')).join('、') + (noGrade ? '\n学年はポータルの「わが家」から入れられます。' : '') +
      '\nポータル：' + portalUrl_()),
  ]);
}

/**
 * ポータルのリンクはみんな同じ。開くと LINE ログインがあり、グループのメンバーだけが入れるので、グループに出してよい。
 */
function handlePortal_(ev) {
  respond_(ev, [
    text_('🏃 ' + CONFIG.CLUB_NAME + ' ポータル\n' + portalUrl_() + '\n\n開くと「LINEでログイン」が出ます。' + CONFIG.CLUB_NAME + 'のLINEグループのメンバーだけが見られます。'),
  ]);
}
