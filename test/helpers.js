'use strict';

const server = require('../src/server');
const config = require('../src/config');
const { DummyClient } = require('../scripts/dummy-client');
const { enroll } = require('../scripts/enroll');

/**
 * 테스트마다 격리된 인메모리 허브를 띄운다.
 * @param {import('node:test').TestContext} t
 */
async function startHub(t) {
  const hub = await server.start({
    host: '127.0.0.1',
    port: 0,
    dbFile: ':memory:',
    log: () => {},
  });
  t.after(() => hub.close());

  hub.url = `ws://127.0.0.1:${hub.port}${config.wsPath}`;
  hub.queueSize = () => hub.database.prepare('SELECT COUNT(*) AS n FROM outbox').get().n;
  hub.queueFor = (deviceId) =>
    hub.database.prepare('SELECT COUNT(*) AS n FROM outbox WHERE recipient_id = ?').get(deviceId).n;

  return hub;
}

/**
 * 더미 클라이언트를 만들고 **허브에 등록까지** 한다.
 * Phase 4 부터는 등록되지 않은 기기가 접속하면 UNKNOWN_DEVICE 로 끊긴다.
 *
 * @param {import('node:test').TestContext} t
 */
function makeClient(t, hub, deviceId, opts = {}) {
  const client = new DummyClient({ deviceId, url: hub.url, ...opts });
  t.after(() => client.close());
  if (opts.enroll !== false) enroll(hub.database, client.enrollment());
  return client;
}

/** 등록 + 접속까지 마친 클라이언트. */
async function connectClient(t, hub, deviceId, opts = {}) {
  const client = makeClient(t, hub, deviceId, opts);
  await client.connect();
  return client;
}

module.exports = { startHub, makeClient, connectClient };
