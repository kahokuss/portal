// src/Portal.html から GitHub Pages 用の docs/index.html を作る: node tools/build-pages.js
// Apps Script のテンプレートの部分（<?!= … ?>）を、決まった値に置きかえるだけ。
// --check を付けると、docs/index.html が最新かどうかだけ確かめる（テスト用）
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

const target = path.join(root, 'docs/index.html');
const html = build();
if (process.argv.includes('--check')) {
  const cur = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  if (cur !== html) { console.error('docs/index.html が古いです。node tools/build-pages.js を実行してください'); process.exit(1); }
  console.log('docs/index.html は最新です');
} else {
  fs.writeFileSync(target, html);
  console.log('docs/index.html を作りました');
}
