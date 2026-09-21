import { del, get, patch, post, put } from './api.js';
import {
  add,
  avatar,
  busy,
  clear,
  colorPicker,
  confirmDialog,
  field,
  h,
  modal,
  PALETTE,
  toast,
  toggle,
} from './util.js';
import { currentPushSubscription, installCard, pushSupport, subscribePush, unsubscribePush } from './pwa.js';

const SECTIONS = [
  ['profile', 'Profile'],
  ['family', 'Family members'],
  ['calendars', 'Calendars'],
  ['lists', 'Lists'],
  ['accounts', 'Linked accounts'],
  ['displays', 'Wall displays'],
  ['photos', 'Photos'],
  ['household', 'Household'],
  ['users', 'Users'],
  ['email', 'Email'],
];

const ADMIN_SECTIONS = new Set(['household', 'users', 'email']);

const SOURCE_LABEL = { local: 'Hearth', ics: 'ICS subscription', caldav: 'CalDAV', google: 'Google' };

const CALDAV_PRESETS = [
  { id: 'icloud', name: 'iCloud (Apple)', url: 'https://caldav.icloud.com/', help: 'Use your Apple ID email and an app-specific password from account.apple.com → Sign-In and Security.' },
  { id: 'fastmail', name: 'Fastmail', url: 'https://caldav.fastmail.com/dav/', help: 'Create an app password under Settings → Privacy & Security → Integrations.' },
  { id: 'nextcloud', name: 'Nextcloud', url: 'https://YOUR-SERVER/remote.php/dav/', help: 'Replace YOUR-SERVER. Create an app password under Personal settings → Security.' },
  { id: 'yahoo', name: 'Yahoo', url: 'https://caldav.calendar.yahoo.com/', help: 'Generate an app password in Yahoo Account Security.' },
  { id: 'other', name: 'Other CalDAV server', url: '', help: 'Enter the CalDAV address from your provider.' },
];

export function renderSettings(root, app, section = 'profile', params = new URLSearchParams()) {
  clear(root);
  const sections = SECTIONS.filter(([id]) => !ADMIN_SECTIONS.has(id) || app.state.user.isAdmin);
  if (!sections.some(([id]) => id === section)) section = 'profile';
  const nav = h(
    'nav',
    { class: 'settings-nav' },
    sections.map(([id, label]) => h('a', { href: `#settings/${id}`, class: id === section ? 'active' : '' }, label)),
  );
  const panel = h('div', { class: 'settings-panel' });
  add(root, h('div', { class: 'settings' }, nav, panel));

  if (params.get('error')) toast(params.get('error'), 'error');
  const renderers = { profile, family, calendars, lists, accounts, displays, photos: photosSection, household, users, email };
  Promise.resolve()
    .then(() => renderers[section](panel, app, params))
    .catch((err) => add(clear(panel), h('p', { class: 'error-text' }, err.message)));
}

function heading(title, description, ...actions) {
  return h('header', { class: 'panel-head' }, h('div', {}, h('h2', {}, title), description ? h('p', { class: 'muted' }, description) : null), h('div', { class: 'row gap-s wrap' }, actions));
}

// --- Profile ------------------------------------------------------------------

function profile(panel, app) {
  const name = h('input', { type: 'text', value: app.state.user.name, maxlength: 80 });
  const saveName = h('button', { class: 'btn primary' }, 'Save');
  saveName.addEventListener(
    'click',
    busy(saveName, async () => {
      const { user } = await patch('/me', { name: name.value });
      app.state.user = user;
      app.renderChrome();
      toast('Saved');
    }),
  );
  const current = h('input', { type: 'password', autocomplete: 'current-password' });
  const next = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8 });
  const savePw = h('button', { class: 'btn' }, 'Change password');
  savePw.addEventListener(
    'click',
    busy(savePw, async () => {
      await post('/me/password', { current: current.value, next: next.value });
      current.value = next.value = '';
      toast('Password changed. Other devices were signed out.');
    }),
  );
  const testDigest = h('button', { class: 'btn ghost' }, 'Send me one now');
  testDigest.addEventListener(
    'click',
    busy(testDigest, async () => {
      await post('/me/digest/test');
      toast(`Sent to ${app.state.user.email}`);
    }),
  );
  const digestCard = app.state.mailEnabled
    ? h(
        'div',
        { class: 'card stack' },
        h('h3', {}, 'Morning summary'),
        h('p', { class: 'muted' }, 'An email each morning with today’s and tomorrow’s events and today’s chores. Skipped on days with nothing planned.'),
        h(
          'div',
          { class: 'row gap wrap' },
          toggle('Email me a morning summary', app.state.user.digestEnabled, async (on, input) => {
            try {
              app.state.user = (await patch('/me', { digestEnabled: on })).user;
              toast(on ? 'Morning summary turned on' : 'Morning summary turned off');
            } catch (err) {
              input.checked = !on;
              toast(err.message, 'error');
            }
          }),
          testDigest,
        ),
      )
    : null;
  add(panel,
    heading('Profile', app.state.user.email),
    h('div', { class: 'card stack' }, field('Your name', name), h('div', {}, saveName)),
    h('div', { class: 'card stack' }, h('h3', {}, 'Password'), field('Current password', current), field('New password', next, 'At least 8 characters.'), h('div', {}, savePw)),
    remindersCard(app),
    digestCard,
    installCard(),
  );
}

// --- Family members -------------------------------------------------------------

function memberForm(member, onSaved) {
  let color = member?.color || PALETTE[Math.floor(Math.random() * PALETTE.length)];
  const name = h('input', { type: 'text', value: member?.name || '', maxlength: 60, placeholder: 'Name' });
  const emoji = h('input', { type: 'text', value: member?.emoji || '', maxlength: 8, placeholder: '🙂', class: 'narrow' });
  const birthday = h('input', { type: 'date', value: member?.birthday || '' });
  const yearUnknown = h('input', { type: 'checkbox', checked: member ? member.birthday && !member.birthdayYearKnown : false });
  const save = h('button', { class: 'btn primary' }, member ? 'Save' : 'Add');
  const m = modal({
    title: member ? `Edit ${member.name}` : 'Add family member',
    content: h(
      'div',
      { class: 'stack' },
      field('Name', name),
      field('Emoji (optional)', emoji, 'Shown on chores and the wall display.'),
      field('Birthday (optional)', birthday, 'Adds a yearly event to your Birthdays calendar.'),
      h('label', { class: 'check' }, yearUnknown, ' I don’t know the year'),
      field('Colour', colorPicker(color, (c) => (color = c))),
    ),
    actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), save],
  });
  save.addEventListener(
    'click',
    busy(save, async () => {
      const body = { name: name.value, emoji: emoji.value, color, birthday: birthday.value || null, birthdayYearKnown: !yearUnknown.checked };
      if (member) await patch(`/members/${member.id}`, body);
      else await post('/members', body);
      m.close();
      onSaved();
    }),
  );
}

