# PROTOCOL.md — 가족 메신저 와이어 프로토콜

> 이 문서가 구현의 근거다. 프로토콜을 바꿀 때는 **이 문서를 먼저 고치고** 코드를 고친다.
> 현재 `protocolVersion`: **1**

---

## 1. 전송 계층

- WebSocket, **텍스트 프레임**, JSON Lines (프레임 1개 = JSON 객체 1개)
- 엔드포인트: `ws://<허브 Tailscale IP>:8787/ws`
- 바이너리(암호문, 공개키, nonce)는 모두 **Base64(표준, 패딩 포함)** 문자열로 인코딩
- 전송 구간 보안은 Tailscale(WireGuard)이 담당한다. 자체 TLS를 쓰지 않는다.

## 2. 공통 봉투

모든 프레임은 `t`(type) 필드를 가진다.

```json
{ "t": "타입명", "...": "..." }
```

알 수 없는 `t`는 `{"t":"error","code":"BAD_REQUEST"}`로 응답한다.
알 수 없는 **추가 필드는 무시**한다 (전방 호환).

---

## 3. 인증 핸드셰이크

기기는 **Ed25519 서명키**로 자신을 증명한다. 비밀번호는 없다.

```
클라이언트                                   허브
    │                                        │
    │──── {"t":"hello","deviceId":"..."} ───▶│
    │                                        │  deviceId가 등록된 기기인지 확인
    │◀─── {"t":"challenge","nonce":"b64"} ───│  32바이트 랜덤 nonce 생성
    │                                        │
    │  nonce를 Ed25519로 서명                  │
    │──── {"t":"auth","sig":"b64"} ─────────▶│  등록된 sign_pub_key로 검증
    │◀─── {"t":"welcome","serverTime":...,   │
    │      "members":[...]} ─────────────────│
    │                                        │
    │◀─── {"t":"deliver", ...} × N ──────────│  미수신 메시지 일괄 전송
```

- 실패 시 `{"t":"error","code":"AUTH_FAILED"}` 전송 후 소켓 종료.
- nonce는 **1회용**이며 60초 후 만료. 재사용 시 `AUTH_FAILED`.
- 인증 완료 전에는 `hello` / `auth` 이외의 프레임을 받지 않는다.

### 3.1 세부 규칙

- 등록되지 않은 `deviceId`면 `challenge`를 주지 않고 `UNKNOWN_DEVICE`로 끊는다.
  기기 등록은 `hub/scripts/enroll.js` 로 손으로 한다 (PLAN.md §6.2).
- **서명 대상은 nonce의 원본 바이트다.** Base64 문자열이 아니라 디코딩한 32바이트에 서명한다.
- `hello`에 선택 필드 `name`을 넣으면 허브가 표시 이름을 갱신한다.
  등록되지 않은 기기를 만들어 내지는 않는다.
- 같은 `deviceId`로 새 연결이 들어오면 **기존 연결을 닫는다**(close code 4000 `replaced`).
  기기당 소켓은 항상 1개다.
- nonce는 **1회용**이다. 인증 성공·실패 어느 쪽이든 즉시 폐기한다.
  같은 nonce로 두 번째 `auth`가 오면 `AUTH_FAILED`.

---

## 4. 클라이언트 → 허브

### `hello` — 인증 시작
```json
{ "t": "hello", "deviceId": "dev_abc123", "protocolVersion": 1 }
```

### `auth` — 챌린지 서명 응답
```json
{ "t": "auth", "sig": "base64-ed25519-signature" }
```

### `send` — 메시지 발신. 수신자 수만큼 payload를 담는다.
```json
{
  "t": "send",
  "msgId": "01J8XK...",
  "sentAt": 1755230400000,
  "payloads": [
    { "to": "dev_mom",  "ct": "base64", "nonce": "base64" },
    { "to": "dev_bro",  "ct": "base64", "nonce": "base64" }
  ]
}
```
- `msgId`: **ULID** (§7 참조). 26자 Crockford Base32가 아니면 `BAD_REQUEST`.
- `sentAt`: 발신자 기기 시각 (epoch ms)
- 발신자 본인은 payloads에 포함하지 않는다 (로컬에 평문 보관)
- `payloads`는 1개 이상 64개 이하. `to`가 등록되지 않은 기기면 **그 payload만 조용히 버린다**
  (영원히 배달되지 않을 큐를 만들지 않기 위해). 나머지 payload는 정상 처리한다.
