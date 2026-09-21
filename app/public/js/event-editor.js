import { del, patch, post } from './api.js';
import {
  addDays,
  busy,
  choose,
  confirmDialog,
  describeWhen,
  eventBounds,
  field,
  h,
  hm,
  localZone,
  modal,
  parseYmd,
  toast,
  weekdayNames,
  ymd,
} from './util.js';

const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** Parses the RRULEs this editor can represent; anything else is kept verbatim as "custom". */
export function parseRrule(rule) {
  if (!rule) return { freq: 'none' };
  const parts = Object.fromEntries(rule.split(';').map((p) => p.split('=')));
  const supported = new Set(['FREQ', 'INTERVAL', 'BYDAY', 'COUNT', 'UNTIL', 'WKST']);
  const simpleByday = !parts.BYDAY || (parts.FREQ === 'WEEKLY' && /^(SU|MO|TU|WE|TH|FR|SA)(,(SU|MO|TU|WE|TH|FR|SA))*$/.test(parts.BYDAY));
  if (Object.keys(parts).some((k) => !supported.has(k)) || !simpleByday) return { freq: 'custom', raw: rule };
  let until = null;
  if (parts.UNTIL) {
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(parts.UNTIL);
    if (m) until = `${m[1]}-${m[2]}-${m[3]}`;
  }
  return {
    freq: parts.FREQ.toLowerCase(),
    interval: Number(parts.INTERVAL || 1),
    byday: parts.BYDAY ? parts.BYDAY.split(',') : [],
    ends: parts.COUNT ? 'count' : until ? 'until' : 'never',
    count: Number(parts.COUNT || 10),
    until,
  };
}

export function buildRrule(r, { allDay, startDate }) {
  if (r.freq === 'none') return null;
  if (r.freq === 'custom') return r.raw;
  const parts = [`FREQ=${r.freq.toUpperCase()}`];
  if (r.interval > 1) parts.push(`INTERVAL=${r.interval}`);
  if (r.freq === 'weekly') {
    const days = r.byday.length ? r.byday : [DAY_CODES[startDate.getDay()]];
    parts.push(`BYDAY=${DAY_CODES.filter((c) => days.includes(c)).join(',')}`);
  }
  if (r.ends === 'count') parts.push(`COUNT=${Math.max(1, r.count || 1)}`);
  if (r.ends === 'until' && r.until) {
    if (allDay) parts.push(`UNTIL=${r.until.replace(/-/g, '')}`);
    else {
      const endOfDay = addDays(parseYmd(r.until), 1);
      parts.push(`UNTIL=${new Date(endOfDay - 1000).toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`);
    }
  }
  return parts.join(';');
}

