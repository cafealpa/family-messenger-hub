'use strict';

/**
 * 검증용 더미 클라이언트. 안드로이드 앱과 **똑같은 프로토콜과 암호화**를 쓴다.
 *
 * - 인증: Ed25519 챌린지-응답 (PROTOCOL.md §3)
 * - 본문: X25519 + XSalsa20-Poly1305 = crypto_box (PROTOCOL.md §12)
 *
 * ⚠ tweetnacl 은 **devDependency** 다. 허브 서버 코드는 이걸 쓰지 않는다.
 *   허브는 암호문을 그대로 옮길 뿐 열지 못하며, 그게 이 프로젝트의 존재 이유다.
 *
 * 라이브러리로:
 *   const { DummyClient } = require('./scripts/dummy-client');
 *
 * CLI 로 (터미널 2개를 띄워 손으로 확인할 때):
 *   node scripts/dummy-client.js --id dev_dad --name 아빠 --keys ~/dad.json
 *   → 먼저 --print-enrollment 로 등록 정보를 뽑아 enroll.js 에 넣어야 접속된다
 */

const { EventEmitter } = require('events');
const fs = require('fs');
const WebSocket = require('ws');
const nacl = require('tweetnacl');
const { monotonicFactory } = require('ulid');

const DEFAULT_URL = 'ws://127.0.0.1:8787/ws';

// 단조 생성기. 기본 ulid() 는 같은 ms 안에서 순서를 보장하지 않는다 (PROTOCOL.md §7.1).
const nextUlid = monotonicFactory();

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const unb64 = (text) => new Uint8Array(Buffer.from(text, 'base64'));

class DummyClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.deviceId
   * @param {string} [opts.name]
   * @param {string} [opts.url]
   * @param {boolean} [opts.autoAck] 기본 true. false 면 받고도 ack 를 안 보낸다(재배달 테스트용).
   * @param {object} [opts.keys] 저장해 둔 키 (없으면 새로 만든다)
   */
  constructor(opts) {
    super();
    this.deviceId = opts.deviceId;
    this.name = opts.name ?? opts.deviceId;
    this.url = opts.url ?? DEFAULT_URL;
    this.autoAck = opts.autoAck ?? true;

    if (opts.keys) {
      this.signKeys = {
        publicKey: unb64(opts.keys.signPub),
        secretKey: unb64(opts.keys.signSecret),
      };
      this.boxKeys = {
        publicKey: unb64(opts.keys.boxPub),
        secretKey: unb64(opts.keys.boxSecret),
      };
    } else {
      this.signKeys = nacl.sign.keyPair();
      this.boxKeys = nacl.box.keyPair();
    }

    /** @type {import('ws')|null} */
    this.ws = null;
    /** @type {Array<{deviceId: string, name: string, boxPubKey: string, online: boolean}>} */
    this.members = [];

    /** 이미 본 msgId. 중복 배달을 여기서 걸러낸다 (PROTOCOL.md §6.3). */
    this.seen = new Set();
    /** 중복 제거를 마친 메시지. recvAt 오름차순으로 유지한다. */
    this.messages = [];
    /** 중복까지 포함해 소켓으로 실제로 몇 번 들어왔는지 (테스트에서 확인용) */
    this.deliverFrameCount = 0;

    // 허브의 error 프레임도 'error' 이벤트로 흘린다. EventEmitter 는 리스너 없는
    // 'error' 를 예외로 던지므로, 아무도 안 듣고 있을 때를 대비해 기본 리스너를 둔다.
    this.on('error', () => {});
  }

  /** enroll.js 에 그대로 넣을 수 있는 등록 정보 (공개키만). */
  enrollment() {
    return {
      deviceId: this.deviceId,
      name: this.name,
      signPub: b64(this.signKeys.publicKey),
      boxPub: b64(this.boxKeys.publicKey),
    };
  }

  /** 개인키까지 포함한 저장용 (테스트/CLI 재사용). 실제 앱에서는 Keystore 로 감싼다. */
  exportKeys() {
    return {
      signPub: b64(this.signKeys.publicKey),
      signSecret: b64(this.signKeys.secretKey),
      boxPub: b64(this.boxKeys.publicKey),
      boxSecret: b64(this.boxKeys.secretKey),
    };
  }

  /** 접속하고 welcome 을 받을 때까지 기다린다. */
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      this.ready = false;

      const onError = (err) => reject(err);
      ws.once('error', onError);

      ws.on('open', () => {
        ws.send(JSON.stringify({
          t: 'hello',
          deviceId: this.deviceId,
          protocolVersion: 1,
          name: this.name,
        }));
      });

      ws.on('message', (data) => {
        let frame;
        try {
          frame = JSON.parse(data.toString());
        } catch {
          this.emit('error', new Error(`unparseable frame: ${data.toString()}`));
          return;
        }

        this._onFrame(frame);

        if (frame.t === 'welcome') {
          ws.removeListener('error', onError);
          resolve(this);
        } else if (frame.t === 'error' && !this.ready) {
          ws.removeListener('error', onError);
          reject(new Error(`${frame.code}: ${frame.msg}`));
        }
      });

      ws.on('close', (code) => {
        this.ready = false;
        this.emit('close', code);
      });
    });
  }

  _onFrame(frame) {
    switch (frame.t) {
      case 'challenge': {
        // nonce 의 **원본 바이트**에 서명한다. base64 문자열이 아니다 (PROTOCOL.md §3.1).
        const nonce = unb64(frame.nonce);
        const sig = nacl.sign.detached(nonce, this.signKeys.secretKey);
        this._send({ t: 'auth', sig: b64(sig) });
        break;
      }

      case 'welcome':
        this.ready = true;
        this.members = frame.members;
        this.serverTime = frame.serverTime;
        break;

      case 'deliver': {
        this.deliverFrameCount += 1;
        if (!this.seen.has(frame.msgId)) {
          const body = this._open(frame);
          if (body === null) {
            // 발신자의 공개키를 아직 모른다. ack 하지 않고 넘어간다 (PROTOCOL.md §12).
            this.emit('undecryptable', frame);
            break;
          }
          this.seen.add(frame.msgId);
          this.messages.push({
            msgId: frame.msgId,
            from: frame.from,
            body,
            sentAt: frame.sentAt,
            recvAt: frame.recvAt,
          });
          // recvAt(허브 시각) 기준 정렬. sentAt 으로 정렬하지 않는다 (PROTOCOL.md §7.2).
          this.messages.sort((a, b) => a.recvAt - b.recvAt || a.msgId.localeCompare(b.msgId));
        }
        if (this.autoAck) this.ack([frame.msgId]);
        break;
      }

      case 'presence': {
        const m = this.members.find((x) => x.deviceId === frame.deviceId);
        if (m) m.online = frame.online;
        break;
      }

      default:
        break;
    }

    this.emit(frame.t, frame);
    this.emit('frame', frame);
  }

  /** @returns {string|null} 못 열면 null */
  _open(frame) {
    const sender = this.members.find((m) => m.deviceId === frame.from);
    if (!sender || !sender.boxPubKey) return null;

    const opened = nacl.box.open(
      unb64(frame.ct),
      unb64(frame.nonce),
      unb64(sender.boxPubKey),
      this.boxKeys.secretKey,
    );
    if (!opened) return '(복호화 실패)';
    return Buffer.from(opened).toString('utf8');
  }

  _send(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('socket is not open');
    }
    this.ws.send(JSON.stringify(obj));
  }

  /**
   * 멤버 전원에게 텍스트를 보낸다. 수신자마다 따로 암호화한다.
   * @returns {string} msgId (ULID)
   */
  sendText(text, opts = {}) {
    const msgId = opts.msgId ?? nextUlid();
    const plain = Buffer.from(text, 'utf8');

    const payloads = this.members.map((m) => {
      // nonce 는 메시지·수신자 조합마다 새로 만든다. 재사용은 치명적이다.
      const nonce = nacl.randomBytes(nacl.box.nonceLength);
      const ct = nacl.box(plain, nonce, unb64(m.boxPubKey), this.boxKeys.secretKey);
      return { to: m.deviceId, ct: b64(ct), nonce: b64(nonce) };
    });

    this._send({ t: 'send', msgId, sentAt: opts.sentAt ?? Date.now(), payloads });
    return msgId;
  }

  ack(msgIds) {
    this._send({ t: 'ack', msgIds });
  }

  ping() {
    this._send({ t: 'ping', ts: Date.now() });
  }

  /** 다음 특정 프레임 1개를 기다린다. */
  waitFor(type, { timeoutMs = 3000, match } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(type, onFrame);
        reject(new Error(`timeout waiting for "${type}"`));
      }, timeoutMs);

      const onFrame = (frame) => {
        if (match && !match(frame)) return;
        clearTimeout(timer);
        this.off(type, onFrame);
        resolve(frame);
      };
      this.on(type, onFrame);
    });
  }

  /**
   * 소켓으로 들어온 deliver 프레임이 누적 n 개가 될 때까지 기다린다 (중복 포함).
   *
   * 주의: 재접속 직후의 밀린 메시지는 welcome 과 **같은 tick 에** 도착한다.
   * 그래서 `await connect()` 뒤에 waitFor('deliver') 를 거는 방식은 이미 지나간
   * 프레임을 놓친다. 이 메서드는 현재 카운트를 먼저 확인하므로 그 경주를 피한다.
   */
  async waitForDeliverFrames(n, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (this.deliverFrameCount < n) {
      const left = deadline - Date.now();
      const fail = () => {
        throw new Error(`timeout: deliver 프레임 ${this.deliverFrameCount}/${n}`);
      };
      if (left <= 0) fail();
      await this.waitFor('deliver', { timeoutMs: left }).catch(fail);
    }
    return this.deliverFrameCount;
  }

  /** deliver 로 받아 중복 제거를 마친 메시지가 n 개가 될 때까지 기다린다. */
  async waitForMessages(n, timeoutMs = 3000) {
    if (this.messages.length >= n) return this.messages;
    const deadline = Date.now() + timeoutMs;
    while (this.messages.length < n) {
      const left = deadline - Date.now();
      if (left <= 0) {
        throw new Error(`timeout: got ${this.messages.length}/${n} messages`);
      }
      await this.waitFor('deliver', { timeoutMs: left }).catch(() => {
        throw new Error(`timeout: got ${this.messages.length}/${n} messages`);
      });
    }
    return this.messages;
  }

  close() {
    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState === WebSocket.CLOSED) return resolve();
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function loadOrCreateKeys(file) {
  if (!file) return null;
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.id) {
    console.error(
      'usage: node scripts/dummy-client.js --id dev_dad [--name 아빠] [--url ws://host:8787/ws] [--keys keys.json] [--print-enrollment]',
    );
    process.exit(2);
  }

  const keys = loadOrCreateKeys(args.keys);
  const client = new DummyClient({
    deviceId: args.id,
    name: args.name,
    url: args.url,
    keys,
  });

  // 키 파일이 지정됐는데 아직 없으면 만들어 둔다. 재실행해도 같은 기기로 인식된다.
  if (args.keys && !keys) {
    fs.writeFileSync(args.keys, JSON.stringify(client.exportKeys(), null, 2));
    console.log(`새 키를 만들어 ${args.keys} 에 저장했습니다.`);
  }

  if (args['print-enrollment']) {
    console.log('아래 한 줄을 허브에서 enroll.js 에 넣으세요:\n');
    console.log(JSON.stringify(client.enrollment()));
    return;
  }

  /** @type {import('readline').Interface|undefined} */
  let rl;

  // process.exit() 로 즉시 끝내지 않는다. 소켓이 정리되는 중에 강제 종료하면
  // 윈도우에서 libuv 어설션(uv_close)이 터진다. 핸들을 닫고 이벤트 루프가
  // 자연히 비도록 두면 종료 코드 0 으로 깔끔하게 끝난다.
  const shutdown = async () => {
    rl?.close();
    await client.close();
  };

  client.on('deliver', (f) => {
    const known = client.messages.find((m) => m.msgId === f.msgId);
    console.log(`\n[${f.from}] ${known ? known.body : '(복호화 불가)'}`);
  });
  client.on('undecryptable', (f) => console.log(`\n  ! ${f.from} 의 공개키를 아직 모릅니다`));
  client.on('receipt', (f) => console.log(`\n  ✓ ${f.by} 가 ${f.msgId} 수신`));
  client.on('presence', (f) => console.log(`\n  · ${f.deviceId} ${f.online ? '접속' : '끊김'}`));
  client.on('sent', (f) => console.log(`  → 허브 접수 ${f.msgId}`));
  client.on('close', (code) => {
    console.log(`\n연결 종료 (${code})`);
    rl?.close();
  });

  try {
    await client.connect();
  } catch (err) {
    console.error(`접속 실패: ${err.message}`);
    if (String(err.message).includes('UNKNOWN_DEVICE')) {
      console.error('\n허브에 등록되지 않은 기기입니다. 허브에서 아래를 실행하세요:');
      console.error(`  node scripts/enroll.js '${JSON.stringify(client.enrollment())}'`);
    }
    process.exit(1);
  }

  console.log(`접속됨: ${client.deviceId}`);
  console.log(`멤버: ${client.members.map((m) => `${m.name}${m.online ? '*' : ''}`).join(', ') || '(없음)'}`);
  console.log('줄을 입력하면 전송. /members /queue /quit');

  rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
  rl.on('line', async (line) => {
    const text = line.trim();
    if (!text) return;
    if (text === '/quit') {
      await shutdown();
      return;
    }
    if (text === '/members') {
      console.log(
        client.members.map((m) => `  ${m.deviceId} ${m.name} ${m.online ? 'online' : 'offline'}`).join('\n') || '  (없음)',
      );
      return;
    }
    if (text === '/queue') {
      console.log(`  받은 메시지 ${client.messages.length}건 (소켓으로 들어온 deliver ${client.deliverFrameCount}회)`);
      return;
    }
    try {
      client.sendText(text);
    } catch (err) {
      console.error(`  ! 전송 실패: ${err.message}`);
    }
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { DummyClient, DEFAULT_URL };
