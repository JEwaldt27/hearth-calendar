import { get, post, put } from './api.js';
import { dayEvents, eventCard, renderCalendar, shiftDate, viewRange, viewTitle } from './calendar-view.js';
import { openChoreEditor, openRewards, renderChoreBoard, toggleItem } from './chores.js';
import { openEventDetails, openEventEditor } from './event-editor.js';
import { renderListsPage } from './lists.js';
import { renderMealsPage } from './meals.js';
import { canPromptInstall, maybeShowIosHint, onInstallAvailabilityChange, promptInstall, registerServiceWorker } from './pwa.js';
import { renderSettings } from './settings.js';
import { add, addDays, avatar, clear, fmtDate, h, modal, parseYmd, sameDay, toast, ymd } from './util.js';

const saved = (() => {
  try {
    return JSON.parse(localStorage.getItem('hearth.prefs') || '{}');
  } catch {
    return {};
  }
})();

const state = {
  user: null,
  calendars: [],
  members: [],
  lists: [],
  events: [],
  items: [],
  view: saved.view || 'week',
  date: new Date(),
  choreDay: ymd(new Date()),
  memberFilter: new Set(saved.memberFilter || []),
  weekStartsOn: saved.weekStartsOn ?? 0,
};

function persist() {
  try {
    localStorage.setItem('hearth.prefs', JSON.stringify({ view: state.view, memberFilter: [...state.memberFilter], weekStartsOn: state.weekStartsOn }));
  } catch {
    /* storage unavailable */
  }
}

const main = document.getElementById('main');
const topbar = document.getElementById('topbar');

const app = {
  state,
  async reload() {
    const [c, m, l] = await Promise.all([get('/calendars'), get('/members'), get('/lists')]);
    state.calendars = c.calendars;
    state.members = m.members;
    state.lists = l.lists;
  },
  renderChrome,
  route,
};

function currentTab() {
  return (location.hash.slice(1).split(/[/?]/)[0] || 'calendar').toLowerCase();
}

function renderChrome() {
  const tab = currentTab();
  add(clear(topbar), 
    h('a', { class: 'brand', href: '#calendar' }, h('span', { class: 'brand-mark' }, '◐'), 'Hearth'),
    h(
      'nav',
      { class: 'tabs' },
      [
        ['calendar', 'Calendar'],
        ['chores', 'Chores'],
        ['lists', 'Lists'],
        ['meals', 'Meals'],
        ['settings', 'Settings'],
      ].map(([id, label]) => h('a', { href: `#${id}`, class: tab === id ? 'active' : '' }, label)),
    ),
    h('span', { class: 'grow' }),
    canPromptInstall() ? h('button', { class: 'btn ghost', onclick: () => promptInstall() }, '⬇ Install app') : null,
    h('a', { class: 'btn ghost hide-s', href: '/display', target: '_blank', rel: 'noopener', title: 'Open the wall display view' }, '🖥️ Display'),
    h(
      'button',
      {
        class: 'btn ghost',
        title: `Signed in as ${state.user.email}`,
        onclick: async () => {
          await post('/auth/logout');
          location.href = '/login';
        },
      },
      h('span', { class: 'hide-s' }, `${state.user.name} · `),
      'Sign out',
    ),
  );
}

// --- Calendar ---------------------------------------------------------------

const calendarsById = () => new Map(state.calendars.map((c) => [c.id, c]));
const membersById = () => new Map(state.members.map((m) => [m.id, m]));

function visibleEvents() {
  const cals = calendarsById();
  return state.events.filter((ev) => {
    const cal = cals.get(ev.calendarId);
    if (!cal || !cal.visible) return false;
    if (state.memberFilter.size && !state.memberFilter.has(cal.memberId || 'none')) return false;
    return true;
  });
}

function eventContext(onChange) {
  const cals = calendarsById();
  return {
    calendars: state.calendars,
    calendarsById: cals,
    membersById: membersById(),
    colorFor: (ev) => cals.get(ev.calendarId)?.color || '#8d7b6a',
    defaultCalendarId: state.calendars.find((c) => c.writable && c.isOwner)?.id,
    onChange,
  };
}

let loadToken = 0;
async function loadEvents() {
  const { start, end } = viewRange(state.view, state.date, state.weekStartsOn);
  const token = ++loadToken;
  const { events } = await get(`/events?from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(end.toISOString())}`);
  if (token === loadToken) state.events = events;
}

