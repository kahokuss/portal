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

  // グループで送られたコマンドの返事を、グループに出さず、送った人にだけ1対1で返すか
  GROUP_PRIVATE_REPLY: true,

  // 休みの連絡を、役員にLINEで個別に知らせるか（1件につき役員の人数分の通数を使います）
  // （通数を節約するため、いまは止めています。役員と当番は、Botの「新着」「出欠」とポータルの出欠で確認します）
  ABSENCE_PUSH_TO_ADMINS: false,

  // ヒヤリハットが書かれたら、役員にLINEで個別に知らせるか（1件につき役員の人数分の通数を使います）
  NEAR_MISS_PUSH_TO_ADMINS: false,

  // グループに投稿された写真をすべてドライブに保存するか
  SAVE_ALL_PHOTOS: true,
  // 写真を何日前までの予定に紐づけるか（大会の翌日に写真を上げる場合など）
  PHOTO_EVENT_LOOKBACK_DAYS: 2,
  // 結果を何日前までの予定に紐づけるか
  RESULT_EVENT_LOOKBACK_DAYS: 7,
};

/** 大会の種目・持ち物・会場の候補（ポータルの入力補助に使います） */
const CHOICES = {
  RACES: ['50m', '100m', '80mH', '800m', '1000m', '走幅跳', '走高跳', 'ジャベボール投', 'リレー', '1km', '2km', '駅伝'],
  ITEMS: ['ユニフォーム', 'アスリートビブス', '弁当', '水筒', '帽子', 'レジャーシート', 'ベンチコート', 'タオル', '着替え', '雨具'],
  TARGETS: ['全員', '3年生以上', '4年生以上', '希望者'],
  ABSENCE_REASONS: ['体調不良', '家の都合', '学校行事', 'その他'],
  // 大会の手続き（チェックリスト）の種類
  TASKS: ['エントリー控え', '参加費支払い', 'プログラム', '受付', '招集', '進出', 'リレー予選', 'リレー決勝', 'レーン', 'ナンバー', 'リザルト', '陣地'],
  // だれでも報告できる手続き（会場で助け合えるように）。ほかは役員と当番だけ
  OPEN_TASKS: ['招集', '進出', 'レーン', 'ナンバー', 'リザルト', '陣地'],
  ROUNDS: ['予選', '準決勝', '決勝', 'タイムレース'],
  // 大会の申込方法と、資料の種類
  APPLY_HOW: ['Web', 'メール', 'FAX', '郵送', '持参', '当日'],
  DOC_KINDS: ['要項', '申込書', 'プログラム', '地図', 'リザルト', 'その他'],
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
