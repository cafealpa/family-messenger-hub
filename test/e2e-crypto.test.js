'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const config = require('../src/config');
const server = require('../src/server');
const { DummyClient } = require('../scripts/dummy-client');
const { enroll } = require('../scripts/enroll');
const { readableRatio, looksLikePlaintext, longestPrintableRun } = require('../scripts/verify-no-plaintext');

const SECRET = '엄마 몰래 케이크 사왔어';

/** 파일 기반 허브. verify-no-plaintext.js 가 실제 파일을 훑어야 하므로 인메모리를 쓸 수 없다. */
async function startFileHub(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'famhub-'));
  const dbFile = path.join(dir, 'hub.sqlite');

  const hub = await server.start({ host: '127.0.0.1', port: 0, dbFile, log: () => {} });
  t.after(() => {
    hub.close().then(() => fs.rmSync(dir, { recursive: true, force: true })).catch(() => {});
  });

  hub.url = `ws://127.0.0.1:${hub.port}${config.wsPath}`;
  hub.dbFile = dbFile;
  return hub;
}

function makeClient(t, hub, deviceId, name, opts = {}) {
  const client = new DummyClient({ deviceId, name, url: hub.url, ...opts });
  t.after(() => client.close());
  enroll(hub.database, client.enrollment());
  return client;
}

test('E2E: 본문은 왕복하지만 허브는 읽지 못한다', async (t) => {
  const hub = await startFileHub(t);

  const mom = makeClient(t, hub, 'dev_mom', '엄마', { autoAck: false });
  await mom.connect();
  const dad = makeClient(t, hub, 'dev_dad', '아빠');
  await dad.connect();

  const msgId = dad.sendText(SECRET);
  const [received] = await mom.waitForMessages(1);

  await t.test('수신자는 평문을 복원한다', () => {
    assert.equal(received.msgId, msgId);
    assert.equal(received.body, SECRET);
  });

  await t.test('허브 outbox 에는 평문이 없다', () => {
    const row = hub.database
      .prepare('SELECT ciphertext, nonce FROM outbox WHERE msg_id = ?')
      .get(msgId);

    assert.ok(row, 'ack 전이므로 행이 남아 있어야 한다');

    const ct = Buffer.from(row.ciphertext);
    const plain = Buffer.from(SECRET, 'utf8');

    assert.ok(!ct.includes(plain), '암호문에 평문이 그대로 들어 있다');
    assert.ok(!ct.toString('utf8').includes(SECRET));
    assert.ok(!ct.toString('base64').includes(plain.toString('base64')));

    // crypto_box 는 16바이트 Poly1305 MAC 을 덧붙인다
    assert.equal(ct.length, plain.length + 16);
    assert.equal(Buffer.from(row.nonce).length, 24);

    // 판정은 비율이 아니라 "유효한 UTF-8 인가 + 긴 ASCII 구간이 있는가" 로 한다.
    // 비율은 짧은 암호문에서 우연히 튀어 오탐을 낸다.
    assert.equal(looksLikePlaintext(ct).suspicious, false, JSON.stringify(looksLikePlaintext(ct)));
  });

  await t.test('수신자마다 nonce 가 다르다', async () => {
    const bro = makeClient(t, hub, 'dev_bro', '형');
    await bro.connect();
    // 형이 새로 등록됐으므로 아빠는 갱신된 welcome 을 받는다
    await dad.waitFor('welcome');

    const multiId = dad.sendText('둘 다에게');
    await dad.waitFor('sent');

    const rows = hub.database
      .prepare('SELECT recipient_id, ciphertext, nonce FROM outbox WHERE msg_id = ?')
      .all(multiId);

    assert.equal(rows.length, 2);
    const nonces = rows.map((r) => Buffer.from(r.nonce).toString('hex'));
    assert.notEqual(nonces[0], nonces[1], 'nonce 재사용은 치명적이다');

    const ciphertexts = rows.map((r) => Buffer.from(r.ciphertext).toString('hex'));
    assert.notEqual(ciphertexts[0], ciphertexts[1], '수신자별로 따로 암호화해야 한다');
  });

  await t.test('verify-no-plaintext.js 가 통과한다', () => {
    // 실제 배포 스크립트를 그대로 돌린다. 이게 Phase 4 완료 기준의 증거다.
    const output = execFileSync(
      process.execPath,
      [path.join(__dirname, '..', 'scripts', 'verify-no-plaintext.js'), '--expect', SECRET],
      { env: { ...process.env, HUB_DB: hub.dbFile }, encoding: 'utf8' },
    );
    assert.match(output, /읽을 수 없습니다/);
  });
});

