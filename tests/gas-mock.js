// Apps Script のサービス（スプレッドシート・カレンダー・LINE API など）をメモリ上でまねる。
// src/*.gs をそのまま読み込んで、Node.js でサーバー側の動きを確かめるために使う。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const SRC = path.join(__dirname, '..', 'src');

function tokyoParts(date) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const o = {};
  f.formatToParts(date).forEach((p) => (o[p.type] = p.value));
  return o;
}

function formatDate(date, tz, pattern) {
  const p = tokyoParts(date);
  return pattern
    .replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day)
    .replace('HH', p.hour).replace(/(^|[^H])H(?!H)/, (m, a) => a + String(Number(p.hour)))
    .replace('mm', p.minute).replace('ss', p.second);
}

class Range {
  constructor(sheet, r, c, nr, nc) { Object.assign(this, { sheet, r, c, nr: nr || 1, nc: nc || 1 }); }
  setValues(vals) {
    vals.forEach((row, i) => row.forEach((v, j) => {
      const rr = this.r + i;
      while (this.sheet.data.length < rr) this.sheet.data.push([]);
      this.sheet.data[rr - 1][this.c + j - 1] = v;
    }));
    return this;
  }
  getValues() {
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const row = this.sheet.data[this.r + i - 1] || [];
      const vals = [];
      for (let j = 0; j < this.nc; j++) vals.push(row[this.c + j - 1] === undefined ? '' : row[this.c + j - 1]);
      out.push(vals);
    }
    return out;
  }
  setNumberFormat() { return this; }
  setFontWeight() { return this; }
}

class Sheet {
  constructor(name) { this.name = name; this.data = []; this.maxRows = 1000; }
  getName() { return this.name; }
  getRange(r, c, nr, nc) {
    if (r + (nr || 1) - 1 > this.maxRows) throw new Error('範囲がシートの外です');
    return new Range(this, r, c, nr, nc);
  }
  getLastRow() {
    for (let i = this.data.length; i > 0; i--) if ((this.data[i - 1] || []).some((v) => v !== '' && v !== undefined)) return i;
    return 0;
  }
  getMaxRows() { return this.maxRows; }
  insertRowsAfter(after, n) { this.maxRows += n; }
  setFrozenRows() {}
  // テスト用：見出しをキーにしたオブジェクトで返す
  rows() {
    const [head, ...rest] = this.data;
    return rest.filter((r) => r && r.some((v) => v !== '')).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] === undefined ? '' : r[i]])));
  }
}

class Spreadsheet {
  constructor(id, name) { this.id = id; this.name = name; this.sheets = [new Sheet('シート1')]; }
  getId() { return this.id; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this.id; }
  getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
  insertSheet(n) { const s = new Sheet(n); this.sheets.push(s); return s; }
  getSheets() { return this.sheets.slice(); }
  deleteSheet(s) { this.sheets = this.sheets.filter((x) => x !== s); }
}

class CalEvent {
  constructor(cal, o) { this.cal = cal; Object.assign(this, o); }
  getId() { return this.id; }
  isRecurringEvent() { return false; }
  isAllDayEvent() { return !!this.allDay; }
  getAllDayStartDate() { return this.start; }
  getStartTime() { return this.start; }
  getEndTime() { return this.end; }
  getTitle() { return this.title; }
  getLocation() { return this.location || ''; }
  setTitle(t) { this.title = t; return this; }
  setLocation(l) { this.location = l; return this; }
  setAllDayDate(d) { this.start = d; this.end = new Date(d.getTime() + 86400000); return this; }
}

class Calendar {
  constructor() { this.events = []; this.seq = 0; }
  add(o) { const e = new CalEvent(this, Object.assign({ id: 'cal' + (++this.seq) + '@google.com' }, o)); this.events.push(e); return e; }
  getEvents(start, end) { return this.events.filter((e) => e.start < end && e.end > start).sort((a, b) => a.start - b.start); }
  createAllDayEvent(title, date, opt) { return this.add({ title, start: date, end: new Date(date.getTime() + 86400000), allDay: true, location: (opt && opt.location) || '' }); }
  getEventById(id) { return this.events.find((e) => e.id === id) || null; }
}

/**
 * @param {{now?: string}} options now はテスト中の「現在時刻」
 */
