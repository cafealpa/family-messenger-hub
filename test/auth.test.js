'use strict';

const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const nacl = require('tweetnacl');
const auth = require('../src/auth');
const db = require('../src/db');
const config = require('../src/config');
const { enroll } = require('../scripts/enroll');
const { startHub, makeClient, connectClient } = require('./helpers');

const b64 = (bytes) => Buffer.from(bytes).toString('base64');

/** hello 를 보내고 challenge 를 받는 저수준 헬퍼. */
function openRaw(hub) {
  const ws = new WebSocket(hub.url);
  const frames = [];
  const waiters = [];

  ws.on('message', (d) => {
    const frame = JSON.parse(d.toString());
    // 기다리는 쪽이 있으면 바로 넘기고 큐에는 넣지 않는다.
    // 둘 다 하면 같은 프레임을 두 번 소비하게 되어 다음 next() 가 옛 프레임을 돌려준다.
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else frames.push(frame);
  });

  return {
    ws,
    frames,
    open: () => new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    }),
    next: (timeoutMs = 3000) => new Promise((resolve, reject) => {
      if (frames.length) return resolve(frames.shift());
      const timer = setTimeout(() => reject(new Error('timeout waiting for frame')), timeoutMs);
      waiters.push((f) => {
        clearTimeout(timer);
        resolve(f);
      });
    }),
    send: (obj) => ws.send(JSON.stringify(obj)),
    closed: () => new Promise((resolve) => ws.once('close', resolve)),
  };
}

test('등록된 기기는 챌린지-응답으로 접속한다', async (t) => {
  const hub = await startHub(t);
  const dad = await connectClient(t, hub, 'dev_dad', { name: '아빠' });

  assert.ok(dad.ready);
  assert.equal(hub.conns.size, 1);
});

test('미등록 기기는 UNKNOWN_DEVICE 로 끊긴다', async (t) => {
  const hub = await startHub(t);
  const stranger = makeClient(t, hub, 'dev_stranger', { name: '낯선이', enroll: false });

  await assert.rejects(stranger.connect(), /UNKNOWN_DEVICE/);
  assert.equal(hub.conns.size, 0);

  // challenge 조차 주지 않는다 — 등록 여부를 확인하는 비용도 아낀다
  assert.equal(hub.database.prepare('SELECT COUNT(*) AS n FROM devices').get().n, 0);
});

test('서명이 틀리면 AUTH_FAILED', async (t) => {
  const hub = await startHub(t);
  const real = makeClient(t, hub, 'dev_dad', { name: '아빠' });

  const raw = openRaw(hub);
  t.after(() => raw.ws.close());
  await raw.open();

  raw.send({ t: 'hello', deviceId: 'dev_dad', protocolVersion: 1 });
  const challenge = await raw.next();
  assert.equal(challenge.t, 'challenge');

  // 엉뚱한 바이트에 서명한다
  const wrong = nacl.sign.detached(Buffer.from('완전히 다른 메시지'), real.signKeys.secretKey);
  raw.send({ t: 'auth', sig: b64(wrong) });

  const err = await raw.next();
  assert.equal(err.code, 'AUTH_FAILED');
  await raw.closed();
  assert.equal(hub.conns.size, 0);
});

test('다른 사람의 키로 서명하면 AUTH_FAILED', async (t) => {
  const hub = await startHub(t);
  makeClient(t, hub, 'dev_dad', { name: '아빠' });
  const impostor = nacl.sign.keyPair();

  const raw = openRaw(hub);
  t.after(() => raw.ws.close());
  await raw.open();

  raw.send({ t: 'hello', deviceId: 'dev_dad', protocolVersion: 1 });
  const challenge = await raw.next();

  // nonce 자체는 올바르게 서명했지만 등록된 키가 아니다
  const nonce = Buffer.from(challenge.nonce, 'base64');
  raw.send({ t: 'auth', sig: b64(nacl.sign.detached(nonce, impostor.secretKey)) });

  assert.equal((await raw.next()).code, 'AUTH_FAILED');
});

test('nonce 는 1회용이다 — 같은 서명을 다시 쓸 수 없다', async (t) => {
  const hub = await startHub(t);
  const dad = makeClient(t, hub, 'dev_dad', { name: '아빠' });

  // 1) 정상 인증해서 nonce 와 서명을 얻는다
  const first = openRaw(hub);
  t.after(() => first.ws.close());
  await first.open();
  first.send({ t: 'hello', deviceId: 'dev_dad', protocolVersion: 1 });
  const challenge = await first.next();
  const nonce = Buffer.from(challenge.nonce, 'base64');
  const sig = b64(nacl.sign.detached(nonce, dad.signKeys.secretKey));
  first.send({ t: 'auth', sig });
  assert.equal((await first.next()).t, 'welcome');

  // 2) 새 연결에서 **같은 서명**을 재사용한다 (녹취-재생 공격)
  const replay = openRaw(hub);
  t.after(() => replay.ws.close());
  await replay.open();
  replay.send({ t: 'hello', deviceId: 'dev_dad', protocolVersion: 1 });
  const fresh = await replay.next();
  assert.notEqual(fresh.nonce, challenge.nonce, '연결마다 새 nonce 를 줘야 한다');

  replay.send({ t: 'auth', sig });
  assert.equal((await replay.next()).code, 'AUTH_FAILED');
});

