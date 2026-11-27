// src/ から次の2つを作る: node tools/build-pages.js
//   docs/index.html … GitHub Pages の画面。Portal.html のテンプレートの部分（<?!= … ?>）を決まった値に置きかえる
//   dist/Code.gs    … Apps Script のエディタの「コード.gs」に、まるごと貼り付ける1つのファイル（src/*.gs をつなげたもの）
// --check を付けると、どちらも最新かどうかだけ確かめる（テスト用）
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const conf = JSON.parse(fs.readFileSync(path.join(root, 'pages.config.json'), 'utf8'));
const configGs = fs.readFileSync(path.join(root, 'src/Config.gs'), 'utf8');
const club = (configGs.match(/CLUB_NAME:\s*'([^']+)'/) || [])[1];
if (!club) throw new Error('Config.gs の CLUB_NAME が見つかりません');

// サーバー（src/*.gs）の版。画面にも同じ値を入れて、Apps Script が古いままなら画面で知らせる
const gsFiles = fs.readdirSync(path.join(root, 'src')).filter((f) => f.endsWith('.gs')).sort();
const serverVersion = require('crypto').createHash('md5').update(gsFiles.map((f) => fs.readFileSync(path.join(root, 'src', f), 'utf8')).join('\n')).digest('hex').slice(0, 10);

// 保護者ポータル（軽い版）から外す、役員だけの画面（関数ごと。次の関数の手前まで消す）
const STAFF_ONLY = ['staffHome', 'adminResPick', 'adminTmPick', 'fyOf', 'moneyFy', 'moneySummaryCard', 'moneyGuideCard', 'adminBudget', 'dutyFlowInfo', 'dutyFlowCard', 'bindDutyFlow', 'myRoleText', 'roleOwner', 'opsChecks', 'opsItem', 'opsCard', 'bindOps', 'adminOps', 'adminTestFam', 'adminNotes', 'adminDutyCal', 'shortFam', 'fyStart', 'fyEnd', 'fyDuties',
  'adminDuty', 'parseDutyTable', 'adminNotify', 'adminTable', 'adminRecords', 'adminMembers', 'adminLedger', 'adminSheet', 'adminPractice', 'adminFees', 'adminPolls', 'adminNotice', 'adminAbsences', 'adminNearMiss', 'adminRoster', 'updateCard'];
function stripStaff(src) {
  const starts = []; const re = /\n  function (\w+)\(/g; let m;
  while ((m = re.exec(src))) starts.push([m[1], m.index]);
  let out = '', pos = 0;
  starts.forEach((x, i) => {
    if (STAFF_ONLY.indexOf(x[0]) < 0) return;
    const end = i + 1 < starts.length ? starts[i + 1][1] : src.length;
    // 次の関数の説明コメント（/** … */ や // …）は残す
    let body = src.slice(x[1], end), keep = '';
    const tail = body.match(/\n(\s*(\/\*\*[\s\S]*?\*\/|\/\/[^\n]*)\s*)+$/);
    if (tail) { keep = tail[0]; body = body.slice(0, body.length - keep.length); }
    // 関数のあとに置いた var（表など）も残す（ほかから使われているかもしれないので）
    const vars = (body.match(/\n  var [^\n]*(\n    [^\n]*)*/g) || []).filter((v) => !/^\n  var \w+ = function/.test(v)).join('');
    out += src.slice(pos, x[1]) + '\n  // （役員ページだけ：' + x[0] + '）' + vars + keep;
    pos = end;
  });
  return out + src.slice(pos);
}
function build(lite) {
  let src = fs.readFileSync(path.join(root, 'src/Portal.html'), 'utf8');
  const build = require('crypto').createHash('md5').update(src + JSON.stringify(conf) + club).digest('hex').slice(0, 10);
  if (lite) src = stripStaff(src);
  const values = { key: '', login: '', error: '', home: conf.portalUrl, club: club, apiUrl: conf.apiUrl, build: build, server: serverVersion, lite: !!lite };
  const out = src.replace(/<\?!=\s*JSON\.stringify\((\w+)\)\s*\?>/g, (m, name) => {
    if (!(name in values)) throw new Error('値が決まっていません: ' + name);
    return JSON.stringify(values[name]).replace(/</g, '\\u003c');
  });
  if (/<\?/.test(out)) throw new Error('Apps Script のテンプレートの部分が残っています');
  return '<!-- このファイルは tools/build-pages.js が src/Portal.html から作ります。直接直さないでください -->\n' +
    out.replace('<head>', '<head>\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<title>' + club + ' ポータル</title>');
}

function buildGas() {
  const files = fs.readdirSync(path.join(root, 'src')).filter((f) => f.endsWith('.gs')).sort();
  return '// ' + club + ' ポータル（Apps Script）。このファイルは tools/build-pages.js が src/*.gs をつなげて作ります。\n' +
    '// 更新のしかた：Apps Script のエディタで「コード.gs」の中身を全部消して、このファイルの中身を全部貼り付け、保存します。\n' +
    '// そのあと「デプロイ」→「デプロイを管理」→ 鉛筆 →「新バージョン」→「デプロイ」。\n\n' +
    files.map((f) => '// ===== ' + f + ' =====\n' + fs.readFileSync(path.join(root, 'src', f), 'utf8').trim().replace("const SERVER_VERSION = 'dev';", "const SERVER_VERSION = '" + serverVersion + "';") + '\n').join('\n');
}

const outputs = [[path.join(root, 'docs/index.html'), build(true)], [path.join(root, 'docs/staff/index.html'), build(false).replace('<title>' + club + ' ポータル</title>', '<title>' + club + ' 役員ページ</title>\n<meta name="theme-color" content="#3d2a78">')], [path.join(root, 'dist/Code.gs'), buildGas()]];
outputs.forEach(([target, text]) => {
  const rel = path.relative(root, target);
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    if (cur !== text) { console.error(rel + ' が古いです。node tools/build-pages.js を実行してください'); process.exit(1); }
    console.log(rel + ' は最新です');
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
    console.log(rel + ' を作りました');
  }
});

// お試しポータル（ダミーデータ）も、いっしょに作り直す（--check のときは最新かどうかだけ）
require('./build-demo.js');
