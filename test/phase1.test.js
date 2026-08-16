'use strict';

const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const { ulid, monotonicFactory } = require('ulid');
const { startHub, connectClient, makeClient } = require('./helpers');

test('핸드셰이크: welcome 과 멤버 목록', async (t) => {
  const hub = await startHub(t);

  const dad = await connectClient(t, hub, 'dev_dad', { name: '아빠' });
  assert.deepEqual(dad.members, [], '첫 접속자는 볼 멤버가 없다');

  const mom = await connectClient(t, hub, 'dev_mom', { name: '엄마' });

  assert.equal(mom.members.length, 1, 'members 에 자기 자신은 없다');
  assert.equal(mom.members[0].deviceId, 'dev_dad');
  assert.equal(mom.members[0].name, '아빠');
  assert.equal(mom.members[0].online, true);
});

test('나중에 합류한 가족을 먼저 접속해 있던 기기도 알게 된다', async (t) => {
  const hub = await startHub(t);

  const dad = await connectClient(t, hub, 'dev_dad', { name: '아빠' });
  assert.deepEqual(dad.members, [], '아직 아무도 없다');

  // 엄마가 새로 등록되면 허브가 아빠에게 welcome 을 다시 보낸다 (PROTOCOL.md §5)
  const refreshed = dad.waitFor('welcome');
  const mom = await connectClient(t, hub, 'dev_mom', { name: '엄마' });
  await refreshed;

  assert.equal(dad.members.length, 1, '멤버 목록이 갱신돼야 한다');
  assert.equal(dad.members[0].deviceId, 'dev_mom');

  // 목록만 갱신되는 게 아니라 실제로 보낼 수 있어야 한다
  dad.sendText('이제 보낼 수 있다');
  const [msg] = await mom.waitForMessages(1);
  assert.equal(msg.body, '이제 보낼 수 있다');
});

test('표시 이름이 바뀌면 다른 기기의 멤버 목록도 갱신된다', async (t) => {
  const hub = await startHub(t);

  const momOld = await connectClient(t, hub, 'dev_mom', { name: '엄마' });
  const dad = await connectClient(t, hub, 'dev_dad', { name: '아빠' });
  assert.equal(dad.members[0].name, '엄마');

  await momOld.close();

  // 같은 기기가 이름만 바꾼 상황이므로 **키는 그대로** 써야 한다.
  // 키까지 새로 만들면 그건 재설치(rekey)지 이름 변경이 아니다.
  const momRenamed = makeClient(t, hub, 'dev_mom', { name: '어머니', keys: momOld.exportKeys() });

  const refreshed = dad.waitFor('welcome');
  await momRenamed.connect();
  await refreshed;

  assert.equal(dad.members[0].name, '어머니');
});

test('허브가 도는 중에 새 기기를 등록해도 접속 중인 가족이 알게 된다', async (t) => {
  const hub = await startHub(t);
  const dad = await connectClient(t, hub, 'dev_dad', { name: '아빠' });
  assert.deepEqual(dad.members, []);

  // enroll.js 로 갓 등록된 기기가 처음 붙는 경우
  const refreshed = dad.waitFor('welcome');
  const bro = await connectClient(t, hub, 'dev_bro', { name: '형' });
  await refreshed;

  assert.equal(dad.members.length, 1);
  assert.equal(dad.members[0].deviceId, 'dev_bro');

  // 공개키까지 받았으므로 실제로 암호화해서 보낼 수 있어야 한다
  dad.sendText('형 안녕');
  const [msg] = await bro.waitForMessages(1);
  assert.equal(msg.body, '형 안녕');
});

test('presence: 접속과 끊김이 다른 기기에 전파된다', async (t) => {
  const hub = await startHub(t);
  const dad = await connectClient(t, hub, 'dev_dad', { name: '아빠' });

  const online = dad.waitFor('presence', { match: (f) => f.deviceId === 'dev_mom' && f.online });
  const mom = await connectClient(t, hub, 'dev_mom', { name: '엄마' });
  await online;

  const offline = dad.waitFor('presence', { match: (f) => f.deviceId === 'dev_mom' && !f.online });
  await mom.close();
  await offline;
});

test('실시간 송수신: 아빠 → 엄마', async (t) => {
  const hub = await startHub(t);
  const mom = await connectClient(t, hub, 'dev_mom', { name: '엄마' });
  const dad = await connectClient(t, hub, 'dev_dad', { name: '아빠' });

  const sentAck = dad.waitFor('sent');
  const receipt = dad.waitFor('receipt');
  const msgId = dad.sendText('저녁 뭐 먹어?');

  assert.equal((await sentAck).msgId, msgId, '허브가 접수를 확인해 준다');

  const [msg] = await mom.waitForMessages(1);
  assert.equal(msg.msgId, msgId);
  assert.equal(msg.from, 'dev_dad');
  assert.equal(msg.body, '저녁 뭐 먹어?');
  assert.ok(msg.recvAt >= msg.sentAt - 1000, 'recvAt 은 허브 시각이다');

  // 엄마가 자동으로 ack 를 보냈으므로 아빠에게 영수증이 돌아온다
  const r = await receipt;
  assert.equal(r.msgId, msgId);
  assert.equal(r.by, 'dev_mom');

  // ack 된 메시지는 허브에서 사라진다 (PROTOCOL.md §6.1)
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(hub.queueSize(), 0, 'ack 후 outbox 가 비어야 한다');
});