test('hello 없이 auth 를 보내면 거절한다', async (t) => {
  const hub = await startHub(t);

  const raw = openRaw(hub);
  t.after(() => raw.ws.close());
  await raw.open();

  raw.send({ t: 'auth', sig: b64(new Uint8Array(64)) });
  assert.equal((await raw.next()).code, 'AUTH_FAILED');
});

test('verifyChallenge: 만료된 nonce 는 거절한다', () => {
  const database = db.open(':memory:');
  try {
    const keys = nacl.sign.keyPair();
    const box = nacl.box.keyPair();
    enroll(database, {
      deviceId: 'dev_dad',
      name: '아빠',
      signPub: b64(keys.publicKey),
      boxPub: b64(box.publicKey),
    });

    const nonce = Buffer.from(nacl.randomBytes(32));
    const sig = b64(nacl.sign.detached(nonce, keys.secretKey));

    // 방금 발급된 nonce → 통과
    assert.deepEqual(
      auth.verifyChallenge(database, 'dev_dad', { sig }, nonce, Date.now()),
      { ok: true },
    );

    // TTL 을 넘긴 nonce → 거절
    const stale = auth.verifyChallenge(
      database,
      'dev_dad',
      { sig },
      nonce,
      Date.now() - auth.NONCE_TTL_MS - 1,
    );
    assert.equal(stale.ok, false);
    assert.equal(stale.code, 'AUTH_FAILED');
    assert.match(stale.msg, /expired/);
  } finally {
    database.close();
  }
});

test('verifyChallenge: 길이가 틀린 서명은 거절한다', () => {
  const database = db.open(':memory:');
  try {
    const keys = nacl.sign.keyPair();
    enroll(database, {
      deviceId: 'dev_dad',
      name: '아빠',
      signPub: b64(keys.publicKey),
      boxPub: b64(nacl.box.keyPair().publicKey),
    });

    const nonce = Buffer.from(nacl.randomBytes(32));
    for (const bad of ['', 'AAAA', b64(new Uint8Array(63)), b64(new Uint8Array(65))]) {
      const result = auth.verifyChallenge(database, 'dev_dad', { sig: bad }, nonce, Date.now());
      assert.equal(result.ok, false, `이 서명은 거절돼야 한다: ${bad.slice(0, 8)}`);
    }
  } finally {
    database.close();
  }
});

test('enroll: 32바이트가 아닌 공개키는 거부한다', () => {
  const database = db.open(':memory:');
  try {
    assert.throws(
      () => enroll(database, {
        deviceId: 'dev_dad',
        name: '아빠',
        signPub: b64(new Uint8Array(16)),
        boxPub: b64(new Uint8Array(32)),
      }),
      /signPub/,
    );
    assert.throws(
      () => enroll(database, { deviceId: 'x', name: '아빠', signPub: b64(new Uint8Array(32)), boxPub: b64(new Uint8Array(32)) }),
      /deviceId/,
    );
  } finally {
    database.close();
  }
});

test('enroll: 재등록하면 키를 덮어쓰고 rekeyed 를 알린다', () => {
  const database = db.open(':memory:');
  try {
    const first = { deviceId: 'dev_dad', name: '아빠', signPub: b64(nacl.sign.keyPair().publicKey), boxPub: b64(nacl.box.keyPair().publicKey) };
    assert.equal(enroll(database, first).action, 'enrolled');
    assert.equal(enroll(database, first).action, 'updated');

    const rekeyed = { ...first, signPub: b64(nacl.sign.keyPair().publicKey) };
    assert.equal(enroll(database, rekeyed).action, 'rekeyed', '앱 재설치를 눈에 띄게 알려야 한다');
  } finally {
    database.close();
  }
});

test('protocolVersion 검사는 등록 여부보다 먼저 한다', async (t) => {
  const hub = await startHub(t);

  const raw = openRaw(hub);
  t.after(() => raw.ws.close());
  await raw.open();

  raw.send({ t: 'hello', deviceId: 'dev_future', protocolVersion: 99 });
  assert.equal((await raw.next()).code, 'UNSUPPORTED_VERSION');
});