function family(panel, app) {
  const refresh = async () => {
    await app.reload();
    app.route();
  };
  const mine = app.state.members.filter((m) => m.mine);
  add(panel,
    heading('Family members', 'People calendars and chores belong to. Kids don’t need an account.', h('button', { class: 'btn primary', onclick: () => memberForm(null, refresh) }, '+ Add person')),
    h(
      'div',
      { class: 'card list' },
      mine.length
        ? mine.map((m) =>
            h(
              'div',
              { class: 'list-row' },
              avatar(m),
              h(
                'div',
                { class: 'grow' },
                h('strong', {}, m.name),
                h(
                  'small',
                  { class: 'muted' },
                  [
                    `${app.state.calendars.filter((c) => c.memberId === m.id).length} calendar(s)`,
                    m.birthday ? `🎂 ${new Date(`${m.birthday}T12:00`).toLocaleDateString([], m.birthdayYearKnown ? { month: 'long', day: 'numeric', year: 'numeric' } : { month: 'long', day: 'numeric' })}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · '),
                ),
              ),
              h('button', { class: 'btn ghost', onclick: () => memberForm(m, refresh) }, 'Edit'),
              h(
                'button',
                {
                  class: 'btn ghost danger',
                  onclick: async () => {
                    if (!(await confirmDialog(`Remove ${m.name}? Their calendars and chores are kept but unassigned.`, { okLabel: 'Remove', danger: true }))) return;
                    await del(`/members/${m.id}`).catch((e) => toast(e.message, 'error'));
                    refresh();
                  },
                },
                'Remove',
              ),
            ),
          )
        : h('p', { class: 'muted pad' }, 'No family members yet.'),
    ),
  );
}

// --- Sharing (shared by calendars and lists) -----------------------------------

export function shareDialog(kind, resource, onChange) {
  const path = kind === 'calendar' ? `/calendars/${resource.id}/shares` : `/lists/${resource.id}/shares`;
  const listEl = h('div', { class: 'list' });
  const draw = (shares) => {
    add(clear(listEl),
      shares.length
        ? shares.map((s) =>
            h(
              'div',
              { class: 'list-row' },
              avatar({ name: s.name, color: '#8d7b6a' }),
              h('div', { class: 'grow' }, h('strong', {}, s.name), h('small', { class: 'muted' }, s.email)),
              h(
                'select',
                {
                  onchange: async (e) => {
                    try {
                      draw((await post(path, { email: s.email, permission: e.target.value })).shares);
                      onChange();
                    } catch (err) {
                      toast(err.message, 'error');
                    }
                  },
                },
                h('option', { value: 'view', selected: s.permission === 'view' }, 'Can view'),
                h('option', { value: 'edit', selected: s.permission === 'edit' }, 'Can edit'),
              ),
              h(
                'button',
                {
                  class: 'icon-btn',
                  'aria-label': `Stop sharing with ${s.name}`,
                  onclick: async () => {
                    draw((await del(`${path}/${s.userId}`)).shares);
                    onChange();
                  },
                },
                '✕',
              ),
            ),
          )
        : h('p', { class: 'muted' }, 'Not shared with anyone yet.'),
    );
  };
  draw(resource.shares || []);
  const email = h('input', { type: 'email', placeholder: 'their-email@example.com' });
  const permission = h('select', {}, h('option', { value: 'view' }, 'Can view'), h('option', { value: 'edit' }, 'Can edit'));
  const shareBtn = h('button', { class: 'btn primary' }, 'Share');
  shareBtn.addEventListener(
    'click',
    busy(shareBtn, async () => {
      draw((await post(path, { email: email.value, permission: permission.value })).shares);
      email.value = '';
      onChange();
    }),
  );
  const m = modal({
    title: `Share “${resource.name}”`,
    content: h(
      'div',
      { class: 'stack' },
      h('p', { class: 'muted' }, 'People you share with see this in their own account and can choose whether it appears on their displays.'),
      h('div', { class: 'row gap-s wrap' }, email, permission, shareBtn),
      listEl,
    ),
    actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'Done')],
  });
}

// --- Calendars ------------------------------------------------------------------

function calendarForm(app, cal, { source = 'local', account, remote } = {}) {
  let color = cal?.ownerColor || remote?.color || PALETTE[Math.floor(Math.random() * PALETTE.length)];
  const mine = app.state.members.filter((m) => m.mine);
  const name = h('input', { type: 'text', value: cal?.name || remote?.name || '', maxlength: 100 });
  const url = h('input', { type: 'url', value: cal?.feedUrl || '', placeholder: 'https:// or webcal://…' });
  const member = h('select', {}, h('option', { value: '' }, 'Nobody in particular'), mine.map((m) => h('option', { value: m.id, selected: m.id === cal?.memberId }, m.name)));
  const kind = cal?.source || source;
  const save = h('button', { class: 'btn primary' }, cal ? 'Save' : 'Add calendar');
  const m = modal({
    title: cal ? 'Edit calendar' : kind === 'ics' ? 'Subscribe to a calendar link' : kind === 'local' ? 'New calendar' : `Add ${remote?.name || 'calendar'}`,
    content: h(
      'div',
      { class: 'stack' },
      kind === 'ics'
        ? field(
            'Calendar link (ICS)',
            url,
            'Read-only. Google: Settings → calendar → “Secret address in iCal format”. Outlook: Settings → Shared calendars → Publish. To add and edit events here, link the account instead.',
          )
        : null,
      field('Name', name),
      field('Belongs to', member, 'Events get this person’s filter chip on the calendar.'),
      field('Colour', colorPicker(color, (c) => (color = c))),
    ),
    actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), save],
  });
  save.addEventListener(
    'click',
    busy(save, async () => {
      const body = { name: name.value, color, memberId: member.value || null };
      if (cal) {
        await patch(`/calendars/${cal.id}`, kind === 'ics' ? { ...body, url: url.value } : body);
        toast('Calendar saved');
      } else {
        const result = await post('/calendars', { ...body, source: kind, url: url.value, accountId: account?.id, remoteUrl: remote?.url });
        toast(result.calendar?.syncError ? `Added, but sync failed: ${result.calendar.syncError}` : 'Calendar added', result.calendar?.syncError ? 'error' : 'info');
      }
      m.close();
      await app.reload();
      app.route();
    }),
  );
}

function calendars(panel, app) {
  const redraw = async () => {
    await app.reload();
    app.route();
  };
  const cards = app.state.calendars.map((cal) => {
    const status = cal.source === 'local' ? null : cal.syncError ? h('span', { class: 'badge error', title: cal.syncError }, 'Sync error') : cal.lastSyncedAt ? h('small', { class: 'muted' }, `Synced ${new Date(cal.lastSyncedAt).toLocaleString()}`) : h('small', { class: 'muted' }, 'Waiting for first sync');
    const member = app.state.members.find((m) => m.id === cal.memberId);
    const syncBtn = h('button', { class: 'btn ghost' }, 'Sync now');
    syncBtn.addEventListener(
      'click',
      busy(syncBtn, async () => {
        const r = await post(`/calendars/${cal.id}/sync`);
        toast(r.error ? `Sync failed: ${r.error}` : 'Synced', r.error ? 'error' : 'info');
        redraw();
      }),
    );
    return h(
      'div',
      { class: 'card cal-card' },
      h(
        'div',
        { class: 'row gap' },
        h('span', { class: 'swatch big', style: { background: cal.color } }),
        h(
          'div',
          { class: 'grow' },
          h('strong', {}, cal.name),
          h(
            'div',
            { class: 'row gap-s wrap' },
            h('span', { class: 'badge' }, cal.managed === 'birthdays' ? 'Automatic · from Family members' : SOURCE_LABEL[cal.source]),
            cal.source === 'caldav' || cal.source === 'google' ? h('span', { class: 'badge accent' }, 'Two-way') : null,
            cal.isOwner ? null : h('span', { class: 'badge' }, `Shared by ${cal.ownerName} · ${cal.permission === 'edit' ? 'can edit' : 'view only'}`),
            member ? h('span', { class: 'badge' }, member.name) : null,
            cal.isOwner && cal.shares?.length ? h('span', { class: 'badge' }, `Shared with ${cal.shares.length}`) : null,
            cal.accountLabel ? h('small', { class: 'muted' }, cal.accountLabel) : null,
            status,
          ),
        ),
      ),
      h(
        'div',
        { class: 'row gap wrap toggles' },
        toggle('Show in my calendar', cal.visible, (v) => put(`/calendars/${cal.id}/prefs`, { visible: v }).then(app.reload).catch((e) => toast(e.message, 'error'))),
        toggle('Show on my wall displays', cal.onDisplay, (v) => put(`/calendars/${cal.id}/prefs`, { onDisplay: v }).then(app.reload).catch((e) => toast(e.message, 'error'))),
        cal.isOwner
          ? null
          : h('label', { class: 'row gap-s' }, h('span', { class: 'muted' }, 'My colour'), colorPicker(cal.color, (c) => put(`/calendars/${cal.id}/prefs`, { color: c }).then(redraw))),
      ),
      h(
        'div',
        { class: 'row gap-s wrap actions' },
        cal.isOwner ? h('button', { class: 'btn ghost', onclick: () => calendarForm(app, cal) }, 'Edit') : null,
        cal.isOwner ? h('button', { class: 'btn ghost', onclick: () => shareDialog('calendar', cal, redraw) }, 'Share') : null,
        h('button', { class: 'btn ghost', onclick: () => feedDialog(cal).catch((e) => toast(e.message, 'error')) }, 'Phone link'),
        cal.source !== 'local' ? syncBtn : null,
        h(
          'button',
          {
            class: 'btn ghost danger',
            onclick: async () => {
              const msg = cal.isOwner
                ? cal.source === 'local'
                  ? `Delete “${cal.name}” and all its events for everyone it’s shared with?`
                  : `Remove “${cal.name}” from Hearth? Events stay in the original calendar.`
                : `Leave “${cal.name}”? ${cal.ownerName} can share it with you again.`;
              if (!(await confirmDialog(msg, { okLabel: cal.isOwner ? 'Delete' : 'Leave', danger: true }))) return;
              await del(`/calendars/${cal.id}`).catch((e) => toast(e.message, 'error'));
              redraw();
            },
          },
          cal.isOwner ? 'Delete' : 'Leave',
        ),
      ),
    );
  });

  add(panel,
    heading(
      'Calendars',
      'Create calendars here, subscribe to links, or link iCloud / Google / CalDAV accounts so changes made here are pushed back.',
      h('button', { class: 'btn primary', onclick: () => calendarForm(app, null, { source: 'local' }) }, '+ New calendar'),
      h('button', { class: 'btn', onclick: () => calendarForm(app, null, { source: 'ics' }) }, '+ Subscribe to link'),
      h('button', { class: 'btn', onclick: () => holidayDialog(app) }, '+ Holidays'),
      h('button', { class: 'btn', onclick: () => (location.hash = '#settings/accounts') }, '+ Link an account'),
    ),
    h(
      'div',
      { class: 'card row gap wrap' },
      h('span', { class: 'big-emoji' }, '📱'),
      h('div', { class: 'grow' }, h('strong', {}, 'See Hearth in your phone’s calendar app'), h('p', { class: 'muted' }, 'A private, read-only subscribe link for the iPhone, Google or Outlook calendar apps.')),
      h('button', { class: 'btn', onclick: () => feedDialog(null).catch((e) => toast(e.message, 'error')) }, 'All my calendars'),
    ),
    cards.length ? cards : h('p', { class: 'muted' }, 'No calendars yet.'),
  );
}

// --- Chore lists ----------------------------------------------------------------

function lists(panel, app) {
  const redraw = async () => {
    await app.reload();
    app.route();
  };
  const listForm = (list) => {
    let color = list?.color || '#5bb974';
    const name = h('input', { type: 'text', value: list?.name || '', maxlength: 100 });
    const kind = h(
      'select',
      {},
      h('option', { value: 'chores' }, 'Chore chart (people, repeats, due dates)'),
      h('option', { value: 'checklist' }, 'Checklist (groceries, packing, to-dos)'),
      h('option', { value: 'meals' }, 'Meal plan'),
    );
    const save = h('button', { class: 'btn primary' }, list ? 'Save' : 'Create');
    const m = modal({
      title: list ? 'Edit list' : 'New list',
      content: h('div', { class: 'stack' }, field('Name', name), list ? null : field('Type', kind), field('Colour', colorPicker(color, (c) => (color = c)))),
      actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), save],
    });
    save.addEventListener(
      'click',
      busy(save, async () => {
        if (list) await patch(`/lists/${list.id}`, { name: name.value, color });
        else await post('/lists', { name: name.value, color, kind: kind.value });
        m.close();
        redraw();
      }),
    );
  };
  add(panel,
    heading('Lists', 'Chore charts show on the Chores tab, checklists (groceries, to-dos) on the Lists tab, and meal plans on the Meals tab. Share a list so the whole family can use it.', h('button', { class: 'btn primary', onclick: () => listForm(null) }, '+ New list')),
    app.state.lists.map((list) =>
      h(
        'div',
        { class: 'card cal-card' },
        h(
          'div',
          { class: 'row gap' },
          h('span', { class: 'swatch big', style: { background: list.color } }),
          h(
            'div',
            { class: 'grow' },
            h('strong', {}, list.name),
            h(
              'div',
              { class: 'row gap-s wrap' },
              h('span', { class: 'badge' }, { checklist: 'Checklist', meals: 'Meal plan' }[list.kind] || 'Chore chart'),
              list.isOwner ? (list.shares?.length ? h('span', { class: 'badge' }, `Shared with ${list.shares.length}`) : null) : h('span', { class: 'badge' }, `Shared by ${list.ownerName} · ${list.permission === 'edit' ? 'can edit' : 'view only'}`),
            ),
          ),
        ),
        h('div', { class: 'row gap wrap toggles' }, toggle('Show on my wall displays', list.onDisplay, (v) => put(`/lists/${list.id}/prefs`, { onDisplay: v }).then(app.reload))),
        h(
          'div',
          { class: 'row gap-s wrap actions' },
          list.isOwner ? h('button', { class: 'btn ghost', onclick: () => listForm(list) }, 'Edit') : null,
          list.isOwner ? h('button', { class: 'btn ghost', onclick: () => shareDialog('list', list, redraw) }, 'Share') : null,
          h(
            'button',
            {
              class: 'btn ghost danger',
              onclick: async () => {
                if (!(await confirmDialog(list.isOwner ? `Delete “${list.name}” and everything on it?` : `Leave “${list.name}”?`, { okLabel: list.isOwner ? 'Delete' : 'Leave', danger: true }))) return;
                await del(`/lists/${list.id}`).catch((e) => toast(e.message, 'error'));
                redraw();
              },
            },
            list.isOwner ? 'Delete' : 'Leave',
          ),
        ),
      ),
    ),
  );
}

// --- Linked accounts ---------------------------------------------------------------

async function pickRemoteCalendars(app, account, calendarsList) {
  const content = h('div', { class: 'list' });
  const m = modal({ title: `Calendars in ${account.label}`, content, actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'Done')], wide: true });
  const draw = (items) => {
    add(clear(content),
      items.length
        ? items.map((c) =>
            h(
              'div',
              { class: 'list-row' },
              h('span', { class: 'swatch', style: { background: c.color || '#8d7b6a' } }),
              h('div', { class: 'grow' }, h('strong', {}, c.name), c.readOnly ? h('small', { class: 'muted' }, ' · read-only in Google') : null),
              c.linked
                ? h('span', { class: 'badge accent' }, 'Added')
                : h(
                    'button',
                    {
                      class: 'btn primary',
                      onclick: () => {
                        m.close();
                        calendarForm(app, null, { source: account.provider, account, remote: c });
                      },
                    },
                    'Add',
                  ),
            ),
          )
        : h('p', { class: 'muted' }, 'No event calendars were found in this account.'),
    );
  };
  if (calendarsList) draw(calendarsList);
  else {
    add(content, h('p', { class: 'muted' }, 'Loading calendars…'));
    try {
      draw((await get(`/accounts/${account.id}/calendars`)).calendars);
    } catch (err) {
      add(clear(content), h('p', { class: 'error-text' }, err.message));
    }
  }
}

function caldavDialog(app) {
  const preset = h('select', {}, CALDAV_PRESETS.map((p) => h('option', { value: p.id }, p.name)));
  const serverUrl = h('input', { type: 'url', value: CALDAV_PRESETS[0].url });
  const username = h('input', { type: 'text', autocomplete: 'off', placeholder: 'you@icloud.com' });
  const password = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'app-specific password' });
  const help = h('p', { class: 'hint' }, CALDAV_PRESETS[0].help);
  preset.addEventListener('change', () => {
    const p = CALDAV_PRESETS.find((x) => x.id === preset.value);
    serverUrl.value = p.url;
    help.textContent = p.help;
  });
  const connect = h('button', { class: 'btn primary' }, 'Connect');
  const m = modal({
    title: 'Link a CalDAV account',
    content: h(
      'div',
      { class: 'stack' },
      h('p', { class: 'muted' }, 'Hearth reads and writes events on this server, so events you add here show up on your phone too.'),
      field('Provider', preset),
      field('Server URL', serverUrl),
      field('Username', username),
      field('Password', password),
      help,
      h('p', { class: 'hint' }, 'Passwords are stored encrypted on your server. Use an app-specific password, never your main one.'),
    ),
    actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), connect],
  });
  connect.addEventListener(
    'click',
    busy(connect, async () => {
      const result = await post('/accounts/caldav', {
        serverUrl: serverUrl.value,
        username: username.value,
        password: password.value,
        label: `${CALDAV_PRESETS.find((x) => x.id === preset.value).name.replace(/ \(.*\)/, '')} – ${username.value}`,
      });
      m.close();
      await app.reload();
      app.route();
      pickRemoteCalendars(app, result.account, result.calendars);
    }),
  );
}

async function accounts(panel, app, params) {
  add(panel, h('p', { class: 'muted' }, 'Loading…'));
  const { accounts: list, googleEnabled } = await get('/accounts');
  clear(panel);
  add(panel,
    heading(
      'Linked accounts',
      'Two-way sync: events from these accounts appear in Hearth, and events you create or edit here are written back.',
      h('button', { class: 'btn primary', onclick: () => caldavDialog(app) }, '+ iCloud / CalDAV'),
      googleEnabled
        ? h('a', { class: 'btn', href: '/api/google/start' }, '+ Google')
        : h('button', { class: 'btn', onclick: () => toast('Google sign-in is not configured on this server. See the README (GOOGLE_CLIENT_ID).', 'error') }, '+ Google'),
    ),
    h(
      'div',
      { class: 'card list' },
      list.length
        ? list.map((a) =>
            h(
              'div',
              { class: 'list-row' },
              h('span', { class: 'badge' }, a.provider === 'google' ? 'Google' : 'CalDAV'),
              h('div', { class: 'grow' }, h('strong', {}, a.label), a.serverUrl ? h('small', { class: 'muted' }, a.serverUrl) : null),
              h('button', { class: 'btn ghost', onclick: () => pickRemoteCalendars(app, a) }, 'Choose calendars'),
              h(
                'button',
                {
                  class: 'btn ghost danger',
                  onclick: async () => {
                    if (!(await confirmDialog(`Unlink ${a.label}? Its calendars are removed from Hearth (nothing is deleted from the account).`, { okLabel: 'Unlink', danger: true }))) return;
                    await del(`/accounts/${a.id}`);
                    await app.reload();
                    app.route();
                  },
                },
                'Unlink',
              ),
            ),
          )
        : h('p', { class: 'muted pad' }, 'No linked accounts yet.'),
    ),
    h(
      'div',
      { class: 'card stack' },
      h('h3', {}, 'Which option should I use?'),
      h('ul', { class: 'bullets' },
        h('li', {}, h('strong', {}, 'iCloud, Fastmail, Nextcloud, Yahoo: '), 'link with CalDAV and an app-specific password.'),
        h('li', {}, h('strong', {}, 'Google: '), 'link with Google sign-in (your admin must set up a Google Cloud OAuth client once).'),
        h('li', {}, h('strong', {}, 'Outlook / Microsoft 365, school & sports sites: '), 'use Calendars → Subscribe to link. These are read-only.'),
      ),
    ),
  );
  const linked = params.get('account');
  if (linked) {
    const acct = list.find((a) => a.id === linked);
    history.replaceState(null, '', '#settings/accounts');
    if (acct) pickRemoteCalendars(app, acct);
  }
}

// --- Wall displays -----------------------------------------------------------------

function displayLink(token) {
  return `${location.origin}/display#token=${token}`;
}

function showLink(token) {
  const link = h('input', { type: 'text', value: displayLink(token), readonly: true, class: 'mono', onfocus: (e) => e.target.select() });
  const m = modal({
    title: 'Display link',
    content: h(
      'div',
      { class: 'stack' },
      h('p', {}, 'Open this link on the tablet or wall screen. It signs that device in to the display only — keep it private, and regenerate it if a device is lost.'),
      link,
      h('p', { class: 'hint' }, 'This link is shown only once.'),
    ),
    actions: [
      h('a', { class: 'btn', href: displayLink(token), target: '_blank', rel: 'noopener' }, 'Open here'),
      h(
        'button',
        {
          class: 'btn primary',
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(link.value);
              toast('Link copied');
            } catch {
              link.select();
            }
          },
        },
        'Copy link',
      ),
      h('button', { class: 'btn', onclick: () => m.close() }, 'Done'),
    ],
  });
}

function displaySettingsForm(d, onSave) {
  const s = {
    view: 'week',
    theme: 'auto',
    showChores: true,
    showLists: false,
    showMeals: false,
    showWeather: true,
    showUpNext: true,
    showCountdowns: true,
    weekStartsOn: 0,
    allowEditing: true,
    nightMode: false,
    nightStart: '22:00',
    nightEnd: '06:00',
    photoFrame: false,
    photoIdleMinutes: 5,
    photoSeconds: 20,
    ...(d?.settings || {}),
  };
  const name = h('input', { type: 'text', value: d?.name || 'Kitchen display', maxlength: 80 });
  const view = h('select', {}, [['week', 'Week'], ['month', 'Month'], ['day', 'Day'], ['agenda', 'Schedule']].map(([v, l]) => h('option', { value: v, selected: s.view === v }, l)));
  const theme = h('select', {}, [['auto', 'Match device'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => h('option', { value: v, selected: s.theme === v }, l)));
  const week = h('select', {}, h('option', { value: 0, selected: s.weekStartsOn === 0 }, 'Sunday'), h('option', { value: 1, selected: s.weekStartsOn === 1 }, 'Monday'));
  const box = (checked) => h('input', { type: 'checkbox', checked });
  const chores = box(s.showChores);
  const showLists = box(s.showLists);
  const showMeals = box(s.showMeals);
  const showWeather = box(s.showWeather);
  const showUpNext = box(s.showUpNext);
  const showCountdowns = box(s.showCountdowns);
  const editing = box(s.allowEditing);
  const night = box(s.nightMode);
  const nightStart = h('input', { type: 'time', value: s.nightStart });
  const nightEnd = h('input', { type: 'time', value: s.nightEnd });
  const photos = box(s.photoFrame);
  const idle = h('select', {}, [1, 2, 5, 10, 15, 30, 60].map((m) => h('option', { value: m, selected: m === s.photoIdleMinutes }, `${m} min`)));
  const seconds = h('select', {}, [5, 10, 15, 20, 30, 60, 120].map((sec) => h('option', { value: sec, selected: sec === s.photoSeconds }, sec < 60 ? `${sec} seconds` : `${sec / 60} min`)));
  const nightRow = h('div', { class: 'row gap-s wrap indent' }, h('span', { class: 'muted' }, 'From'), nightStart, h('span', { class: 'muted' }, 'to'), nightEnd);
  const photoRow = h(
    'div',
    { class: 'stack gap-s indent' },
    h('div', { class: 'row gap-s wrap' }, h('span', { class: 'muted' }, 'Start after'), idle, h('span', { class: 'muted' }, 'untouched, change every'), seconds),
    h('p', { class: 'hint' }, 'Add photos under Settings → Photos (the photos of the account that owns this display are used).'),
  );
  const sync = () => {
    nightRow.hidden = !night.checked;
    photoRow.hidden = !photos.checked;
  };
  night.addEventListener('change', sync);
  photos.addEventListener('change', sync);
  sync();
  const save = h('button', { class: 'btn primary' }, d ? 'Save' : 'Create display');
  const m = modal({
    title: d ? 'Display settings' : 'New wall display',
    content: h(
      'div',
      { class: 'stack' },
      field('Name', name),
      h('div', { class: 'row gap wrap' }, field('Default view', view), field('Theme', theme), field('Week starts on', week)),
      h('h3', {}, 'Show on screen'),
      h('label', { class: 'check' }, showWeather, ' Weather (set the location in Settings → Household)'),
      h('label', { class: 'check' }, showUpNext, ' “Up next” strip'),
      h('label', { class: 'check' }, showCountdowns, ' Countdowns'),
      h('label', { class: 'check' }, chores, ' Today’s chores'),
      h('label', { class: 'check' }, showLists, ' Grocery & to-do lists'),
      h('label', { class: 'check' }, showMeals, ' Meal plan'),
      h('h3', {}, 'Screen'),
      h('label', { class: 'check' }, night, ' Night mode: dim to a clock overnight'),
      nightRow,
      h('label', { class: 'check' }, photos, ' Photo frame when nobody is using it'),
      photoRow,
      h('label', { class: 'check' }, editing, ' Allow adding events and list items from the display'),
      h('p', { class: 'hint' }, 'Choose exactly which calendars and lists appear with the “Show on my wall displays” switches in Settings → Calendars and Settings → Lists.'),
    ),
    actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), save],
  });
  save.addEventListener(
    'click',
    busy(save, async () => {
      await onSave({
        name: name.value,
        settings: {
          view: view.value,
          theme: theme.value,
          weekStartsOn: Number(week.value),
          showChores: chores.checked,
          showLists: showLists.checked,
          showMeals: showMeals.checked,
          showWeather: showWeather.checked,
          showUpNext: showUpNext.checked,
          showCountdowns: showCountdowns.checked,
          allowEditing: editing.checked,
          nightMode: night.checked,
          nightStart: nightStart.value || '22:00',
          nightEnd: nightEnd.value || '06:00',
          photoFrame: photos.checked,
          photoIdleMinutes: Number(idle.value),
          photoSeconds: Number(seconds.value),
        },
      });
      m.close();
    }),
  );
}

async function displays(panel, app) {
  const { displays: list } = await get('/displays');
  const redraw = () => app.route();
  add(clear(panel),
    heading(
      'Wall displays',
      'A display is a tablet or screen that shows your family calendar full-screen without signing in.',
      h(
        'button',
        {
          class: 'btn primary',
          onclick: () =>
            displaySettingsForm(null, async (body) => {
              const r = await post('/displays', body);
              redraw();
              showLink(r.token);
            }),
        },
        '+ New display',
      ),
      h('a', { class: 'btn', href: '/display', target: '_blank', rel: 'noopener' }, 'Preview on this device'),
    ),
    h(
      'div',
      { class: 'card list' },
      list.length
        ? list.map((d) =>
            h(
              'div',
              { class: 'list-row' },
              h('span', { class: 'big-emoji' }, '🖥️'),
              h('div', { class: 'grow' }, h('strong', {}, d.name), h('small', { class: 'muted' }, d.lastSeenAt ? `Last active ${new Date(d.lastSeenAt).toLocaleString()}` : 'Not opened yet')),
              h('button', { class: 'btn ghost', onclick: () => displaySettingsForm(d, async (body) => (await patch(`/displays/${d.id}`, body), redraw())) }, 'Settings'),
              h(
                'button',
                {
                  class: 'btn ghost',
                  onclick: async () => {
                    if (!(await confirmDialog('Create a new link? The old link stops working immediately.', { okLabel: 'New link' }))) return;
                    const r = await post(`/displays/${d.id}/token`);
                    showLink(r.token);
                  },
                },
                'New link',
              ),
              h(
                'button',
                {
                  class: 'btn ghost danger',
                  onclick: async () => {
                    if (!(await confirmDialog(`Remove ${d.name}? That screen will be signed out.`, { okLabel: 'Remove', danger: true }))) return;
                    await del(`/displays/${d.id}`);
                    redraw();
                  },
                },
                'Remove',
              ),
            ),
          )
        : h('p', { class: 'muted pad' }, 'No displays yet.'),
    ),
  );
}

// --- Users (admin) -----------------------------------------------------------------

/** Shows a one-time password link with a copy button, noting whether it was also emailed. */
function showPasswordLink(user, result, purpose) {
  const link = h('input', { type: 'text', value: result.link, readonly: true, class: 'mono', onfocus: (e) => e.target.select() });
  const lifetime = purpose === 'invite' ? '7 days' : '2 hours';
  const message = result.emailed
    ? `We emailed this link to ${user.email}. You can also copy it and send it another way.`
    : result.emailError
      ? `The email couldn’t be sent (${result.emailError}). Copy the link and send it to ${user.name} yourself.`
      : `Send this link to ${user.name} by text or chat. They’ll use it to choose ${purpose === 'invite' ? 'their' : 'a new'} password.`;
  const m = modal({
    title: purpose === 'invite' ? `Invite link for ${user.name}` : `Reset link for ${user.name}`,
    content: h('div', { class: 'stack' }, h('p', {}, message), link, h('p', { class: 'hint' }, `The link works once and expires in ${lifetime}. Creating a new link cancels this one.`)),
    actions: [
      h(
        'button',
        {
          class: 'btn primary',
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(result.link);
              toast('Link copied');
            } catch {
              link.select();
            }
          },
        },
        'Copy link',
      ),
      h('button', { class: 'btn', onclick: () => m.close() }, 'Done'),
    ],
  });
}

function resetPasswordDialog(u, mailEnabled) {
  const purpose = u.pending ? 'invite' : 'reset';
  const createLink = h('button', { class: 'btn primary' }, mailEnabled ? 'Email a reset link' : 'Create a reset link');
  const password = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8 });
  const setPw = h('button', { class: 'btn' }, 'Set password');
  const m = modal({
    title: u.pending ? `Resend invite to ${u.name}` : `Reset ${u.name}’s password`,
    content: h(
      'div',
      { class: 'stack' },
      h('p', { class: 'muted' }, u.pending ? `${u.name} hasn’t chosen a password yet. Send a fresh invite link:` : `Send ${u.name} a link to choose a new password:`),
      h('div', {}, createLink),
      h('hr', { class: 'sep' }),
      h('p', { class: 'muted' }, 'Or set a password yourself and tell them what it is:'),
      field('New password', password, 'At least 8 characters. They can change it under Settings → Profile.'),
      h('div', {}, setPw),
    ),
    actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel')],
  });
  if (u.pending) createLink.textContent = mailEnabled ? 'Email a new invite link' : 'Create a new invite link';
  createLink.addEventListener(
    'click',
    busy(createLink, async () => {
      const result = await post(`/admin/users/${u.id}/reset-link`);
      m.close();
      showPasswordLink(u, result, purpose);
    }),
  );
  setPw.addEventListener(
    'click',
    busy(setPw, async () => {
      await post(`/admin/users/${u.id}/password`, { password: password.value });
      m.close();
      toast(`${u.name}’s password was changed and their devices were signed out.`);
    }),
  );
}

