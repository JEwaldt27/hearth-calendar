import {
  add,
  addDays,
  clear,
  eventBounds,
  fmtDate,
  fmtTime,
  h,
  readableText,
  sameDay,
  startOfDay,
  startOfWeek,
  weekdayNames,
  ymd,
} from './util.js';

/** Visible date range for a view anchored on `date`. */
export function viewRange(view, date, weekStartsOn = 0) {
  if (view === 'month') {
    const first = new Date(date.getFullYear(), date.getMonth(), 1);
    const start = startOfWeek(first, weekStartsOn);
    const last = new Date(date.getFullYear(), date.getMonth() + 1, 0);
    const weeks = Math.ceil((Math.round((last - start) / 86400000) + 1) / 7);
    return { start, end: addDays(start, weeks * 7), weeks };
  }
  if (view === 'week') {
    const start = startOfWeek(date, weekStartsOn);
    return { start, end: addDays(start, 7) };
  }
  const start = startOfDay(date);
  return { start, end: addDays(start, 14) };
}

export function viewTitle(view, date, weekStartsOn = 0) {
  if (view === 'month') return fmtDate(date, { month: 'long', year: 'numeric' });
  const { start, end } = viewRange(view, date, weekStartsOn);
  const last = addDays(end, -1);
  const sameMonth = start.getMonth() === last.getMonth();
  return `${fmtDate(start, { month: 'short', day: 'numeric' })} – ${fmtDate(last, sameMonth ? { day: 'numeric' } : { month: 'short', day: 'numeric' })}, ${last.getFullYear()}`;
}

export function shiftDate(view, date, direction) {
  if (view === 'month') return new Date(date.getFullYear(), date.getMonth() + direction, 1);
  return addDays(date, direction * (view === 'week' ? 7 : 14));
}

/** Buckets events into local days: Map<'YYYY-MM-DD', event[]>, all-day first then by start time. */
export function bucketByDay(events, start, end) {
  const map = new Map();
  for (const ev of events) {
    const b = eventBounds(ev);
    let day = startOfDay(b.start < start ? start : b.start);
    do {
      if (day >= end) break;
      const key = ymd(day);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push({ ...ev, _start: b.start, _end: b.end, _continues: !sameDay(day, b.start) });
      day = addDays(day, 1);
    } while (day < b.end);
  }
  for (const list of map.values()) {
    list.sort((a, b) => (a.allDay !== b.allDay ? (a.allDay ? -1 : 1) : a._start - b._start || a.title.localeCompare(b.title)));
  }
  return map;
}

function chip(ev, ctx, { showTime = true } = {}) {
  const color = ctx.colorFor(ev);
  const past = !ev.allDay && ev._end < ctx.now;
  if (ev.allDay) {
    return h(
      'button',
      {
        class: `pill solid${past ? ' past' : ''}`,
        style: { background: color, color: readableText(color) },
        title: ev.title,
        onclick: (e) => {
          e.stopPropagation();
          ctx.onEvent(ev);
        },
      },
      ev.title || '(untitled)',
    );
  }
  return h(
    'button',
    {
      class: `pill${past ? ' past' : ''}`,
      title: `${fmtTime(ev._start)} ${ev.title}`,
      onclick: (e) => {
        e.stopPropagation();
        ctx.onEvent(ev);
      },
    },
    h('span', { class: 'dot', style: { background: color } }),
    showTime && !ev._continues ? h('span', { class: 'pill-time' }, fmtTime(ev._start)) : null,
    h('span', { class: 'pill-title' }, ev.title || '(untitled)'),
  );
}

function renderMonth(root, ctx) {
  const { start, end, weeks } = viewRange('month', ctx.date, ctx.weekStartsOn);
  const byDay = bucketByDay(ctx.events, start, end);
  const grid = h('div', { class: 'month', style: { gridTemplateRows: `auto repeat(${weeks}, 1fr)` } });
  for (const name of weekdayNames(ctx.weekStartsOn)) add(grid, h('div', { class: 'month-head' }, name));
  const limit = ctx.compact ? 3 : 4;
  for (let day = start; day < end; day = addDays(day, 1)) {
    const d = day;
    const list = byDay.get(ymd(d)) || [];
    const cell = h(
      'div',
      {
        class: `month-cell${d.getMonth() !== ctx.date.getMonth() ? ' other' : ''}${sameDay(d, ctx.now) ? ' today' : ''}`,
        onclick: () => ctx.onDay(d),
      },
      h('div', { class: 'month-num' }, h('span', {}, d.getDate())),
    );
    const shown = list.length > limit ? list.slice(0, limit - 1) : list;
    for (const ev of shown) add(cell, chip(ev, ctx));
    if (list.length > shown.length) {
      add(cell, 
        h('button', { class: 'more', onclick: (e) => (e.stopPropagation(), ctx.onDay(d, true)) }, `+${list.length - shown.length} more`),
      );
    }
    add(grid, cell);
  }
  add(root, grid);
}

