'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');
const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const router = require('./router');
const tailscale = require('./tailscale');

/**
 * WebSocket 서버 + 연결 수명주기.
 *
 * 연결 상태는 두 개뿐이다.
 *   1. 인증 전 — hello 만 받는다
 *   2. 인증 후 — send / ack / ping 을 router 로 넘긴다
 *
 * Phase 4 에서 1번이 challenge/auth 왕복으로 늘어난다.
 */

const CLOSE_REPLACED = 4000;   // 같은 deviceId 로 새 연결이 들어와 밀려남
const CLOSE_PROTOCOL = 4001;   // 인증 전에 엉뚱한 프레임

/**
 * @param {object} [opts]
 * @param {string} [opts.host]
 * @param {number} [opts.port]
 * @param {string} [opts.dbFile]
 * @param {(msg: string) => void} [opts.log]
 */
async function start(opts = {}) {
  const port = opts.port ?? config.port;
  const log = opts.log ?? ((m) => console.log(`[hub] ${m}`));

  // HUB_HOST=tailscale 이면 여기서 100.x 주소를 찾아 바인딩한다.
  // 못 찾으면 예외를 던진다 — 조용히 0.0.0.0 으로 물러서지 않는다.
  const bind = tailscale.resolveBindHost(opts.host ?? config.host);
  const host = bind.host;
  const requireTailscale = opts.requireTailscale ?? config.requireTailscale;

  if (bind.tailscaleOnly) {
    log(`binding to Tailscale address ${host} (${bind.iface}) — tailnet 밖에서는 보이지 않습니다`);
  } else if (host === '0.0.0.0') {
    log('WARNING: 0.0.0.0 에 바인딩합니다. 같은 네트워크의 누구나 접속할 수 있습니다.');
    log('         외부망에서 쓰려면 HUB_HOST=tailscale 로 실행하세요.');
  }

  const database = db.open(opts.dbFile);

  /** deviceId → conn. 기기당 소켓은 항상 1개다. */
  const conns = new Map();

  const hub = {
    db: database,
    conns,
    log,
    send(conn, obj) {
      sendJson(conn.ws, obj);
    },
  };

  const httpServer = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          serverTime: Date.now(),
          online: conns.size,
          queued: database.prepare('SELECT COUNT(*) AS n FROM outbox').get().n,
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({
    server: httpServer,
    path: config.wsPath,
    maxPayload: config.maxFrameBytes,
  });

  wss.on('connection', (ws, req) => {
    const peer = req.socket.remoteAddress;

    // 2차 방어선: tailnet 밖 주소는 인증 시도조차 못 하게 끊는다.
    if (requireTailscale && !tailscale.isTailscaleIp(peer)) {
      log(`rejecting non-tailnet peer ${peer}`);
      db.logEvent(database, 'error', null, `non-tailnet peer ${peer}`);
      sendJson(ws, { t: 'error', code: 'AUTH_FAILED', msg: 'not a tailnet address' });
      ws.close(CLOSE_PROTOCOL, 'not a tailnet address');
      return;
    }

    /** @type {{ws: import('ws').WebSocket, deviceId: string|null, authed: boolean, peer: string}} */
    const conn = {
      ws,
      deviceId: null,
      authed: false,
      peer,
      sendTimes: [],
      // 핸드셰이크 중간 상태 (PROTOCOL.md §3)
      pendingDeviceId: null,
      nonce: null,
      nonceIssuedAt: 0,
      membersFingerprint: null,
    };

    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    log(`connect ${conn.peer}`);

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        sendJson(ws, { t: 'error', code: 'BAD_REQUEST', msg: 'binary frames are not supported' });
        return;
      }

      let frame;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        sendJson(ws, { t: 'error', code: 'BAD_REQUEST', msg: 'frame must be valid JSON' });
        return;
      }
      if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) {
        sendJson(ws, { t: 'error', code: 'BAD_REQUEST', msg: 'frame must be a JSON object' });
        return;
      }

      try {
        if (!conn.authed) {
          onUnauthenticatedFrame(hub, conn, frame);
        } else {
          router.handle(hub, conn, frame);
        }
      } catch (err) {
        // 프레임 하나가 서버 전체를 죽이지 않게 한다.
        log(`frame handler error (${conn.deviceId ?? conn.peer}): ${err.message}`);
        db.logEvent(database, 'error', conn.deviceId, err.message);
        sendJson(ws, { t: 'error', code: 'BAD_REQUEST', msg: 'frame could not be processed' });
      }
    });

    ws.on('error', (err) => {
      log(`socket error (${conn.deviceId ?? conn.peer}): ${err.message}`);
    });

    ws.on('close', (code) => {
      // 이미 다른 소켓에 자리를 내준 연결이면 레지스트리를 건드리지 않는다.
      if (conn.authed && conns.get(conn.deviceId) === conn) {
        conns.delete(conn.deviceId);
        auth.touchLastSeen(database, conn.deviceId);
        router.broadcastPresence(hub, conn.deviceId, false);
        db.logEvent(database, 'disconnect', conn.deviceId, String(code));
        log(`disconnect ${conn.deviceId} (${code})`);
      } else {
        log(`disconnect ${conn.deviceId ?? conn.peer} (${code})`);
      }
    });
  });

  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (client.isAlive === false) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      try {
        client.ping();
      } catch {
        client.terminate();
      }
    }
  }, config.heartbeatIntervalMs);
  heartbeat.unref();

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.removeListener('error', reject);
      resolve();
    });
  });

  const actualPort = httpServer.address().port;
  log(`listening on ws://${host}:${actualPort}${config.wsPath}`);

  async function close() {
    clearInterval(heartbeat);
    for (const client of wss.clients) client.close(1001, 'server shutting down');
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => httpServer.close(resolve));
    database.close();
    log('stopped');
  }

  return { port: actualPort, close, database, wss, httpServer, conns };
}

