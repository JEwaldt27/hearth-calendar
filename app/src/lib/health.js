import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const startedAt = new Date();

const appRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let version = 'dev';
try {
  version = (await fs.readFile(path.join(appRoot, 'VERSION'), 'utf8')).trim() || 'dev';
} catch {
  /* no VERSION file (local development) */
}
export const appVersion = version;

// Recent problems (sync failures, email/push errors…) kept in memory for the health page.
const problems = [];

export function recordProblem(kind, message) {
  problems.unshift({ at: new Date().toISOString(), kind, message: String(message).slice(0, 300) });
  if (problems.length > 50) problems.length = 50;
}

export function recentProblems() {
  return problems.slice(0, 30);
}

export const BACKUP_DIR = process.env.BACKUP_DIR || '/backups';

/** Newest backup file in the (read-only mounted) backups folder, or null if the folder isn't there. */
export async function backupStatus() {
  let names;
  try {
    names = (await fs.readdir(BACKUP_DIR)).filter((n) => /^hearth-.*\.sql\.gz$/.test(n));
  } catch {
    return { available: false };
  }
  const files = await Promise.all(
    names.map(async (name) => {
      const st = await fs.stat(path.join(BACKUP_DIR, name));
      return { name, at: st.mtime.toISOString(), bytes: st.size };
    }),
  );
  files.sort((a, b) => (a.at < b.at ? 1 : -1));
  return { available: true, count: files.length, latest: files[0] || null, totalBytes: files.reduce((n, f) => n + f.bytes, 0) };
}

/** Free space on the disk that holds the backups (the server's disk). */
export async function diskStatus() {
  for (const target of [BACKUP_DIR, appRoot]) {
    try {
      const s = await fs.statfs(target);
      return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
    } catch {
      /* try the next path */
    }
  }
  return null;
}