- 같은 `(msgId, to)`가 이미 큐에 있으면 **무시**한다 (재전송은 무해하다, §6.4).
- 기기당 `send` 프레임은 **분당 60개**로 제한한다. 초과분은 `RATE_LIMITED`로 거절하고
  큐에 넣지 않는다. 앱의 재전송 루프가 폭주해서 허브 폰 저장소를 채우는 것을 막는 안전장치다.

### `ack` — 수신 확인. 허브는 ack된 메시지를 삭제한다.
```json
{ "t": "ack", "msgIds": ["01J8XK...", "01J8XL..."] }
```

### `ping` — 킵얼라이브
```json
{ "t": "ping", "ts": 1755230400000 }
```

---

## 5. 허브 → 클라이언트

### `challenge`
```json
{ "t": "challenge", "nonce": "base64-32bytes" }
```

### `welcome` — 인증 성공 + 멤버 목록 동기화
```json
{
  "t": "welcome",
  "serverTime": 1755230400123,
  "members": [
    { "deviceId": "dev_mom", "name": "엄마",
      "boxPubKey": "base64", "signPubKey": "base64", "online": true }
  ]
}
```

- `members`에는 **자기 자신이 포함되지 않는다.** 클라이언트는 이 목록을 그대로 순회해
  `send.payloads`를 만들면 된다 (자기 자신을 걸러낼 필요가 없다).
- `boxPubKey`(X25519 32바이트) / `signPubKey`(Ed25519 32바이트)는 항상 채워져 있다.

**`welcome`은 접속 직후에만 오는 것이 아니다.** 멤버 구성이 바뀌면
(새 기기 등록, 표시 이름 변경) 허브가 **접속 중인 다른 기기 전원에게 `welcome`을 다시 보낸다.**

이게 없으면 먼저 접속해 있던 기기는 나중에 합류한 가족을 영영 모른다. `presence`에는
이름도 공개키도 없어서 클라이언트가 새 멤버를 만들어 낼 수 없기 때문이다. 그 결과
"먼저 설치한 사람이 나중에 설치한 가족에게 메시지를 못 보내는" 상태가 된다.

클라이언트의 `welcome` 처리는 **멱등**이어야 한다 — 언제 몇 번을 받아도 안전하게
멤버 목록을 덮어쓰고, 대면 검증 시각(`verifiedAt`)처럼 허브가 모르는 로컬 값은 보존한다.

### `deliver` — 메시지 배달
```json
{
  "t": "deliver",
  "msgId": "01J8XK...",
  "from": "dev_dad",
  "sentAt": 1755230400000,
  "recvAt": 1755230400150,
  "ct": "base64",
  "nonce": "base64"
}
```

### `sent` — 발신자에게 허브 접수 확인
```json
{ "t": "sent", "msgId": "01J8XK...", "recvAt": 1755230400150 }
```

### `receipt` — 전달 확인 (누가 받았는지)
```json
{ "t": "receipt", "msgId": "01J8XK...", "by": "dev_mom", "at": 1755230401000 }
```

수신자가 `ack`를 보낸 시점에 **원 발신자에게** 전달한다.
`receipt`와 `presence`는 **best-effort**다. 발신자가 그때 접속해 있지 않으면 그냥 버린다
(큐에 쌓지 않는다). 발신 상태 표시는 놓쳐도 되는 정보이고, 큐에 쌓으면
"메시지는 지웠는데 영수증은 남는" 상태가 생긴다.

