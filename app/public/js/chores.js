import { del, get, patch, post } from './api.js';
import { add, avatar, busy, clear, confirmDialog, field, h, modal, parseYmd, toast, weekdayNames, ymd } from './util.js';

export const EVERY_DAY = 127;
export const WEEKDAYS = 62;

/** Should this item appear on the board for `day` ('YYYY-MM-DD')? */
export function isShownOn(item, day) {
  const date = parseYmd(day);
  if (item.repeatDays) {
    return Boolean(item.repeatDays & (1 << date.getDay())) && (!item.dueDate || item.dueDate <= day);
  }
  if (item.done) return item.completedAt ? ymd(new Date(item.completedAt)) === day : false;
  return !item.dueDate || item.dueDate <= day;
}

export function describeRepeat(bits) {
  if (!bits) return '';
  if (bits === EVERY_DAY) return 'Every day';
  if (bits === WEEKDAYS) return 'Weekdays';
  if (bits === 65) return 'Weekends';
  const names = weekdayNames(0, 'short');
  return names.filter((_, i) => bits & (1 << i)).join(', ');
}

/**
 * Chore chart: one column per family member plus "Anyone".
 * ctx: { root, items, lists, members, day, editable, onToggle(item, done), onEdit?(item), onAdd?(memberId), compact }
 */
export function renderChoreBoard(ctx) {
  const { root, day } = ctx;
  clear(root);
  const listsById = new Map(ctx.lists.map((l) => [l.id, l]));
  const items = ctx.items.filter((i) => listsById.has(i.listId) && isShownOn(i, day));

  const columns = ctx.members.map((m) => ({ member: m, items: items.filter((i) => i.memberId === m.id) }));
  const unassigned = items.filter((i) => !i.memberId || !ctx.members.some((m) => m.id === i.memberId));
  if (unassigned.length || !ctx.compact) columns.push({ member: null, items: unassigned });

  const visibleColumns = ctx.compact ? columns.filter((c) => c.items.length) : columns;
  if (!visibleColumns.length) {
    add(root, h('div', { class: 'board-empty' }, h('span', { class: 'big-emoji' }, '🎉'), h('p', {}, ctx.compact ? 'No chores today' : 'Nothing to do on this day.')));
    return;
  }

  const board = h('div', { class: `board${ctx.compact ? ' compact' : ''}` });
  for (const col of visibleColumns) {
    const done = col.items.filter((i) => i.done).length;
    const member = col.member;
    const pct = col.items.length ? Math.round((done / col.items.length) * 100) : 0;
    add(board,
      h(
        'section',
        { class: 'board-col', style: { '--c': member?.color || '#8d7b6a' } },
        h(
          'header',
          { class: 'board-head' },
          member ? avatar(member, 'lg') : h('span', { class: 'avatar lg anyone' }, '★'),
          h('div', {}, h('strong', {}, member ? member.name : 'Anyone'), h('small', {}, `${done} of ${col.items.length} done`)),
          member && ctx.stars ? h('span', { class: 'star-chip', title: 'Stars earned' }, `⭐ ${ctx.stars[member.id] || 0}`) : null,
          h('div', { class: 'ring', style: { '--p': pct } }),
        ),
        h(
          'ul',
          { class: 'chores' },
          col.items
            .sort((a, b) => Number(a.done) - Number(b.done))
            .map((item) => {
              const list = listsById.get(item.listId);
              const canEdit = list && list.permission !== 'view' && ctx.editable !== false;
              const overdue = !item.repeatDays && !item.done && item.dueDate && item.dueDate < day;
              return h(
                'li',
                { class: `chore${item.done ? ' done' : ''}` },
                h(
                  'button',
                  {
                    class: 'check',
                    'aria-pressed': String(item.done),
                    'aria-label': `${item.done ? 'Mark not done' : 'Mark done'}: ${item.title}`,
                    disabled: !canEdit,
                    onclick: (e) => ctx.onToggle(item, !item.done, e.currentTarget),
                  },
                  '✓',
                ),
                h(
                  'button',
                  { class: 'chore-text', disabled: !ctx.onEdit || !canEdit, onclick: () => ctx.onEdit?.(item) },
                  h('span', { class: 'chore-title' }, item.title),
                  h(
                    'small',
                    {},
                    [item.repeatDays ? `↻ ${describeRepeat(item.repeatDays)}` : null, overdue ? `Overdue (${parseYmd(item.dueDate).toLocaleDateString()})` : null, ctx.lists.length > 1 ? list?.name : null]
                      .filter(Boolean)
                      .join(' · '),
                  ),
                ),
              );
            }),
        ),
        ctx.onAdd ? h('button', { class: 'btn ghost add-chore', onclick: () => ctx.onAdd(member?.id || null) }, '+ Add') : null,
      ),
    );
  }
  add(root, board);
}

