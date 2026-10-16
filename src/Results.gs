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