export function describeRrule(rule) {
  const r = parseRrule(rule);
  if (r.freq === 'none') return '';
  if (r.freq === 'custom') return 'Repeats (custom rule)';
  const unit = { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' }[r.freq];
  let text = r.interval > 1 ? `Every ${r.interval} ${unit}s` : `Every ${unit}`;
  if (r.freq === 'weekly' && r.byday.length) {
    const names = weekdayNames(0, 'short');
    text += ` on ${r.byday.map((c) => names[DAY_CODES.indexOf(c)]).join(', ')}`;
  }
  if (r.ends === 'count') text += `, ${r.count} times`;
  if (r.ends === 'until') text += `, until ${parseYmd(r.until).toLocaleDateString()}`;
  return text;
}

function birthdayAge(ev, cal) {
  if (cal?.managed !== 'birthdays') return null;
  const born = /Born (\d{4})/.exec(ev.description || '');
  return born ? Number(ev.start.slice(0, 4)) - Number(born[1]) : null;
}

const SCOPES = {
  this: { value: 'this', label: 'Only this event' },
  following: { value: 'following', label: 'This and following events' },
  all: { value: 'all', label: 'All events in the series' },
};

/** Read-only popover for an occurrence with Edit / Delete when allowed. */
export function openEventDetails(ev, ctx) {
  const cal = ctx.calendarsById.get(ev.calendarId);
  const member = cal?.memberId ? ctx.membersById.get(cal.memberId) : null;
  const color = ctx.colorFor(ev);
  const canEdit = cal?.writable && ctx.allowEditing !== false;
  const m = modal({
    title: ev.title || '(untitled)',
    content: h(
      'div',
      { class: 'details' },
      h('p', { class: 'details-when' }, describeWhen(ev)),
      ev.rrule || ev.recurring ? h('p', { class: 'muted' }, `↻ ${describeRrule(ev.rrule) || 'Part of a repeating series'}`) : null,
      h('p', { class: 'details-cal' }, h('span', { class: 'dot', style: { background: color } }), cal ? cal.name : 'Calendar', member && member.name !== cal?.name ? ` · ${member.name}` : '', cal && !cal.isOwner ? ` · shared by ${cal.ownerName}` : ''),
      ev.location ? h('p', {}, '📍 ', ev.location) : null,
      birthdayAge(ev, cal) ? h('p', {}, `🎉 Turns ${birthdayAge(ev, cal)}`) : null,
      ev.description && !(cal?.managed === 'birthdays') ? h('p', { class: 'details-notes' }, ev.description) : null,
      cal?.managed === 'birthdays' ? h('p', { class: 'hint' }, 'Birthdays come from Settings → Family members.') : null,
      cal && !cal.writable ? h('p', { class: 'hint' }, cal.source === 'ics' ? 'This calendar is a read-only subscription.' : 'You have view-only access to this calendar.') : null,
    ),
    actions: canEdit
      ? [
          h('button', { class: 'btn danger ghost', onclick: () => deleteFlow(ev, ctx, m) }, 'Delete'),
          h('button', { class: 'btn primary', onclick: () => (m.close(), openEventEditor({ ...ctx, event: ev })) }, 'Edit'),
        ]
      : [],
  });
}

async function deleteFlow(ev, ctx, parentModal) {
  let scope = 'all';
  if (ev.recurring) {
    scope = await choose('Delete repeating event', null, [SCOPES.this, SCOPES.following, { ...SCOPES.all, danger: true }]);
    if (!scope) return;
  } else if (!(await confirmDialog(`Delete “${ev.title}”?`, { okLabel: 'Delete', danger: true }))) {
    return;
  }
  try {
    const q = scope === 'this' ? `?scope=this&occurrence=${encodeURIComponent(ev.occurrence)}` : '';
    await del(`/events/${ev.eventId}${q}`);
    parentModal?.close();
    toast('Event deleted');
    ctx.onChange?.();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/**
 * Create/edit form. ctx: { event?, date?, calendars, calendarsById, defaultCalendarId, onChange }
 */
export function openEventEditor(ctx) {
  const ev = ctx.event;
  const writable = ctx.calendars.filter((c) => c.writable);
  if (!writable.length) {
    toast('You have no editable calendars. Create one in Settings → Calendars.', 'error');
    return;
  }

  let startDate;
  let endDate;
  let allDay = false;
  if (ev) {
    const b = eventBounds(ev);
    allDay = ev.allDay;
    startDate = b.start;
    endDate = ev.allDay ? addDays(b.end, -1) : b.end;
  } else if (ctx.draft) {
    // Pre-filled from quick add.
    allDay = ctx.draft.allDay;
    startDate = ctx.draft.start;
    endDate = ctx.draft.allDay ? addDays(ctx.draft.end, -1) : ctx.draft.end;
  } else if (ctx.startAt) {
    // A time slot tapped in the day view.
    startDate = new Date(ctx.startAt);
    endDate = new Date(startDate.getTime() + 3600000);
  } else {
    const base = ctx.date ? new Date(ctx.date) : new Date();
    const now = new Date();
    const hour = ctx.date && ymd(ctx.date) !== ymd(now) ? 9 : Math.min(now.getHours() + 1, 23);
    startDate = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, 0);
    endDate = new Date(startDate.getTime() + 3600000);
    allDay = Boolean(ctx.allDay);
  }

  const title = h('input', { type: 'text', value: ev?.title || ctx.draft?.title || '', placeholder: 'What’s happening?', maxlength: 500, required: true });
  const calendar = h(
    'select',
    {},
    writable.map((c) => h('option', { value: c.id, selected: c.id === (ev?.calendarId || ctx.draft?.calendarId || ctx.defaultCalendarId) }, c.isOwner ? c.name : `${c.name} (${c.ownerName})`)),
  );
  const allDayInput = h('input', { type: 'checkbox', checked: allDay });
  const startDay = h('input', { type: 'date', value: ymd(startDate), required: true });
  const startTime = h('input', { type: 'time', value: hm(startDate), step: 300 });
  const endDay = h('input', { type: 'date', value: ymd(endDate), required: true });
  const endTime = h('input', { type: 'time', value: hm(endDate), step: 300 });
  const location = h('input', { type: 'text', value: ev?.location || ctx.draft?.location || '', placeholder: 'Add a place', maxlength: 500 });
  const countdown = h('input', { type: 'checkbox', checked: Boolean(ev?.countdown) });
  const notes = h('textarea', { rows: 3, placeholder: 'Notes', maxlength: 10000 }, ev?.description || '');

  // Keep the end after the start as the start moves.
  let lastStart = new Date(startDate);
  const readStart = () => (allDayInput.checked ? parseYmd(startDay.value) : new Date(`${startDay.value}T${startTime.value || '00:00'}`));
  const readEnd = () => (allDayInput.checked ? parseYmd(endDay.value) : new Date(`${endDay.value}T${endTime.value || '00:00'}`));
  const onStartChange = () => {
    const s = readStart();
    if (Number.isNaN(s.getTime())) return;
    const e = readEnd();
    const shifted = new Date(e.getTime() + (s - lastStart));
    endDay.value = ymd(shifted);
    endTime.value = hm(shifted);
    lastStart = s;
    syncRepeatDefaults();
  };
  startDay.addEventListener('change', onStartChange);
  startTime.addEventListener('change', onStartChange);
  const syncAllDay = () => {
    startTime.hidden = allDayInput.checked;
    endTime.hidden = allDayInput.checked;
    lastStart = readStart();
  };
  allDayInput.addEventListener('change', syncAllDay);

  // Repeat controls
  const rule = parseRrule(ev ? ev.rrule : ctx.draft?.rrule);
  const freq = h(
    'select',
    {},
    [
      ['none', 'Does not repeat'],
      ['daily', 'Daily'],
      ['weekly', 'Weekly'],
      ['monthly', 'Monthly'],
      ['yearly', 'Yearly'],
      ...(rule.freq === 'custom' ? [['custom', 'Custom (from another app)']] : []),
    ].map(([v, label]) => h('option', { value: v, selected: v === rule.freq }, label)),
  );
  const interval = h('input', { type: 'number', min: 1, max: 99, value: rule.interval || 1, class: 'narrow' });
  const unitLabel = h('span', { class: 'muted' });
  const dayButtons = DAY_CODES.map((code, i) =>
    h(
      'button',
      {
        type: 'button',
        class: `day-toggle${(rule.byday || []).includes(code) ? ' on' : ''}`,
        dataset: { code },
        onclick: (e) => e.currentTarget.classList.toggle('on'),
      },
      weekdayNames(0, 'narrow')[i],
    ),
  );
  const ends = h(
    'select',
    {},
    [
      ['never', 'Never ends'],
      ['until', 'Ends on date'],
      ['count', 'Ends after…'],
    ].map(([v, label]) => h('option', { value: v, selected: v === (rule.ends || 'never') }, label)),
  );
  const until = h('input', { type: 'date', value: rule.until || ymd(addDays(startDate, 90)) });
  const count = h('input', { type: 'number', min: 1, max: 999, value: rule.count || 10, class: 'narrow' });
  const countLabel = h('span', { class: 'muted' }, 'times');
  const everyRow = h('div', { class: 'row gap-s' }, h('span', { class: 'muted' }, 'Every'), interval, unitLabel);
  const daysRow = h('div', { class: 'day-toggles' }, dayButtons);
  const endsRow = h('div', { class: 'row gap-s wrap' }, ends, until, count, countLabel);

  function syncRepeatDefaults() {
    if (!dayButtons.some((b) => b.classList.contains('on'))) {
      const code = DAY_CODES[readStart().getDay()];
      dayButtons.forEach((b) => b.classList.toggle('on', b.dataset.code === code));
    }
  }
  function syncRepeat() {
    const f = freq.value;
    const simple = !['none', 'custom'].includes(f);
    everyRow.hidden = !simple;
    daysRow.hidden = f !== 'weekly';
    endsRow.hidden = !simple;
    until.hidden = ends.value !== 'until';
    count.hidden = countLabel.hidden = ends.value !== 'count';
    unitLabel.textContent = { daily: 'day(s)', weekly: 'week(s)', monthly: 'month(s)', yearly: 'year(s)' }[f] || '';
    if (f === 'weekly') syncRepeatDefaults();
  }
  freq.addEventListener('change', syncRepeat);
  ends.addEventListener('change', syncRepeat);

  const form = h(
    'form',
    { class: 'stack editor', onsubmit: (e) => e.preventDefault() },
    h('input', { type: 'submit', hidden: true }),
    field('Title', title),
    field('Calendar', calendar),
    h('label', { class: 'check' }, allDayInput, ' All day'),
    h('div', { class: 'row gap-s wrap' }, h('span', { class: 'field-label w-4' }, 'Starts'), startDay, startTime),
    h('div', { class: 'row gap-s wrap' }, h('span', { class: 'field-label w-4' }, 'Ends'), endDay, endTime),
    field('Repeat', freq),
    everyRow,
    daysRow,
    endsRow,
    field('Location', location),
    field('Notes', notes),
    h('label', { class: 'check' }, countdown, ' Show a countdown to this (“🏖️ Beach trip in 12 days”)'),
  );
  syncAllDay();
  syncRepeat();

  const save = h('button', { class: 'btn primary', type: 'button' }, ev ? 'Save' : 'Add event');
  const actions = [h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancel'), save];
  if (ev) actions.unshift(h('button', { class: 'btn danger ghost left', type: 'button', onclick: () => deleteFlow(ev, ctx, m) }, 'Delete'));

  const m = modal({ title: ev ? 'Edit event' : 'New event', content: form, actions });
  form.addEventListener('submit', () => save.click());

  save.addEventListener(
    'click',
    busy(save, async () => {
      if (!title.value.trim()) {
        title.focus();
        throw new Error('Please give the event a title.');
      }
      const isAllDay = allDayInput.checked;
      const s = readStart();
      let e = readEnd();
      if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) throw new Error('Please enter valid dates.');
      if (e < s) throw new Error('The event cannot end before it starts.');
      const body = {
        calendarId: calendar.value,
        title: title.value.trim(),
        location: location.value.trim(),
        description: notes.value,
        allDay: isAllDay,
        tzid: localZone(),
        start: isAllDay ? ymd(s) : s.toISOString(),
        end: isAllDay ? ymd(addDays(e, 1)) : e.toISOString(),
        countdown: countdown.checked,
        rrule: buildRrule(
          {
            freq: freq.value,
            raw: rule.raw,
            interval: Number(interval.value) || 1,
            byday: dayButtons.filter((b) => b.classList.contains('on')).map((b) => b.dataset.code),
            ends: ends.value,
            until: until.value,
            count: Number(count.value),
          },
          { allDay: isAllDay, startDate: s },
        ),
      };

      if (!ev) {
        await post('/events', body);
        toast('Event added');
      } else {
        let scope = 'all';
        const ruleChanged = (body.rrule || null) !== (ev.rrule || null);
        if (ev.recurring && body.calendarId === ev.calendarId) {
          scope = await choose('Edit repeating event', null, ruleChanged ? [SCOPES.following, SCOPES.all] : [SCOPES.this, SCOPES.following, SCOPES.all]);
          if (!scope) return;
        }
        if (scope === 'this' || (ev.recurring && !ev.rrule)) delete body.rrule;
        await patch(`/events/${ev.eventId}`, { ...body, scope, occurrence: ev.occurrence, originalStart: ev.start });
        toast('Event updated');
      }
      m.close();
      ctx.onChange?.();
    }),
  );
}