async function users(panel, app) {
  const { users: list, mailEnabled } = await get('/admin/users');
  const redraw = () => app.route();
  const addUser = () => {
    const name = h('input', { type: 'text', maxlength: 80 });
    const email = h('input', { type: 'email' });
    const password = h('input', { type: 'password', autocomplete: 'new-password' });
    const admin = h('input', { type: 'checkbox' });
    const inviteRadio = h('input', { type: 'radio', name: 'how', value: 'invite', checked: true });
    const passwordRadio = h('input', { type: 'radio', name: 'how', value: 'password' });
    const passwordField = field('Password', password, 'They can change it under Settings → Profile.');
    const sync = () => (passwordField.hidden = !passwordRadio.checked);
    inviteRadio.addEventListener('change', sync);
    passwordRadio.addEventListener('change', sync);
    const save = h('button', { class: 'btn primary' }, 'Create account');
    const m = modal({
      title: 'Add a user',
      content: h(
        'div',
        { class: 'stack' },
        field('Name', name),
        field('Email', email),
        h(
          'div',
          { class: 'stack gap-s' },
          h('label', { class: 'check' }, inviteRadio, mailEnabled ? ' Email them an invite link to choose their own password' : ' Give me an invite link to send them (they choose their password)'),
          h('label', { class: 'check' }, passwordRadio, ' Set a password for them now'),
        ),
        passwordField,
        h('label', { class: 'check' }, admin, ' Administrator'),
      ),
      actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), save],
    });
    sync();
    save.addEventListener(
      'click',
      busy(save, async () => {
        const invite = inviteRadio.checked;
        const result = await post('/admin/users', { name: name.value, email: email.value, password: invite ? undefined : password.value, isAdmin: admin.checked, invite });
        m.close();
        redraw();
        if (invite) showPasswordLink(result.user, result, 'invite');
        else toast('Account created');
      }),
    );
  };
  add(clear(panel),
    heading(
      'Users',
      `Everyone with an account on this server. Sign-up is controlled by ALLOW_SIGNUP.${mailEnabled ? '' : ' Email isn’t set up, so reset and invite links are shown for you to send.'}`,
      h('button', { class: 'btn primary', onclick: addUser }, '+ Add user'),
    ),
    h(
      'div',
      { class: 'card list' },
      list.map((u) =>
        h(
          'div',
          { class: 'list-row' },
          avatar({ name: u.name, color: '#8d7b6a' }),
          h(
            'div',
            { class: 'grow' },
            h('strong', {}, u.name, u.isAdmin ? h('span', { class: 'badge accent' }, 'Admin') : null, u.pending ? h('span', { class: 'badge' }, 'Invite pending') : null),
            h('small', { class: 'muted' }, u.email),
          ),
          u.id === app.state.user.id
            ? h('small', { class: 'muted' }, 'You')
            : [
                h('button', { class: 'btn ghost', onclick: () => resetPasswordDialog(u, mailEnabled) }, u.pending ? 'Resend invite' : 'Reset password'),
                h('button', { class: 'btn ghost', onclick: async () => (await patch(`/admin/users/${u.id}`, { isAdmin: !u.isAdmin }), redraw()) }, u.isAdmin ? 'Remove admin' : 'Make admin'),
                h(
                  'button',
                  {
                    class: 'btn ghost danger',
                    onclick: async () => {
                      if (!(await confirmDialog(`Delete ${u.name}’s account and everything they own?`, { okLabel: 'Delete', danger: true }))) return;
                      await del(`/admin/users/${u.id}`);
                      redraw();
                    },
                  },
                  'Delete',
                ),
              ],
        ),
      ),
    ),
  );
}

