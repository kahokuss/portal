// Botとのトーク画面の下に出すメニューの画像（docs/richmenu.png, 2500x843）を作る: node tools/build-richmenu.js
// 並びは src/Bot.gs の setupRichMenu() と同じ（上段：新着・今日・休み、下段：カレンダー・メニュー・ポータル）
const path = require('path');
const { chromium } = require('playwright');

const cells = [['🔔', '新着', 'まとめて確認'], ['⏰', '今日', '時刻・招集'], ['🙋', '休み', '休みの連絡'], ['🗓️', 'カレンダー', '日にちを押して予定'], ['☰', 'メニュー', '当番・集金・アンケート'], ['🏃', 'ポータル', 'エントリー・写真']];
const html = '<html><body style="margin:0"><div style="width:2500px;height:843px;display:grid;grid-template-columns:repeat(3,1fr);grid-template-rows:repeat(2,1fr);background:#e9eef0;gap:6px;font-family:\'Noto Sans CJK JP\',\'Noto Sans JP\',sans-serif">' +
  cells.map((c, i) => '<div style="background:' + (i === 5 ? '#c4512f' : '#fff') + ';color:' + (i === 5 ? '#fff' : '#182328') + ';display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px">' +
    '<div style="font-size:120px;line-height:1">' + c[0] + '</div><div style="font-size:96px;font-weight:800">' + c[1] + '</div><div style="font-size:48px;opacity:.7">' + c[2] + '</div></div>').join('') + '</div></body></html>';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 2500, height: 843 } });
  await page.setContent(html);
  await page.screenshot({ path: path.join(__dirname, '..', 'docs', 'richmenu.png') });
  await browser.close();
  console.log('docs/richmenu.png を作りました');
})();
