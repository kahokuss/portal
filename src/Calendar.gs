/**
 * カレンダーの予定に対応するキー。
 * 繰り返し予定は各回が同じ ID を持つので日付を足して区別する。
 */
function eventKey_(calEvent) {
  let base = calEvent.getId();
  if (calEvent.isRecurringEvent()) base += '|' + fmt_(calEvent.getStartTime(), 'yyyy-MM-dd');
  return md5Hex_(base).slice(0, 12);
}

function calendar_() {
  const calendar = CalendarApp.getCalendarById(requireProp_('CALENDAR_ID'));
  if (!calendar) throw new Error('カレンダーが見つかりません。CALENDAR_ID と共有設定を確認してください');
  return calendar;
}

/** 予定名から種別を判断する */
function guessType_(title) {
  return CONFIG.RACE_KEYWORDS.test(title) ? '大会' : '練習';
}

function calEventToRow_(ce) {
  const allDay = ce.isAllDayEvent();
  return {
    eventKey: eventKey_(ce),
    '日付': fmt_(allDay ? ce.getAllDayStartDate() : ce.getStartTime(), 'yyyy-MM-dd'),
    '開始': allDay ? '終日' : fmt_(ce.getStartTime(), 'HH:mm'),
    '終了': allDay ? '' : fmt_(ce.getEndTime(), 'HH:mm'),
    'タイトル': ce.getTitle(),
    '場所': ce.getLocation(),
    'カレンダーID': ce.getId(),
  };
}

const EVENT_FIELDS = ['日付', '開始', '終了', 'タイトル', '場所'];

function syncRange_() {
  const today = today_();
  const first = addDays_(today, -CONFIG.SYNC_DAYS_BEFORE);
  const last = addDays_(today, CONFIG.SYNC_DAYS_AHEAD);
  return { first: first, last: last, start: new Date(first + 'T00:00:00+09:00'), end: new Date(addDays_(last, 1) + 'T00:00:00+09:00') };
}

/** Google カレンダーの予定を「予定」シートに取り込む */
function syncCalendar_() {
  const range = syncRange_();
  return withLock_(() => {
    const rows = readRows_(SHEETS.EVENTS);
    const byKey = {};
    rows.forEach((r) => (byKey[r.eventKey] = r));
    const seen = {};

    calendar_().getEvents(range.start, range.end).forEach((ce) => {
      const data = calEventToRow_(ce);
      seen[data.eventKey] = true;
      const row = byKey[data.eventKey];
      if (!row) {
        appendRow_(SHEETS.EVENTS, Object.assign(data, { '種別': guessType_(data['タイトル']), '状態': '予定', '更新日時': now_() }));
        return;
      }
      const changed = EVENT_FIELDS.some((f) => row[f] !== data[f]);
      if (!changed && row['状態'] !== '中止') return;
      Object.assign(row, data, { '状態': '予定', '更新日時': now_() });
      if (!row['種別']) row['種別'] = guessType_(row['タイトル']);
      updateRow_(SHEETS.EVENTS, row);
    });

    // 期間内なのにカレンダーから消えた予定は中止扱い
    rows.forEach((r) => {
      if (seen[r.eventKey] || r['状態'] === '中止') return;
      if (r['日付'] < range.first || r['日付'] > range.last) return;
      r['状態'] = '中止';
      r['更新日時'] = now_();
      updateRow_(SHEETS.EVENTS, r);
    });
    setProp_('LAST_SYNC', String(Date.now()));
  });
}

/** 前回の同期から時間がたっていればカレンダーを読み直す */
function syncIfStale_() {
  const last = Number(prop_('LAST_SYNC') || 0);
  if (Date.now() - last < CONFIG.SYNC_INTERVAL_MINUTES * 60000) return;
  try {
    syncCalendar_();
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
  }
}

/**
 * ポータルで作った・直した大会をカレンダーにも反映し、「予定」シートの行を返す。
 * 大会はカレンダーでは終日の予定にする（集合時刻などはポータル側で持つ）。
 */
function upsertRaceEvent_(eventKey, title, date, place) {
  const cal = calendar_();
  const d = new Date(date + 'T00:00:00+09:00');
  let row = eventKey ? findEvent_(eventKey) : null;
  if (row) {
    const ce = cal.getEventById(row['カレンダーID']);
    if (ce && !ce.isRecurringEvent()) {
      ce.setTitle(title);
      ce.setLocation(place || '');
      ce.setAllDayDate(d);
    }
    Object.assign(row, { '日付': date, '開始': '終日', '終了': '', 'タイトル': title, '場所': place || '', '種別': '大会', '状態': '予定', '更新日時': now_() });
    updateRow_(SHEETS.EVENTS, row);
    return row;
  }
  const ce = cal.createAllDayEvent(title, d, { location: place || '' });
  const data = calEventToRow_(ce);
  return appendRow_(SHEETS.EVENTS, Object.assign(data, { '種別': '大会', '状態': '予定', '更新日時': now_() }));
}
