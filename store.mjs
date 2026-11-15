import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS quotes (
  request_id TEXT PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  digest TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  notification_status TEXT NOT NULL DEFAULT 'pending',
  notification_attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at BIGINT NOT NULL DEFAULT 0,
  notification_error TEXT
);
CREATE INDEX IF NOT EXISTS quotes_notifications ON quotes(notification_status, next_attempt_at);
`;

function quoteRow(row) {
  return row && {
    requestId: row.request_id,
    reference: row.reference,
    digest: row.digest,
    payload: JSON.parse(row.payload),
    createdAt: Number(row.created_at),
    notificationStatus: row.notification_status,
    notificationAttempts: row.notification_attempts,
    nextAttemptAt: Number(row.next_attempt_at),
    notificationError: row.notification_error,
  };
}

export class SQLiteStore {
  constructor(filename = './data/quotes.sqlite') {
    if (filename !== ':memory:') mkdirSync(dirname(resolve(filename)), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec(`${SCHEMA}
      CREATE TABLE IF NOT EXISTS quote_photos (
        request_id TEXT NOT NULL REFERENCES quotes(request_id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        name TEXT NOT NULL,
        mime TEXT NOT NULL,
        bytes BLOB NOT NULL,
        PRIMARY KEY(request_id, position)
      );`);
  }

  async save(quote) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT * FROM quotes WHERE request_id = ?').get(quote.requestId);
      if (existing) {
        this.db.exec('COMMIT');
        return { quote: quoteRow(existing), duplicate: true, conflict: existing.digest !== quote.digest };
      }
      this.db.prepare(`INSERT INTO quotes(request_id, reference, digest, payload, created_at)
        VALUES(?, ?, ?, ?, ?)`)
        .run(quote.requestId, quote.reference, quote.digest, JSON.stringify(quote.payload), quote.createdAt);
      const insertPhoto = this.db.prepare('INSERT INTO quote_photos(request_id, position, name, mime, bytes) VALUES(?, ?, ?, ?, ?)');
      quote.photos.forEach((photo, position) => insertPhoto.run(quote.requestId, position, photo.name, photo.type, photo.bytes));
      this.db.exec('COMMIT');
      return { quote: await this.get(quote.requestId), duplicate: false, conflict: false };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async get(requestId) {
    return quoteRow(this.db.prepare('SELECT * FROM quotes WHERE request_id = ?').get(requestId));
  }

  async photos(requestId) {
    return this.db.prepare('SELECT position, name, mime, bytes FROM quote_photos WHERE request_id = ? ORDER BY position')
      .all(requestId).map(row => ({ position: row.position, name: row.name, type: row.mime, bytes: Buffer.from(row.bytes) }));
  }

  async recent(limit = 100) {
    return this.db.prepare('SELECT * FROM quotes ORDER BY created_at DESC LIMIT ?').all(limit).map(quoteRow);
  }

  async claimNotifications(now, limit = 5) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.db.prepare(`SELECT * FROM quotes
        WHERE notification_status IN ('pending', 'retry', 'sending') AND next_attempt_at <= ?
        ORDER BY created_at LIMIT ?`).all(now, limit);
      const claim = this.db.prepare(`UPDATE quotes SET notification_status='sending',
        notification_attempts=notification_attempts+1, next_attempt_at=? WHERE request_id=?`);
      rows.forEach(row => claim.run(now + 120_000, row.request_id));
      this.db.exec('COMMIT');
      return rows.map(row => quoteRow({ ...row, notification_status: 'sending', notification_attempts: row.notification_attempts + 1 }));
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async finishNotification(requestId, status, nextAttemptAt, errorCode = null) {
    this.db.prepare(`UPDATE quotes SET notification_status=?, next_attempt_at=?, notification_error=? WHERE request_id=?`)
      .run(status, nextAttemptAt, errorCode, requestId);
  }

  async ping() { this.db.prepare('SELECT 1').get(); }
  async close() { this.db.close(); }
}

export class PostgresStore {
  static async connect(connectionString, options = {}) {
    const { Pool } = await import('pg');
    if (options.ssl && typeof options.ssl === 'object') {
      // pg's connection-string SSL options replace the explicit SSL object. Preserve the trusted CA policy.
      const url = new URL(connectionString);
      for (const key of ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'sslpassword']) url.searchParams.delete(key);
      connectionString = url.toString();
    }
    const pool = new Pool({ connectionString, max: 5, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000, ...options });
    pool.on('error', () => console.error('database_pool_error'));
    const store = new PostgresStore(pool);
    await pool.query(`${SCHEMA}
      CREATE TABLE IF NOT EXISTS quote_photos (
        request_id TEXT NOT NULL REFERENCES quotes(request_id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        name TEXT NOT NULL,
        mime TEXT NOT NULL,
        bytes BYTEA NOT NULL,
        PRIMARY KEY(request_id, position)
      );`);
    return store;
  }

  constructor(pool) { this.pool = pool; }

  async save(quote) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(`INSERT INTO quotes(request_id, reference, digest, payload, created_at)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(request_id) DO NOTHING RETURNING *`,
      [quote.requestId, quote.reference, quote.digest, JSON.stringify(quote.payload), quote.createdAt]);
      if (!inserted.rowCount) {
        const { rows } = await client.query('SELECT * FROM quotes WHERE request_id=$1', [quote.requestId]);
        await client.query('COMMIT');
        return { quote: quoteRow(rows[0]), duplicate: true, conflict: rows[0].digest !== quote.digest };
      }
      for (const [position, photo] of quote.photos.entries()) {
        await client.query('INSERT INTO quote_photos(request_id, position, name, mime, bytes) VALUES($1,$2,$3,$4,$5)',
          [quote.requestId, position, photo.name, photo.type, photo.bytes]);
      }
      await client.query('COMMIT');
      return { quote: quoteRow(inserted.rows[0]), duplicate: false, conflict: false };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async get(requestId) {
    return quoteRow((await this.pool.query('SELECT * FROM quotes WHERE request_id=$1', [requestId])).rows[0]);
  }

  async photos(requestId) {
    return (await this.pool.query('SELECT position,name,mime,bytes FROM quote_photos WHERE request_id=$1 ORDER BY position', [requestId]))
      .rows.map(row => ({ position: row.position, name: row.name, type: row.mime, bytes: Buffer.from(row.bytes) }));
  }

  async recent(limit = 100) {
    return (await this.pool.query('SELECT * FROM quotes ORDER BY created_at DESC LIMIT $1', [limit])).rows.map(quoteRow);
  }

  async claimNotifications(now, limit = 5) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(`SELECT * FROM quotes
        WHERE notification_status IN ('pending', 'retry', 'sending') AND next_attempt_at <= $1
        ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED`, [now, limit]);
      for (const row of rows) {
        await client.query(`UPDATE quotes SET notification_status='sending', notification_attempts=notification_attempts+1,
          next_attempt_at=$1 WHERE request_id=$2`, [now + 120_000, row.request_id]);
      }
      await client.query('COMMIT');
      return rows.map(row => quoteRow({ ...row, notification_status: 'sending', notification_attempts: row.notification_attempts + 1 }));
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async finishNotification(requestId, status, nextAttemptAt, errorCode = null) {
    await this.pool.query('UPDATE quotes SET notification_status=$1,next_attempt_at=$2,notification_error=$3 WHERE request_id=$4',
      [status, nextAttemptAt, errorCode, requestId]);
  }

  async ping() { await this.pool.query('SELECT 1'); }
  async close() { await this.pool.end(); }
}
