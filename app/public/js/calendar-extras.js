import { get, patch, post } from './api.js';
import { describeRrule } from './event-editor.js';
import { parseQuickAdd } from './quickadd.js';
import { add, addDays, choose, clear, eventBounds, fmtDate, fmtTime, h, localZone, modal, startOfDay, toast, ymd } from './util.js';

const DAY = 86400000;
const dayNumber = (d) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY;

// --- Search -------------------------------------------------------------------------

/** Search dialog. `onPick(event)` is called with the chosen occurrence. */
export function openSearch(ctx, onPick) {
  const input = h('input', { type: 'search', placeholder: 'Search events: dentist, soccer, birthday…', autocomplete: 'off' });
  const results = h('div', { class: 'search-results' });
  let timer = null;
  let seq = 0;
  const run = async () => {
    const q = input.value.trim();
    if (q.length < 2) {
      add(clear(results), h('p', { class: 'muted' }, 'Type at least two letters.'));
      return;
    }
    const mine = ++seq;
    const { events } = await get(`/search?q=${encodeURIComponent(q)}`).catch((e) => (toast(e.message, 'error'), { events: [] }));
    if (mine !== seq) return;
    const now = new Date();
    const row = (ev) => {
      const b = eventBounds(ev);
      const cal = ctx.calendarsById.get(ev.calendarId);
      return h(
        'button',
        { class: 'search-row', onclick: () => (m.close(), onPick(ev)) },
        h('span', { class: 'dot', style: { background: ctx.colorFor(ev) } }),
        h('span', { class: 'grow' }, h('strong', {}, ev.title || '(untitled)'), h('small', { class: 'muted' }, [cal?.name, ev.location, ev.recurring ? '↻ repeats' : null].filter(Boolean).join(' · '))),
        h('span', { class: 'search-when' }, fmtDate(b.start, { weekday: 'short', month: 'short', day: 'numeric', year: b.start.getFullYear() === now.getFullYear() ? undefined : 'numeric' }), ev.allDay ? '' : ` · ${fmtTime(b.start)}`),
      );
    };
    const upcoming = events.filter((ev) => eventBounds(ev).end > now);
    const past = events.filter((ev) => eventBounds(ev).end <= now);
    add(
      clear(results),
      events.length
        ? [upcoming.length ? [h('h3', {}, 'Coming up'), upcoming.map(row)] : null, past.length ? [h('h3', {}, 'Past'), past.map(row)] : null]
        : h('p', { class: 'muted' }, 'Nothing found.'),
    );
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(run, 250);
  });
  const m = modal({ title: 'Search', wide: true, content: h('div', { class: 'stack' }, input, results) });
}

// --- Quick add ------------------------------------------------------------------------

function describeDraft(d, ctx) {
  const parts = [];
  if (d.allDay) {
    const last = addDays(d.end, -1);
    parts.push(dayNumber(last) > dayNumber(d.start) ? `${fmtDate(d.start, { month: 'short', day: 'numeric' })} – ${fmtDate(last, { month: 'short', day: 'numeric' })}` : fmtDate(d.start, { weekday: 'short', month: 'short', day: 'numeric' }));
    parts.push('all day');
  } else {
    parts.push(`${fmtDate(d.start, { weekday: 'short', month: 'short', day: 'numeric' })} · ${fmtTime(d.start)} – ${fmtTime(d.end)}`);
  }
  const cal = ctx.calendarsById.get(d.calendarId || ctx.defaultCalendarId);
  if (cal) parts.push(cal.name);
  if (d.rrule) parts.push(`↻ ${describeRrule(d.rrule)}`);
  if (d.location) parts.push(`📍 ${d.location}`);
  return parts.join('  ·  ');
}

