'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

/**
 * SQLite 래퍼.
 *
 * 불변 규칙: 이 파일에 평문 본문을 저장하는 컬럼을 추가하지 않는다.
 * outbox 에 들어가는 것은 ciphertext / nonce 뿐이다.
 * (Phase 1 에서는 "암호화하지 않은 바이트"가 ciphertext 자리에 들어가지만,
 *  스키마는 처음부터 최종형을 쓴다. Phase 4 에서 내용물만 진짜 암호문으로 바뀐다.)
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS devices (
  device_id     TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  sign_pub_key  BLOB NOT NULL,
  box_pub_key   BLOB NOT NULL,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER
);

CREATE TABLE IF NOT EXISTS outbox (
  msg_id        TEXT NOT NULL,
  recipient_id  TEXT NOT NULL,
  sender_id     TEXT NOT NULL,
  ciphertext    BLOB NOT NULL,
  nonce         BLOB NOT NULL,
  sent_at       INTEGER NOT NULL,
  recv_at       INTEGER NOT NULL,
  delivered_at  INTEGER,
  PRIMARY KEY (msg_id, recipient_id)
);

CREATE INDEX IF NOT EXISTS idx_outbox_recipient ON outbox(recipient_id, recv_at);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         INTEGER NOT NULL,
  device_id  TEXT,
  kind       TEXT NOT NULL,
  detail     TEXT
);
`;

/**
 * DB 를 열고 스키마를 보장한다.
 * @param {string} [file] 기본값은 config.dbFile. ':memory:' 를 주면 테스트용 인메모리.
 * @returns {import('better-sqlite3').Database}
 */
function open(file = config.dbFile) {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

/**
 * 운영 로그 기록. detail 에 메시지 내용을 넣지 말 것.
 * @param {import('better-sqlite3').Database} db
 * @param {string} kind connect|disconnect|send|ack|error|...
 * @param {string|null} deviceId
 * @param {string|null} detail
 */
function logEvent(db, kind, deviceId = null, detail = null) {
  db.prepare('INSERT INTO events (at, device_id, kind, detail) VALUES (?, ?, ?, ?)')
    .run(Date.now(), deviceId, kind, detail);
}

module.exports = { open, logEvent, SCHEMA };