### `presence` — 온라인 상태 변경 브로드캐스트
```json
{ "t": "presence", "deviceId": "dev_mom", "online": false, "at": 1755230500000 }
```

### `pong`
```json
{ "t": "pong", "ts": 1755230400000, "serverTime": 1755230400130 }
```

### `error`
```json
{ "t": "error", "code": "AUTH_FAILED", "msg": "설명" }
```

**에러 코드**

| code | 의미 |
|---|---|
| `AUTH_FAILED` | 서명 검증 실패 / nonce 만료 / nonce 재사용 |
| `UNKNOWN_DEVICE` | 등록되지 않은 deviceId |
| `BAD_REQUEST` | JSON 파싱 실패, 필수 필드 누락, 알 수 없는 타입 |
| `UNSUPPORTED_VERSION` | protocolVersion 불일치 |
| `RATE_LIMITED` | 과도한 전송 |

---

## 6. 신뢰성 규칙

1. **허브는 ack를 받기 전까지 메시지를 삭제하지 않는다.**
2. 클라이언트는 재접속할 때마다 미수신 메시지를 전부 다시 받는다.
3. 중복 배달은 **정상 동작**이다. 클라이언트가 `msgId`로 중복 제거한다.
4. 발신 실패 시 앱의 outbox에 남겨두고 재접속 시 재전송한다.
   재전송해도 `msgId`는 **바꾸지 않는다**.

---

## 7. 메시지 ID와 정렬

**`msgId`는 ULID를 사용한다.** UUIDv4가 아니다.

- ULID는 앞 48비트가 타임스탬프 → **문자열 정렬 = 시간 정렬**
- 중앙 서버가 순번을 매기지 않는 구조이므로 ID 자체에 순서가 담겨야 한다

### 7.1 클라이언트는 반드시 **단조(monotonic)** ULID 생성기를 써야 한다

기본 ULID 생성기는 호출할 때마다 랜덤 80비트를 새로 뽑는다. 그래서 **같은 밀리초 안에
만든 두 ULID는 생성 순서대로 정렬되지 않는다.** 연타로 보낸 메시지가 뒤집혀 보인다.

- JS: `ulid` 패키지의 `monotonicFactory()`
- Kotlin: 같은 ms 면 랜덤 파트를 +1 하는 방식으로 직접 구현 (`Ulid.next()`)

같은 ms 안에서 **서로 다른 기기**가 만든 ULID의 상대 순서는 보장되지 않는다.
이건 중앙 순번 발급자가 없는 구조의 본질적 한계이고, 아래 정렬 규칙이 모든 기기에서
동일하므로 **가족 구성원 전원이 같은 순서를 본다**는 점만 지키면 된다.

### 7.2 정렬 규칙

화면 표시는 **`recvAt` 오름차순, 동률이면 `msgId` 오름차순**으로 정렬한다.
허브가 큐를 내보낼 때 쓰는 순서(`ORDER BY recv_at, msg_id`)와 같아야 한다.

> `sentAt`은 발신자 폰의 시계다. 가족 중 누군가의 시계가 10분 틀어져 있으면
> 메시지가 과거로 튄다. 허브 시계 하나만 신뢰하면 전체 순서가 일관된다.
> 단 `sentAt`도 함께 저장해서 "보낸 시각"으로 표시하고,
> 두 값이 5분 이상 벌어지면 UI에 경고를 띄운다.

---

## 8. 허브 저장 스키마 (SQLite)