// --- Email (admin) -----------------------------------------------------------------

const MAIL_PRESETS = [
  { id: 'gmail', name: 'Gmail', host: 'smtp.gmail.com', port: 587, secure: false, help: 'Turn on 2-Step Verification, then create an app password at myaccount.google.com/apppasswords. Use your full Gmail address as the username.' },
  { id: 'icloud', name: 'iCloud Mail', host: 'smtp.mail.me.com', port: 587, secure: false, help: 'Create an app-specific password at account.apple.com → Sign-In and Security. The From address must be your @icloud.com address.' },
  { id: 'fastmail', name: 'Fastmail', host: 'smtp.fastmail.com', port: 465, secure: true, help: 'Create an app password under Settings → Privacy & Security → Integrations.' },
  { id: 'yahoo', name: 'Yahoo Mail', host: 'smtp.mail.yahoo.com', port: 465, secure: true, help: 'Generate an app password in Yahoo Account Security.' },
  { id: 'custom', name: 'Other SMTP server', host: '', port: 587, secure: false, help: 'Use the SMTP details from your email provider. Port 587 usually has SSL/TLS off (it upgrades automatically); port 465 has it on.' },
];

function hourLabel(hour) {
  return new Date(2000, 0, 1, hour).toLocaleTimeString([], { hour: 'numeric' });
}

