// お試しポータル（ダミーデータ）を作る: node tools/build-demo.js → docs/demo/index.html
// 本物のサーバーにはつながらない。テスト用の偽サーバー（tests/gas-mock.js）と src/*.gs を、ブラウザの中で動かす。
// --check を付けると、最新かどうかだけ確かめる（テスト用）
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'src');

function build() {
  const files = {};
  fs.readdirSync(src).filter((f) => f.endsWith('.gs') || f === 'Portal.html').sort().forEach((f) => { files[f] = fs.readFileSync(path.join(src, f), 'utf8'); });
  const js = (v) => JSON.stringify(v).replace(/<\//g, '<\\/').replace(/<!--/g, '<\\!--');
  return '<!doctype html>\n<!-- このファイルは tools/build-demo.js が作ります。直接直さないでください -->\n<html lang="ja"><head><meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<meta name="robots" content="noindex">\n<title>お試しポータル（ダミーデータ）</title>\n<style>\n' +
    'html,body{margin:0;height:100%;background:#e9eef0;font-family:"Hiragino Sans","Noto Sans CJK JP",system-ui,sans-serif}\nbody{display:flex;flex-direction:column}\n' +
    '#bar{position:sticky;top:0;z-index:5;display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:6px 10px;background:#6a4fb0;color:#fff;font-size:13px}\n' +
    '#bar b{font-size:14px}#bar select,#bar button{font:inherit;font-size:13px;border:0;border-radius:8px;padding:4px 8px}\n#bar button{background:#fff;color:#6a4fb0;font-weight:700}\n' +
    '#app{display:block;border:0;width:100%;flex:1;min-height:0;background:#e9eef0}\n#loading{padding:24px;text-align:center;color:#5f7079}\n</style></head><body>\n' +
    '<div id="bar"><b>🧪 お試し（ダミーデータ）</b><span>本物のデータには入りません</span><label>だれで見る <select id="who"></select></label><button id="reset" type="button">最初から</button></div>\n' +
    '<div id="loading">ダミーデータを準備しています…</div>\n' +
    '<iframe id="app" title="お試しポータル" sandbox="allow-scripts allow-forms allow-popups allow-modals"></iframe>\n' +
    '<script>var FILES = ' + js(files) + ';\nvar GAS_MOCK_SRC = ' + js(fs.readFileSync(path.join(root, 'tests/gas-mock.js'), 'utf8')) + ';<\/script>\n' +
    '<script>\n' + fs.readFileSync(path.join(__dirname, 'demo-browser.js'), 'utf8') + '<\/script>\n</body></html>\n';
}

const target = path.join(root, 'docs/demo/index.html');
const out = build();
if (process.argv.includes('--check')) {
  const cur = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  if (cur !== out) { console.error('docs/demo/index.html が古いです。node tools/build-demo.js を実行してください'); process.exit(1); }
} else {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, out);
  console.log('docs/demo/index.html を作りました（' + Math.round(out.length / 1024) + 'KB）');
}
