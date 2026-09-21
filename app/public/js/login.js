import { get, post } from './api.js';
import { registerServiceWorker } from './pwa.js';

registerServiceWorker();

const form = document.getElementById('auth-form');
const title = document.getElementById('auth-title');
const subtitle = document.getElementById('auth-subtitle');
const nameField = document.getElementById('name-field');
const passwordField = document.getElementById('password-field');
const errorEl = document.getElementById('auth-error');
const infoEl = document.getElementById('auth-info');
const submit = document.getElementById('auth-submit');
const switchWrap = document.getElementById('switch-wrap');
const switchText = document.getElementById('switch-text');
const switchBtn = document.getElementById('auth-switch');
const forgotWrap = document.getElementById('forgot-wrap');
const forgotBtn = document.getElementById('forgot-btn');

let mode = 'login';
let status = { signupAllowed: false, needsSetup: false, mailEnabled: false };

function render() {
  const register = mode === 'register';
  const forgot = mode === 'forgot';
  nameField.hidden = !register;
  passwordField.hidden = forgot;
  form.password.required = !forgot;
  form.password.autocomplete = register ? 'new-password' : 'current-password';
  title.textContent = status.needsSetup ? 'Set up Hearth' : register ? 'Create your account' : forgot ? 'Reset your password' : 'Sign in';
  subtitle.textContent = status.needsSetup
    ? 'Create the first account. It becomes the administrator.'
    : register
      ? 'You can share calendars and chores with family once you’re in.'
      : forgot
        ? 'Enter your email and we’ll send you a link to choose a new password.'
        : 'Your family calendar.';
  submit.textContent = register ? 'Create account' : forgot ? 'Send reset link' : 'Sign in';
  switchWrap.hidden = status.needsSetup || forgot || !status.signupAllowed;
  switchText.textContent = register ? 'Already have an account?' : 'New here?';
  switchBtn.textContent = register ? 'Sign in' : 'Create an account';
  forgotWrap.hidden = status.needsSetup || register;
  forgotBtn.textContent = forgot ? 'Back to sign in' : 'Forgot password?';
  errorEl.hidden = true;
  infoEl.hidden = true;
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

switchBtn.addEventListener('click', () => {
  mode = mode === 'login' ? 'register' : 'login';
  render();
});

forgotBtn.addEventListener('click', () => {
  if (mode === 'forgot') {
    mode = 'login';
    render();
    return;
  }
  if (!status.mailEnabled) {
    render();
    showError('Ask your Hearth administrator to reset it for you (Settings → Users → Reset password).');
    return;
  }
  mode = 'forgot';
  render();
  form.email.focus();
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.hidden = true;
  infoEl.hidden = true;
  submit.disabled = true;
  try {
    if (mode === 'forgot') {
      await post('/auth/forgot', { email: form.email.value });
      infoEl.textContent = 'If that email has an account, a reset link is on its way. Check your inbox (and spam folder).';
      infoEl.hidden = false;
      return;
    }
    const body = { email: form.email.value, password: form.password.value, name: form.name.value };
    await post(mode === 'register' ? '/auth/register' : '/auth/login', body);
    location.href = '/';
  } catch (err) {
    showError(err.message);
  } finally {
    submit.disabled = false;
  }
});

try {
  status = await get('/auth/status');
  if (status.user) location.href = '/';
  if (status.needsSetup) mode = 'register';
} catch (err) {
  showError(err.message);
}
render();
