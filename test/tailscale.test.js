'use strict';

const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const tailscale = require('../src/tailscale');
const server = require('../src/server');
const config = require('../src/config');

test('isTailscaleIp: 100.64.0.0/10 만 통과한다', () => {
  // 대역 안
  assert.ok(tailscale.isTailscaleIp('100.64.0.1'));
  assert.ok(tailscale.isTailscaleIp('100.100.50.7'));
  assert.ok(tailscale.isTailscaleIp('100.127.255.255'));

  // 경계 바깥 — 여기가 틀리면 tailnet 아닌 기기가 들어온다
  assert.ok(!tailscale.isTailscaleIp('100.63.255.255'));
  assert.ok(!tailscale.isTailscaleIp('100.128.0.0'));

  // 완전히 다른 대역
  assert.ok(!tailscale.isTailscaleIp('192.168.0.5'));
  assert.ok(!tailscale.isTailscaleIp('10.0.2.2'));
  assert.ok(!tailscale.isTailscaleIp('127.0.0.1'));

  // 쓰레기 입력
  assert.ok(!tailscale.isTailscaleIp(''));
  assert.ok(!tailscale.isTailscaleIp('100.64.0'));
  assert.ok(!tailscale.isTailscaleIp('100.64.0.256'));
  assert.ok(!tailscale.isTailscaleIp(null));
  assert.ok(!tailscale.isTailscaleIp('100.abc.0.1'));
});

test('isTailscaleIp: IPv4-mapped IPv6 도 인식한다', () => {
  // ws 클라이언트가 ::ffff:100.x 형태로 붙는 경우가 실제로 있다
  assert.ok(tailscale.isTailscaleIp('::ffff:100.100.1.1'));
  assert.ok(!tailscale.isTailscaleIp('::ffff:192.168.0.1'));
});

test('findTailscaleAddress: 인터페이스 이름이 아니라 주소 대역으로 찾는다', () => {
  // 안드로이드 Tailscale 은 VpnService 라 tun0 으로 보이는 경우가 흔하다
  const interfaces = {
    lo: [{ family: 'IPv4', address: '127.0.0.1' }],
    wlan0: [{ family: 'IPv4', address: '192.168.0.5' }],
    tun0: [{ family: 'IPv4', address: '100.101.102.103' }],
  };

  assert.deepEqual(tailscale.findTailscaleAddress(interfaces), {
    address: '100.101.102.103',
    iface: 'tun0',
  });
});

test('findTailscaleAddress: 없으면 null', () => {
  assert.equal(
    tailscale.findTailscaleAddress({ wlan0: [{ family: 'IPv4', address: '192.168.0.5' }] }),
    null,
  );
});

test('resolveBindHost: tailscale 주소를 못 찾으면 조용히 넘어가지 않고 실패한다', () => {
  const noTailscale = { wlan0: [{ family: 'IPv4', address: '192.168.0.5' }] };

  // 여기서 0.0.0.0 으로 물러서면 "잠갔다고 믿는데 실제로는 열려 있는" 상태가 된다
  assert.throws(
    () => tailscale.resolveBindHost('tailscale', noTailscale),
    /Tailscale 주소/,
  );
});

test('resolveBindHost: 일반 주소는 그대로 통과', () => {
  assert.deepEqual(tailscale.resolveBindHost('0.0.0.0', {}), {
    host: '0.0.0.0',
    iface: null,
    tailscaleOnly: false,
  });
});

test('resolveBindHost: tailscale 주소를 찾으면 거기에만 묶는다', () => {
  const interfaces = { tailscale0: [{ family: 'IPv4', address: '100.90.80.70' }] };

  assert.deepEqual(tailscale.resolveBindHost('tailscale', interfaces), {
    host: '100.90.80.70',
    iface: 'tailscale0',
    tailscaleOnly: true,
  });
});

test('HUB_REQUIRE_TAILSCALE: tailnet 밖 주소는 접속이 끊긴다', async (t) => {
  const hub = await server.start({
    host: '127.0.0.1',
    port: 0,
    dbFile: ':memory:',
    requireTailscale: true,
    log: () => {},
  });
  t.after(() => hub.close());

  // 'open' 을 기다렸다가 프레임을 받는 방식은 쓰지 않는다.
  // 서버가 즉시 끊기 때문에 'open' 을 놓치고 영원히 기다리는 경주가 생긴다.
  const ws = new WebSocket(`ws://127.0.0.1:${hub.port}${config.wsPath}`);

  let frame = null;
  ws.on('message', (d) => {
    frame = JSON.parse(d.toString());
  });

  const closed = await new Promise((resolve) => {
    ws.once('close', (code) => resolve({ code }));
    ws.once('error', (err) => resolve({ error: err.message }));
  });

  assert.ok(closed.code !== undefined || closed.error, `연결이 끊겨야 한다: ${JSON.stringify(closed)}`);
  if (frame) {
    assert.equal(frame.t, 'error');
    assert.equal(frame.code, 'AUTH_FAILED');
  }
  assert.equal(hub.conns.size, 0, '등록조차 되지 않아야 한다');
});