async function email(panel, app) {
  let { mail } = await get('/admin/mail');
  const presetFor = (value) => MAIL_PRESETS.find((p) => p.host && p.host === value)?.id || (value ? 'custom' : 'gmail');
  const preset = h('select', {}, MAIL_PRESETS.map((p) => h('option', { value: p.id, selected: p.id === presetFor(mail.host) }, p.name)));
  const host = h('input', { type: 'text', value: mail.host, placeholder: 'smtp.example.com' });
  const port = h('input', { type: 'number', min: 1, max: 65535, value: mail.port, class: 'narrow' });
  const secure = h('input', { type: 'checkbox', checked: mail.secure });
  const user = h('input', { type: 'text', value: mail.user, autocomplete: 'off', placeholder: 'you@gmail.com' });
  const password = h('input', { type: 'password', autocomplete: 'new-password', placeholder: mail.hasPassword ? 'Saved (leave blank to keep it)' : 'App password' });
  const from = h('input', { type: 'email', value: mail.from, placeholder: 'you@gmail.com' });
  const digestHour = h('select', {}, Array.from({ length: 24 }, (_, i) => h('option', { value: i, selected: i === mail.digestHour }, hourLabel(i))));
  const help = h('p', { class: 'hint' });
  const hostRow = h(
    'div',
    { class: 'stack' },
    field('SMTP server', host),
    h('div', { class: 'row gap wrap' }, field('Port', port), h('label', { class: 'check' }, secure, ' Use SSL/TLS (port 465)')),
  );

  const applyPreset = (initial) => {
    const p = MAIL_PRESETS.find((x) => x.id === preset.value);
    help.textContent = p.help;
    hostRow.hidden = p.id !== 'custom';
    if (!initial && p.id !== 'custom') {
      host.value = p.host;
      port.value = p.port;
      secure.checked = p.secure;
    }
  };
  preset.addEventListener('change', () => applyPreset(false));
  port.addEventListener('change', () => (secure.checked = Number(port.value) === 465));
  // Most providers require the From address to be the account itself.
  user.addEventListener('change', () => {
    if (!from.value && user.value.includes('@')) from.value = user.value;
  });
  applyPreset(true);
  if (preset.value !== 'custom' && !mail.host) {
    const p = MAIL_PRESETS.find((x) => x.id === preset.value);
    host.value = p.host;
    port.value = p.port;
    secure.checked = p.secure;
  }

  const body = () => ({
    host: host.value,
    port: Number(port.value),
    secure: secure.checked,
    user: user.value,
    password: password.value,
    from: from.value,
    digestHour: Number(digestHour.value),
  });

  const status = h('div', {});
  const drawStatus = () => {
    add(
      clear(status),
      mail.enabled
        ? h('p', {}, h('span', { class: 'badge accent' }, 'On'), mail.source === 'env' ? ' Using the SMTP settings from the server’s .env file. Saving here replaces them.' : ` Sending as ${mail.from}.`)
        : h('p', {}, h('span', { class: 'badge' }, 'Off'), ' Without email, reset and invite links are shown to you to send by hand.'),
    );
  };
  drawStatus();

  const turnOff = h(
    'button',
    {
      class: 'btn ghost danger',
      hidden: mail.source !== 'admin',
      onclick: async () => {
        if (!(await confirmDialog('Stop sending email? Reset and invite links will be shown to you instead, and morning summaries stop.', { okLabel: 'Turn off', danger: true }))) return;
        mail = (await del('/admin/mail')).mail;
        app.state.mailEnabled = mail.enabled;
        app.route();
      },
    },
    'Turn off email',
  );
  const test = h('button', { class: 'btn' }, `Send a test to ${app.state.user.email}`);
  test.addEventListener(
    'click',
    busy(test, async () => {
      await post('/admin/mail/test', body());
      toast(`Test email sent to ${app.state.user.email}. Check your inbox (and spam).`);
    }),
  );
  const save = h('button', { class: 'btn primary' }, 'Save');
  save.addEventListener(
    'click',
    busy(save, async () => {
      mail = (await put('/admin/mail', body())).mail;
      app.state.mailEnabled = mail.enabled;
      password.value = '';
      password.placeholder = mail.hasPassword ? 'Saved (leave blank to keep it)' : 'App password';
      turnOff.hidden = mail.source !== 'admin';
      drawStatus();
      toast('Email settings saved');
    }),
  );

  add(
    clear(panel),
    heading('Email', 'Used for “Forgot password?”, invites and morning summaries. The password is stored encrypted on your server.'),
    h('div', { class: 'card' }, status),
    h(
      'div',
      { class: 'card stack' },
      field('Email provider', preset),
      help,
      hostRow,
      field('Username', user),
      field('Password', password, 'Use an app password, not your normal email password.'),
      field('Send from', from, 'Usually the same address as the username.'),
      field('Morning summary time', digestHour, `In ${mail.timezone}. Each person turns the summary on in Settings → Profile.`),
      h('div', { class: 'row gap-s wrap' }, save, test, h('span', { class: 'grow' }), turnOff),
    ),
  );
}

