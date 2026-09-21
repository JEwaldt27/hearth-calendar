import { del, get, patch, post } from './api.js';
import { shareDialog } from './settings.js';
import { add, addDays, busy, clear, confirmDialog, field, fmtDate, h, modal, sameDay, startOfWeek, toast, ymd } from './util.js';

const SLOTS = [
  ['breakfast', 'Breakfast'],
  ['lunch', 'Lunch'],
  ['dinner', 'Dinner'],
  ['snack', 'Snack'],
];
const SLOTS_KEY = 'hearth.mealSlots';
const LIST_KEY = 'hearth.mealList';

function stored(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}
function store(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

/** Add/edit a meal. ctx: { item?, list, day, slot, checklists, history, onChange } */
function mealEditor(ctx) {
  const item = ctx.item;
  const title = h('input', { type: 'text', value: item?.title || '', maxlength: 200, placeholder: 'Tacos, spaghetti, leftovers…', list: 'meal-history' });
  const datalist = h('datalist', { id: 'meal-history' }, ctx.history.map((m) => h('option', { value: m.title })));
  const slot = h('select', {}, SLOTS.map(([v, label]) => h('option', { value: v, selected: v === (item?.mealSlot || ctx.slot) }, label)));
  const date = h('input', { type: 'date', value: item?.dueDate || ctx.day });
  const notes = h('textarea', { rows: 5, placeholder: 'Ingredients, one per line (optional)' }, item?.notes || '');
  // Picking a meal made before fills in its ingredients.
  title.addEventListener('change', () => {
    const prior = ctx.history.find((m) => m.title.toLowerCase() === title.value.trim().toLowerCase());
    if (prior && !notes.value.trim() && prior.notes) notes.value = prior.notes;
  });
  const target = h('select', {}, ctx.checklists.map((l) => h('option', { value: l.id }, l.name)));
  const toGroceries = h('button', { class: 'btn', type: 'button' }, '🛒 Add ingredients');
  toGroceries.addEventListener(
    'click',
    busy(toGroceries, async () => {
      const lines = notes.value.split(/\r?\n/).map((l) => l.replace(/^[-•*\s]+/, '').trim()).filter(Boolean);
      if (!lines.length) throw new Error('Add some ingredients first, one per line.');
      for (const line of lines) await post(`/lists/${target.value}/items`, { title: line });
      toast(`Added ${lines.length} item${lines.length === 1 ? '' : 's'} to ${target.selectedOptions[0].textContent}`);
    }),
  );
  const save = h('button', { class: 'btn primary' }, item ? 'Save' : 'Add meal');
  const m = modal({
    title: item ? 'Edit meal' : 'Plan a meal',
    content: h(
      'form',
      { class: 'stack', onsubmit: (e) => (e.preventDefault(), save.click()) },
      field('Meal', title),
      datalist,
      h('div', { class: 'row gap wrap' }, field('When', slot), field('Day', date)),
      field('Ingredients', notes),
      ctx.checklists.length ? h('div', { class: 'row gap-s wrap' }, toGroceries, h('span', { class: 'muted' }, 'to'), target) : null,
      h('input', { type: 'submit', hidden: true }),
    ),
    actions: [
      item
        ? h(
            'button',
            {
              class: 'btn danger ghost left',
              onclick: async () => {
                if (!(await confirmDialog(`Remove “${item.title}” from the plan?`, { okLabel: 'Remove', danger: true }))) return;
                await del(`/items/${item.id}`).catch((e) => toast(e.message, 'error'));
                m.close();
                ctx.onChange();
              },
            },
            'Remove',
          )
        : null,
      h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'),
      save,
    ].filter(Boolean),
  });
  save.addEventListener(
    'click',
    busy(save, async () => {
      if (!title.value.trim()) throw new Error('What’s for this meal?');
      const body = { title: title.value.trim(), mealSlot: slot.value, dueDate: date.value, notes: notes.value };
      if (item) await patch(`/items/${item.id}`, body);
      else await post(`/lists/${ctx.list.id}/items`, body);
      m.close();
      ctx.onChange();
    }),
  );
}

export async function renderMealsPage(main, app) {
  let weekStart = startOfWeek(new Date(), app.state.weekStartsOn);
  let slots = stored(SLOTS_KEY, ['dinner']);
  let items = [];
  let history = [];
  const mealLists = () => app.state.lists.filter((l) => l.kind === 'meals');
  const selected = () => mealLists().find((l) => l.id === stored(LIST_KEY, null)) || mealLists()[0];

  const title = h('h1', { class: 'page-title' });
  const grid = h('div', { class: 'meal-grid' });
  const slotChips = h('div', { class: 'chips' });

  async function refresh() {
    const list = selected();
    if (!list) return draw();
    try {
      const [itemsRes, historyRes] = await Promise.all([
        get(`/items?mealsFrom=${ymd(weekStart)}&mealsTo=${ymd(addDays(weekStart, 6))}`),
        get(`/lists/${list.id}/meal-history`),
      ]);
      items = itemsRes.items.filter((i) => i.listId === list.id);
      history = historyRes.meals;
    } catch (err) {
      toast(err.message, 'error');
    }
    draw();
  }

  function drawSlots() {
    add(
      clear(slotChips),
      SLOTS.map(([v, label]) =>
        h(
          'button',
          {
            class: `chip${slots.includes(v) ? ' on' : ''}`,
            onclick: () => {
              slots = slots.includes(v) ? slots.filter((s) => s !== v) : SLOTS.map(([k]) => k).filter((k) => k === v || slots.includes(k));
              if (!slots.length) slots = ['dinner'];
              store(SLOTS_KEY, slots);
              draw();
            },
          },
          label,
        ),
      ),
    );
  }

  function draw() {
    const list = selected();
    title.textContent = `Meals · ${fmtDate(weekStart, { month: 'short', day: 'numeric' })} – ${fmtDate(addDays(weekStart, 6), { month: 'short', day: 'numeric' })}`;
    drawSlots();
    if (!list) {
      add(
        clear(grid),
        h(
          'div',
          { class: 'card board-empty' },
          h('span', { class: 'big-emoji' }, '🍽️'),
          h('p', {}, 'Plan the week’s meals and send ingredients to your grocery list.'),
          h(
            'button',
            {
              class: 'btn primary',
              onclick: async () => {
                const { list: created } = await post('/lists', { name: 'Meal plan', kind: 'meals' });
                store(LIST_KEY, created.id);
                await app.reload();
                refresh();
              },
            },
            'Start a meal plan',
          ),
        ),
      );
      return;
    }
    const canEdit = list.permission !== 'view';
    const checklists = app.state.lists.filter((l) => l.kind === 'checklist' && l.permission !== 'view');
    const today = new Date();
    grid.style.setProperty('--slots', slots.length);
    const rows = [];
    for (let i = 0; i < 7; i++) {
      const day = addDays(weekStart, i);
      const key = ymd(day);
      rows.push(
        h(
          'div',
          { class: `meal-row${sameDay(day, today) ? ' today' : ''}` },
          h('div', { class: 'meal-day' }, h('span', { class: 'wd' }, day.toLocaleDateString([], { weekday: 'short' })), h('span', { class: 'dn' }, day.getDate())),
          slots.map((slot) => {
            const here = items.filter((it) => it.dueDate === key && (it.mealSlot || 'dinner') === slot);
            return h(
              'div',
              { class: 'meal-cell' },
              slots.length > 1 ? h('span', { class: 'meal-slot-label' }, SLOTS.find(([v]) => v === slot)[1]) : null,
              here.map((it) =>
                h(
                  'button',
                  { class: 'meal-chip', disabled: !canEdit, onclick: () => mealEditor({ item: it, list, day: key, slot, checklists, history, onChange: refresh }) },
                  h('span', {}, it.title),
                  it.notes ? h('small', { class: 'muted' }, `${it.notes.split(/\r?\n/).filter(Boolean).length} ingredients`) : null,
                ),
              ),
              canEdit ? h('button', { class: 'meal-add', 'aria-label': `Add ${slot} on ${key}`, onclick: () => mealEditor({ list, day: key, slot, checklists, history, onChange: refresh }) }, here.length ? '+' : '+ Add') : null,
            );
          }),
        ),
      );
    }
    add(clear(grid), rows);
  }

  const go = (n) => {
    weekStart = n === 0 ? startOfWeek(new Date(), app.state.weekStartsOn) : addDays(weekStart, n * 7);
    refresh();
  };
  const list = selected();
  const listPicker =
    mealLists().length > 1
      ? h(
          'select',
          { onchange: (e) => (store(LIST_KEY, e.target.value), refresh()) },
          mealLists().map((l) => h('option', { value: l.id, selected: l.id === list?.id }, l.isOwner ? l.name : `${l.name} (${l.ownerName})`)),
        )
      : null;
  add(
    clear(main),
    h(
      'div',
      { class: 'toolbar' },
      h('button', { class: 'btn', onclick: () => go(0) }, 'This week'),
      h('button', { class: 'icon-btn', 'aria-label': 'Previous week', onclick: () => go(-1) }, '‹'),
      h('button', { class: 'icon-btn', 'aria-label': 'Next week', onclick: () => go(1) }, '›'),
      title,
      h('span', { class: 'grow' }),
      listPicker,
      list?.isOwner ? h('button', { class: 'btn ghost', onclick: () => shareDialog('list', list, () => app.reload()) }, 'Share') : null,
    ),
    h('div', { class: 'toolbar sub' }, h('span', { class: 'muted' }, 'Show:'), slotChips),
    grid,
  );
  draw();
  await refresh();
  return refresh;
}

/** Today's meals as short text, e.g. for the wall display. */
export function mealsOn(items, day) {
  const key = typeof day === 'string' ? day : ymd(day);
  const order = Object.fromEntries(SLOTS.map(([v], i) => [v, i]));
  return items.filter((i) => i.dueDate === key && i.mealSlot).sort((a, b) => order[a.mealSlot] - order[b.mealSlot]);
}

export const slotLabel = (slot) => SLOTS.find(([v]) => v === slot)?.[1] || 'Meal';
