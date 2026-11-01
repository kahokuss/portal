/**
 * 参考動画：トレーニングの参考になる動画のリンク（YouTube など）を、クラブのみんなで集める。
 * だれでも足せる。消せるのは足した人と役員。目標の「やること」に動画を付けると、今日やることから開ける。
 */

const VIDEO_KINDS = ['走り方', 'スタート', 'ダッシュ', '跳躍', '投てき', '筋トレ・体幹', 'ストレッチ', 'なわとび', 'その他'];

/** YouTube の動画ID（watch?v= / youtu.be / shorts / live / embed）。なければ空 */
function youtubeId_(url) {
  const m = String(url || '').match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : '';
}

function videosFor_(ctx) {
  return readRows_(SHEETS.VIDEOS).filter((v) => v.id && v.URL).reverse().map((v) => ({ id: v.id, url: v.URL, yt: youtubeId_(v.URL), title: v['タイトル'], kind: v['種類'], memo: v['メモ'], by: v['追加者'], mine: v.userId === ctx.userId, at: String(v['日時']).slice(0, 10) }));
}

function addVideoAction_(ctx, p) {
  const url = String(p.url || '').trim().replace(/\s.*$/, '');
  if (!/^https?:\/\/[^\s]+$/.test(url)) throw new Error('動画のリンク（https:// から始まるURL）を貼ってください。');
  if (readRows_(SHEETS.VIDEOS).some((v) => v.id && (v.URL === url || (youtubeId_(url) && youtubeId_(v.URL) === youtubeId_(url))))) throw new Error('この動画はもう入っています。');
  let title = String(p.title || '').trim().slice(0, 80);
  if (!title && youtubeId_(url)) {
    // YouTube の題名を取ってくる（取れなければ「YouTube の動画」）
    try {
      const res = UrlFetchApp.fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(url), { muteHttpExceptions: true });
      if (res.getResponseCode() === 200) title = String(JSON.parse(res.getContentText()).title || '').slice(0, 80);
    } catch (err) { console.warn(err); }
  }
  withLock_(() => appendRow_(SHEETS.VIDEOS, {
    id: randomKey_().slice(0, 10), URL: url.slice(0, 300), 'タイトル': title || (youtubeId_(url) ? 'YouTube の動画' : '参考動画'),
    '種類': VIDEO_KINDS.indexOf(p.kind) >= 0 ? p.kind : 'その他', 'メモ': String(p.memo || '').slice(0, 200), '追加者': ctx.name, userId: ctx.userId, '日時': now_(),
  }));
  return '参考動画を足しました' + (title ? '：' + title : '');
}

function deleteVideoAction_(ctx, p) {
  withLock_(() => {
    const v = readRows_(SHEETS.VIDEOS).find((x) => x.id && x.id === p.id);
    if (!v) throw new Error('動画が見つかりません。');
    if (v.userId !== ctx.userId && !ctx.admin) throw new Error('消せるのは、足した人と役員です。');
    clearRow_(SHEETS.VIDEOS, v);
  });
  return '参考動画を消しました';
}
