// お試しポータル（docs/demo/）の中で動くもの。tools/build-demo.js がこのファイルを埋め込む。
// テスト用の偽サーバー（tests/gas-mock.js と src/*.gs）をブラウザの中で動かし、ダミーの家族20組を入れる。
// 本物のスプレッドシート・LINE・Googleドライブには一切つながらない。
/* global FILES, GAS_MOCK_SRC */
(function () {
  'use strict';

  // ---- MD5（Apps Script の Utilities.computeDigest のまね） ----
  function md5bytes(str) {
    var bytes = Array.from(new TextEncoder().encode(str));
    var K = [], S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
    for (var i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
    var len = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    for (i = 0; i < 8; i++) bytes.push(i < 4 ? (len >>> (8 * i)) & 0xff : 0);
    var a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    for (var off = 0; off < bytes.length; off += 64) {
      var M = [];
      for (i = 0; i < 16; i++) M[i] = bytes[off + i * 4] | (bytes[off + i * 4 + 1] << 8) | (bytes[off + i * 4 + 2] << 16) | (bytes[off + i * 4 + 3] << 24);
      var A = a0, B = b0, C = c0, D = d0;
      for (i = 0; i < 64; i++) {
        var F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; } else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; } else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; } else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        F = (F + A + K[i] + M[g]) >>> 0;
        A = D; D = C; C = B;
        B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) >>> 0;
      }
      a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
    }
    var out = [];
    [a0, b0, c0, d0].forEach(function (w) { for (var j = 0; j < 4; j++) out.push((w >>> (8 * j)) & 0xff); });
    return out;
  }

  // ---- Node の require のかわり（gas-mock.js をそのまま動かすため） ----
  var shim = {
    fs: {
      readFileSync: function (p) { var n = String(p).split('/').pop(); if (!(n in FILES)) throw new Error('no file ' + n); return FILES[n]; },
      readdirSync: function () { return Object.keys(FILES); },
    },
    path: { join: function () { return Array.prototype.slice.call(arguments).join('/'); } },
    crypto: {
      randomUUID: function () { return (self.crypto && self.crypto.randomUUID) ? self.crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, function () { return (Math.random() * 16 | 0).toString(16); }); },
      createHash: function () { var s = ''; var h = { update: function (t) { s += t; return h; }, digest: function (enc) { var b = md5bytes(s); return enc === 'hex' ? b.map(function (x) { return (x < 16 ? '0' : '') + x.toString(16); }).join('') : b; } }; return h; },
    },
    // vm：見えない iframe を Apps Script の「世界」にする（const もふくめて、src/*.gs の上の階層がそのまま使える）
    vm: {
      createContext: function (ctx) {
        var f = document.createElement('iframe');
        f.style.display = 'none';
        document.body.appendChild(f);
        var w = f.contentWindow;
        Object.keys(ctx).forEach(function (k) { w[k] = ctx[k]; });
        ctx.__win = w;
        return ctx;
      },
      runInContext: function (code, ctx) {
        var w = ctx.__win, d = w.document, s = d.createElement('script');
        s.textContent = code.replace(/this\.__run = /, 'window.__run = ');
        d.head.appendChild(s);
        // 関数（doGet・api など）を ctx から呼べるように
        Object.getOwnPropertyNames(w).forEach(function (k) { if (!(k in ctx) && typeof w[k] === 'function') { try { ctx[k] = w[k]; } catch (e) { /* 無視 */ } } });
        ctx.__run = w.__run;
      },
    },
  };
  var module = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', '__dirname', GAS_MOCK_SRC)(function (n) { return shim[n]; }, module, '/tests');
  var createGas = module.exports.createGas;

  // ---- ダミーデータ（名前はすべて架空） ----
  var SEI = ['山田', '佐藤', '鈴木', '高橋', '田中', '伊藤', '渡辺', '中村', '小林', '加藤', '吉田', '山本', '松本', '井上', '木村', '林', '清水', '山口', '森', '池田'];
  var MEI = ['たろう', 'はな', 'けんた', 'さくら', 'ゆうと', 'みお', 'そうた', 'ひなた', 'りく', 'あおい', 'はると', 'ゆい', 'かいと', 'めい', 'こうき', 'りん', 'だいち', 'あかり', 'しょう', 'ここな'];
  function ymd(d) { return new Date(d.getTime() + 9 * 3600000).toISOString().slice(0, 10); }
  function jst(s) { return new Date(s + '+09:00'); }

  function seed() {
    var now = new Date();
    var gas = createGas({ now: now.toISOString() });
    gas.init();
    var today = ymd(now), day = function (n) { return ymd(new Date(now.getTime() + n * 864e5)); };
    // 練習：火・木 17:00〜18:30、土 9:00〜11:00（8週前から6週先まで）
    for (var i = -56; i <= 42; i++) {
      var ds = day(i), wd = new Date(ds + 'T00:00:00Z').getUTCDay();
      if (wd !== 2 && wd !== 4 && wd !== 6) continue;
      gas.calendar.add({ title: '通常練習', start: jst(ds + 'T' + (wd === 6 ? '09:00' : '17:00') + ':00'), end: jst(ds + 'T' + (wd === 6 ? '11:00' : '18:30') + ':00'), location: wd === 6 ? '市民グラウンド' : '第二小学校 校庭' });
    }
    gas.calendar.add({ title: '第3回 お試し記録会', start: jst(day(10) + 'T00:00:00'), end: jst(day(11) + 'T00:00:00'), allDay: true, location: '市営陸上競技場' });
    gas.calendar.add({ title: 'お試しロードレース大会', start: jst(day(31) + 'T00:00:00'), end: jst(day(32) + 'T00:00:00'), allDay: true, location: '運動公園' });
    gas.calendar.add({ title: '秋の陸上競技会', start: jst(day(-20) + 'T00:00:00'), end: jst(day(-19) + 'T00:00:00'), allDay: true, location: '県営陸上競技場' });
    SEI.forEach(function (s, k) {
      var u = 'U' + (k + 1);
      gas.profiles[u] = s + 'ほごしゃ';
      gas.members.add(u);
      gas.line({ type: 'user', userId: u }, '登録 ' + s + MEI[k] + ' ' + ((k % 6) + 1) + '年');
    });
    gas.login('U1');
    gas.sheet('家族').data.forEach(function (r) { if (r[0] === 'U1') r[3] = '○'; });
    var keyOf = {};
    var key = function (u) { return keyOf[u] || (keyOf[u] = gas.login(u).key); };
    var api = function (u, a, p) { return gas.ctx.api(key(u), a, p); };
    SEI.forEach(function (s, k) { api('U' + (k + 1), 'saveChildren', { children: [{ name: s + ' ' + MEI[k], grade: (k % 6) + 1, sex: k % 2 ? '女' : '男' }] }); });
    var st = api('U1', 'bootstrap');
    var race = st.events.find(function (e) { return e.title === '第3回 お試し記録会'; });
    var road = st.events.find(function (e) { return e.title === 'お試しロードレース大会'; });
    var past = st.events.find(function (e) { return e.title === '秋の陸上競技会'; });
    api('U1', 'saveRace', { key: race.key, title: race.title, date: race.date, place: '市営陸上競技場', type: '記録会', target: '全員', fee: 500, deadline: day(5), races: ['100m', '走幅跳', '800m'], items: ['ユニフォーム', 'スパイク', 'ゼッケン', '水筒'], meetTime: '8:00', meetPlace: '正面スタンド下', applyBy: day(7), payBy: day(10) });
    api('U1', 'saveRace', { key: road.key, title: road.title, date: road.date, place: '運動公園', type: '大会', target: '3年生以上', fee: 800, deadline: day(20), races: ['2km', '3km'] });
    api('U1', 'saveRace', { key: past.key, title: past.title, date: past.date, place: '県営陸上競技場', type: '大会', target: '全員', races: ['100m', '走幅跳'] });
    // 当番：過去の練習と大会（前回からの日数がばらばらになるように）、これからの2週間は自動で。その先は空けておく（自動で入れるのを試せる）
    var fams = SEI.map(function (s, k) { return 'U' + (k + 1); });
    var prac = st.events.filter(function (e) { return e.type === '練習' && e.date < today; });
    prac.forEach(function (e, n) { api('U1', 'setDuty', { key: e.key, fam: fams[(n * 7) % fams.length], on: true }); });
    api('U1', 'setDuty', { key: past.key, fam: 'U3', on: true });
    api('U1', 'setDuty', { key: past.key, fam: 'U4', on: true });
    api('U1', 'autoDuty', { type: '練習', days: 14, per: 1 });
    api('U1', 'setDuty', { key: race.key, fam: 'U2', on: true });
    api('U1', 'setDuty', { key: race.key, fam: 'U5', on: true });
    // エントリー（保護者は参加・不参加、種目は役員が登録）
    SEI.forEach(function (s, k) {
      if (k % 5 === 4) return;
      var u = 'U' + (k + 1), name = s + ' ' + MEI[k];
      api(u, 'saveEntry', { key: race.key, child: name, join: k % 7 === 6 ? '不参加' : '参加' });
      if (k % 7 !== 6) api('U1', 'saveEntry', { key: race.key, child: name, join: '参加', races: (k % 6) + 1 >= 3 && k % 3 === 0 ? ['100m', '走幅跳'] : ['100m'] });
    });
    // 時刻表
    api('U1', 'saveTimetable', { key: race.key, rows: [
      { start: '9:30', race: '100m', group: '1・2年男子', call: '9:10' }, { start: '9:40', race: '100m', group: '1・2年女子', call: '9:20' },
      { start: '10:00', race: '100m', group: '3・4年男子', call: '9:40' }, { start: '10:10', race: '100m', group: '3・4年女子', call: '9:50' },
      { start: '10:30', race: '100m', group: '5・6年男子', call: '10:10' }, { start: '10:40', race: '100m', group: '5・6年女子', call: '10:20' },
      { start: '11:00', race: '走幅跳', group: '3〜6年', call: '10:20' }, { start: '13:00', race: '800m', group: '女子', call: '12:40' }, { start: '13:10', race: '800m', group: '男子', call: '12:50' },
    ] });
    // 休み・お知らせ
    var next = st.events.filter(function (e) { return e.type === '練習' && e.date >= today; })[0];
    if (next) [2, 6, 9].forEach(function (k) { api('U' + (k + 1), 'reportAbsence', { child: SEI[k] + ' ' + MEI[k], date: next.date, reason: '体調不良' }); });
    api('U1', 'saveNotice', { title: 'お試しポータルへようこそ', body: 'ここはダミーデータのお試し用です。自由に押して大丈夫です。本物のデータには何も入りません。', important: false });
    return { gas: gas, key: key };
  }

  // ---- 画面（ポータル本体は、本物と同じ Portal.html を中の枠で動かす） ----
  var PEOPLE = [['U1', '山田さん（役員）'], ['U2', '佐藤さん（大会の当番あり）'], ['U4', '高橋さん（保護者）'], ['U7', '渡辺さん（保護者）']];
  var world = null, who = 'U1';
  try { who = sessionStorage.getItem('demoWho') || 'U1'; } catch (e) { /* 無視 */ }
  var bridge = '<script>(function(){var n=0,cb={};window.addEventListener("message",function(e){var d=e.data;if(!d||!d.__demo)return;var c=cb[d.id];if(!c)return;delete cb[d.id];if(d.err)c.ng(new Error(d.err));else c.ok(d.ok);});' +
    'function runner(){var ok=function(){},ng=function(){};var r={withSuccessHandler:function(f){ok=f;return r},withFailureHandler:function(f){ng=f;return r},api:function(k,a,p){var id=++n;cb[id]={ok:ok,ng:ng};parent.postMessage({__demo:1,id:id,k:k,a:a,p:p},"*");}};return r;}' +
    'window.google={script:{get run(){return runner()}}};})();<\/script>';

  function open(u) {
    who = u;
    try { sessionStorage.setItem('demoWho', u); } catch (e) { /* 無視 */ }
    var html = world.gas.login(u).html.replace('<head>', '<head>' + bridge);
    document.getElementById('app').srcdoc = html;
  }
  window.addEventListener('message', function (e) {
    var d = e.data, f = document.getElementById('app');
    if (!d || !d.__demo || e.source !== f.contentWindow) return;
    var res;
    try { res = { ok: JSON.parse(JSON.stringify(world.gas.ctx.api(d.k, d.a, d.p))) }; } catch (err) { res = { err: String(err && err.message || err) }; }
    res.__demo = 1; res.id = d.id;
    setTimeout(function () { f.contentWindow.postMessage(res, '*'); }, 150); // 本物らしく少し待つ
  });
  function start() {
    var sel = document.getElementById('who');
    sel.innerHTML = PEOPLE.map(function (p) { return '<option value="' + p[0] + '">' + p[1] + '</option>'; }).join('');
    sel.value = who;
    sel.addEventListener('change', function () { open(sel.value); });
    document.getElementById('reset').addEventListener('click', function () { if (!confirm('ダミーデータを最初の状態にもどしますか？')) return; world = seed(); open(who); });
    world = seed();
    open(who);
    document.getElementById('loading').hidden = true;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(start, 30); }); else setTimeout(start, 30);
})();