// --- Reminders (push notifications) ------------------------------------------------

function hourName(hour) {
  return new Date(2000, 0, 1, hour).toLocaleTimeString([], { hour: 'numeric' });
}

function remindersCard(app) {
  const user = app.state.user;
  const savePref = async (body, input, revert) => {
    try {
      app.state.user = (await patch('/me', body)).user;
      toast('Saved');
    } catch (err) {
      revert?.(input);
      toast(err.message, 'error');
    }
  };
  const minutes = h(
    'select',
    { onchange: (e) => savePref({ remindMinutes: Number(e.target.value) }) },
    [
      [0, 'Off'],
      [5, '5 minutes before'],
      [10, '10 minutes before'],
      [15, '15 minutes before'],
      [30, '30 minutes before'],
      [60, '1 hour before'],
      [120, '2 hours before'],
    ].map(([v, label]) => h('option', { value: v, selected: v === user.remindMinutes }, label)),
  );
  const choresHour = h(
    'select',
    { onchange: (e) => savePref({ remindChoresHour: e.target.value === '' ? null : Number(e.target.value) }) },
    h('option', { value: '', selected: user.remindChoresHour === null }, 'Off'),
    [15, 16, 17, 18, 19, 20, 21].map((hr) => h('option', { value: hr, selected: hr === user.remindChoresHour }, `At ${hourName(hr)}`)),
  );
  const status = h('div', { class: 'stack gap-s' });

  const drawStatus = async () => {
    const support = pushSupport();
    if (!support.ok) {
      const messages = {
        'ios-install': 'On iPhone and iPad, reminders only work in the installed app. Add Hearth to your Home Screen (Share → Add to Home Screen), open it from there, then come back to this page.',
        denied: 'Notifications are blocked for Hearth on this device. Allow them in your browser or phone settings, then reload.',
        unsupported: 'This browser can’t show notifications. Try Chrome, Edge, Firefox, or the installed app.',
      };
      add(clear(status), h('p', { class: 'muted' }, messages[support.reason]));
      return;
    }
    const [{ publicKey, devices }, sub] = await Promise.all([get('/push/key'), currentPushSubscription()]);
    const others = sub ? devices - 1 : devices;
    const note = others > 0 ? h('p', { class: 'hint' }, `Also on for ${others} other device${others === 1 ? '' : 's'}.`) : null;
    if (sub) {
      const test = h('button', { class: 'btn' }, 'Send a test');
      test.addEventListener('click', busy(test, async () => (await post('/push/test'), toast('Sent. It should pop up in a few seconds.'))));
      const off = h('button', { class: 'btn ghost danger' }, 'Turn off on this device');
      off.addEventListener(
        'click',
        busy(off, async () => {
          const endpoint = await unsubscribePush();
          if (endpoint) await post('/push/unsubscribe', { endpoint });
          await drawStatus();
        }),
      );
      add(clear(status), h('p', {}, h('span', { class: 'badge accent' }, 'On'), ' Reminders are on for this device.'), h('div', { class: 'row gap-s wrap' }, test, off), note);
    } else {
      const on = h('button', { class: 'btn primary' }, 'Turn on reminders for this device');
      on.addEventListener(
        'click',
        busy(on, async () => {
          const subscription = await subscribePush(publicKey);
          await post('/push/subscribe', { subscription });
          toast('Reminders turned on');
          await drawStatus();
        }),
      );
      add(clear(status), h('div', {}, on), note);
    }
  };
  drawStatus().catch((err) => add(clear(status), h('p', { class: 'error-text' }, err.message)));

  return h(
    'div',
    { class: 'card stack' },
    h('h3', {}, 'Reminders'),
    h('p', { class: 'muted' }, 'Notifications on your phone or computer for events and unfinished chores. Turn them on for each device you want them on.'),
    status,
    field('Event reminders', minutes, 'For events in the calendars you show.'),
    toggle('All-day events: remind me at 8:00 AM', user.remindAllDay, (on, input) => savePref({ remindAllDay: on }, input, (i) => (i.checked = !on))),
    field('Unfinished chores', choresHour, 'Only sent when chores are still open that day.'),
  );
}

