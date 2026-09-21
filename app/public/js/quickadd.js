// Turns "Soccer Tue 5pm @Sam at Riverside Park" into event fields. Pure (no DOM), English only.

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_WORD = '(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|rsday|urday|sday)?';
const MONTH_WORD = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());
const weekdayIndex = (word) => WEEKDAYS.indexOf(word.slice(0, 3).toLowerCase());

/** Hour 1–12 without am/pm: guess the likely one for a family calendar (8–11 → am, otherwise pm). */
function guessHour(hour) {
  if (hour >= 13) return hour;
  if (hour === 12) return 12;
  return hour >= 8 ? hour : hour + 12;
}

function toHour(hour, meridiem) {
  const h = Number(hour);
  if (!meridiem) return null;
  const pm = meridiem.toLowerCase().startsWith('p');
  if (h === 12) return pm ? 12 : 0;
  return pm ? h + 12 : h;
}

/**
 * @returns {{ title, allDay, start: Date, end: Date, rrule: string|null, location: string, calendarId: string|null, understood: string[] }}
 * For all-day results `end` is the (exclusive) day after the last day.
 */
export function parseQuickAdd(input, { now = new Date(), calendars = [], members = [], dayFirst = false } = {}) {
  let text = ` ${String(input || '').replace(/\s+/g, ' ').trim()} `;
  const understood = [];
  const take = (re) => {
    const m = text.match(re);
    if (!m) return null;
    text = `${text.slice(0, m.index)} ${text.slice(m.index + m[0].length)}`;
    return m;
  };

  // --- Who / which calendar: "@Sam" -------------------------------------------------
  let calendarId = null;
  const writable = calendars.filter((c) => c.writable);
  const at = text.match(/\s@([\p{L}\d_'’-]+)/u);
  if (at) {
    const name = at[1].toLowerCase();
    const member = members.find((m) => m.name.toLowerCase().startsWith(name));
    const cal = (member && writable.find((c) => c.memberId === member.id)) || writable.find((c) => c.name.toLowerCase().startsWith(name));
    if (cal) {
      calendarId = cal.id;
      take(/\s@([\p{L}\d_'’-]+)/u);
      understood.push(`calendar:${cal.name}`);
    }
  }

  // --- Repeats ----------------------------------------------------------------------------
  let rrule = null;
  let repeatDays = null;
  let m = take(new RegExp(`\\s(?:every|each)\\s+((?:${DAY_WORD}s?(?:\\s*(?:,|and|&)\\s*)?)+)(?=\\s)`, 'i'));
  if (m) {
    repeatDays = [...m[1].matchAll(new RegExp(DAY_WORD, 'gi'))].map((x) => weekdayIndex(x[1]));
    rrule = `FREQ=WEEKLY;BYDAY=${[...new Set(repeatDays)].sort().map((i) => CODES[i]).join(',')}`;
  } else if ((m = take(/\s(?:every|each)\s+(other\s+week|weekday|weekdays|day|week|month|year)(?=\s)/i) || take(/\s(daily|weekly|monthly|yearly|annually|weekdays)(?=\s)/i))) {
    const word = m[1].toLowerCase().replace(/\s+/g, ' ');
    rrule = {
      day: 'FREQ=DAILY',
      daily: 'FREQ=DAILY',
      weekday: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
      weekdays: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
      week: 'FREQ=WEEKLY',
      weekly: 'FREQ=WEEKLY',
      'other week': 'FREQ=WEEKLY;INTERVAL=2',
      month: 'FREQ=MONTHLY',
      monthly: 'FREQ=MONTHLY',
      year: 'FREQ=YEARLY',
      yearly: 'FREQ=YEARLY',
      annually: 'FREQ=YEARLY',
    }[word];
    if (word.startsWith('weekday')) repeatDays = [1, 2, 3, 4, 5];
  }
  if (rrule) understood.push('repeat');

  // --- All day -----------------------------------------------------------------------------
  let allDay = Boolean(take(/\sall[- ]?day(?=\s)/i));

  // --- Dates -------------------------------------------------------------------------------
  const today = startOfDay(now);
  let date = null;
  let lastDate = null; // for ranges like "Oct 3-5"
  let tonight = false;
  if ((m = take(/\s(today|tonight|tomorrow|tmrw|tmr)(?=\s)/i))) {
    date = /^to(day|night)$/i.test(m[1]) ? today : addDays(today, 1);
    tonight = m[1].toLowerCase() === 'tonight';
  } else if ((m = take(new RegExp(`\\s(?:on\\s+)?(next\\s+)?${DAY_WORD}(?=\\s)`, 'i')))) {
    const target = weekdayIndex(m[2]);
    let diff = (target - today.getDay() + 7) % 7;
    if (m[1]) {
      if (diff === 0) diff = 7;
      if (diff < 7) diff += 7;
    }
    date = addDays(today, diff);
  } else if ((m = take(new RegExp(`\\s(?:on\\s+)?${MONTH_WORD}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*(?:-|–|to|through|thru)\\s*(?:${MONTH_WORD}\\s+)?(\\d{1,2})(?:st|nd|rd|th)?)?(?:,?\\s+(\\d{4}))?(?=\\s)`, 'i')))) {
    const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    const year = m[5] ? Number(m[5]) : today.getFullYear();
    date = new Date(year, month, Number(m[2]));
    if (!m[5] && date < addDays(today, -30)) date = new Date(year + 1, month, Number(m[2]));
    if (m[4]) {
      const endMonth = m[3] ? MONTHS.indexOf(m[3].slice(0, 3).toLowerCase()) : month;
      lastDate = new Date(date.getFullYear() + (endMonth < month ? 1 : 0), endMonth, Number(m[4]));
    }
  } else if ((m = take(/\s(?:on\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?=\s)/))) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    const [month, day] = dayFirst ? [b, a] : [a, b];
    let year = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : today.getFullYear();
    date = new Date(year, month - 1, day);
    if (!m[3] && date < addDays(today, -30)) date = new Date(++year, month - 1, day);
  } else if ((m = take(/\s(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)(?=\s)/i))) {
    date = new Date(today.getFullYear(), today.getMonth(), Number(m[1]));
    if (date < today) date = new Date(today.getFullYear(), today.getMonth() + 1, Number(m[1]));
  } else if ((m = take(/\sin\s+(\d+)\s+(day|days|week|weeks)(?=\s)/i))) {
    date = addDays(today, Number(m[1]) * (m[2].startsWith('week') ? 7 : 1));
  }
  if (date) understood.push('date');

  // --- Times -------------------------------------------------------------------------------
  let startTime = null; // [hour, minute]
  let endTime = null;
  m = take(/\s(?:from\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|a|p)?\s*(?:-|–|to|until|till)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|a|p)?(?=\s)/i);
  const bareOk = m && !(m[3] || m[6] || m[2] || m[5]) && date && Number(m[1]) <= 12 && Number(m[4]) <= 12;
  if (m && (m[3] || m[6] || m[2] || m[5] || bareOk)) {
    let h1 = toHour(m[1], m[3]);
    let h2 = toHour(m[4], m[6]);
    if (h2 !== null && h1 === null) {
      // "5-6pm" → both pm; "11-1pm" → 11am.
      const pm = m[6].toLowerCase().startsWith('p');
      h1 = toHour(m[1], Number(m[1]) <= Number(m[4]) || Number(m[4]) === 12 ? m[6] : pm ? 'am' : 'pm');
      if (Number(m[1]) === 12 && pm) h1 = 12;
    }
    if (h1 === null) h1 = guessHour(Number(m[1]));
    if (h2 === null) h2 = m[6] ? toHour(m[4], m[6]) : h1 >= 12 && Number(m[4]) < 12 ? Number(m[4]) + 12 : guessHour(Number(m[4]));
    startTime = [h1, Number(m[2] || 0)];
    endTime = [h2, Number(m[5] || 0)];
  } else if (m) {
    // Two bare numbers ("3-4") with no day given are more likely part of the title; put them back.
    text = `${text.slice(0, m.index)} ${m[0].trim()} ${text.slice(m.index)}`;
  }
  if (!startTime) {
    m =
      take(/\s(?:at\s+|@\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|a|p)(?=\s)/i) ||
      take(/\s(?:at\s+|@\s*)?(\d{1,2}):(\d{2})(?=\s)/i) ||
      take(/\sat\s+(\d{1,2})(?=\s)(?![^\s]*\/)/i);
    if (m) {
      const hour = m[3] ? toHour(m[1], m[3]) : m[2] !== undefined && Number(m[1]) > 12 ? Number(m[1]) : guessHour(Number(m[1]));
      startTime = [hour, Number(m[2] || 0)];
    } else if ((m = take(/\s(?:at\s+)?(noon|midday|midnight)(?=\s)/i))) {
      startTime = [m[1].toLowerCase() === 'midnight' ? 0 : 12, 0];
    }
  }
  if (!startTime && tonight) startTime = [19, 0];
  let durationMin = null;
  m = take(/\sfor\s+(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)(?=\s)/i);
  if (m) durationMin = Number(m[1]) * (m[2].toLowerCase().startsWith('h') ? 60 : 1);
  if (startTime) understood.push('time');

  // --- Location: "... at Riverside Park" ------------------------------------------------------
  if (!date && repeatDays?.length) {
    // "every Tuesday" with no date starts on the next Tuesday (today if it is one).
    date = [0, 1, 2, 3, 4, 5, 6].map((n) => addDays(today, n)).find((d) => repeatDays.includes(d.getDay()));
  }

  let location = '';
  m = take(/\s(?:at|@|in)\s+(?!\d)([^@]+?)\s*$/i);
  if (m && !/^(the\s+)?(morning|afternoon|evening|night|home)$/i.test(m[1].trim())) location = m[1].trim();
  else if (m) text += ` ${m[0].trim()} `;

  const title = text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(on|at|from|for|every)\s+/i, '')
    .replace(/\s+(on|at|from|for|every|,|-)$/i, '')
    .trim();

  // --- Assemble ---------------------------------------------------------------------------------
  let start;
  let end;
  if (lastDate || (date && !startTime) || allDay || (!date && !startTime)) {
    allDay = true;
    start = date || today;
    end = addDays(lastDate && lastDate >= start ? lastDate : start, 1);
  } else {
    let day = date;
    if (!day) {
      day = today;
      const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), startTime[0], startTime[1]);
      if (candidate <= now) day = addDays(today, 1);
    }
    start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), startTime[0], startTime[1]);
    if (endTime) {
      end = new Date(day.getFullYear(), day.getMonth(), day.getDate(), endTime[0], endTime[1]);
      if (end <= start) end = addDays(end, 1);
    } else {
      end = new Date(start.getTime() + (durationMin || 60) * 60000);
    }
  }
  return { title: title || String(input || '').trim(), allDay, start, end, rrule, location, calendarId, understood };
}
