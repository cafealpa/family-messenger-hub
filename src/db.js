'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

/**
 * SQLite 래퍼.
 *
 * **Node 내장 `node:sqlite` 를 쓴다.** 예전에는 better-sqlite3 를 썼는데,
 * 그건 네이티브 모듈이라 허브 폰(Termux)에서 설치가 되지 않았다.
 * 동봉된 미리 빌드 바이너리는 glibc 와 musl 용뿐인데 Termux 는 Bionic libc 를 쓰고,
 * 소스 빌드를 하려면 폰에 컴파일 도구 일습을 깔아야 했다.
 * 내장 모듈로 바꾸면서 허브의 네이티브 의존성이 0이 됐다 —
 * 이제 `npm install` 이 순수 JS 패키지 두 개(ws, ulid)만 받는다.
 *
 * 불변 규칙: 이 파일에 평문 본문을 저장하는 컬럼을 추가하지 않는다.
 * outbox 에 들어가는 것은 ciphertext / nonce 뿐이다.
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
 * @returns {import('node:sqlite').DatabaseSync}
 */
function open(file = config.dbFile) {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  const db = new DatabaseSync(file);

  // WAL 이라야 허브가 도는 중에도 verify-no-plaintext.js 가 같은 DB 를 읽을 수 있다.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

/**
 * 여러 문장을 한 트랜잭션으로 묶는다.
 *
 * better-sqlite3 의 `db.transaction(fn)()` 을 대신한다. node:sqlite 에는
 * 해당 헬퍼가 없어서 BEGIN/COMMIT/ROLLBACK 을 직접 다룬다.
 * 중첩은 지원하지 않는다 — 이 프로젝트에서 쓸 일이 없다.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {() => T} fn
 * @returns {T}
 * @template T
 */
function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    // 롤백 자체가 실패해도 원래 예외를 덮지 않는다. 그게 진짜 원인이다.
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 이미 롤백된 상태일 수 있다 */
    }
    throw err;
  }
}

/**
 * 운영 로그 기록. detail 에 메시지 내용을 넣지 말 것.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} kind connect|disconnect|send|ack|error|...
 * @param {string|null} deviceId
 * @param {string|null} detail
 */
function logEvent(db, kind, deviceId = null, detail = null) {
  db.prepare('INSERT INTO events (at, device_id, kind, detail) VALUES (?, ?, ?, ?)')
    .run(Date.now(), deviceId, kind, detail);
}

module.exports = { open, transaction, logEvent, SCHEMA };
