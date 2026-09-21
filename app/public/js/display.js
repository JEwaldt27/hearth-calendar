import { get, post, setDisplayToken } from './api.js';
import { renderCalendar, shiftDate, viewRange, viewTitle, dayEvents, eventCard } from './calendar-view.js';
import { renderChoreBoard, toggleItem } from './chores.js';
import { nightOverlay, photoFrame, upNextStrip, weatherWidget } from './display-extras.js';
import { openEventDetails, openEventEditor } from './event-editor.js';
import { add, avatar, clear, fmtDate, h, modal, sameDay, toast, ymd } from './util.js';

const TOKEN_KEY = 'hearth.displayToken';
const root = document.getElementById('display');

function storage(action, key, value) {
  try {
    if (action === 'get') return localStorage.getItem(key);
    if (action === 'set') localStorage.setItem(key, value);
    if (action === 'remove') localStorage.removeItem(key);
  } catch {
    return null;
  }
  return null;
}

// The token lives in the URL fragment, which browsers never send to the server. It stays in the
// address bar so an iPad "Add to Home Screen" icon (which gets its own storage) keeps working.
const fromHash = new URLSearchParams(location.hash.slice(1)).get('token');
if (fromHash) storage('set', TOKEN_KEY, fromHash);
const token = fromHash || storage('get', TOKEN_KEY);
if (token) setDisplayToken(token);

const state = {
  settings: null,
  view: 'week',
  date: new Date(),
  calendars: [],
  members: [],
  lists: [],
  checklists: [],
  mealLists: [],
  stars: null,
  events: [],
  upcoming: [],
  lastWeather: 0,
  lastPhotoList: 0,
  items: [],
  memberFilter: new Set(),
  lastInteraction: Date.now(),
  today: ymd(new Date()),
};

function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

function showSignedOut(message) {
  add(clear(root), 
    h(
      'div',
      { class: 'auth-card center' },
      h('div', { class: 'brand big' }, h('span', { class: 'brand-mark' }, '◐'), 'Hearth Display'),
      h('p', {}, message),
      h('p', { class: 'muted' }, 'Create a display link in Settings → Wall displays and open it on this screen, or sign in to preview.'),
      h('a', { class: 'btn primary', href: '/login' }, 'Sign in'),
    ),
  );
}

const els = {};
const cals = () => new Map(state.calendars.map((c) => [c.id, c]));

function ctx() {
  const byId = cals();
  return {
    calendars: state.calendars,
    calendarsById: byId,
    membersById: new Map(state.members.map((m) => [m.id, m])),
    colorFor: (ev) => byId.get(ev.calendarId)?.color || '#8d7b6a',
    defaultCalendarId: state.calendars.find((c) => c.writable)?.id,
    allowEditing: state.settings.allowEditing,
    onChange: refreshEvents,
  };
}

function visibleEvents() {
  const byId = cals();
  return state.events.filter((ev) => {
    const cal = byId.get(ev.calendarId);
    return cal && (!state.memberFilter.size || state.memberFilter.has(cal.memberId));
  });
}

function drawClock() {
  const now = new Date();
  els.time.textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  els.date.textContent = fmtDate(now, { weekday: 'long', month: 'long', day: 'numeric' });
}

function drawCalendar() {
  const c = ctx();
  els.title.textContent = viewTitle(state.view, state.date, state.settings.weekStartsOn);
  els.viewButtons.forEach((b) => b.classList.toggle('on', b.dataset.view === state.view));
  renderCalendar(els.calendar, {
    ...c,
    view: state.view,
    date: state.date,
    events: visibleEvents(),
    weekStartsOn: state.settings.weekStartsOn,
    compact: true,
    onEvent: (ev) => openEventDetails(ev, c),
    onDay: (day) => {
      const list = dayEvents(visibleEvents(), day);
      const m = modal({
        title: fmtDate(day),
        content: h(
          'div',
          { class: 'agenda-list' },
          list.length ? list.map((ev) => eventCard(ev, { ...c, now: new Date(), onEvent: (e) => (m.close(), openEventDetails(e, c)) })) : h('p', { class: 'muted' }, 'Nothing planned.'),
        ),
        actions: state.settings.allowEditing && c.defaultCalendarId ? [h('button', { class: 'btn primary', onclick: () => (m.close(), openEventEditor({ ...c, date: day })) }, '+ Add event')] : [],
      });
    },
  });
}

