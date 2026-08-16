'use strict';

const db = require('./db');

/**
 * 메시지 라우팅 / 큐잉.
 *
 * 핵심 규칙 (PROTOCOL.md §6):
 *   허브는 ack 를 받기 전까지 outbox 행을 지우지 않는다.
 *   그래서 중복 배달이 생기는데, 그건 정상이고 클라이언트가 msgId 로 걸러낸다.
 */

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;          // Crockford Base32, 26자
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const MAX_PAYLOADS = 64;
const MAX_ACK_IDS = 500;
const SEND_LIMIT = 60;                                // 기기당 분당 send 프레임
const SEND_WINDOW_MS = 60_000;

/**
 * 인증을 마친 연결에서 올라온 프레임을 처리한다.
 * @param {object} hub { db, conns, send, log }
 * @param {object} conn
 * @param {object} frame
 */
function handle(hub, conn, frame) {
  switch (frame.t) {
    case 'send':
      return handleSend(hub, conn, frame);
    case 'ack':
      return handleAck(hub, conn, frame);
    case 'ping':
      return hub.send(conn, { t: 'pong', ts: frame.ts, serverTime: Date.now() });
    case 'hello':
      return hub.send(conn, { t: 'error', code: 'BAD_REQUEST', msg: 'already authenticated' });
    default:
      return hub.send(conn, {
        t: 'error',
        code: 'BAD_REQUEST',
        msg: `unknown type: ${String(frame.t)}`,
      });
  }
}

// ---------------------------------------------------------------- send

/** @returns {string|null} 문제가 있으면 사유, 없으면 null */
function validateSend(frame) {
  if (typeof frame.msgId !== 'string' || !ULID_RE.test(frame.msgId)) {
    return 'msgId must be a 26-char ULID';
  }
  if (!Number.isFinite(frame.sentAt)) {
    return 'sentAt must be a number (epoch ms)';
  }
  if (!Array.isArray(frame.payloads) || frame.payloads.length === 0) {
    return 'payloads must be a non-empty array';
  }
  if (frame.payloads.length > MAX_PAYLOADS) {
    return `payloads must hold at most ${MAX_PAYLOADS} entries`;
  }
  for (const p of frame.payloads) {
    if (p === null || typeof p !== 'object') return 'each payload must be an object';
    if (typeof p.to !== 'string' || p.to.length === 0) return 'payload.to must be a device id';
    if (typeof p.ct !== 'string' || !BASE64_RE.test(p.ct)) return 'payload.ct must be base64';
    if (typeof p.nonce !== 'string' || !BASE64_RE.test(p.nonce)) return 'payload.nonce must be base64';
  }
  return null;
}

/** 슬라이딩 윈도우 레이트 제한. 앱의 재전송 루프 폭주로부터 허브 저장소를 지킨다. */
function withinRateLimit(conn) {
  const now = Date.now();
  conn.sendTimes = (conn.sendTimes || []).filter((t) => now - t < SEND_WINDOW_MS);
  if (conn.sendTimes.length >= SEND_LIMIT) return false;
  conn.sendTimes.push(now);
  return true;
}