function createGas(options) {
  const NOW = new Date((options && options.now) || '2026-10-14T09:00:00+09:00').getTime();
  class FakeDate extends Date {
    constructor(...a) { if (a.length === 0) super(NOW); else super(...a); }
    static now() { return NOW; }
  }
  const props = {};
  const spreadsheets = {};
  const calendar = new Calendar();
  const fetches = [];
  const cache = {};
  const profiles = {};
  const members = new Set();

  const ctx = {
    console: { log() {}, warn() {}, error: (...a) => ctx.__errors.push(a.join(' ')) },
    __errors: [],
    Date: FakeDate,
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); } }) },
    SpreadsheetApp: {
      openById: (id) => { if (!spreadsheets[id]) throw new Error('no spreadsheet ' + id); return spreadsheets[id]; },
      create: (name) => { const id = 'ss' + Object.keys(spreadsheets).length; spreadsheets[id] = new Spreadsheet(id, name); return spreadsheets[id]; },
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: (k) => cache[k] || null, put: (k, v) => { cache[k] = v; }, remove: (k) => { delete cache[k]; } }) },
    Utilities: {
      formatDate,
      getUuid: () => crypto.randomUUID(),
      computeDigest: (alg, s) => Array.from(crypto.createHash('md5').update(s, 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b)),
      DigestAlgorithm: { MD5: 'MD5' },
      Charset: { UTF_8: 'UTF-8' },
    },
    CalendarApp: { getCalendarById: (id) => (id === props.CALENDAR_ID ? calendar : null) },
    UrlFetchApp: {
      fetch: (url, opt) => {
        const raw = opt && opt.payload;
        const payload = typeof raw === 'string' ? JSON.parse(raw) : raw || null;
        fetches.push({ url, method: opt && opt.method, payload });
        const res = (code, obj) => ({ getResponseCode: () => code, getContentText: () => JSON.stringify(obj), getBlob: () => ({ getContentType: () => 'image/jpeg', setName() { return this; } }) });
        // LINE ログイン：code は「login:<userId>」の形にしておく
        if (/oauth2\/v2\.1\/token$/.test(url)) {
          const m = String(payload.code).match(/^login:(.+)$/);
          return m ? res(200, { id_token: 'idtoken:' + m[1] }) : res(400, { error: 'invalid_grant' });
        }
        if (/oauth2\/v2\.1\/verify$/.test(url)) {
          const u = String(payload.id_token).replace('idtoken:', '');
          return res(200, { sub: u, name: profiles[u] || '保護者' });
        }
        const gm = url.match(/\/group\/([^/]+)\/member\/([^/]+)$/);
        if (gm) return members.has(gm[2]) ? res(200, { displayName: profiles[gm[2]] || '保護者' }) : res(404, { message: 'Not found' });
        const m = url.match(/\/profile\/([^/]+)$/);
        return res(200, m ? { displayName: profiles[m[1]] || '保護者' } : {});
      },
    },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (t) => { const o = { text: t, setMimeType: () => o }; return o; } },
    ScriptApp: { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/TEST/exec' }) },
    Session: { getActiveUser: () => ({ getEmail: () => '' }), getEffectiveUser: () => ({ getEmail: () => 'club@example.com' }) },
    HtmlService: {
      createTemplateFromFile: (name) => {
        const t = {
          evaluate() {
            const html = fs.readFileSync(path.join(SRC, name + '.html'), 'utf8').replace(/<\?!=\s*JSON\.stringify\((\w+)\)\s*\?>/g, (m, v) => JSON.stringify(t[v] === undefined ? '' : t[v]).replace(/</g, '\\u003c'));
            const out = { getContent: () => html, setTitle: () => out, addMetaTag: () => out };
            return out;
          },
        };
        return t;
      },
    },
    DriveApp: { getFolderById: () => ({ getUrl: () => 'https://drive.google.com/drive/folders/TEST' }) },
  };
  vm.createContext(ctx);
  const code = fs.readdirSync(SRC).filter((f) => f.endsWith('.gs')).sort().map((f) => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n;\n');
  vm.runInContext(code + '\n;this.__run = (src) => eval(src);', ctx, { filename: 'gas.js' });

  const gas = {
    ctx,
    props,
    calendar,
    fetches,
    profiles,
    members,
    cache,
    run: (src) => ctx.__run(src),
    sheet: (name) => { const ss = spreadsheets[props.SPREADSHEET_ID]; return ss && ss.getSheetByName(name); },
    rows: (name) => { const s = gas.sheet(name); return s ? s.rows() : []; },
    /** 初期設定：スプレッドシートを作り、シートを用意する */
    init() {
      props.LINE_CHANNEL_ACCESS_TOKEN = 'test-token';
      props.CALENDAR_ID = 'club-calendar';
      props.WEBHOOK_TOKEN = 'hook';
      props.PHOTO_FOLDER_ID = 'folder';
      props.GROUP_ID = 'G1';
      props.LINE_LOGIN_CHANNEL_ID = 'login-channel';
      props.LINE_LOGIN_CHANNEL_SECRET = 'login-secret';
      props.SPREADSHEET_ID = ctx.SpreadsheetApp.create('test').getId();
      ctx.__run('Object.keys(SHEETS).forEach((k) => sheet_(SHEETS[k]))');
    },
    /** LINE からのメッセージを1件受け取ったことにする。返信された文章を返す */
    line(source, text) {
      const before = fetches.length;
      const ev = { type: 'message', webhookEventId: crypto.randomUUID(), replyToken: 'r', timestamp: NOW, source, message: { type: 'text', id: 'm', text } };
      ctx.doPost({ parameter: { token: props.WEBHOOK_TOKEN }, postData: { contents: JSON.stringify({ events: [ev] }) } });
      return fetches.slice(before).filter((f) => /reply$/.test(f.url)).map((f) => f.payload.messages.map((m) => m.text).join('\n')).join('\n');
    },
    pushes() { return fetches.filter((f) => /push$/.test(f.url)); },
    /** LINE ログインして戻ってきたことにする。ポータルのキー（または null）とエラー文を返す */
    login(userId) {
      const html = ctx.doGet({ parameter: {} }).getContent();
      const state = decodeURIComponent((html.match(/state=([A-Za-z0-9]+)/) || [])[1] || '');
      const out = ctx.doGet({ parameter: { code: 'login:' + userId, state } }).getContent();
      const key = JSON.parse(out.match(/var KEY = (".*?");/)[1]);
      const error = JSON.parse(out.match(/var LOGIN_ERROR = (".*?");/)[1]);
      return { key: key || null, error, html: out };
    },
  };
  return gas;
}

module.exports = { createGas };
