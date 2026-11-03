import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scrypt as derive, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

const scrypt = promisify(derive);
const digest = value => createHash('sha256').update(value).digest('hex');
export const csrfFor = token => digest(`deckpg-csrf:${token}`);

// The database is opened only by native account administration or an enabled web listener.
export class Accounts {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, 'accounts.sqlite');
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS accounts (username TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (digest TEXT PRIMARY KEY, username TEXT NOT NULL REFERENCES accounts(username) ON DELETE CASCADE,
        expires INTEGER NOT NULL);`);
    this.dummySalt = randomBytes(16).toString('hex');
  }

  list() {
    return this.db.prepare('SELECT username FROM accounts ORDER BY username').all().map(row => ({ username: row.username }));
  }

  async save(username, password) {
    if (typeof username !== 'string' || !/^[\p{L}\p{N}_.@-]{1,64}$/u.test(username)
      || typeof password !== 'string' || password.length < 8 || password.length > 256) {
      throw Error('账号仅支持字母、数字及 _.@-；密码须为 8–256 个字符');
    }
    const salt = randomBytes(16).toString('hex');
    const hash = (await scrypt(password, salt, 64)).toString('hex');
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO accounts VALUES (?, ?, ?) ON CONFLICT(username) DO UPDATE SET salt=excluded.salt, hash=excluded.hash')
        .run(username, salt, hash);
      this.db.prepare('DELETE FROM sessions WHERE username=?').run(username);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async remove(username) {
    this.db.prepare('DELETE FROM accounts WHERE username=?').run(username);
  }

  async login(username, password) {
    const account = this.db.prepare('SELECT * FROM accounts WHERE username=?').get(username);
    const actual = await scrypt(password, account?.salt || this.dummySalt, 64);
    if (!account || !timingSafeEqual(actual, Buffer.from(account.hash, 'hex'))) {
      return null;
    }
    // Password reset/removal while scrypt runs must not mint a session for the old credentials.
    if (this.db.prepare('SELECT hash FROM accounts WHERE username=?').get(username)?.hash !== account.hash) {
      return null;
    }
    this.db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now());
    const token = randomBytes(32).toString('hex');
    this.db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(digest(token), username, Date.now() + 8 * 3600_000);
    return { token, username, csrf: csrfFor(token) };
  }

  session(token) {
    return this.db.prepare('SELECT username, expires FROM sessions WHERE digest=? AND expires>?').get(digest(token), Date.now()) || null;
  }

  revoke(token) {
    this.db.prepare('DELETE FROM sessions WHERE digest=?').run(digest(token));
  }

  revokeDigest(hash) {
    this.db.prepare('DELETE FROM sessions WHERE digest=?').run(hash);
  }

  revokeAll() {
    this.db.exec('DELETE FROM sessions');
  }

  close() {
    this.db.close();
  }
}