/** "Soccer Tue 5pm @Sam" box with a live preview. `getCtx()` returns the current event context. */
export function quickAddBar(getCtx, openEditor) {
  const input = h('input', { type: 'text', class: 'quick-input', placeholder: 'Quick add: “Soccer Tue 5pm @Sam”', autocomplete: 'off', enterkeyhint: 'done' });
  const preview = h('div', { class: 'quick-preview', hidden: true });
  const more = h('button', { class: 'btn ghost', type: 'button', hidden: true }, 'More options');
  let draft = null;
  const parse = () => {
    const ctx = getCtx();
    const text = input.value.trim();
    draft = text ? parseQuickAdd(text, { calendars: ctx.calendars, members: [...ctx.membersById.values()], dayFirst: !navigator.language.startsWith('en-US') && !navigator.language.startsWith('en-CA') && navigator.language !== 'en' }) : null;
    preview.hidden = more.hidden = !draft;
    if (draft) preview.textContent = `${draft.title}  ·  ${describeDraft(draft, ctx)}`;
  };
  input.addEventListener('input', parse);
  more.addEventListener('click', () => {
    if (!draft) return;
    openEditor({ draft });
    input.value = '';
    parse();
  });
  const form = h(
    'form',
    {
      class: 'quick-add-bar',
      onsubmit: async (e) => {
        e.preventDefault();
        parse();
        if (!draft) return;
        const ctx = getCtx();
        const calendarId = draft.calendarId || ctx.defaultCalendarId;
        if (!calendarId) return toast('You have no calendar you can add to.', 'error');
        const body = {
          calendarId,
          title: draft.title,
          allDay: draft.allDay,
          start: draft.allDay ? ymd(draft.start) : draft.start.toISOString(),
          end: draft.allDay ? ymd(draft.end) : draft.end.toISOString(),
          tzid: localZone(),
          location: draft.location,
          rrule: draft.rrule,
        };
        try {
          await post('/events', body);
          toast(`Added “${draft.title}”`);
          input.value = '';
          parse();
          ctx.onChange?.(draft.start);
        } catch (err) {
          toast(err.message, 'error');
        }
      },
    },
    h('span', { class: 'quick-icon', 'aria-hidden': 'true' }, '＋'),
    input,
    more,
  );
  return h('div', { class: 'quick-wrap' }, form, preview);
}

// --- Countdowns -------------------------------------------------------------------------

export function daysUntil(ev) {
  return dayNumber(eventBounds(ev).start) - dayNumber(new Date());
}

export function countdownLabel(ev) {
  const n = daysUntil(ev);
  if (n <= 0) return 'Today!';
  if (n === 1) return 'Tomorrow';
  return `${n} days`;
}

/** Fills `el` with countdown chips. Resolves to the number shown. */
export async function drawCountdowns(el, colorFor, query = '') {
  let events = [];
  try {
    events = (await get(`/countdowns${query}`)).events;
  } catch {
    /* leave empty */
  }
  el.hidden = !events.length;
  add(
    clear(el),
    events.map((ev) =>
      h('span', { class: 'countdown', style: { '--c': colorFor(ev) }, title: fmtDate(eventBounds(ev).start) }, h('span', {}, ev.title), h('strong', {}, countdownLabel(ev))),
    ),
  );
  return events.length;
}

// --- Drag to another day ------------------------------------------------------------------

/** Moves an occurrence to `day`, keeping its time. Asks which events for repeating ones. */
export async function moveEvent(ev, day, ctx) {
  const b = eventBounds(ev);
  const delta = dayNumber(startOfDay(day)) - dayNumber(startOfDay(b.start));
  if (!delta) return;
  let scope = 'all';
  if (ev.recurring) {
    scope = await choose('Move repeating event', null, [
      { value: 'this', label: 'Only this event' },
      { value: 'following', label: 'This and following events' },
      { value: 'all', label: 'All events in the series' },
    ]);
    if (!scope) return;
  }
  const body = ev.allDay
    ? { allDay: true, start: ymd(addDays(b.start, delta)), end: ymd(addDays(b.end, delta)) }
    : { allDay: false, start: addDays(b.start, delta).toISOString(), end: addDays(b.end, delta).toISOString(), tzid: localZone() };
  try {
    await patch(`/events/${ev.eventId}`, { ...body, scope, occurrence: ev.occurrence, originalStart: ev.start });
    toast(`Moved to ${fmtDate(day, { weekday: 'long', month: 'short', day: 'numeric' })}`);
    ctx.onChange?.();
  } catch (err) {
    toast(err.message, 'error');
  }
}