function daySheet(day, ctx) {
  const list = dayEvents(visibleEvents(), day);
  const m = modal({
    title: fmtDate(day),
    content: h(
      'div',
      { class: 'agenda-list' },
      list.length ? list.map((ev) => eventCard(ev, { ...ctx, now: new Date(), onEvent: (e) => (m.close(), openEventDetails(e, ctx)) })) : h('p', { class: 'muted' }, 'Nothing planned.'),
    ),
    actions: [h('button', { class: 'btn primary', onclick: () => (m.close(), openEventEditor({ ...ctx, date: day })) }, '+ Add event')],
  });
}

function memberChips(onChange) {
  const inUse = new Set(state.calendars.filter((c) => c.visible).map((c) => c.memberId || 'none'));
  const people = state.members.filter((m) => inUse.has(m.id));
  if (!people.length) return null;
  const chipsEl = h('div', { class: 'chips' });
  const draw = () => {
    add(clear(chipsEl), 
      h('button', { class: `chip${state.memberFilter.size ? '' : ' on'}`, onclick: () => (state.memberFilter.clear(), persist(), draw(), onChange()) }, 'Everyone'),
      people.map((m) =>
        h(
          'button',
          {
            class: `chip${state.memberFilter.has(m.id) ? ' on' : ''}`,
            style: { '--c': m.color },
            onclick: () => {
              if (state.memberFilter.has(m.id)) state.memberFilter.delete(m.id);
              else state.memberFilter.add(m.id);
              persist();
              draw();
              onChange();
            },
          },
          avatar(m, 'sm'),
          m.name,
        ),
      ),
      inUse.has('none') && state.memberFilter.size
        ? h('button', { class: `chip${state.memberFilter.has('none') ? ' on' : ''}`, onclick: () => (state.memberFilter.has('none') ? state.memberFilter.delete('none') : state.memberFilter.add('none'), persist(), draw(), onChange()) }, 'Unassigned')
        : null,
    );
  };
  draw();
  return chipsEl;
}

function calendarMenu(onChange) {
  const button = h('button', { class: 'btn ghost' }, 'Calendars ▾');
  button.addEventListener('click', () => {
    const m = modal({
      title: 'Show calendars',
      content: h(
        'div',
        { class: 'list' },
        state.calendars.map((cal) => {
          const input = h('input', { type: 'checkbox', checked: cal.visible });
          input.addEventListener('change', async () => {
            cal.visible = input.checked;
            onChange();
            await put(`/calendars/${cal.id}/prefs`, { visible: input.checked }).catch((e) => toast(e.message, 'error'));
          });
          return h('label', { class: 'list-row check' }, input, h('span', { class: 'swatch', style: { background: cal.color } }), h('span', { class: 'grow' }, cal.name), cal.isOwner ? null : h('small', { class: 'muted' }, cal.ownerName));
        }),
      ),
      actions: [h('a', { class: 'btn ghost', href: '#settings/calendars', onclick: () => m.close() }, 'Manage'), h('button', { class: 'btn primary', onclick: () => m.close() }, 'Done')],
    });
  });
  return button;
}

async function renderCalendarPage() {
  const title = h('h1', { class: 'page-title' });
  const root = h('div', { class: 'calendar-root' });
  const draw = () => {
    const ctx = eventContext(refresh);
    title.textContent = viewTitle(state.view, state.date, state.weekStartsOn);
    renderCalendar(root, {
      ...ctx,
      view: state.view,
      date: state.date,
      events: visibleEvents(),
      weekStartsOn: state.weekStartsOn,
      onEvent: (ev) => openEventDetails(ev, ctx),
      onDay: (day, more) => (state.view === 'month' || more ? daySheet(day, ctx) : openEventEditor({ ...ctx, date: day })),
    });
  };
  const refresh = async () => {
    try {
      await loadEvents();
    } catch (err) {
      toast(err.message, 'error');
    }
    draw();
  };
  const go = (dir) => {
    state.date = dir === 0 ? new Date() : shiftDate(state.view, state.date, dir);
    refresh();
  };
  const views = h(
    'div',
    { class: 'segmented', role: 'group', 'aria-label': 'View' },
    [
      ['month', 'Month'],
      ['week', 'Week'],
      ['agenda', 'Schedule'],
    ].map(([v, label]) =>
      h(
        'button',
        {
          class: state.view === v ? 'on' : '',
          'aria-pressed': String(state.view === v),
          onclick: (e) => {
            state.view = v;
            persist();
            views.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget));
            refresh();
          },
        },
        label,
      ),
    ),
  );
  add(clear(main), 
    h(
      'div',
      { class: 'toolbar' },
      h('button', { class: 'btn', onclick: () => go(0) }, 'Today'),
      h('button', { class: 'icon-btn', 'aria-label': 'Previous', onclick: () => go(-1) }, '‹'),
      h('button', { class: 'icon-btn', 'aria-label': 'Next', onclick: () => go(1) }, '›'),
      title,
      h('span', { class: 'grow' }),
      views,
      h('button', { class: 'btn primary', onclick: () => openEventEditor({ ...eventContext(refresh), date: sameDay(state.date, new Date()) ? null : state.date }) }, '+ Event'),
    ),
    h('div', { class: 'toolbar sub' }, memberChips(draw), h('span', { class: 'grow' }), calendarMenu(draw)),
    root,
  );
  draw();
  await refresh();
  pageRefresh = refresh;
}