function drawChips() {
  const inUse = new Set(state.calendars.map((c) => c.memberId));
  const people = state.members.filter((m) => inUse.has(m.id));
  clear(els.chips);
  if (people.length < 2) return;
  add(els.chips, 
    h('button', { class: `chip${state.memberFilter.size ? '' : ' on'}`, onclick: () => (state.memberFilter.clear(), drawChips(), drawCalendar()) }, 'Everyone'),
    people.map((m) =>
      h(
        'button',
        {
          class: `chip${state.memberFilter.has(m.id) ? ' on' : ''}`,
          style: { '--c': m.color },
          onclick: () => {
            if (state.memberFilter.has(m.id)) state.memberFilter.delete(m.id);
            else state.memberFilter.add(m.id);
            drawChips();
            drawCalendar();
          },
        },
        avatar(m, 'sm'),
        m.name,
      ),
    ),
  );
}

function drawChores() {
  if (!els.chores) return;
  const scroll = els.chores.scrollTop;
  requestAnimationFrame(() => (els.chores.scrollTop = scroll));
  renderChoreBoard({
    root: els.choreBoard,
    items: state.items,
    lists: state.lists,
    members: state.members,
    stars: state.stars,
    day: state.today,
    compact: true,
    onToggle: async (item, done, button) => {
      await toggleItem(item, done, state.today, button).catch(() => {});
      drawChores();
    },
  });
}

const SLOT_NAMES = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snack' };
const SLOT_ORDER = { breakfast: 1, lunch: 2, dinner: 3, snack: 4 };

/** Today's and tomorrow's planned meals. */
function drawMeals() {
  if (!els.mealsBox) return;
  const mealListIds = new Set(state.mealLists.map((l) => l.id));
  const meals = state.items.filter((i) => mealListIds.has(i.listId));
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const days = [
    ['Today', state.today],
    ['Tomorrow', ymd(tomorrow)],
  ];
  add(
    clear(els.mealsBox),
    days.map(([label, key]) => {
      const here = meals.filter((m) => m.dueDate === key).sort((a, b) => (SLOT_ORDER[a.mealSlot] || 9) - (SLOT_ORDER[b.mealSlot] || 9));
      return h(
        'div',
        { class: 'd-meal-day' },
        h('strong', {}, label),
        here.length
          ? here.map((m) => h('div', { class: 'd-meal' }, h('span', { class: 'muted' }, SLOT_NAMES[m.mealSlot] || 'Meal'), h('span', {}, m.title)))
          : h('div', { class: 'd-meal muted' }, 'Nothing planned'),
      );
    }),
  );
}

/** Grocery / to-do lists on the side panel: tap to check off, optional quick add. */
function drawChecklists() {
  if (!els.listsBox) return;
  const scroll = els.side.scrollTop;
  requestAnimationFrame(() => (els.side.scrollTop = scroll));
  clear(els.listsBox);
  if (!state.checklists.length) {
    add(els.listsBox, h('p', { class: 'muted' }, 'No lists are set to show on displays.'));
    return;
  }
  for (const list of state.checklists) {
    const canEdit = list.permission !== 'view';
    const mine = state.items.filter((i) => i.listId === list.id);
    const open = mine.filter((i) => !i.done);
    const checked = mine.length - open.length;
    const input = h('input', { type: 'text', placeholder: `Add to ${list.name}…`, maxlength: 200, enterkeyhint: 'enter' });
    const form =
      canEdit && state.settings.allowEditing
        ? h(
            'form',
            {
              class: 'd-quick-add',
              onsubmit: async (e) => {
                e.preventDefault();
                const title = input.value.trim();
                if (!title) return;
                input.value = '';
                try {
                  const r = await post(`/lists/${list.id}/items`, { title });
                  const at = state.items.findIndex((i) => i.id === r.item.id);
                  if (at >= 0) state.items[at] = r.item;
                  else state.items.push(r.item);
                  drawChecklists();
                } catch (err) {
                  toast(err.message, 'error');
                }
              },
            },
            input,
            h('button', { class: 'btn primary', type: 'submit', 'aria-label': 'Add' }, '+'),
          )
        : null;
    add(
      els.listsBox,
      h(
        'section',
        { class: 'd-list', style: { '--c': list.color } },
        h('header', { class: 'd-list-head' }, h('span', { class: 'dot', style: { background: list.color } }), h('strong', { class: 'grow' }, list.name), checked ? h('small', { class: 'muted' }, `✓ ${checked}`) : null),
        open.length
          ? h(
              'ul',
              { class: 'd-list-items' },
              open.map((item) =>
                h(
                  'li',
                  {},
                  h(
                    'button',
                    {
                      class: 'd-list-item',
                      disabled: !canEdit,
                      onclick: async (e) => {
                        e.currentTarget.classList.add('done');
                        item.done = true;
                        try {
                          await post(`/items/${item.id}/complete`, { done: true });
                        } catch (err) {
                          item.done = false;
                          toast(err.message, 'error');
                        }
                        setTimeout(drawChecklists, 450);
                      },
                    },
                    h('span', { class: 'check' }, '✓'),
                    h('span', {}, item.title),
                  ),
                ),
              ),
            )
          : h('p', { class: 'muted d-list-empty' }, 'All done!'),
        form,
      ),
    );
  }
}

