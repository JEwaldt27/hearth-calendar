import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from '../config.js';

const scryptParams = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(password, salt, 64, scryptParams, (err, key) => {
      if (err) return reject(err);
      resolve(`scrypt$${salt.toString('base64')}$${key.toString('base64')}`);
    });
  });
}

export function verifyPassword(password, stored) {
  return new Promise((resolve) => {
    const [scheme, saltB64, keyB64] = String(stored).split('$');
    if (scheme !== 'scrypt' || !saltB64 || !keyB64) return resolve(false);
    const expected = Buffer.from(keyB64, 'base64');
    crypto.scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, scryptParams, (err, key) => {
      if (err) return resolve(false);
      resolve(crypto.timingSafeEqual(key, expected));
    });
  });
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// AES-256-GCM for third-party credentials (CalDAV app passwords, Google refresh tokens).
const encKey = crypto.createHash('sha256').update(`hearth-credentials:${config.appSecret}`).digest();

export function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}

export function decrypt(payload) {
  const [iv, tag, data] = String(payload).split('.').map((s) => Buffer.from(s, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

function isBlockedAddress(address) {
  const v4 = net.isIPv6(address) && address.startsWith('::ffff:') ? address.slice(7) : address;
  if (net.isIPv4(v4)) {
    const [a, b] = v4.split('.').map(Number);
    if (a === 127 || a === 0 || (a === 169 && b === 254)) return true;
    if (config.blockPrivateNetworks) {
      if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return true;
    }
    return false;
  }
  const lower = address.toLowerCase();
  if (lower === '::1' || lower === '::' || lower.startsWith('fe80:')) return true;
  if (config.blockPrivateNetworks && (lower.startsWith('fc') || lower.startsWith('fd'))) return true;
  return false;
}

/** Rejects URLs that would make the server call itself, cloud metadata endpoints, or (optionally) the LAN. */
export async function assertSafeUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw httpError(400, 'That does not look like a valid URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw httpError(400, 'Only http(s) and webcal URLs are supported.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (addresses.length === 0) throw httpError(400, `Could not resolve ${url.hostname}.`);
  if (addresses.some(isBlockedAddress)) throw httpError(400, 'That address is not allowed.');
  return url;
}

export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