// --- Chores -----------------------------------------------------------------

/** Chore charts only; grocery and to-do checklists live on the Lists tab. */
const choreLists = () => state.lists.filter((l) => l.kind !== 'checklist');

async function renderChoresPage() {
  const title = h('h1', { class: 'page-title' });
  const root = h('div', { class: 'chores-root' });
  let stars = {};
  const refresh = async () => {
    try {
      const [{ items }, starRes] = await Promise.all([get(`/items?day=${state.choreDay}`), get('/stars')]);
      state.items = items;
      stars = starRes.balances;
    } catch (err) {
      toast(err.message, 'error');
    }
    draw();
  };
  const editorCtx = (extra) => ({ lists: choreLists(), members: state.members, onChange: refresh, ...extra });
  const draw = () => {
    const day = parseYmd(state.choreDay);
    title.textContent = sameDay(day, new Date()) ? `Today · ${fmtDate(day, { month: 'long', day: 'numeric' })}` : fmtDate(day);
    renderChoreBoard({
      root,
      items: state.items,
      lists: choreLists(),
      members: state.members,
      stars,
      day: state.choreDay,
      onToggle: async (item, done, button) => {
        await toggleItem(item, done, state.choreDay, button).catch(() => {});
        stars = (await get('/stars').catch(() => ({ balances: stars }))).balances;
        draw();
      },
      onEdit: (item) => openChoreEditor(editorCtx({ item })),
      onAdd: (memberId) => openChoreEditor(editorCtx({ memberId })),
    });
  };
  const go = (n) => {
    state.choreDay = n === 0 ? ymd(new Date()) : ymd(addDays(parseYmd(state.choreDay), n));
    refresh();
  };
  add(clear(main), 
    h(
      'div',
      { class: 'toolbar' },
      h('button', { class: 'btn', onclick: () => go(0) }, 'Today'),
      h('button', { class: 'icon-btn', 'aria-label': 'Previous day', onclick: () => go(-1) }, '‹'),
      h('button', { class: 'icon-btn', 'aria-label': 'Next day', onclick: () => go(1) }, '›'),
      title,
      h('span', { class: 'grow' }),
      h('button', { class: 'btn', onclick: () => openRewards({ members: state.members, onChange: refresh }).catch((e) => toast(e.message, 'error')) }, '⭐ Rewards'),
      h('button', { class: 'btn primary', onclick: () => openChoreEditor(editorCtx()) }, '+ Chore'),
    ),
    choreLists().length ? root : h('div', { class: 'card pad' }, h('p', {}, 'You have no chore lists.'), h('a', { class: 'btn primary', href: '#settings/lists' }, 'Create a list')),
  );
  await refresh();
  pageRefresh = refresh;
}

// --- Routing ----------------------------------------------------------------

let pageRefresh = null;

function route() {
  pageRefresh = null;
  renderChrome();
  const [path, query = ''] = location.hash.slice(1).split('?');
  const [tab, section] = path.split('/');
  if (tab === 'chores') renderChoresPage();
  else if (tab === 'lists') renderListsPage(clear(main), app).then((refresh) => (pageRefresh = refresh));
  else if (tab === 'meals') renderMealsPage(clear(main), app).then((refresh) => (pageRefresh = refresh));
  else if (tab === 'settings') renderSettings(clear(main), app, section, new URLSearchParams(query));
  else renderCalendarPage();
}

registerServiceWorker();

async function boot() {
  let status;
  try {
    status = await get('/auth/status');
  } catch (err) {
    main.textContent = err.message;
    return;
  }
  if (!status.user) {
    location.href = '/login';
    return;
  }
  state.user = status.user;
  state.mailEnabled = status.mailEnabled;
  await app.reload();
  window.addEventListener('hashchange', route);
  onInstallAvailabilityChange(() => renderChrome());
  maybeShowIosHint();
  route();

  // Keep the page fresh when it is left open or revisited.
  setInterval(() => pageRefresh?.(), 2 * 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') pageRefresh?.();
  });
}

boot();