function eventCard(ev, ctx) {
  const color = ctx.colorFor(ev);
  const cal = ctx.calendarsById.get(ev.calendarId);
  const member = cal?.memberId ? ctx.membersById.get(cal.memberId) : null;
  const past = ev._end <= ctx.now && !ev.allDay;
  const time = ev.allDay
    ? 'All day'
    : ev._continues
      ? `until ${fmtTime(ev._end)}`
      : +ev._end === +ev._start
        ? fmtTime(ev._start)
        : `${fmtTime(ev._start)} – ${fmtTime(ev._end)}`;
  return h(
    'button',
    {
      class: `card-event${ev.allDay ? ' allday' : ''}${past ? ' past' : ''}`,
      style: ev.allDay ? { background: color, color: readableText(color) } : { '--c': color },
      onclick: (e) => {
        e.stopPropagation();
        ctx.onEvent(ev);
      },
    },
    h('span', { class: 'ce-title' }, ev.title || '(untitled)'),
    h(
      'span',
      { class: 'ce-meta' },
      time,
      ev.recurring ? h('span', { class: 'ce-icon', title: 'Repeats' }, ' ↻') : null,
      ev.location ? h('span', { class: 'ce-loc' }, ` · ${ev.location}`) : null,
    ),
    member && !ev.allDay ? h('span', { class: 'ce-member', style: { background: member.color } }, member.emoji || member.name.charAt(0)) : null,
  );
}

function renderWeek(root, ctx) {
  const { start, end } = viewRange('week', ctx.date, ctx.weekStartsOn);
  const byDay = bucketByDay(ctx.events, start, end);
  const wrap = h('div', { class: 'week' });
  for (let day = start; day < end; day = addDays(day, 1)) {
    const d = day;
    const list = byDay.get(ymd(d)) || [];
    add(wrap, 
      h(
        'section',
        { class: `week-col${sameDay(d, ctx.now) ? ' today' : ''}${d < startOfDay(ctx.now) ? ' before' : ''}`, onclick: () => ctx.onDay(d) },
        h(
          'header',
          { class: 'week-head' },
          h('span', { class: 'wd' }, d.toLocaleDateString([], { weekday: 'short' })),
          h('span', { class: 'dn' }, d.getDate()),
        ),
        h('div', { class: 'week-body' }, list.length ? list.map((ev) => eventCard(ev, ctx)) : h('span', { class: 'empty-day' }, '')),
      ),
    );
  }
  add(root, wrap);
}

function renderAgenda(root, ctx) {
  const { start, end } = viewRange('agenda', ctx.date, ctx.weekStartsOn);
  const byDay = bucketByDay(ctx.events, start, end);
  const wrap = h('div', { class: 'agenda' });
  let any = false;
  for (let day = start; day < end; day = addDays(day, 1)) {
    const d = day;
    const list = byDay.get(ymd(d)) || [];
    const isToday = sameDay(d, ctx.now);
    if (!list.length && !isToday) continue;
    any = true;
    add(wrap, 
      h(
        'section',
        { class: `agenda-day${isToday ? ' today' : ''}` },
        h(
          'header',
          { class: 'agenda-head', onclick: () => ctx.onDay(d) },
          h('span', { class: 'dn' }, d.getDate()),
          h('span', {}, h('strong', {}, isToday ? 'Today' : d.toLocaleDateString([], { weekday: 'long' })), h('small', {}, fmtDate(d, { month: 'long', year: 'numeric' }))),
        ),
        h('div', { class: 'agenda-list' }, list.length ? list.map((ev) => eventCard(ev, ctx)) : h('p', { class: 'muted' }, 'Nothing planned.')),
      ),
    );
  }
  if (!any) add(wrap, h('p', { class: 'muted center' }, 'Nothing planned for the next two weeks.'));
  add(root, wrap);
}

/**
 * Renders a calendar view into `root`.
 * ctx: { view, date, events, calendarsById, membersById, colorFor, onEvent, onDay, weekStartsOn, compact }
 */
export function renderCalendar(root, ctx) {
  clear(root);
  const full = { now: new Date(), weekStartsOn: 0, ...ctx };
  root.dataset.view = full.view;
  if (full.view === 'month') renderMonth(root, full);
  else if (full.view === 'week') renderWeek(root, full);
  else renderAgenda(root, full);
}

/** Sheet listing every event on one day (used for "+N more" and day taps). */
export function dayEvents(events, day) {
  const start = startOfDay(day);
  return bucketByDay(events, start, addDays(start, 1)).get(ymd(start)) || [];
}

export { eventCard };