// --- Phone calendar subscribe links ---------------------------------------------------

async function feedDialog(calendar) {
  const label = calendar ? `“${calendar.name}”` : 'all your calendars';
  let { url } = await post('/feeds', { calendarId: calendar?.id || null });
  const input = h('input', { type: 'text', value: url, readonly: true, class: 'mono', onfocus: (e) => e.target.select() });
  const webcal = h('a', { class: 'btn', href: url.replace(/^https?:/, 'webcal:') }, 'Open in Calendar app');
  const copy = h(
    'button',
    {
      class: 'btn primary',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(input.value);
          toast('Link copied');
        } catch {
          input.select();
        }
      },
    },
    'Copy link',
  );
  const reset = h('button', { class: 'btn ghost danger left' }, 'Make a new link');
  reset.addEventListener(
    'click',
    busy(reset, async () => {
      if (!(await confirmDialog('Make a new link? Phones subscribed with the old link will stop updating until you add the new one.', { okLabel: 'New link', danger: true }))) return;
      ({ url } = await post('/feeds/reset', { calendarId: calendar?.id || null }));
      input.value = url;
      webcal.href = url.replace(/^https?:/, 'webcal:');
      toast('New link created');
    }),
  );
  const m = modal({
    title: `Subscribe to ${calendar ? calendar.name : 'all calendars'}`,
    wide: true,
    content: h(
      'div',
      { class: 'stack' },
      h('p', {}, `Add ${label} to the calendar app on your phone or computer. It’s read-only there and updates automatically. Changes are made in Hearth.`),
      input,
      h(
        'ul',
        { class: 'bullets' },
        h('li', {}, h('strong', {}, 'iPhone / iPad / Mac: '), 'tap “Open in Calendar app” on that device, or go to Settings → Calendar → Accounts → Add Account → Other → Add Subscribed Calendar and paste the link.'),
        h('li', {}, h('strong', {}, 'Google Calendar: '), 'on a computer, open calendar.google.com → “Other calendars” + → From URL → paste. Google refreshes it every few hours.'),
        h('li', {}, h('strong', {}, 'Outlook: '), 'Add calendar → Subscribe from web → paste.'),
      ),
      h('p', { class: 'hint' }, 'Anyone with this link can see these events, so only share it with people you trust. Make a new link if it gets out.'),
    ),
    actions: [reset, h('button', { class: 'btn', onclick: () => m.close() }, 'Done'), webcal, copy],
  });
}