test('오프라인 큐잉: 끊긴 사이 온 메시지가 재접속 때 순서대로 도착한다', async (t) => {
  const hub = await startHub(t);

  // 엄마가 한 번 접속했다가 나간다 (비행기 모드에 해당).
  // **같은 클라이언트 객체를 다시 붙인다** — 새로 만들면 키가 바뀌어 복호화가 안 된다.
  const mom = makeClient(t, hub, 'dev_mom', { name: '엄마' });
  await mom.connect();
  await mom.close();

  const dad = await connectClient(t, hub, 'dev_dad', { name: '아빠' });
  assert.equal(dad.members.find((m) => m.deviceId === 'dev_mom').online, false);

  const ids = [];
  for (const text of ['첫째', '둘째', '셋째']) {
    ids.push(dad.sendText(text));
    await dad.waitFor('sent');
  }
  assert.equal(hub.queueFor('dev_mom'), 3, '오프라인 수신자 앞으로 큐가 쌓인다');

  // 비행기 모드 해제
  await mom.connect();
  const msgs = await mom.waitForMessages(3);

  assert.deepEqual(msgs.map((m) => m.body), ['첫째', '둘째', '셋째'], 'recvAt 오름차순으로 온다');
  assert.deepEqual(msgs.map((m) => m.msgId), ids);

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(hub.queueFor('dev_mom'), 0, 'ack 후 큐가 비워진다');
});