test('verify-no-plaintext.js: 평문이 들어 있으면 실패로 잡아낸다', async (t) => {
  const hub = await startFileHub(t);

  // 암호화하지 않은 본문을 일부러 넣는다. 검사기가 이걸 놓치면 검사기가 쓸모없다.
  hub.database
    .prepare(
      `INSERT INTO outbox (msg_id, recipient_id, sender_id, ciphertext, nonce, sent_at, recv_at)
       VALUES ('01J8XK000000000000000000AB', 'dev_mom', 'dev_dad', ?, ?, 1, 2)`,
    )
    .run(Buffer.from(SECRET, 'utf8'), Buffer.alloc(24));

  assert.throws(
    () => execFileSync(
      process.execPath,
      [path.join(__dirname, '..', 'scripts', 'verify-no-plaintext.js'), '--expect', SECRET],
      { env: { ...process.env, HUB_DB: hub.dbFile }, encoding: 'utf8', stdio: 'pipe' },
    ),
    (err) => err.status === 1,
  );
});

test('looksLikePlaintext: 평문은 잡고 난수는 통과시킨다', () => {
  // 평문 — 반드시 잡혀야 한다
  for (const text of ['저녁 뭐 먹어?', 'hello family, see you at home', '{"body":"내용"}']) {
    const buf = Buffer.from(text, 'utf8');
    assert.equal(looksLikePlaintext(buf).suspicious, true, `평문을 놓쳤다: ${text}`);
  }

  // 평문의 base64 (Phase 1 방식) 도 잡아야 한다
  const b64 = Buffer.from(Buffer.from('저녁 뭐 먹어?').toString('base64'), 'utf8');
  assert.equal(looksLikePlaintext(b64).suspicious, true);

  // 난수 앞뒤에 평문 조각이 박힌 경우
  const embedded = Buffer.concat([
    require('crypto').randomBytes(20),
    Buffer.from('secret-password-here', 'utf8'),
    require('crypto').randomBytes(20),
  ]);
  assert.equal(looksLikePlaintext(embedded).suspicious, true, '박혀 있는 평문을 놓쳤다');
});

test('looksLikePlaintext: 짧은 암호문에서 오탐이 나지 않는다', () => {
  // 실패했던 사례가 55바이트짜리 암호문이었다. 비율 기반 판정은 여기서 종종 튀었다.
  // 길이를 바꿔 가며 넉넉히 돌려 오탐이 하나도 없어야 한다.
  const crypto = require('crypto');
  let falsePositives = 0;

  for (let length = 16; length <= 120; length += 1) {
    for (let i = 0; i < 40; i += 1) {
      if (looksLikePlaintext(crypto.randomBytes(length)).suspicious) falsePositives += 1;
    }
  }

  assert.equal(falsePositives, 0, `난수 ${falsePositives}건을 평문으로 잘못 신고했다`);
});

test('longestPrintableRun', () => {
  assert.equal(longestPrintableRun(Buffer.from('abc', 'utf8')), 3);
  assert.equal(longestPrintableRun(Buffer.from([0x41, 0x00, 0x42, 0x43])), 2);
  assert.equal(longestPrintableRun(Buffer.alloc(50)), 0);
});

test('readableRatio 는 진단용 지표일 뿐이다', () => {
  // 평문에서는 확실히 높다
  assert.ok(readableRatio(Buffer.from('저녁 뭐 먹어?', 'utf8')) > 0.9);
  // 난수에서는 낮은 편이지만 튈 수 있다 — 그래서 판정 기준으로 쓰지 않는다
  assert.ok(readableRatio(require('crypto').randomBytes(4096)) < 0.9);
});
