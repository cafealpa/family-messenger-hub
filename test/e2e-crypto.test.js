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
const { readableRatio } = require('../scripts/verify-no-plaintext');

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

    // 균일 난수라면 UTF-8 로 읽을 수 있는 비율이 낮아야 한다
    assert.ok(readableRatio(ct) < 0.5, `암호문이 너무 읽을 만하다: ${readableRatio(ct)}`);
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

test('readableRatio: 평문은 높고 난수는 낮다', () => {
  assert.ok(readableRatio(Buffer.from('저녁 뭐 먹어?', 'utf8')) > 0.9);
  assert.ok(readableRatio(Buffer.from('hello family', 'utf8')) > 0.9);

  const random = require('crypto').randomBytes(256);
  assert.ok(readableRatio(random) < 0.6, '난수가 읽을 만하게 나오면 기준이 잘못된 것');
});
