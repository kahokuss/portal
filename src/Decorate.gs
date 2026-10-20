/**
 * スプレッドシートを、PCで直接さわりやすくする（setup() から呼ぶ）。
 *   ・書きかえてよい列の見出しは緑、自動で入る列は灰色。見出しにメモ
 *   ・ID などの裏方の列はかくす
 *   ・自動の列を書きかえようとすると、確認が出る（止めはしない）
 *   ・いちばん前に「使い方」シート、その次に「予定入力」シート
 */
const SHEET_GUIDE = {
  '家族': { edit: ['役員', '休み通知'], hide: ['userId', 'ポータルキー', 'グループ確認', '家族ID', '新着確認'], note: '役員には「役員」に ○。休みの連絡をLINEで受け取る人は「休み通知」に ○（受け取らないなら ×）' },
  '子ども': { edit: ['名前', '学年', '性別'], hide: ['保護者userId'], note: '4月に学年を1つ上げてください。性別は 男 か 女' },
  '予定入力': { edit: ['日付', '開始', '終了', 'タイトル', '場所', '種別', '削除'], hide: ['カレンダーID', '反映内容'], note: '1行に1つの予定。書くとすぐGoogleカレンダーとポータルに入ります' },
  '予定': { edit: [], hide: ['eventKey', 'カレンダーID'], note: 'Googleカレンダーから自動で取り込みます。直すときは「予定入力」シートかポータルで' },
  '大会': { edit: ['種別', '対象', '参加費', '締切', '集合時刻', '集合場所', '種目', '持ち物', '注意', '主催', '申込期限', '申込方法', '支払期限', '受付', '要項URL'], hide: ['eventKey', '手続き期限'], note: '大会の案内。ポータルの「案内を直す」と同じ内容です' },
  'エントリー': { edit: ['回答', '種目', '集金'], hide: ['eventKey'], note: '回答は 参加 / 不参加、集金は 済 か空欄' },
  '休み': { edit: ['理由', 'メモ', '確認'], hide: ['id', '連絡者userId'], note: '' },
  'お知らせ': { edit: ['タイトル', '本文'], hide: ['id', 'eventKey'], note: '' },
  '写真': { edit: [], hide: ['eventKey', 'userId', 'ファイルID'], note: '写真を消すときは、ポータルの「消す」で' },
  '結果': { edit: ['種目', '記録', '順位', 'ラウンド', 'メモ'], hide: ['eventKey', 'userId', 'id'], note: '' },
  'タイムテーブル': { edit: ['開始', '種目', '区分', '組', '招集', 'アップ', 'メモ'], hide: ['id', 'eventKey'], note: '' },
  '手続き': { edit: ['状態', 'メモ'], hide: ['id', 'eventKey', '写真ID'], note: '' },
  '当番': { edit: [], hide: ['eventKey'], note: '当番はポータルの「当番表」か、予定のページで決めてください' },
  'コメント': { edit: ['本文', '場所', '対策'], hide: ['id', 'eventKey', 'userId', '写真ID'], note: 'ヒヤリハットの一覧にも使えます（「種類」で絞り込み）' },
  '資料': { edit: ['種類', '名前', 'URL'], hide: ['id', 'eventKey', 'ファイルID'], note: '' },
  '履歴': { edit: [], hide: ['eventKey'], note: 'だれがいつ何をしたかの記録です' },
  '会計': { edit: ['日付', '種類', '金額', '相手', '但し書き'], hide: ['id', 'eventKey', '写真ID'], note: '' },
};

