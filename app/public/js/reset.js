import { post } from './api.js';

const form = document.getElementById('reset-form');
const title = document.getElementById('reset-title');
const subtitle = document.getElementById('reset-subtitle');
const errorEl = document.getElementById('reset-error');
const submit = document.getElementById('reset-submit');

// Keep the token out of the address bar (and browser history) once read.
const token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
history.replaceState(null, '', '/reset');

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

try {
  if (!token) throw new Error('This link is incomplete. Open the full link from your email or message.');
  const info = await post('/auth/token', { token });
  if (info.purpose === 'invite') {
    title.textContent = `Welcome, ${info.name}!`;
    subtitle.textContent = `Choose a password for ${info.email} to finish setting up your account.`;
  } else {
    title.textContent = 'Choose a new password';
    subtitle.textContent = `For ${info.email}. Other devices will be signed out.`;
  }
  form.username.value = info.email;
  form.hidden = false;
  form.password.focus();
} catch (err) {
  title.textContent = 'Link not valid';
  subtitle.textContent = err.message;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.hidden = true;
  if (form.password.value.length < 8) return showError('Passwords need at least 8 characters.');
  if (form.password.value !== form.confirm.value) return showError('The two passwords don’t match.');
  submit.disabled = true;
  try {
    await post('/auth/reset', { token, password: form.password.value });
    location.href = '/';
  } catch (err) {
    showError(err.message);
  } finally {
    submit.disabled = false;
  }
});
