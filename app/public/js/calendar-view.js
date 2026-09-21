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
  if (view === 'day') {
    const start = startOfDay(date);
    return { start, end: addDays(start, 1) };
  }
  const start = startOfDay(date);
  return { start, end: addDays(start, 14) };
}

export function viewTitle(view, date, weekStartsOn = 0) {
  if (view === 'month') return fmtDate(date, { month: 'long', year: 'numeric' });
  if (view === 'day') return fmtDate(date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const { start, end } = viewRange(view, date, weekStartsOn);
  const last = addDays(end, -1);
  const sameMonth = start.getMonth() === last.getMonth();
  return `${fmtDate(start, { month: 'short', day: 'numeric' })} – ${fmtDate(last, sameMonth ? { day: 'numeric' } : { month: 'short', day: 'numeric' })}, ${last.getFullYear()}`;
}

export function shiftDate(view, date, direction) {
  if (view === 'month') return new Date(date.getFullYear(), date.getMonth() + direction, 1);
  return addDays(date, direction * ({ week: 7, day: 1 }[view] || 14));
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

let dragging = null;

/** Lets an event element be dragged to another day (week and month views, on a computer). */
function makeDraggable(el, ev, ctx) {
  if (!ctx.onMove || !ctx.canMove?.(ev)) return el;
  el.draggable = true;
  el.addEventListener('dragstart', (e) => {
    dragging = ev;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', ev.id);
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => {
    dragging = null;
    el.classList.remove('dragging');
    document.querySelectorAll('.drop-target').forEach((t) => t.classList.remove('drop-target'));
  });
  return el;
}

function makeDropTarget(el, day, ctx) {
  if (!ctx.onMove) return el;
  el.addEventListener('dragover', (e) => {
    if (!dragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    el.classList.add('drop-target');
  });
  el.addEventListener('dragleave', (e) => {
    if (!el.contains(e.relatedTarget)) el.classList.remove('drop-target');
  });
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('drop-target');
    const ev = dragging;
    dragging = null;
    if (ev) ctx.onMove(ev, day);
  });
  return el;
}

function chip(ev, ctx, { showTime = true } = {}) {
  const color = ctx.colorFor(ev);
  const past = !ev.allDay && ev._end < ctx.now;
  if (ev.allDay) {
    return makeDraggable(h(
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
    ), ev, ctx);
  }
  return makeDraggable(h(
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
  ), ev, ctx);
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
    const cell = makeDropTarget(h(
      'div',
      {
        class: `month-cell${d.getMonth() !== ctx.date.getMonth() ? ' other' : ''}${sameDay(d, ctx.now) ? ' today' : ''}`,
        onclick: () => ctx.onDay(d),
      },
      h('div', { class: 'month-num' }, h('span', {}, d.getDate())),
    ), d, ctx);
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
  return makeDraggable(h(
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
  ), ev, ctx);
}

function renderWeek(root, ctx) {
  const { start, end } = viewRange('week', ctx.date, ctx.weekStartsOn);
  const byDay = bucketByDay(ctx.events, start, end);
  const wrap = h('div', { class: 'week' });
  for (let day = start; day < end; day = addDays(day, 1)) {
    const d = day;
    const list = byDay.get(ymd(d)) || [];
    add(wrap,
      makeDropTarget(h(
        'section',
        { class: `week-col${sameDay(d, ctx.now) ? ' today' : ''}${d < startOfDay(ctx.now) ? ' before' : ''}`, onclick: () => ctx.onDay(d) },
        h(
          'header',
          { class: 'week-head' },
          h('span', { class: 'wd' }, d.toLocaleDateString([], { weekday: 'short' })),
          h('span', { class: 'dn' }, d.getDate()),
        ),
        h('div', { class: 'week-body' }, list.length ? list.map((ev) => eventCard(ev, ctx)) : h('span', { class: 'empty-day' }, '')),
      ), d, ctx),
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

const HOUR_PX = 52;

/** Places overlapping timed events side by side. Returns [{ ev, top, height, col, cols }]. */
function layoutDay(events, dayStart) {
  const dayEnd = addDays(dayStart, 1);
  const items = events
    .map((ev) => {
      const s = Math.max(ev._start, dayStart);
      const e = Math.min(Math.max(ev._end, ev._start.getTime() + 15 * 60000), dayEnd);
      return { ev, s, e, top: ((s - dayStart) / 3600000) * HOUR_PX, height: Math.max(24, ((e - s) / 3600000) * HOUR_PX - 2) };
    })
    .sort((a, b) => a.s - b.s || b.e - a.e);
  let cluster = [];
  let clusterEnd = 0;
  const finish = () => {
    const cols = Math.max(1, ...cluster.map((i) => i.col + 1));
    for (const i of cluster) i.cols = cols;
    cluster = [];
  };
  for (const item of items) {
    if (cluster.length && item.s >= clusterEnd) finish();
    const used = new Set(cluster.filter((i) => i.e > item.s).map((i) => i.col));
    let col = 0;
    while (used.has(col)) col++;
    item.col = col;
    cluster.push(item);
    clusterEnd = Math.max(clusterEnd, item.e);
  }
  if (cluster.length) finish();
  return items;
}

function renderDay(root, ctx) {
  const dayStart = startOfDay(ctx.date);
  const list = bucketByDay(ctx.events, dayStart, addDays(dayStart, 1)).get(ymd(dayStart)) || [];
  const allDay = list.filter((ev) => ev.allDay);
  const timed = list.filter((ev) => !ev.allDay);
  const grid = h('div', {
    class: 'dv-grid',
    style: { height: `${24 * HOUR_PX}px` },
    onclick: (e) => {
      if (e.target !== grid && !e.target.classList.contains('dv-hour')) return;
      const y = e.clientY - grid.getBoundingClientRect().top;
      const minutes = Math.max(0, Math.min(23.5 * 60, Math.floor((y / HOUR_PX) * 2) * 30));
      ctx.onSlot?.(new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate(), 0, minutes));
    },
  });
  for (let hr = 0; hr < 24; hr++) {
    add(grid, h('div', { class: 'dv-hour', style: { top: `${hr * HOUR_PX}px`, height: `${HOUR_PX}px` } }, h('span', { class: 'dv-label' }, hr === 0 ? '' : new Date(2000, 0, 1, hr).toLocaleTimeString([], { hour: 'numeric' }))));
  }
  for (const item of layoutDay(timed, dayStart)) {
    const { ev } = item;
    const color = ctx.colorFor(ev);
    const past = ev._end <= ctx.now;
    add(
      grid,
      h(
        'button',
        {
          class: `dv-event${past ? ' past' : ''}`,
          style: {
            '--c': color,
            top: `${item.top}px`,
            height: `${item.height}px`,
            left: `calc(58px + (100% - 64px) * ${item.col / item.cols})`,
            width: `calc((100% - 64px) / ${item.cols} - 4px)`,
          },
          onclick: (e) => {
            e.stopPropagation();
            ctx.onEvent(ev);
          },
        },
        h('span', { class: 'ce-title' }, ev.title || '(untitled)'),
        item.height > 34 ? h('span', { class: 'ce-meta' }, `${fmtTime(ev._start)} – ${fmtTime(ev._end)}${ev.location ? ` · ${ev.location}` : ''}`) : null,
      ),
    );
  }
  if (sameDay(dayStart, ctx.now)) {
    const minutes = ctx.now.getHours() * 60 + ctx.now.getMinutes();
    add(grid, h('div', { class: 'dv-now', style: { top: `${(minutes / 60) * HOUR_PX}px` } }));
  }
  const scroller = h('div', { class: 'dv-scroll' }, grid);
  add(
    root,
    h(
      'div',
      { class: 'dayview' },
      allDay.length ? h('div', { class: 'dv-allday' }, h('span', { class: 'dv-label' }, 'All day'), h('div', { class: 'dv-allday-list' }, allDay.map((ev) => eventCard(ev, ctx)))) : null,
      scroller,
    ),
  );
  // Start scrolled to the current time (today) or 7 AM.
  const focusHour = sameDay(dayStart, ctx.now) ? Math.max(0, ctx.now.getHours() - 1) : 7;
  requestAnimationFrame(() => (scroller.scrollTop = focusHour * HOUR_PX));
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
  else if (full.view === 'day') renderDay(root, full);
  else renderAgenda(root, full);
}

/** Sheet listing every event on one day (used for "+N more" and day taps). */
export function dayEvents(events, day) {
  const start = startOfDay(day);
  return bucketByDay(events, start, addDays(start, 1)).get(ymd(start)) || [];
}

export { eventCard };