export async function toggleItem(item, done, day, button) {
  button?.classList.add('pop');
  item.done = done;
  item.completedAt = done ? new Date().toISOString() : null;
  try {
    await post(`/items/${item.id}/complete`, { done, day });
  } catch (err) {
    item.done = !done;
    toast(err.message, 'error');
    throw err;
  }
}

/** Add/edit form for a chore or to-do. ctx: { item?, lists, members, memberId?, listId?, onChange } */
export function openChoreEditor(ctx) {
  const item = ctx.item;
  const editableLists = ctx.lists.filter((l) => l.permission !== 'view');
  if (!editableLists.length) {
    toast('Create a chore list in Settings first.', 'error');
    return;
  }
  const title = h('input', { type: 'text', value: item?.title || '', placeholder: 'e.g. Feed the dog', maxlength: 200 });
  const list = h('select', {}, editableLists.map((l) => h('option', { value: l.id, selected: l.id === (item?.listId || ctx.listId) }, l.name)));
  const member = h('select', {});
  const fillMembers = () => {
    const owner = ctx.lists.find((l) => l.id === list.value)?.ownerId;
    const chosen = member.value || item?.memberId || ctx.memberId || '';
    add(clear(member),
      h('option', { value: '' }, 'Anyone'),
      ...ctx.members.filter((m) => m.ownerId === owner).map((m) => h('option', { value: m.id, selected: m.id === chosen }, `${m.emoji ? `${m.emoji} ` : ''}${m.name}`)),
    );
  };
  list.addEventListener('change', fillMembers);
  fillMembers();

  let bits = item?.repeatDays || 0;
  const mode = h(
    'select',
    {},
    [
      ['once', 'One-time task'],
      ['daily', 'Every day'],
      ['weekdays', 'Weekdays'],
      ['custom', 'Specific days'],
    ].map(([v, label]) => h('option', { value: v, selected: v === (bits === 0 ? 'once' : bits === EVERY_DAY ? 'daily' : bits === WEEKDAYS ? 'weekdays' : 'custom') }, label)),
  );
  const names = weekdayNames(0, 'narrow');
  const dayButtons = names.map((n, i) =>
    h('button', { type: 'button', class: `day-toggle${bits & (1 << i) ? ' on' : ''}`, onclick: (e) => e.currentTarget.classList.toggle('on') }, n),
  );
  const daysRow = h('div', { class: 'day-toggles' }, dayButtons);
  const due = h('input', { type: 'date', value: item?.dueDate || '' });
  const dueField = field('Due date (optional)', due);
  const stars = h('select', {}, [0, 1, 2, 3, 4, 5, 10].map((n) => h('option', { value: n, selected: n === (item?.stars ?? 1) }, n === 0 ? 'No stars' : `${'⭐'.repeat(Math.min(n, 5))}${n > 5 ? ` ×${n}` : ''} (${n})`)));
  const starsField = field('Stars when done', stars, 'Earned by the person it’s assigned to. Spend them in ⭐ Rewards.');
  const sync = () => {
    daysRow.hidden = mode.value !== 'custom';
    dueField.querySelector('.field-label').textContent = mode.value === 'once' ? 'Due date (optional)' : 'Starting on (optional)';
  };
  mode.addEventListener('change', sync);
  sync();

  const save = h('button', { class: 'btn primary' }, item ? 'Save' : 'Add');
  const actions = [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), save];
  if (item) {
    actions.unshift(
      h(
        'button',
        {
          class: 'btn danger ghost left',
          onclick: async () => {
            if (!(await confirmDialog(`Delete “${item.title}”?`, { okLabel: 'Delete', danger: true }))) return;
            try {
              await del(`/items/${item.id}`);
              m.close();
              ctx.onChange?.();
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        },
        'Delete',
      ),
    );
  }
  const m = modal({
    title: item ? 'Edit chore' : 'New chore',
    content: h('form', { class: 'stack', onsubmit: (e) => (e.preventDefault(), save.click()) }, field('Task', title), field('List', list), field('Who', member), field('Repeats', mode), daysRow, dueField, starsField, h('input', { type: 'submit', hidden: true })),
    actions,
  });

  save.addEventListener(
    'click',
    busy(save, async () => {
      if (!title.value.trim()) throw new Error('Please enter a task.');
      bits = { once: 0, daily: EVERY_DAY, weekdays: WEEKDAYS }[mode.value] ?? dayButtons.reduce((acc, b, i) => (b.classList.contains('on') ? acc | (1 << i) : acc), 0);
      if (mode.value === 'custom' && !bits) throw new Error('Pick at least one day.');
      const body = { title: title.value.trim(), memberId: member.value || null, repeatDays: bits || null, dueDate: due.value || null, stars: Number(stars.value) };
      if (item) await patch(`/items/${item.id}`, { ...body, listId: list.value });
      else await post(`/lists/${list.value}/items`, body);
      m.close();
      ctx.onChange?.();
    }),
  );
}

// --- Stars & rewards --------------------------------------------------------------------

/** Rewards window: balances, redeeming, bonuses and managing rewards. ctx: { members, onChange } */
export async function openRewards(ctx) {
  const body = h('div', { class: 'stack' });
  const m = modal({ title: '⭐ Stars & rewards', content: body, wide: true, actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'Done')] });

  const draw = async () => {
    const [{ balances }, { rewards }] = await Promise.all([get('/stars'), get('/rewards')]);
    const people = ctx.members;
    const mine = people.filter((p) => p.mine);
    const rewardForm = (reward) => {
      const emoji = h('input', { type: 'text', value: reward?.emoji || '', placeholder: '🍦', maxlength: 8, class: 'narrow' });
      const title = h('input', { type: 'text', value: reward?.title || '', placeholder: 'Ice cream trip', maxlength: 100 });
      const cost = h('input', { type: 'number', min: 1, max: 10000, value: reward?.cost || 20, class: 'narrow' });
      const save = h('button', { class: 'btn primary' }, reward ? 'Save' : 'Add reward');
      const f = modal({
        title: reward ? 'Edit reward' : 'New reward',
        content: h('div', { class: 'stack' }, h('div', { class: 'row gap-s' }, field('Emoji', emoji), h('div', { class: 'grow' }, field('Reward', title))), field('Cost in stars', cost)),
        actions: [
          reward
            ? h(
                'button',
                {
                  class: 'btn danger ghost left',
                  onclick: async () => {
                    await del(`/rewards/${reward.id}`).catch((e) => toast(e.message, 'error'));
                    f.close();
                    draw();
                  },
                },
                'Delete',
              )
            : null,
          h('button', { class: 'btn', onclick: () => f.close() }, 'Cancel'),
          save,
        ].filter(Boolean),
      });
      save.addEventListener(
        'click',
        busy(save, async () => {
          const data = { emoji: emoji.value, title: title.value, cost: Number(cost.value) };
          if (reward) await patch(`/rewards/${reward.id}`, data);
          else await post('/rewards', data);
          f.close();
          draw();
        }),
      );
    };
    const adjust = (person) => {
      const amount = h('input', { type: 'number', value: 5, class: 'narrow' });
      const reason = h('input', { type: 'text', placeholder: 'Helped with dinner', maxlength: 120 });
      const save = h('button', { class: 'btn primary' }, 'Save');
      const f = modal({
        title: `Stars for ${person.name}`,
        content: h('div', { class: 'stack' }, field('Stars (use a minus sign to take some away)', amount), field('Why (optional)', reason)),
        actions: [h('button', { class: 'btn', onclick: () => f.close() }, 'Cancel'), save],
      });
      save.addEventListener(
        'click',
        busy(save, async () => {
          await post('/stars/adjust', { memberId: person.id, delta: Number(amount.value), reason: reason.value });
          f.close();
          draw();
          ctx.onChange?.();
        }),
      );
    };
    const history = async (person) => {
      const { history: rows } = await get(`/stars/${person.id}/history`);
      modal({
        title: `${person.name}’s stars`,
        content: rows.length
          ? h(
              'div',
              { class: 'list' },
              rows.map((r) =>
                h(
                  'div',
                  { class: 'list-row' },
                  h('span', { class: `star-delta ${r.delta > 0 ? 'plus' : 'minus'}` }, `${r.delta > 0 ? '+' : ''}${r.delta}`),
                  h('div', { class: 'grow' }, h('strong', {}, r.reason), h('small', { class: 'muted' }, `${new Date(r.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}${r.by ? ` · ${r.by}` : ''}`)),
                ),
              ),
            )
          : h('p', { class: 'muted' }, 'No stars yet.'),
      });
    };
    const redeem = async (reward, person) => {
      if (!(await confirmDialog(`Spend ${reward.cost} ⭐ from ${person.name} on “${reward.title}”?`, { okLabel: 'Redeem' }))) return;
      try {
        await post(`/rewards/${reward.id}/redeem`, { memberId: person.id });
        toast(`🎉 ${person.name} redeemed ${reward.title}!`);
        draw();
        ctx.onChange?.();
      } catch (err) {
        toast(err.message, 'error');
      }
    };

    add(
      clear(body),
      h(
        'div',
        { class: 'star-people' },
        people.length
          ? people.map((p) =>
              h(
                'div',
                { class: 'star-person', style: { '--c': p.color } },
                avatar(p, 'lg'),
                h('strong', {}, p.name),
                h('span', { class: 'star-balance' }, `⭐ ${balances[p.id] || 0}`),
                h(
                  'div',
                  { class: 'row gap-s' },
                  p.mine ? h('button', { class: 'btn ghost', onclick: () => adjust(p) }, '± Stars') : null,
                  h('button', { class: 'btn ghost', onclick: () => history(p) }, 'History'),
                ),
              ),
            )
          : h('p', { class: 'muted' }, 'Add family members in Settings to start earning stars.'),
      ),
      h('div', { class: 'row gap-s' }, h('h3', { class: 'grow' }, 'Rewards'), h('button', { class: 'btn', onclick: () => rewardForm(null) }, '+ New reward')),
      rewards.length
        ? h(
            'div',
            { class: 'list' },
            rewards.map((r) =>
              h(
                'div',
                { class: 'list-row' },
                h('span', { class: 'big-emoji' }, r.emoji || '🎁'),
                h('div', { class: 'grow' }, h('strong', {}, r.title), h('small', { class: 'muted' }, `${r.cost} ⭐`)),
                mine.map((p) =>
                  h('button', { class: `btn ${(balances[p.id] || 0) >= r.cost ? 'primary' : ''}`, disabled: (balances[p.id] || 0) < r.cost, title: `Redeem for ${p.name}`, onclick: () => redeem(r, p) }, `${p.emoji || p.name.charAt(0)} Redeem`),
                ),
                r.mine ? h('button', { class: 'btn ghost', onclick: () => rewardForm(r) }, 'Edit') : null,
              ),
            ),
          )
        : h('p', { class: 'muted' }, 'No rewards yet. Add a few things kids can save up for, like picking movie night or an ice cream trip.'),
      h('p', { class: 'hint' }, 'Chores earn their stars when ticked off (set how many in each chore). Only the parent who added a family member can spend or adjust their stars.'),
    );
  };
  await draw();
}
