import { authHeaders, get } from './api.js';
import { add, clear, fmtDate, fmtTime, h, modal } from './util.js';

// --- Weather -------------------------------------------------------------------------

export function weatherWidget() {
  let last = null;
  const el = h('button', {
    class: 'd-weather',
    hidden: true,
    onclick: () => {
      if (!last) return;
      modal({
        title: last.place ? `Weather · ${last.place}` : 'Weather',
        content: h(
          'div',
          { class: 'wx-days' },
          last.days.map((d, i) =>
            h(
              'div',
              { class: 'wx-day' },
              h('strong', {}, i === 0 ? 'Today' : new Date(`${d.date}T12:00`).toLocaleDateString([], { weekday: 'long' })),
              h('span', { class: 'wx-big' }, d.icon),
              h('span', {}, d.label),
              h('span', {}, `${d.high}° / ${d.low}°`),
              d.rain !== null ? h('span', { class: 'muted' }, `💧 ${d.rain}%`) : null,
            ),
          ),
        ),
      });
    },
  });
  async function refresh() {
    try {
      const { weather } = await get('/weather');
      if (!weather.configured) {
        el.hidden = true;
        return;
      }
      last = weather;
      const today = weather.days[0];
      add(
        clear(el),
        h('span', { class: 'wx-icon' }, weather.current.icon),
        h('span', { class: 'wx-temp' }, `${weather.current.temp}°`),
        h('span', { class: 'wx-range' }, `${today.high}° / ${today.low}°`),
        today.rain !== null && today.rain >= 30 ? h('span', { class: 'wx-rain' }, `💧${today.rain}%`) : null,
      );
      el.title = `${weather.current.label}${weather.place ? ` · ${weather.place}` : ''}`;
      el.hidden = false;
    } catch {
      /* keep showing the last reading */
    }
  }
  return { el, refresh };
}

// --- Up next -------------------------------------------------------------------------

function relative(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `in ${hours} h ${rest} min` : `in ${hours} h`;
}

/** "Next: 🦄 Soccer practice · 5 PM · in 1 h 20 min" */
export function upNextStrip() {
  const el = h('div', { class: 'd-upnext', hidden: true });
  function update(events, ctx) {
    const now = new Date();
    const timed = events.filter((e) => !e.allDay).map((e) => ({ ...e, s: new Date(e.start), e2: new Date(e.end) }));
    const current = timed.filter((e) => e.s <= now && e.e2 > now).sort((a, b) => a.e2 - b.e2)[0];
    const next = timed.filter((e) => e.s > now && e.s - now < 12 * 3600000).sort((a, b) => a.s - b.s)[0];
    const label = (ev) => {
      const cal = ctx.calendarsById.get(ev.calendarId);
      const member = cal?.memberId ? ctx.membersById.get(cal.memberId) : null;
      return [member?.emoji ? `${member.emoji} ` : '', ev.title || '(untitled)'].join('');
    };
    const parts = [];
    if (current) parts.push(h('span', { class: 'upnext-item now' }, h('b', {}, 'Now '), label(current), h('span', { class: 'muted' }, ` · until ${fmtTime(current.e2)}`)));
    if (next) {
      parts.push(
        h(
          'span',
          { class: 'upnext-item', style: { '--c': ctx.colorFor(next) } },
          h('b', {}, 'Next '),
          label(next),
          h('span', { class: 'muted' }, ` · ${fmtTime(next.s)} · ${relative(next.s - now)}`),
        ),
      );
    }
    el.hidden = !parts.length;
    add(clear(el), parts);
  }
  return { el, update };
}

// --- Night mode ----------------------------------------------------------------------

const minutesOf = (hhmm) => {
  const [hr, mi] = String(hhmm || '00:00').split(':').map(Number);
  return hr * 60 + mi;
};

export function inNightWindow(date, start, end) {
  const m = date.getHours() * 60 + date.getMinutes();
  const s = minutesOf(start);
  const e = minutesOf(end);
  return s <= e ? m >= s && m < e : m >= s || m < e;
}

/** Dim, clock-only screen overnight. A tap wakes it for two minutes. */
export function nightOverlay(settings) {
  let wakeUntil = 0;
  const time = h('div', { class: 'night-time' });
  const date = h('div', { class: 'night-date' });
  const el = h('div', { class: 'd-night', hidden: true, onclick: () => ((wakeUntil = Date.now() + 2 * 60000), (el.hidden = true)) }, time, date, h('div', { class: 'night-hint' }, 'Tap to wake'));
  function tick(now = new Date()) {
    const active = settings.nightMode && inNightWindow(now, settings.nightStart, settings.nightEnd) && Date.now() > wakeUntil;
    el.hidden = !active;
    if (active) {
      time.textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      date.textContent = fmtDate(now, { weekday: 'long', month: 'long', day: 'numeric' });
    }
    return active;
  }
  return { el, tick, isActive: () => !el.hidden };
}

// --- Photo frame ---------------------------------------------------------------------

/** Full-screen slideshow of the display owner's photos after the screen has been idle. */
export function photoFrame(settings, { idleMs }) {
  let photos = [];
  let order = [];
  let index = 0;
  let running = false;
  let timer = null;
  let front = 0;
  const layers = [h('img', { class: 'pf-img', alt: '' }), h('img', { class: 'pf-img', alt: '' })];
  const clock = h('div', { class: 'pf-clock' });
  const el = h('div', { class: 'd-photos', hidden: true, onpointerdown: () => stop() }, layers, clock);
  const urls = new Map();

  async function loadList() {
    if (!settings.photoFrame) return;
    try {
      photos = (await get('/photos')).photos;
    } catch {
      photos = [];
    }
  }

  async function blobUrl(id) {
    if (urls.has(id)) return urls.get(id);
    const res = await fetch(`/api/photos/${id}`, { headers: authHeaders(), credentials: 'same-origin' });
    if (!res.ok) throw new Error('photo failed');
    const url = URL.createObjectURL(await res.blob());
    urls.set(id, url);
    // Keep memory bounded on long-running tablets.
    if (urls.size > 12) {
      const [oldId, oldUrl] = urls.entries().next().value;
      URL.revokeObjectURL(oldUrl);
      urls.delete(oldId);
    }
    return url;
  }

  async function showNext() {
    if (!running || !photos.length) return;
    if (index >= order.length) {
      order = [...photos].sort(() => Math.random() - 0.5);
      index = 0;
    }
    const photo = order[index++];
    try {
      const url = await blobUrl(photo.id);
      const next = layers[1 - front];
      next.src = url;
      await next.decode().catch(() => {});
      next.classList.add('on');
      layers[front].classList.remove('on');
      front = 1 - front;
    } catch {
      /* skip unreadable photo */
    }
    timer = setTimeout(showNext, settings.photoSeconds * 1000);
  }

  function start() {
    if (running) return;
    running = true;
    el.hidden = false;
    showNext();
  }

  function stop() {
    if (!running) return;
    running = false;
    clearTimeout(timer);
    el.hidden = true;
  }

  function tick(lastInteraction, blocked) {
    const now = new Date();
    clock.textContent = `${now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · ${fmtDate(now, { weekday: 'long', month: 'long', day: 'numeric' })}`;
    const shouldRun = settings.photoFrame && photos.length > 0 && !blocked && Date.now() - lastInteraction > idleMs();
    if (shouldRun) start();
    else if (running && (blocked || Date.now() - lastInteraction <= idleMs())) stop();
  }

  return { el, loadList, tick, stop, isRunning: () => running };
}
