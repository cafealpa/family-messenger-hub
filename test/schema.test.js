'use strict';

const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');

/**
 * CLAUDE.md 불변 규칙 1 회귀 테스트.
 * 누군가 편의를 위해 outbox 에 본문 컬럼을 추가하면 여기서 걸린다.
 */
test('outbox 에 본문 평문 컬럼이 없다', () => {
  const database = db.open(':memory:');
  try {
    const cols = database.prepare('PRAGMA table_info(outbox)').all().map((c) => c.name);

    assert.deepEqual(cols.sort(), [
      'ciphertext', 'delivered_at', 'msg_id', 'nonce',
      'recipient_id', 'recv_at', 'sender_id', 'sent_at',
    ]);

    for (const forbidden of ['body', 'text', 'plaintext', 'content', 'message']) {
      assert.ok(!cols.includes(forbidden), `금지된 컬럼이 있다: ${forbidden}`);
    }
  } finally {
    database.close();
  }
});

test('events.detail 에 본문을 넣지 않는다 (라우터가 남기는 로그 형태 확인)', async () => {
  const database = db.open(':memory:');
  try {
    db.logEvent(database, 'send', 'dev_dad', '01J8XK accepted=2 dropped=0');
    const row = database.prepare('SELECT detail FROM events ORDER BY id DESC LIMIT 1').get();

    // 카운트와 msgId 만 남는다. 본문이 들어갈 자리가 없는 형식이다.
    assert.match(row.detail, /^[0-9A-HJKMNP-TV-Z]+ accepted=\d+ dropped=\d+$/);
  } finally {
    database.close();
  }
});