/** 인증 전에는 hello / auth 만 받는다 (PROTOCOL.md §3). */
function onUnauthenticatedFrame(hub, conn, frame) {
  if (frame.t === 'hello') return onHello(hub, conn, frame);
  if (frame.t === 'auth') return onAuth(hub, conn, frame);

  hub.send(conn, { t: 'error', code: 'BAD_REQUEST', msg: 'expected hello first' });
  conn.ws.close(CLOSE_PROTOCOL, 'expected hello');
}

function onHello(hub, conn, frame) {
  const result = auth.beginChallenge(hub.db, frame, config.protocolVersion);
  if (!result.ok) {
    hub.send(conn, { t: 'error', code: result.code, msg: result.msg });
    db.logEvent(hub.db, 'error', frame.deviceId ?? null, result.code);
    conn.ws.close(CLOSE_PROTOCOL, result.code);
    return;
  }

  // 아직 인증된 게 아니다. 서명을 받아야 conns 에 들어간다.
  conn.pendingDeviceId = result.deviceId;
  conn.nonce = result.nonce;
  conn.nonceIssuedAt = Date.now();

  hub.send(conn, { t: 'challenge', nonce: result.nonce.toString('base64') });
}

function onAuth(hub, conn, frame) {
  const deviceId = conn.pendingDeviceId;
  if (!deviceId) {
    hub.send(conn, { t: 'error', code: 'AUTH_FAILED', msg: 'send hello first' });
    conn.ws.close(CLOSE_PROTOCOL, 'AUTH_FAILED');
    return;
  }

  const nonce = conn.nonce;
  // nonce 는 1회용이다. 검증 전에 지운다 — 실패해도 같은 nonce 로 다시 시도할 수 없다.
  conn.nonce = null;

  const result = auth.verifyChallenge(hub.db, deviceId, frame, nonce, conn.nonceIssuedAt);
  if (!result.ok) {
    hub.send(conn, { t: 'error', code: result.code, msg: result.msg });
    db.logEvent(hub.db, 'error', deviceId, result.code);
    hub.log(`auth failed for ${deviceId}: ${result.msg}`);
    conn.ws.close(CLOSE_PROTOCOL, result.code);
    return;
  }

  // 기기당 소켓 1개. 옛 연결은 밀어낸다. (재접속 시 유령 소켓이 남는 것을 막는다)
  const previous = hub.conns.get(deviceId);
  if (previous && previous !== conn) {
    hub.log(`replacing existing connection for ${deviceId}`);
    previous.authed = false;
    previous.ws.close(CLOSE_REPLACED, 'replaced by a newer connection');
  }

  conn.deviceId = deviceId;
  conn.authed = true;
  hub.conns.set(deviceId, conn);

  db.logEvent(hub.db, 'connect', deviceId, conn.peer);
  hub.log(`authenticated ${deviceId} (${conn.peer})`);

  sendWelcome(hub, conn);

  // 멤버 구성이 바뀌었으면 이미 붙어 있던 기기들의 목록이 낡았다 (PROTOCOL.md §5).
  // 각 연결이 마지막으로 받은 지문과 비교한다 — 새 기기 등록, 이름 변경, 등록 해제를
  // 모두 잡는다. 이게 없으면 먼저 접속해 있던 기기는 새 가족에게 메시지를 못 보낸다.
  const fingerprint = auth.membersFingerprint(hub.db);
  for (const [id, other] of hub.conns) {
    if (id === deviceId) continue;
    if (other.membersFingerprint !== fingerprint) {
      hub.log(`membership changed, refreshing ${id}`);
      sendWelcome(hub, other);
    }
  }

  router.broadcastPresence(hub, deviceId, true);

  // 재접속이므로 ack 안 된 것까지 전부 다시 보낸다 (onlyNew 를 켜지 않는다).
  const flushed = router.deliverPending(hub, conn);
  if (flushed) hub.log(`flushed ${flushed} queued message(s) to ${deviceId}`);
}

/** 현재 멤버 목록을 담은 welcome 을 보낸다. 접속 직후 말고도 멤버 구성이 바뀔 때마다 부른다. */
function sendWelcome(hub, conn) {
  // 이 연결이 어떤 멤버 구성까지 알고 있는지 기록해 둔다. 다음 갱신 판단의 기준이 된다.
  conn.membersFingerprint = auth.membersFingerprint(hub.db);
  hub.send(conn, {
    t: 'welcome',
    serverTime: Date.now(),
    members: auth.listMembers(hub.db, conn.deviceId, hub.conns),
  });
}

/** @param {import('ws').WebSocket} ws */
function sendJson(ws, obj) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(obj));
}

module.exports = { start, sendJson, CLOSE_REPLACED, CLOSE_PROTOCOL };
