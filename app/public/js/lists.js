import { del, get, patch, post } from './api.js';
import { shareDialog } from './settings.js';
import { add, busy, clear, colorPicker, confirmDialog, field, h, modal, toast } from './util.js';

const SELECTED_KEY = 'hearth.selectedList';

function remember(id) {
  try {
    localStorage.setItem(SELECTED_KEY, id);
  } catch {
    /* storage unavailable */
  }
}

function remembered() {
  try {
    return localStorage.getItem(SELECTED_KEY);
  } catch {
    return null;
  }
}

/** Create or rename a checklist. Resolves to the saved list id, or null if cancelled. */
function listForm(list) {
  return new Promise((resolve) => {
    let color = list?.color || '#f29f3d';
    let done = false;
    const name = h('input', { type: 'text', value: list?.name || '', maxlength: 100, placeholder: 'Groceries, Costco, Packing, To-do…' });
    const save = h('button', { class: 'btn primary' }, list ? 'Save' : 'Create list');
    const m = modal({
      title: list ? 'Edit list' : 'New list',
      content: h('form', { class: 'stack', onsubmit: (e) => (e.preventDefault(), save.click()) }, field('Name', name), field('Colour', colorPicker(color, (c) => (color = c))), h('input', { type: 'submit', hidden: true })),
      actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), save],
      onClose: () => !done && resolve(null),
    });
    save.addEventListener(
      'click',
      busy(save, async () => {
        const saved = list
          ? (await patch(`/lists/${list.id}`, { name: name.value, color })).list
          : (await post('/lists', { name: name.value, color, kind: 'checklist' })).list;
        done = true;
        m.close();
        resolve(saved.id);
      }),
    );
  });
}

function editItemDialog(item, onChange) {
  const title = h('input', { type: 'text', value: item.title, maxlength: 200 });
  const save = h('button', { class: 'btn primary' }, 'Save');
  const m = modal({
    title: 'Edit item',
    content: h('form', { class: 'stack', onsubmit: (e) => (e.preventDefault(), save.click()) }, field('Item', title), h('input', { type: 'submit', hidden: true })),
    actions: [
      h(
        'button',
        {
          class: 'btn danger ghost left',
          onclick: async () => {
            m.close();
            await del(`/items/${item.id}`).catch((e) => toast(e.message, 'error'));
            onChange();
          },
        },
        'Delete',
      ),
      h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'),
      save,
    ],
  });
  save.addEventListener(
    'click',
    busy(save, async () => {
      await patch(`/items/${item.id}`, { title: title.value });
      m.close();
      onChange();
    }),
  );
}

/** The list's "usuals": tap to add back, and manage the set. */
async function staplesDialog(list, openItems, onAdded) {
  const canEdit = list.permission !== 'view';
  const chips = h('div', { class: 'staples' });
  const onList = new Set(openItems.map((i) => i.title.toLowerCase()));
  let staples = (await get(`/lists/${list.id}/staples`)).staples;
  const draw = () => {
    add(
      clear(chips),
      staples.length
        ? staples.map((st) =>
            h(
              'span',
              { class: `staple${onList.has(st.title.toLowerCase()) ? ' on' : ''}` },
              h(
                'button',
                {
                  class: 'staple-add',
                  disabled: !canEdit || onList.has(st.title.toLowerCase()),
                  onclick: async () => {
                    await post(`/lists/${list.id}/items`, { title: st.title }).catch((e) => toast(e.message, 'error'));
                    onList.add(st.title.toLowerCase());
                    draw();
                    onAdded();
                  },
                },
                onList.has(st.title.toLowerCase()) ? `✓ ${st.title}` : `+ ${st.title}`,
              ),
              canEdit
                ? h(
                    'button',
                    {
                      class: 'staple-remove',
                      'aria-label': `Remove ${st.title} from usuals`,
                      onclick: async () => {
                        await del(`/staples/${st.id}`).catch((e) => toast(e.message, 'error'));
                        staples = staples.filter((x) => x.id !== st.id);
                        draw();
                      },
                    },
                    '✕',
                  )
                : null,
            ),
          )
        : h('p', { class: 'muted' }, 'No usuals yet. Add the things you buy most weeks.'),
    );
  };
  draw();
  const input = h('input', { type: 'text', placeholder: 'Add a usual, e.g. Milk', maxlength: 200 });
  const addForm = h(
    'form',
    {
      class: 'quick-add',
      onsubmit: async (e) => {
        e.preventDefault();
        if (!input.value.trim()) return;
        staples = (await post(`/lists/${list.id}/staples`, { title: input.value })).staples;
        input.value = '';
        draw();
      },
    },
    input,
    h('button', { class: 'btn', type: 'submit' }, 'Save'),
  );
  const addAll = h('button', { class: 'btn ghost' }, 'Add all usuals to the list');
  addAll.addEventListener(
    'click',
    busy(addAll, async () => {
      for (const st of staples) {
        if (!onList.has(st.title.toLowerCase())) {
          await post(`/lists/${list.id}/items`, { title: st.title });
          onList.add(st.title.toLowerCase());
        }
      }
      draw();
      onAdded();
    }),
  );
  const saveCurrent = h('button', { class: 'btn ghost' }, 'Save what’s on the list as usuals');
  saveCurrent.addEventListener(
    'click',
    busy(saveCurrent, async () => {
      if (!openItems.length) throw new Error('The list is empty.');
      staples = (await post(`/lists/${list.id}/staples`, { titles: openItems.map((i) => i.title) })).staples;
      draw();
      toast('Saved as usuals');
    }),
  );
  modal({
    title: `${list.name} · usuals`,
    wide: true,
    content: h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Tap one to put it back on the list.'), chips, canEdit ? addForm : null),
    actions: canEdit ? [saveCurrent, addAll] : [],
  });
}