// --- Photos (for the display's photo frame) -----------------------------------------

/** Shrinks a photo to at most 1920px on its long side and re-encodes it as JPEG. */
async function shrinkImage(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, 1920 / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  return { blob, width, height };
}

async function photosSection(panel, app) {
  const grid = h('div', { class: 'photo-grid' });
  const count = h('span', { class: 'muted' });
  const draw = async () => {
    const { photos } = await get('/photos');
    count.textContent = `${photos.length} photo${photos.length === 1 ? '' : 's'}`;
    add(
      clear(grid),
      photos.length
        ? photos.map((p) =>
            h(
              'figure',
              { class: 'photo-tile' },
              h('img', { src: `/api/photos/${p.id}`, alt: '', loading: 'lazy' }),
              h(
                'button',
                {
                  class: 'icon-btn photo-remove',
                  'aria-label': 'Delete photo',
                  onclick: async () => {
                    if (!(await confirmDialog('Delete this photo from the photo frame?', { okLabel: 'Delete', danger: true }))) return;
                    await del(`/photos/${p.id}`).catch((e) => toast(e.message, 'error'));
                    draw();
                  },
                },
                '✕',
              ),
            ),
          )
        : h('p', { class: 'muted pad' }, 'No photos yet.'),
    );
  };
  const input = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
  const upload = h('button', { class: 'btn primary', onclick: () => input.click() }, '+ Add photos');
  input.addEventListener('change', async () => {
    const files = [...input.files];
    input.value = '';
    if (!files.length) return;
    upload.disabled = true;
    let done = 0;
    for (const file of files) {
      upload.textContent = `Uploading ${done + 1} of ${files.length}…`;
      try {
        const { blob, width, height } = await shrinkImage(file);
        const res = await fetch('/api/photos', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'image/jpeg', 'X-Requested-With': 'fetch', 'X-Image-Width': width, 'X-Image-Height': height },
          body: blob,
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Upload failed (${res.status})`);
        done += 1;
      } catch (err) {
        toast(`${file.name}: ${err.message}`, 'error');
      }
    }
    upload.disabled = false;
    upload.textContent = '+ Add photos';
    if (done) toast(`Added ${done} photo${done === 1 ? '' : 's'}`);
    draw();
  });
  add(
    panel,
    heading('Photos', 'Family photos for the wall display’s photo frame. Turn it on in Settings → Wall displays.', count, upload, input),
    h('div', { class: 'card' }, grid),
    h('p', { class: 'hint' }, 'Photos are resized to 1920 pixels and stored on your server (they are included in backups).'),
  );
  await draw();
}

// --- Household (admin): location for weather, units -----------------------------------

async function household(panel) {
  let { household: current } = await get('/household');
  const status = h('p', {});
  const drawStatus = () => {
    status.textContent = current.configured ? `📍 ${current.placeName}` : 'No location set, so the display won’t show weather.';
  };
  drawStatus();
  const search = h('input', { type: 'text', placeholder: 'Search for your city or town…' });
  const results = h('div', { class: 'list' });
  const find = h('button', { class: 'btn' }, 'Search');
  const runSearch = busy(find, async () => {
    const { results: found } = await get(`/admin/geocode?q=${encodeURIComponent(search.value)}`);
    add(
      clear(results),
      found.length
        ? found.map((r) =>
            h(
              'button',
              {
                class: 'list-row geo-result',
                onclick: async () => {
                  current = (await put('/admin/household', { latitude: r.latitude, longitude: r.longitude, placeName: r.name })).household;
                  clear(results);
                  search.value = '';
                  drawStatus();
                  toast('Location saved');
                },
              },
              '📍 ',
              r.name,
            ),
          )
        : h('p', { class: 'muted' }, 'No places found.'),
    );
  });
  find.addEventListener('click', runSearch);
  search.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), runSearch()));
  const units = h(
    'select',
    {
      onchange: async (e) => {
        current = (await put('/admin/household', { units: e.target.value })).household;
        toast('Saved');
      },
    },
    h('option', { value: 'fahrenheit', selected: current.units !== 'celsius' }, '°F (Fahrenheit)'),
    h('option', { value: 'celsius', selected: current.units === 'celsius' }, '°C (Celsius)'),
  );
  add(
    panel,
    heading('Household', 'Settings for the whole family.'),
    h(
      'div',
      { class: 'card stack' },
      h('h3', {}, 'Location for weather'),
      status,
      h('div', { class: 'row gap-s' }, search, find),
      results,
      h('p', { class: 'hint' }, 'Weather comes from Open-Meteo (free, no account). Only the location is sent to it.'),
    ),
    h('div', { class: 'card stack' }, field('Temperature units', units)),
  );
}

// --- Public holiday calendars ------------------------------------------------------------

const HOLIDAY_CALENDARS = [
  ['United States', 'en.usa'],
  ['Canada', 'en.canadian'],
  ['United Kingdom', 'en.uk'],
  ['Ireland', 'en.irish'],
  ['Australia', 'en.australian'],
  ['New Zealand', 'en.new_zealand'],
  ['Mexico', 'en.mexican'],
  ['Brazil', 'en.brazilian'],
  ['Germany', 'en.german'],
  ['France', 'en.french'],
  ['Spain', 'en.spain'],
  ['Italy', 'en.italian'],
  ['Netherlands', 'en.dutch'],
  ['Sweden', 'en.swedish'],
  ['India', 'en.indian'],
  ['Philippines', 'en.philippines'],
  ['Japan', 'en.japanese'],
  ['South Africa', 'en.sa'],
  ['Christian holidays', 'en.christian'],
  ['Jewish holidays', 'en.judaism'],
  ['Islamic holidays', 'en.islamic'],
  ['Hindu holidays', 'en.hinduism'],
];

function holidayDialog(app) {
  const country = h('select', {}, HOLIDAY_CALENDARS.map(([label, id]) => h('option', { value: id }, label)));
  const save = h('button', { class: 'btn primary' }, 'Add holidays');
  const m = modal({
    title: 'Add a holiday calendar',
    content: h('div', { class: 'stack' }, field('Holidays for', country), h('p', { class: 'hint' }, 'A read-only calendar of public holidays, kept up to date automatically.')),
    actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), save],
  });
  save.addEventListener(
    'click',
    busy(save, async () => {
      const label = country.selectedOptions[0].textContent;
      const id = `${country.value}#holiday@group.v.calendar.google.com`;
      await post('/calendars', {
        source: 'ics',
        name: label.endsWith('holidays') ? label : `${label} holidays`,
        color: '#e8594f',
        url: `https://calendar.google.com/calendar/ical/${encodeURIComponent(id)}/public/basic.ics`,
      });
      m.close();
      toast('Holidays added');
      await app.reload();
      app.route();
    }),
  );
}