function handleSend(hub, conn, frame) {
  const problem = validateSend(frame);
  if (problem) {
    return hub.send(conn, { t: 'error', code: 'BAD_REQUEST', msg: problem });
  }
  if (!withinRateLimit(conn)) {
    db.logEvent(hub.db, 'error', conn.deviceId, 'RATE_LIMITED');
    return hub.send(conn, {
      t: 'error',
      code: 'RATE_LIMITED',
      msg: `at most ${SEND_LIMIT} send frames per minute`,
    });
  }

  const recvAt = Date.now();
  const known = hub.db.prepare('SELECT 1 FROM devices WHERE device_id = ?');
  const insert = hub.db.prepare(
    `INSERT OR IGNORE INTO outbox
       (msg_id, recipient_id, sender_id, ciphertext, nonce, sent_at, recv_at, delivered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  );

  const accepted = [];
  const dropped = [];

  hub.db.transaction(() => {
    for (const p of frame.payloads) {
      // 자기 자신에게는 보내지 않는다. 발신자는 평문을 로컬에 갖고 있다.
      if (p.to === conn.deviceId) continue;
      // 등록되지 않은 기기 앞으로 온 payload 는 버린다. 큐에 넣어봐야 영원히 안 빠진다.
      if (!known.get(p.to)) {
        dropped.push(p.to);
        continue;
      }
      insert.run(
        frame.msgId,
        p.to,
        conn.deviceId,
        Buffer.from(p.ct, 'base64'),
        Buffer.from(p.nonce, 'base64'),
        frame.sentAt,
        recvAt,
      );
      accepted.push(p.to);
    }
  })();

  // detail 에 본문을 남기지 않는다 (CLAUDE.md 불변 규칙 1).
  db.logEvent(
    hub.db,
    'send',
    conn.deviceId,
    `${frame.msgId} accepted=${accepted.length} dropped=${dropped.length}`,
  );
  if (dropped.length) {
    hub.log(`send ${frame.msgId}: dropped payloads for unknown devices: ${dropped.join(', ')}`);
  }

  hub.send(conn, { t: 'sent', msgId: frame.msgId, recvAt });

  // 접속해 있는 수신자에게 즉시 밀어준다. 나머지는 outbox 에 남아 재접속 때 나간다.
  for (const to of new Set(accepted)) {
    const target = hub.conns.get(to);
    if (target) deliverPending(hub, target, { onlyNew: true });
  }
}

// ---------------------------------------------------------------- deliver

/**
 * 수신자 큐를 소켓으로 흘려보낸다.
 *
 * @param {object} hub
 * @param {object} conn 수신자 연결
 * @param {object} [opts]
 * @param {boolean} [opts.onlyNew] true 면 아직 한 번도 안 내보낸 것만.
 *   재접속 직후에는 false 로 불러서, 배달됐지만 ack 안 된 것까지 전부 다시 보낸다.
 * @returns {number} 내보낸 개수
 */
function deliverPending(hub, conn, opts = {}) {
  const sql = opts.onlyNew
    ? `SELECT * FROM outbox WHERE recipient_id = ? AND delivered_at IS NULL ORDER BY recv_at, msg_id`
    : `SELECT * FROM outbox WHERE recipient_id = ? ORDER BY recv_at, msg_id`;

  const rows = hub.db.prepare(sql).all(conn.deviceId);
  if (rows.length === 0) return 0;

  const markDelivered = hub.db.prepare('UPDATE outbox SET delivered_at = ? WHERE msg_id = ? AND recipient_id = ?');
  const now = Date.now();

  for (const row of rows) {
    hub.send(conn, {
      t: 'deliver',
      msgId: row.msg_id,
      from: row.sender_id,
      sentAt: row.sent_at,
      recvAt: row.recv_at,
      ct: Buffer.from(row.ciphertext).toString('base64'),
      nonce: Buffer.from(row.nonce).toString('base64'),
    });
    markDelivered.run(now, row.msg_id, conn.deviceId);
  }

  return rows.length;
}

// ---------------------------------------------------------------- ack

function handleAck(hub, conn, frame) {
  if (!Array.isArray(frame.msgIds) || frame.msgIds.length === 0) {
    return hub.send(conn, { t: 'error', code: 'BAD_REQUEST', msg: 'msgIds must be a non-empty array' });
  }
  if (frame.msgIds.length > MAX_ACK_IDS) {
    return hub.send(conn, { t: 'error', code: 'BAD_REQUEST', msg: `at most ${MAX_ACK_IDS} msgIds per ack` });
  }
  if (frame.msgIds.some((id) => typeof id !== 'string' || !ULID_RE.test(id))) {
    return hub.send(conn, { t: 'error', code: 'BAD_REQUEST', msg: 'every msgId must be a 26-char ULID' });
  }

  const lookup = hub.db.prepare('SELECT sender_id FROM outbox WHERE msg_id = ? AND recipient_id = ?');
  const remove = hub.db.prepare('DELETE FROM outbox WHERE msg_id = ? AND recipient_id = ?');

  /** @type {Array<{msgId: string, senderId: string}>} */
  const removed = [];

  hub.db.transaction(() => {
    for (const msgId of frame.msgIds) {
      const row = lookup.get(msgId, conn.deviceId);
      if (!row) continue; // 이미 지워졌다. 중복 ack 는 무해하다.
      remove.run(msgId, conn.deviceId);
      removed.push({ msgId, senderId: row.sender_id });
    }
  })();

  db.logEvent(hub.db, 'ack', conn.deviceId, `${removed.length}/${frame.msgIds.length}`);

  // 영수증은 best-effort. 발신자가 오프라인이면 그냥 버린다 (PROTOCOL.md §5).
  const at = Date.now();
  for (const { msgId, senderId } of removed) {
    const sender = hub.conns.get(senderId);
    if (sender) hub.send(sender, { t: 'receipt', msgId, by: conn.deviceId, at });
  }
}

// ---------------------------------------------------------------- presence

/** 자기 자신을 제외한 접속 중인 모든 기기에 상태 변화를 알린다. */
function broadcastPresence(hub, deviceId, online) {
  const frame = { t: 'presence', deviceId, online, at: Date.now() };
  for (const [id, other] of hub.conns) {
    if (id === deviceId) continue;
    hub.send(other, frame);
  }
}

module.exports = { handle, deliverPending, broadcastPresence, validateSend, ULID_RE };