test('중복 배달: ack 안 하면 재접속 때 다시 오고, 클라이언트가 걸러낸다', async (t) => {
  const hub = await startHub(t);

  // autoAck=false → 받기만 하고 ack 를 안 보내는 클라이언트
  const mom = await connectClient(t, hub, 'dev_mom', { name: '엄마', autoAck: false });
  const dad = await connectClient(t, hub, 'dev_dad', { name: '아빠' });

  const msgId = dad.sendText('한 번만 보이면 됨');
  await mom.waitForMessages(1);
  assert.equal(mom.deliverFrameCount, 1);
  assert.equal(hub.queueFor('dev_mom'), 1, 'ack 이 없으니 허브는 안 지운다');

  // 끊었다 다시 붙는다. seen/messages 는 유지된다 (앱의 Room DB 에 해당)
  await mom.close();
  await mom.connect();
  await mom.waitForDeliverFrames(2);

  assert.equal(mom.deliverFrameCount, 2, '소켓으로는 두 번 들어왔다');
  assert.equal(mom.messages.length, 1, 'msgId 로 걸러서 화면에는 한 번만 뜬다');
  assert.equal(mom.messages[0].msgId, msgId);

  // 이제 ack 하면 사라진다
  mom.ack([msgId]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(hub.queueFor('dev_mom'), 0);
});

test('같은 msgId 재전송은 큐를 부풀리지 않는다', async (t) => {
  const hub = await startHub(t);
  const momFirst = await connectClient(t, hub, 'dev_mom', { name: '엄마' });
  await momFirst.close();

  const dad = await connectClient(t, hub, 'dev_dad', { name: '아빠' });
  const msgId = ulid();

  dad.sendText('재전송 테스트', { msgId });
  await dad.waitFor('sent');
  dad.sendText('재전송 테스트', { msgId });
  await dad.waitFor('sent');

  assert.equal(hub.queueFor('dev_mom'), 1, 'INSERT OR IGNORE 로 한 행만 남는다');
});

test('3인 대화: 발신자 본인에게는 배달되지 않는다', async (t) => {
  const hub = await startHub(t);
  const mom = await connectClient(t, hub, 'dev_mom', { name: '엄마' });
  const bro = await connectClient(t, hub, 'dev_bro', { name: '형' });
  const dad = await connectClient(t, hub, 'dev_dad', { name: '아빠' });

  assert.equal(dad.members.length, 2);
  dad.sendText('다 같이 보는 메시지');

  await mom.waitForMessages(1);
  await bro.waitForMessages(1);
  assert.equal(mom.messages[0].body, '다 같이 보는 메시지');
  assert.equal(bro.messages[0].body, '다 같이 보는 메시지');
  assert.equal(dad.messages.length, 0, '자기가 보낸 것은 되돌아오지 않는다');
});

test('ping/pong', async (t) => {
  const hub = await startHub(t);
  const dad = await connectClient(t, hub, 'dev_dad');

  const pong = dad.waitFor('pong');
  dad.ping();
  const frame = await pong;

  assert.equal(typeof frame.ts, 'number');
  assert.equal(typeof frame.serverTime, 'number');
});

test('같은 deviceId 로 새로 접속하면 옛 연결이 밀려난다', async (t) => {
  const hub = await startHub(t);
  const first = await connectClient(t, hub, 'dev_dad');

  const closed = new Promise((resolve) => first.once('close', resolve));
  const second = await connectClient(t, hub, 'dev_dad');

  assert.equal(await closed, 4000, 'close code 4000 = replaced');
  assert.equal(hub.conns.size, 1, '기기당 소켓은 1개');
  assert.ok(second.ready);
});

test('유효성 검사', async (t) => {
  const hub = await startHub(t);
  const mom = await connectClient(t, hub, 'dev_mom');
  const dad = await connectClient(t, hub, 'dev_dad');

  await t.test('msgId 가 ULID 가 아니면 BAD_REQUEST', async () => {
    const err = dad.waitFor('error');
    dad._send({
      t: 'send',
      msgId: 'not-a-ulid',
      sentAt: Date.now(),
      payloads: [{ to: 'dev_mom', ct: '', nonce: '' }],
    });
    assert.equal((await err).code, 'BAD_REQUEST');
  });

  await t.test('payloads 가 비면 BAD_REQUEST', async () => {
    const err = dad.waitFor('error');
    dad._send({ t: 'send', msgId: ulid(), sentAt: Date.now(), payloads: [] });
    assert.equal((await err).code, 'BAD_REQUEST');
  });

  await t.test('등록되지 않은 수신자 앞 payload 는 조용히 버린다', async () => {
    const sent = dad.waitFor('sent');
    dad._send({
      t: 'send',
      msgId: ulid(),
      sentAt: Date.now(),
      payloads: [{ to: 'dev_nobody', ct: 'aGk=', nonce: '' }],
    });
    await sent;
    assert.equal(hub.queueFor('dev_nobody'), 0, '영원히 안 빠질 큐를 만들지 않는다');
  });

  await t.test('알 수 없는 타입은 BAD_REQUEST', async () => {
    const err = dad.waitFor('error');
    dad._send({ t: 'nonsense' });
    assert.equal((await err).code, 'BAD_REQUEST');
  });

  await t.test('ack 의 msgId 도 ULID 여야 한다', async () => {
    const err = dad.waitFor('error');
    dad._send({ t: 'ack', msgIds: ['nope'] });
    assert.equal((await err).code, 'BAD_REQUEST');
  });

  assert.ok(mom.ready);
});

test('인증 전에는 hello 만 받는다', async (t) => {
  const hub = await startHub(t);

  const ws = new WebSocket(hub.url);
  await new Promise((resolve) => ws.once('open', resolve));

  const frame = await new Promise((resolve) => {
    ws.once('message', (d) => resolve(JSON.parse(d.toString())));
    ws.send(JSON.stringify({ t: 'send', msgId: ulid(), sentAt: Date.now(), payloads: [] }));
  });

  assert.equal(frame.t, 'error');
  assert.equal(frame.code, 'BAD_REQUEST');
  assert.equal(await new Promise((resolve) => ws.once('close', resolve)), 4001);
});

test('protocolVersion 이 다르면 UNSUPPORTED_VERSION', async (t) => {
  const hub = await startHub(t);

  const ws = new WebSocket(hub.url);
  await new Promise((resolve) => ws.once('open', resolve));

  const frame = await new Promise((resolve) => {
    ws.once('message', (d) => resolve(JSON.parse(d.toString())));
    ws.send(JSON.stringify({ t: 'hello', deviceId: 'dev_future', protocolVersion: 99 }));
  });

  assert.equal(frame.code, 'UNSUPPORTED_VERSION');
});

test('레이트 제한: 분당 60개를 넘기면 RATE_LIMITED', async (t) => {
  const hub = await startHub(t);
  const momFirst = await connectClient(t, hub, 'dev_mom');
  await momFirst.close();

  const dad = await connectClient(t, hub, 'dev_dad');

  for (let i = 0; i < 60; i += 1) {
    dad.sendText(`flood ${i}`);
    await dad.waitFor('sent');
  }

  const err = dad.waitFor('error');
  dad.sendText('61번째');
  const frame = await err;

  assert.equal(frame.code, 'RATE_LIMITED');
  assert.equal(hub.queueFor('dev_mom'), 60, '거절된 메시지는 큐에 들어가지 않는다');
});

test('ULID: 단조 생성기라야 같은 ms 안에서도 문자열 정렬 = 시간 정렬', () => {
  // 기본 생성기는 같은 ms 안에서 순서가 깨진다 — 그래서 클라이언트는 쓰면 안 된다.
  const plain = Array.from({ length: 50 }, () => ulid());
  assert.notDeepEqual([...plain].sort(), plain, '기본 ulid() 는 순서를 보장하지 못한다');

  // 단조 생성기는 보장한다 (PROTOCOL.md §7.1)
  const next = monotonicFactory();
  const mono = Array.from({ length: 50 }, () => next());
  assert.deepEqual([...mono].sort(), mono);
  assert.ok(mono.every((id) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)));
});