```sql
-- 등록된 가족 기기
CREATE TABLE devices (
  device_id     TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  sign_pub_key  BLOB NOT NULL,   -- Ed25519 공개키 (인증용)
  box_pub_key   BLOB NOT NULL,   -- X25519 공개키 (암호화용)
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER
);

-- 미배달 메시지 큐 (배달+ack 완료 시 DELETE)
CREATE TABLE outbox (
  msg_id        TEXT NOT NULL,
  recipient_id  TEXT NOT NULL,
  sender_id     TEXT NOT NULL,
  ciphertext    BLOB NOT NULL,
  nonce         BLOB NOT NULL,
  sent_at       INTEGER NOT NULL,   -- 발신자 시각
  recv_at       INTEGER NOT NULL,   -- 허브 도착 시각 (정렬 기준)
  delivered_at  INTEGER,            -- 소켓으로 내보낸 시각
  PRIMARY KEY (msg_id, recipient_id)
);
CREATE INDEX idx_outbox_recipient ON outbox(recipient_id, recv_at);

-- 운영 로그 (내용 없음, 디버깅용)
CREATE TABLE events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         INTEGER NOT NULL,
  device_id  TEXT,
  kind       TEXT NOT NULL,    -- connect|disconnect|send|ack|error
  detail     TEXT
);
```

> **허브는 평문을 절대 저장하지 않는다.** `ciphertext` 외의 본문 컬럼을 추가하지 말 것.
> `events.detail`에도 메시지 내용을 넣지 않는다.

---

## 9. 배달 순서

한 소켓 안에서 허브가 프레임을 내보내는 순서는 다음을 보장한다.

1. `welcome`
2. 밀린 `deliver` × N — `recv_at` 오름차순, 동률이면 `msg_id` 오름차순
3. 이후 실시간 프레임

클라이언트는 이 순서에 의존해도 된다. 단, **중복 `deliver`는 언제든 올 수 있다**(§6.3).

## 10. 변경 이력

| 시점 | 변경 |
|---|---|
| Phase 0 | 초안. 배관 확인용 `echo` 프레임 사용 |
| Phase 1 | `echo` 제거. §3.1 신뢰 모드, §9 배달 순서, members 자기 제외, receipt/presence best-effort, send 유효성·레이트 제한 명시 |
| Phase 3 | 허브 바인딩을 Tailscale 주소로 제한하는 운영 규칙 추가 (§11) |
| Phase 4 | 신뢰 모드 제거 → 챌린지-응답 인증 강제. `ct`/`nonce` 가 진짜 crypto_box 암호문이 됨 (§12) |

## 11. 네트워크 노출 (Phase 3)

허브는 `HUB_HOST=tailscale` 로 실행하면 이 기기의 **Tailscale 주소(100.64.0.0/10)에만** 바인딩한다.
주소를 찾지 못하면 **시작을 거부한다.** 0.0.0.0 으로 조용히 물러서면
"잠갔다고 믿는데 실제로는 열려 있는" 상태가 되기 때문이다.

인터페이스 **이름**(tailscale0 / tun0 / utun3)은 플랫폼마다 달라서 판별 기준으로 쓰지 않는다.
안드로이드 Tailscale 은 VpnService 라 Termux 에서 보통 `tun0` 으로 보인다.

`HUB_REQUIRE_TAILSCALE=1` 을 켜면 바인딩과 별개로 접속해 온 상대 주소가
100.64.0.0/10 이 아닐 때 거절한다(2차 방어선).

## 12. 암호화 (Phase 4)

| 용도 | 알고리즘 |
|---|---|
| 기기 인증 | Ed25519 서명 (nonce 원본 32바이트에 detached 서명) |
| 메시지 암호화 | X25519 + XSalsa20-Poly1305 = libsodium `crypto_box_easy` |

- `send.payloads[].ct` = `crypto_box_easy(평문, nonce, 수신자_boxPub, 발신자_boxSecret)`
- `nonce` = 24바이트 난수. **메시지·수신자 조합마다 새로 만든다.** 재사용은 치명적이다.
- 수신자는 `deliver.from` 으로 발신자를 찾아 그 `boxPubKey` 로 연다.
- 발신자를 아직 모르면(멤버 목록에 없음) **ack 하지 않는다.** 곧 올 `welcome` 으로
  키를 배운 뒤 재접속 때 다시 받아 열면 된다.
  반대로 키는 아는데 복호화에 실패하면 영구적 실패이므로 자리표시자로 저장하고 ack 한다
  (안 그러면 재접속마다 영원히 같은 프레임이 온다).