/** Events in the next 24 hours, for the "Up next" strip (independent of the calendar view). */
async function refreshUpcoming() {
  if (!els.upNext) return;
  const now = new Date();
  try {
    const { events } = await get(`/events?display=1&from=${encodeURIComponent(new Date(now - 12 * 3600000).toISOString())}&to=${encodeURIComponent(new Date(now.getTime() + 24 * 3600000).toISOString())}`);
    state.upcoming = events;
  } catch {
    /* keep the previous list */
  }
  drawUpNext();
}

function drawUpNext() {
  if (!els.upNext) return;
  const byId = cals();
  const visible = state.upcoming.filter((ev) => {
    const cal = byId.get(ev.calendarId);
    return cal && (!state.memberFilter.size || state.memberFilter.has(cal.memberId));
  });
  els.upNext.update(visible, ctx());
}

async function refreshEvents() {
  const { start, end } = viewRange(state.view, state.date, state.settings.weekStartsOn);
  try {
    const { events } = await get(`/events?display=1&from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(end.toISOString())}`);
    state.events = events;
    els.status.hidden = true;
  } catch (err) {
    handleError(err);
  }
  drawCalendar();
}

async function refreshAll() {
  try {
    const [c, m, l] = await Promise.all([get('/calendars?display=1'), get('/members'), get('/lists?display=1')]);
    state.calendars = c.calendars;
    state.members = m.members;
    state.lists = l.lists.filter((list) => list.kind !== 'checklist');
    state.checklists = l.lists.filter((list) => list.kind === 'checklist');
    state.mealLists = l.lists.filter((list) => list.kind === 'meals');
    state.lists = l.lists.filter((list) => list.kind === 'chores');
    const s = state.settings;
    if (s.showChores || s.showLists || s.showMeals) state.items = (await get(`/items?display=1&day=${state.today}`)).items;
    if (s.showChores) state.stars = (await get('/stars').catch(() => ({ balances: null }))).balances;
    els.status.hidden = true;
  } catch (err) {
    handleError(err);
  }
  await refreshUpcoming();
  if (els.weather && Date.now() - state.lastWeather > 10 * 60000) {
    state.lastWeather = Date.now();
    els.weather.refresh();
  }
  if (els.photos && Date.now() - state.lastPhotoList > 30 * 60000) {
    state.lastPhotoList = Date.now();
    els.photos.loadList();
  }
  drawChips();
  const typing = els.listsBox?.contains(document.activeElement) && document.activeElement.value;
  drawChores();
  drawMeals();
  if (!typing) drawChecklists();
  await refreshEvents();
}

function handleError(err) {
  if (err.status === 401) {
    storage('remove', TOKEN_KEY);
    showSignedOut('This display link is no longer valid.');
    throw err;
  }
  els.status.textContent = `Offline — showing saved data (${err.message})`;
  els.status.hidden = false;
}

let wakeLock = null;
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible' && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    }
  } catch {
    /* not supported or not allowed yet */
  }
}