/** Shared grocery / to-do checklists. */
export async function renderListsPage(main, app) {
  let items = [];
  let selectedId = remembered();
  const checklists = () => app.state.lists.filter((l) => l.kind === 'checklist');

  const nav = h('nav', { class: 'lists-nav', 'aria-label': 'Lists' });
  const panel = h('section', { class: 'card list-panel' });

  const selected = () => checklists().find((l) => l.id === selectedId) || checklists()[0] || null;

  async function refresh() {
    try {
      items = (await get('/items')).items;
    } catch (err) {
      toast(err.message, 'error');
    }
    draw();
  }

  async function reloadLists(selectId) {
    await app.reload();
    if (selectId) {
      selectedId = selectId;
      remember(selectId);
    }
    await refresh();
  }

  const newList = async () => {
    const id = await listForm(null);
    if (id) await reloadLists(id);
  };

  function drawNav() {
    const current = selected();
    add(
      clear(nav),
      checklists().map((l) => {
        const open = items.filter((i) => i.listId === l.id && !i.done).length;
        return h(
          'button',
          {
            class: `list-tab${current && l.id === current.id ? ' on' : ''}`,
            style: { '--c': l.color },
            onclick: () => {
              selectedId = l.id;
              remember(l.id);
              draw();
            },
          },
          h('span', { class: 'dot', style: { background: l.color } }),
          h('span', { class: 'grow' }, l.name),
          open ? h('span', { class: 'count' }, open) : null,
        );
      }),
    );
  }

  let showWho = false;
  function itemRow(item, canEdit) {
    return h(
      'li',
      { class: `check-item${item.done ? ' done' : ''}` },
      h(
        'button',
        {
          class: 'check',
          'aria-pressed': String(item.done),
          'aria-label': `${item.done ? 'Uncheck' : 'Check off'} ${item.title}`,
          disabled: !canEdit,
          onclick: async () => {
            item.done = !item.done;
            draw();
            try {
              await post(`/items/${item.id}/complete`, { done: item.done });
            } catch (err) {
              item.done = !item.done;
              draw();
              toast(err.message, 'error');
            }
          },
        },
        '✓',
      ),
      h(
        'button',
        { class: 'item-title', disabled: !canEdit, onclick: () => editItemDialog(item, refresh) },
        h('span', {}, item.title),
        showWho && (item.done ? item.completedByName : item.createdByName)
          ? h('small', { class: 'item-who' }, item.done ? `✓ ${item.completedByName}` : `added by ${item.createdByName}`)
          : null,
      ),
      canEdit
        ? h(
            'button',
            {
              class: 'icon-btn remove',
              'aria-label': `Remove ${item.title}`,
              onclick: async () => {
                items = items.filter((i) => i !== item);
                draw();
                await del(`/items/${item.id}`).catch((e) => toast(e.message, 'error'));
              },
            },
            '✕',
          )
        : null,
    );
  }

  function drawPanel() {
    const list = selected();
    if (!list) {
      add(clear(panel), h('div', { class: 'board-empty' }, h('span', { class: 'big-emoji' }, '🛒'), h('p', {}, 'No lists yet.'), h('button', { class: 'btn primary', onclick: newList }, '+ New list')));
      return;
    }
    const canEdit = list.permission !== 'view';
    showWho = !list.isOwner || Boolean(list.shares?.length);
    const mine = items.filter((i) => i.listId === list.id);
    const open = mine.filter((i) => !i.done);
    const checked = mine.filter((i) => i.done);

    const input = h('input', { type: 'text', placeholder: 'Add an item…', maxlength: 200, enterkeyhint: 'enter', autocomplete: 'off' });
    const addItems = async (titles) => {
      const clean = titles.map((t) => t.trim()).filter(Boolean);
      if (!clean.length) return;
      for (const title of clean) {
        try {
          const r = await post(`/lists/${list.id}/items`, { title });
          const at = items.findIndex((i) => i.id === r.item.id);
          if (at >= 0) items[at] = r.item;
          else items.push(r.item);
        } catch (err) {
          toast(err.message, 'error');
        }
      }
      draw();
      panel.querySelector('.quick-add input')?.focus();
    };
    // Pasting several lines adds one item per line.
    input.addEventListener('paste', (e) => {
      const text = e.clipboardData?.getData('text') || '';
      if (!text.includes('\n')) return;
      e.preventDefault();
      addItems(text.split(/\r?\n/));
    });
    const form = h(
      'form',
      {
        class: 'quick-add',
        onsubmit: (e) => {
          e.preventDefault();
          const value = input.value;
          input.value = '';
          addItems([value]);
        },
      },
      input,
      h('button', { class: 'btn primary', type: 'submit' }, 'Add'),
    );

    const clearChecked = h('button', { class: 'btn ghost' }, 'Clear checked');
    clearChecked.addEventListener(
      'click',
      busy(clearChecked, async () => {
        await post(`/lists/${list.id}/clear-checked`);
        items = items.filter((i) => !(i.listId === list.id && i.done));
        draw();
      }),
    );

    const menu = list.isOwner
      ? h(
          'button',
          {
            class: 'btn ghost',
            onclick: async () => {
              const m = modal({
                title: list.name,
                content: h(
                  'div',
                  { class: 'stack' },
                  h('button', { class: 'btn block', onclick: async () => (m.close(), (await listForm(list)) && reloadLists()) }, 'Rename or recolour'),
                  h('button', { class: 'btn block', onclick: () => (m.close(), shareDialog('list', list, () => reloadLists())) }, 'Share'),
                  h(
                    'button',
                    {
                      class: 'btn block danger',
                      onclick: async () => {
                        m.close();
                        if (!(await confirmDialog(`Delete “${list.name}” and everything on it?`, { okLabel: 'Delete', danger: true }))) return;
                        await del(`/lists/${list.id}`).catch((e) => toast(e.message, 'error'));
                        selectedId = null;
                        reloadLists();
                      },
                    },
                    'Delete list',
                  ),
                ),
              });
            },
          },
          'Edit',
        )
      : h(
          'button',
          {
            class: 'btn ghost',
            onclick: async () => {
              if (!(await confirmDialog(`Leave “${list.name}”? ${list.ownerName} can share it with you again.`, { okLabel: 'Leave', danger: true }))) return;
              await del(`/lists/${list.id}`).catch((e) => toast(e.message, 'error'));
              selectedId = null;
              reloadLists();
            },
          },
          'Leave',
        );

    add(
      clear(panel),
      h(
        'header',
        { class: 'list-head' },
        h('span', { class: 'swatch big', style: { background: list.color } }),
        h(
          'div',
          { class: 'grow' },
          h('h2', {}, list.name),
          h('small', { class: 'muted' }, list.isOwner ? (list.shares?.length ? `Shared with ${list.shares.map((s) => s.name).join(', ')}` : 'Only you') : `Shared by ${list.ownerName}${canEdit ? '' : ' · view only'}`),
        ),
        h('button', { class: 'btn ghost', onclick: () => staplesDialog(list, open, refresh).catch((e) => toast(e.message, 'error')) }, '★ Usuals'),
        list.isOwner ? h('button', { class: 'btn ghost', onclick: () => shareDialog('list', list, () => reloadLists()) }, 'Share') : null,
        menu,
      ),
      canEdit ? form : null,
      open.length
        ? h('ul', { class: 'check-items' }, open.map((i) => itemRow(i, canEdit)))
        : h('p', { class: 'muted empty-list' }, checked.length ? 'All done! 🎉' : 'Nothing on this list yet.'),
      checked.length
        ? h(
            'div',
            { class: 'checked-block' },
            h('div', { class: 'row gap-s' }, h('span', { class: 'muted grow' }, `Checked (${checked.length})`), canEdit ? clearChecked : null),
            h('ul', { class: 'check-items' }, checked.map((i) => itemRow(i, canEdit))),
          )
        : null,
    );
  }

  function draw() {
    drawNav();
    drawPanel();
  }

  add(
    clear(main),
    h('div', { class: 'toolbar' }, h('h1', { class: 'page-title' }, 'Lists'), h('span', { class: 'grow' }), h('button', { class: 'btn primary', onclick: newList }, '+ New list')),
    h('div', { class: 'lists-layout' }, nav, panel),
  );
  draw();
  await refresh();

  // Keep lists fresh while someone else is adding things (e.g. at the store together).
  const timer = setInterval(async () => {
    if (!main.contains(panel)) return clearInterval(timer);
    const input = panel.querySelector('.quick-add input');
    // Don't redraw while a dialog is open or something is half-typed.
    if (document.visibilityState !== 'visible' || document.querySelector('.backdrop') || input?.value) return;
    const hadFocus = document.activeElement === input;
    await refresh();
    if (hadFocus) panel.querySelector('.quick-add input')?.focus();
  }, 15000);
  return refresh;
}
