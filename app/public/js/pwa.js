import { h } from './util.js';

let deferredPrompt = null;
const listeners = new Set();

export const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

export const isIOS = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/** True when the browser can show its own install dialog (Chrome, Edge, Samsung Internet...). */
export const canPromptInstall = () => Boolean(deferredPrompt);

export function onInstallAvailabilityChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  for (const fn of listeners) fn(canPromptInstall());
}

export function registerServiceWorker() {
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    notify();
  });
}

export async function promptInstall() {
  if (!deferredPrompt) return false;
  const prompt = deferredPrompt;
  deferredPrompt = null;
  prompt.prompt();
  const { outcome } = await prompt.userChoice;
  notify();
  return outcome === 'accepted';
}

function storage(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    return null;
  }
  return null;
}

/** One-time hint for iPhone/iPad Safari, which has no install prompt of its own. */
export function maybeShowIosHint() {
  if (!isIOS() || isStandalone() || storage('hearth.iosHintDismissed')) return;
  const banner = h(
    'div',
    { class: 'install-hint', role: 'note' },
    h('img', { src: '/icons/icon-192.png', alt: '', width: 40, height: 40 }),
    h('div', { class: 'grow' }, h('strong', {}, 'Install Hearth on this device'), h('span', {}, 'Tap ', h('span', { class: 'share-glyph', 'aria-label': 'Share' }, '⎋'), ' Share, then “Add to Home Screen”.')),
    h(
      'button',
      {
        class: 'icon-btn',
        'aria-label': 'Dismiss',
        onclick: () => {
          storage('hearth.iosHintDismissed', '1');
          banner.remove();
        },
      },
      '✕',
    ),
  );
  document.body.append(banner);
}

/** Instructions card for Settings → Profile. */
export function installCard() {
  if (isStandalone()) {
    return h('div', { class: 'card stack' }, h('h3', {}, 'App'), h('p', { class: 'muted' }, '✅ You’re using the installed Hearth app.'));
  }
  const button = h('button', { class: 'btn primary', hidden: !canPromptInstall(), onclick: () => promptInstall() }, 'Install Hearth');
  onInstallAvailabilityChange((available) => (button.hidden = !available));
  const steps = isIOS()
    ? h('p', {}, 'In Safari, tap the Share button, then “Add to Home Screen”. Hearth then opens full-screen like a regular app.')
    : h(
        'ul',
        { class: 'bullets' },
        h('li', {}, h('strong', {}, 'Android (Chrome): '), 'tap ⋮ → “Install app” or “Add to Home screen”.'),
        h('li', {}, h('strong', {}, 'iPhone / iPad (Safari): '), 'tap Share → “Add to Home Screen”.'),
        h('li', {}, h('strong', {}, 'Computer (Chrome / Edge): '), 'click the install icon at the right of the address bar.'),
      );
  return h('div', { class: 'card stack' }, h('h3', {}, 'Install as an app'), h('p', { class: 'muted' }, 'Put Hearth on your home screen with its own icon and full-screen window.'), steps, h('div', {}, button));
}

// --- Push reminders -------------------------------------------------------------------

/** Whether this device can receive reminders, and if not, why. */
export function pushSupport() {
  if (isIOS() && !isStandalone()) return { ok: false, reason: 'ios-install' };
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window) || !window.isSecureContext) {
    return { ok: false, reason: 'unsupported' };
  }
  if (Notification.permission === 'denied') return { ok: false, reason: 'denied' };
  return { ok: true };
}

function swReady() {
  return Promise.race([navigator.serviceWorker.ready, new Promise((resolve) => setTimeout(() => resolve(null), 6000))]);
}

function base64UrlToBytes(value) {
  const padded = (value + '='.repeat((4 - (value.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

export async function currentPushSubscription() {
  const reg = await swReady();
  return reg ? reg.pushManager.getSubscription() : null;
}

/** Asks for permission and subscribes this device. Returns the subscription JSON for the server. */
export async function subscribePush(publicKey) {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications were not allowed. You can allow them for this site in your browser or phone settings.');
  const reg = await swReady();
  if (!reg) throw new Error('The app is still loading. Reload the page and try again.');
  const existing = await reg.pushManager.getSubscription();
  const sub = existing || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(publicKey) }));
  return sub.toJSON();
}

/** Unsubscribes this device. Returns the old endpoint so the server can forget it. */
export async function unsubscribePush() {
  const sub = await currentPushSubscription();
  if (!sub) return null;
  const { endpoint } = sub;
  await sub.unsubscribe().catch(() => {});
  return endpoint;
}
