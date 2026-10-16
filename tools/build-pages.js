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

function build() {
  const values = { key: '', login: '', error: '', home: conf.portalUrl, club: club, apiUrl: conf.apiUrl };
  const src = fs.readFileSync(path.join(root, 'src/Portal.html'), 'utf8');
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
    files.map((f) => '// ===== ' + f + ' =====\n' + fs.readFileSync(path.join(root, 'src', f), 'utf8').trim() + '\n').join('\n');
}

const outputs = [[path.join(root, 'docs/index.html'), build()], [path.join(root, 'dist/Code.gs'), buildGas()]];
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