function build() {
  const s = state.settings;
  const go = (dir) => {
    state.date = dir === 0 ? new Date() : shiftDate(state.view, state.date, dir);
    refreshEvents();
  };
  els.time = h('span', { class: 'd-time' });
  els.date = h('span', { class: 'd-date' });
  els.title = h('span', { class: 'd-range' });
  els.chips = h('div', { class: 'chips' });
  els.calendar = h('div', { class: 'calendar-root d-calendar' });
  els.status = h('div', { class: 'd-status', hidden: true });
  els.weather = s.showWeather ? weatherWidget() : null;
  els.upNext = s.showUpNext ? upNextStrip() : null;
  els.night = s.nightMode ? nightOverlay(s) : null;
  els.photos = s.photoFrame ? photoFrame(s, { idleMs: () => s.photoIdleMinutes * 60000 }) : null;
  els.viewButtons = [
    ['month', 'Month'],
    ['week', 'Week'],
    ['day', 'Day'],
    ['agenda', 'Schedule'],
  ].map(([v, label]) =>
    h(
      'button',
      {
        dataset: { view: v },
        onclick: () => {
          state.view = v;
          refreshEvents();
        },
      },
      label,
    ),
  );
  if (s.showChores || s.showLists || s.showMeals) {
    els.choreBoard = s.showChores ? h('div', {}) : null;
    els.listsBox = s.showLists ? h('div', { class: 'd-lists' }) : null;
    els.mealsBox = s.showMeals ? h('div', { class: 'd-meals' }) : null;
    els.side = h(
      'aside',
      { class: 'd-chores' },
      s.showMeals ? [h('h2', {}, '🍽 Meals'), els.mealsBox] : null,
      s.showChores ? [h('h2', { class: s.showMeals ? 'd-section-gap' : '' }, 'Today’s chores'), els.choreBoard] : null,
      s.showLists ? [h('h2', { class: s.showChores || s.showMeals ? 'd-section-gap' : '' }, 'Lists'), els.listsBox] : null,
    );
    els.chores = s.showChores ? els.side : null;
  }

  add(clear(root), 
    h(
      'header',
      { class: 'd-top' },
      h('div', { class: 'd-clock' }, els.time, els.date, els.weather?.el),
      h(
        'div',
        { class: 'd-controls' },
        h('div', { class: 'row gap-s' }, h('button', { class: 'icon-btn', 'aria-label': 'Previous', onclick: () => go(-1) }, '‹'), h('button', { class: 'btn', onclick: () => go(0) }, 'Today'), h('button', { class: 'icon-btn', 'aria-label': 'Next', onclick: () => go(1) }, '›'), els.title),
        h('div', { class: 'segmented' }, els.viewButtons),
        s.allowEditing ? h('button', { class: 'btn primary', onclick: () => openEventEditor({ ...ctx() }) }, '+ Event') : null,
        document.fullscreenEnabled
          ? h('button', { class: 'icon-btn', 'aria-label': 'Full screen', title: 'Full screen', onclick: () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {}) }, '⛶')
          : null,
      ),
    ),
    h('div', { class: 'd-sub' }, els.upNext?.el, els.chips, els.status),
    h('div', { class: `d-body${els.side ? ' with-chores' : ''}` }, els.calendar, els.side),
    els.photos?.el,
    els.night?.el,
  );
}

async function boot() {
  let session;
  try {
    session = await get('/display/session');
  } catch (err) {
    showSignedOut(err.status === 401 ? (token ? 'This display link is no longer valid.' : 'This screen is not set up yet.') : err.message);
    if (err.status === 401) storage('remove', TOKEN_KEY);
    return;
  }
  state.settings = session.settings;
  state.view = session.settings.view;
  applyTheme(session.settings.theme);
  document.title = session.display ? `${session.display.name} · Hearth` : 'Hearth Display (preview)';
  build();
  drawClock();
  await refreshAll().catch(() => {});

  setInterval(() => {
    drawClock();
    const night = els.night ? els.night.tick() : false;
    els.photos?.tick(state.lastInteraction, night || Boolean(document.querySelector('.backdrop')));
  }, 1000);
  setInterval(() => {
    const today = ymd(new Date());
    // After a few idle minutes, drift back to today's default view.
    const idle = Date.now() - state.lastInteraction > 5 * 60 * 1000 && !document.querySelector('.backdrop');
    if (today !== state.today || (idle && (!sameDay(state.date, new Date()) || state.view !== state.settings.view))) {
      state.today = today;
      state.date = new Date();
      state.view = state.settings.view;
    }
    refreshAll().catch(() => {});
  }, 60 * 1000);

  for (const evt of ['pointerdown', 'keydown']) {
    document.addEventListener(evt, () => {
      state.lastInteraction = Date.now();
      keepAwake();
    });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      keepAwake();
      refreshAll().catch(() => {});
    }
  });
  keepAwake();
  window.addEventListener('offline', () => toast('Connection lost — will keep retrying.', 'error'));
}

boot();