const GUIDE_ROWS = [
  ['このスプレッドシートは、ポータルとLINE Botのデータです（クラブ共用アカウントのものです）'],
  [''],
  ['■ PCで書きかえてよいところ'],
  ['・見出しが緑の列は、書きかえてOKです。灰色の列は自動で入るので、さわらないでください（さわろうとすると確認が出ます）'],
  ['・「予定入力」シート：練習や大会を1行ずつ書くと、すぐGoogleカレンダーとポータルに入ります。コピー＆貼り付けでまとめて入れられます'],
  ['　　日付：2026-10-20、10/20　　開始・終了：17:00、1700（空なら終日）　　種別：練習・大会・記録会　　削除：○ でカレンダーから消える'],
  ['・「家族」シート：役員に ○、休みの連絡を受け取る人に ○'],
  ['・「子ども」シート：名前の書き間違い、4月の学年の繰り上げ、男女'],
  [''],
  ['■ 注意'],
  ['・見出し（1行目）の名前や、列の順番は変えないでください'],
  ['・かくしてある列（ID など）は、つながりを保つためのものです。表示しても書きかえないでください'],
  ['・日付は 2026-10-20、時刻は 17:00 の形で書くと確実です'],
  ['・まちがえたら「ファイル → 変更履歴」で前の状態に戻せます'],
  ['・写真や資料のファイルは、ドライブで直接消さず、ポータルの「消す」を使ってください'],
];

function decorateSheets_() {
  const ss = ss_();
  Object.keys(SHEETS).forEach((k) => {
    const def = SHEETS[k];
    const guide = SHEET_GUIDE[def.name];
    if (!guide) return;
    try {
      decorateSheet_(sheet_(def), def, guide);
    } catch (err) {
      console.warn('シートの見た目を整えられませんでした: ' + def.name + ' ' + err);
    }
  });
  try {
    let g = ss.getSheetByName('使い方');
    if (!g) g = ss.insertSheet('使い方');
    g.getRange(1, 1, GUIDE_ROWS.length, 1).setValues(GUIDE_ROWS);
    g.getRange(1, 1).setFontWeight('bold');
    g.setColumnWidth(1, 900);
    g.setTabColor('#2f6fae');
    ss.setActiveSheet(g);
    ss.moveActiveSheet(1);
    const input = ss.getSheetByName(SHEETS.SCHEDULE_INPUT.name);
    if (input) {
      input.setTabColor('#237a55');
      ss.setActiveSheet(input);
      ss.moveActiveSheet(2);
      const col = (h) => SHEETS.SCHEDULE_INPUT.headers.indexOf(h) + 1;
      const rows = Math.max(1, input.getMaxRows() - 1);
      input.getRange(2, col('種別'), rows, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['練習', '大会', '記録会'], true).setAllowInvalid(true).build());
      input.getRange(2, col('削除'), rows, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['○'], true).setAllowInvalid(true).build());
    }
    ss.setActiveSheet(g);
  } catch (err) {
    console.warn('使い方シートを作れませんでした: ' + err);
  }
}

function decorateSheet_(sh, def, guide) {
  const n = def.headers.length;
  def.headers.forEach((h, i) => {
    const editable = guide.edit.indexOf(h) >= 0;
    const cell = sh.getRange(1, i + 1);
    cell.setBackground(editable ? '#d9ead3' : '#eeeeee');
    cell.setNote(editable ? '書きかえてOK' + (i === 0 && guide.note ? '\n' + guide.note : '') : '自動で入ります。さわらないでください' + (i === 0 && guide.note ? '\n' + guide.note : ''));
  });
  if (guide.note) sh.getRange(1, 1).setNote(guide.note);
  // 前に付けた「自動の列」の保護をはずしてから付け直す（確認が出るだけで、止めはしない）
  sh.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach((p) => {
    if (String(p.getDescription()).indexOf('自動で入る列') === 0) p.remove();
  });
  def.headers.forEach((h, i) => {
    if (guide.edit.indexOf(h) >= 0) return;
    sh.getRange(1, i + 1, sh.getMaxRows(), 1).protect().setDescription('自動で入る列：' + h).setWarningOnly(true);
  });
  sh.getRange(1, 1, 1, n).protect().setDescription('自動で入る列：見出し').setWarningOnly(true);
  guide.hide.forEach((h) => {
    const i = def.headers.indexOf(h);
    if (i >= 0) sh.hideColumns(i + 1);
  });
}
