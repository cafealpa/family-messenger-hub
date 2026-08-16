# 가족 메신저 (Hub 기반 무서버 메신저) 구현 계획서

> **문서 목적**: Claude Code가 이 문서 하나만 읽고 단계별로 구현에 착수할 수 있도록 작성된 기술 명세 및 실행 계획서.
> **작성 기준일**: 2026-08-15

---

## 1. 프로젝트 개요

### 1.1 한 줄 정의

외부 클라우드 서버 없이, 집에 상시 전원 연결된 안드로이드 폰 1대를 "허브"로 삼아 동작하는 가족 전용 종단간 암호화 메신저.

### 1.2 목표 (Goals)

| # | 목표 |
|---|---|
| G1 | 제3자 서버에 메시지 내용이 저장되지 않는다 |
| G2 | 수신자가 오프라인이어도 메시지가 유실되지 않는다 |
| G3 | 앱이 백그라운드에 있어도 알림이 즉시 도착한다 |
| G4 | 외부망(LTE)에서도 집 허브에 접속할 수 있다 |
| G5 | 허브 운영자(=가족 구성원)조차 메시지 내용을 읽을 수 없다 |

### 1.3 비목표 (Non-Goals) — 명시적으로 만들지 않는 것

- 음성/영상 통화
- 사용자 가입, 로그인, 비밀번호, 이메일 인증
- 그룹 여러 개 (가족 단톡방 **1개만** 존재한다고 가정)
- 앱스토어 배포
- 익명성 / 메타데이터 은닉 (허브는 "누가 언제 보냈는지"는 알게 됨. 가족이므로 수용)
- 웹 클라이언트, iOS 클라이언트

### 1.4 제약 조건 (Constraints)

- 전 구성원 안드로이드 (**iOS 없음 → FCM/APNs 불필요**)
- 인원 4~6명, 일 메시지 수백 건 수준. 성능 최적화는 고려 대상 아님
- 허브 = 구형 안드로이드 폰 + Termux
- 개발 인력 1명

---

## 2. 아키텍처

### 2.1 전체 구조

```
   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐
   │  아빠 폰     │   │  엄마 폰     │   │  형 폰       │
   │             │   │             │   │             │
   │ Foreground  │   │ Foreground  │   │ Foreground  │
   │ Service     │   │ Service     │   │ Service     │
   │ + Room DB   │   │ + Room DB   │   │ + Room DB   │
   └──────┬──────┘   └──────┬──────┘   └──────┬──────┘
          │                 │                 │
          └────────┬────────┴────────┬────────┘
                   │  WebSocket      │
                   │  over Tailscale │
                   ▼                 ▼
          ┌──────────────────────────────┐
          │   허브 (집에 있는 구형 폰)      │
          │                              │
          │   Termux                     │
          │    └ Node.js (ws)            │
          │        └ SQLite              │
          │                              │
          │   ⚠ 암호문만 보관. 복호화 불가  │
          └──────────────────────────────┘
```

### 2.2 계층별 책임

| 계층 | 책임 | 하지 않는 것 |
|---|---|---|
| **앱** | 평문 관리, 암호화/복호화, 로컬 알림 생성, 소켓 유지 | 서로 직접 연결 시도 |
| **허브** | 암호문 중계 및 임시 보관, 온라인 상태 추적 | 복호화, 내용 검사, 영구 보관 |
| **Tailscale** | NAT 통과, 전송 구간 암호화, 고정 주소 제공 | 애플리케이션 인증 |

### 2.3 왜 이 구조인가 (트레이드오프)

| 결정 | 채택 | 버린 대안 | 이유 |
|---|---|---|---|
| 연결 방식 | 허브 경유 (star) | WebRTC P2P mesh | NAT 홀펀칭/ICE 구현 부담 제거. 인원 적어 허브 병목 없음 |
| 네트워크 | Tailscale (WireGuard) | 포트포워딩 + DDNS | 통신사 CGNAT 통과. 공유기 설정 불필요 |
| 푸시 | Foreground Service 상시 소켓 | FCM | 안드로이드 전용이므로 구글 의존 완전 제거 가능 |
| 암호화 | 수신자별 개별 암호화 (N배 복사) | 그룹키 공유 | 키 로테이션/멤버 변경 로직 불필요. 텍스트라 용량 무의미 |
| 전송 보안 | Tailscale WireGuard | 자체 TLS 인증서 | 인증서 발급/갱신 부담 제거 |

> **핵심 통찰**: 이 설계는 "P2P의 어려운 부분(발견, 홀펀칭, 오프라인 저장)"을 허브 하나로 전부 우회한다. 대신 허브가 SPOF(단일 장애점)가 되지만, 가족용이므로 허브가 죽으면 그냥 재부팅하면 되는 수준의 문제다.

---

## 3. 저장소 구조

모노레포로 구성한다.

```
family-messenger/
├── CLAUDE.md                  # Claude Code용 프로젝트 규칙 (§8 참조)
├── PLAN.md                    # 이 문서
├── PROTOCOL.md                # §4 프로토콜 명세를 복사해 둘 것
├── hub/                       # Node.js 허브 서버
│   ├── package.json
│   ├── src/
│   │   ├── index.js           # 진입점
│   │   ├── server.js          # WebSocket 서버
│   │   ├── auth.js            # 챌린지-응답 인증
│   │   ├── db.js              # SQLite 래퍼
│   │   ├── router.js          # 메시지 라우팅/큐잉
│   │   └── config.js
│   ├── scripts/
│   │   ├── enroll.js          # 기기 등록 CLI
│   │   └── start-hub.sh       # Termux 부팅 스크립트
│   └── test/
└── app/                       # 안드로이드 앱
    ├── build.gradle.kts
    └── app/src/main/java/.../
        ├── ui/                # Jetpack Compose
        ├── service/           # MessengerService (Foreground)
        ├── net/               # WebSocket 클라이언트
        ├── crypto/            # 키 관리, 암복호화
        ├── data/              # Room DB, Repository
        └── notify/            # 로컬 알림
```

---

## 4. 프로토콜 명세

> 실제 구현 근거는 `PROTOCOL.md`에 복사되어 있다. 프로토콜을 바꿀 때는 그쪽을 먼저 고친다.

### 4.1 전송

- WebSocket, 텍스트 프레임, **JSON Lines** (프레임 1개 = JSON 객체 1개)
- 엔드포인트: `ws://<허브 Tailscale IP>:8787/ws`
- 바이너리(암호문, 공개키)는 모두 **Base64** 문자열로 인코딩

### 4.2 공통 봉투

모든 메시지는 `t`(type) 필드를 가진다.

```json
{ "t": "타입명" }
```

### 4.3 인증 핸드셰이크

기기는 **Ed25519 서명키**로 자신을 증명한다. 비밀번호는 없다.

```
클라이언트                                   허브
    │                                        │
    │──── {"t":"hello","deviceId":"..."} ───▶│
    │                                        │  deviceId가 등록된 기기인지 확인
    │◀─── {"t":"challenge","nonce":"b64"} ───│  32바이트 랜덤 nonce 생성
    │                                        │
    │  nonce를 Ed25519로 서명                  │
    │──── {"t":"auth","sig":"b64"} ─────────▶│
    │                                        │  등록된 sign_pub_key로 검증
    │◀─── {"t":"welcome","serverTime":...,   │
    │      "members":[...]} ─────────────────│
    │                                        │
    │◀─── {"t":"deliver", ...} × N ──────────│  미수신 메시지 일괄 전송
```

**실패 시**: `{"t":"error","code":"AUTH_FAILED"}` 후 소켓 종료.

> nonce는 1회용이며 60초 후 만료. 재사용 시 `AUTH_FAILED`.

### 4.4 메시지 타입 목록

#### 클라이언트 → 허브

**`hello`** — 인증 시작
```json
{ "t": "hello", "deviceId": "dev_abc123", "protocolVersion": 1 }
```

**`auth`** — 챌린지 서명 응답
```json
{ "t": "auth", "sig": "base64-ed25519-signature" }
```

**`send`** — 메시지 발신. 수신자 수만큼 payload를 담는다.
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
- `msgId`: **ULID** 사용 (§4.6 참조)
- `sentAt`: 발신자 기기 시각 (epoch ms)
- 발신자 본인은 payloads에 포함하지 않는다 (로컬에 평문 보관)

**`ack`** — 수신 확인. 허브는 ack된 메시지를 삭제한다.
```json
{ "t": "ack", "msgIds": ["01J8XK...", "01J8XL..."] }
```

**`ping`** — 킵얼라이브 (§6.3)
```json
{ "t": "ping", "ts": 1755230400000 }
```

#### 허브 → 클라이언트

**`challenge`**
```json
{ "t": "challenge", "nonce": "base64-32bytes" }
```

**`welcome`** — 인증 성공 + 멤버 목록 동기화
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

**`deliver`** — 메시지 배달
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

**`sent`** — 발신자에게 허브 접수 확인
```json
{ "t": "sent", "msgId": "01J8XK...", "recvAt": 1755230400150 }
```

**`receipt`** — 전달 확인 (누가 받았는지)
```json
{ "t": "receipt", "msgId": "01J8XK...", "by": "dev_mom", "at": 1755230401000 }
```

**`presence`** — 온라인 상태 변경 브로드캐스트
```json
{ "t": "presence", "deviceId": "dev_mom", "online": false, "at": 1755230500000 }
```

**`pong`**
```json
{ "t": "pong", "ts": 1755230400000, "serverTime": 1755230400130 }
```

**`error`**
```json
{ "t": "error", "code": "AUTH_FAILED", "msg": "설명" }
```

에러 코드: `AUTH_FAILED` / `UNKNOWN_DEVICE` / `BAD_REQUEST` / `UNSUPPORTED_VERSION` / `RATE_LIMITED`

### 4.5 신뢰성 규칙

1. **허브는 ack를 받기 전까지 메시지를 삭제하지 않는다.**
2. 클라이언트는 재접속할 때마다 미수신 메시지를 전부 다시 받는다.
3. 중복 배달은 **정상 동작**이다. 클라이언트가 `msgId`로 중복 제거한다.
4. 발신 실패 시 앱의 outbox에 남겨두고 재접속 시 재전송한다. 재전송해도 `msgId`는 **바꾸지 않는다**.

### 4.6 메시지 ID와 정렬 (중요)

**`msgId`는 ULID를 사용한다.** UUIDv4가 아니다.

- ULID는 앞 48비트가 타임스탬프 → **문자열 정렬 = 시간 정렬**
- 중앙 서버가 순번을 매기지 않는 구조이므로 ID 자체에 순서가 담겨야 한다

**정렬 기준**: 화면 표시는 `recvAt`(허브 도착 시각) 기준으로 정렬한다.

> 이유: `sentAt`은 발신자 폰의 시계다. 가족 중 누군가의 시계가 10분 틀어져 있으면 메시지가 과거로 튄다. 허브 시계 하나만 신뢰하면 전체 순서가 일관된다. 단, `sentAt`도 함께 저장해서 "보낸 시각"으로 표시하고, 두 값이 5분 이상 벌어지면 UI에 경고를 띄운다.

---

## 5. 데이터 모델

### 5.1 허브 SQLite

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

### 5.2 앱 Room DB

```kotlin
@Entity(tableName = "messages")
data class MessageEntity(
    @PrimaryKey val msgId: String,      // ULID
    val senderId: String,
    val body: String,                    // 복호화된 평문 (기기 내부에만)
    val sentAt: Long,
    val recvAt: Long,                    // 정렬 기준
    val isMine: Boolean,
    val state: String                    // PENDING|SENT|DELIVERED|FAILED
)

@Entity(tableName = "members")
data class MemberEntity(
    @PrimaryKey val deviceId: String,
    val displayName: String,
    val boxPubKey: ByteArray,
    val signPubKey: ByteArray,
    val verifiedAt: Long?,               // QR 대면 검증 시각. null이면 미검증
    val online: Boolean
)

@Entity(tableName = "outbox")
data class OutboxEntity(
    @PrimaryKey val msgId: String,
    val payloadJson: String,             // 암호화 완료된 send 프레임
    val createdAt: Long,
    val retryCount: Int
)
```

---

## 6. 상세 설계

### 6.1 암호화

| 용도 | 알고리즘 | 라이브러리 |
|---|---|---|
| 기기 인증 | Ed25519 서명 | lazysodium-android / Tink |
| 메시지 암호화 | X25519 + XSalsa20-Poly1305 (`crypto_box_easy`) | lazysodium-android |
| 개인키 보관 | Android Keystore로 래핑 후 EncryptedSharedPreferences | AndroidX Security |

**절차**
1. 앱 최초 실행 시 Ed25519 + X25519 키페어 2쌍 생성
2. 개인키는 Keystore 마스터키로 암호화하여 저장. **절대 기기 밖으로 나가지 않는다**
3. 발신 시 각 수신자의 `boxPubKey`로 개별 암호화 → payloads 배열 생성
4. nonce는 메시지·수신자 조합마다 새로 생성 (24바이트 랜덤)

**하지 말 것**
- nonce 재사용 (치명적)
- 개인키를 파일/로그/백업에 평문 저장
- `allowBackup=true` (매니페스트에서 **반드시 false**)

> Signal 수준의 전방향 비밀성(Double Ratchet)은 이번 범위에서 제외한다. 가족 5명, 신뢰 관계, 대면 키 교환이라는 전제에서 정적 키 방식으로 충분하다. 필요해지면 Phase 7에서 검토.

### 6.2 기기 등록 (Enrollment)

앱스토어가 없으므로 등록도 수동이다.

```
1. 앱 설치 → 최초 실행 시 키페어 생성
2. 앱이 자기 정보를 QR로 표시
   {"deviceId":"dev_abc","name":"아빠","signPub":"b64","boxPub":"b64"}
3. 허브 폰에서 실행:  node scripts/enroll.js --qr
   → 카메라 대신, QR 문자열을 복사해 붙여넣는 방식이 더 간단함
4. 허브 devices 테이블에 INSERT
5. 다음 접속부터 인증 통과
```

**멤버 간 공개키 교환**: 허브가 `welcome`의 `members`로 배포한다. 단, 허브가 공개키를 바꿔치기하면 중간자 공격이 가능하므로 → **가족이 한자리에 모여 서로 QR을 스캔해 `verifiedAt`을 채운다.** 미검증 멤버는 UI에 노란 경고 표시.

### 6.3 연결 유지 (안드로이드 핵심 난제)

**Foreground Service** + `OkHttp WebSocket`

```
- 서비스 타입: specialUse (아래 주석 참조)
- 상시 알림: "가족 메신저 연결됨" (낮은 우선순위 채널, 사용자에게 덜 거슬리게)
- 킵얼라이브: OkHttp pingInterval = 30초
- 재연결: 지수 백오프 1s → 2s → 4s → ... → 최대 60s (지터 ±20%)
- 네트워크 전환: ConnectivityManager.NetworkCallback으로 감지 → 즉시 재연결
- 재부팅: BOOT_COMPLETED 리시버로 서비스 자동 시작
```

> **서비스 타입 정정 (Phase 2 구현 중 발견)**: 초안은 `dataSync` 였으나 targetSdk 35에서 쓸 수 없다.
> Android 15는 `dataSync` 를 (a) `BOOT_COMPLETED` 리시버에서 시작 금지,
> (b) 24시간 중 누적 6시간으로 제한한다. 이 프로젝트의 완료 기준 "재부팅 후 자동 시작"과
> "8시간 방치 후 수신" 두 가지를 정면으로 어긴다.
> `specialUse` 는 두 제약을 모두 받지 않는다. 앱스토어 배포가 비목표(§1.3)이므로
> `specialUse` 의 스토어 심사 요건도 문제되지 않는다.

**Doze 모드 대응**
- Doze 진입 시 소켓이 조용히 죽는다. ping 응답 타임아웃(60초)으로 감지
- `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` 안내 화면을 **온보딩에 필수 단계로** 넣을 것
- 삼성/샤오미는 별도 절전 설정이 추가로 존재 → 제조사별 안내 문구 분기

**알림**
- 소켓으로 `deliver` 수신 → 복호화 → Room 저장 → `NotificationManager`로 로컬 알림
- FCM 사용하지 않음. 구글 의존 0

### 6.4 허브 운영 (Termux)

> **의존성 정정 (허브 폰 설치 중 발견)**: 초안의 `better-sqlite3` 는 Termux 에서 설치되지 않는다.
> 동봉된 미리 빌드 바이너리가 glibc·musl 용뿐인데 Termux 는 **Bionic libc** 를 쓰기 때문이고,
> 소스 빌드를 하려면 폰에 python·make·clang 을 깔아야 한다.
> Node 22.5+ 의 내장 `node:sqlite` 로 교체해 네이티브 의존성을 0으로 만들었다.
> 이제 런타임 의존성은 순수 JS 인 `ws` 와 `ulid` 뿐이다.

```bash
# 최초 설치
pkg install nodejs-lts       # Node 22.5 이상
npm install                  # 순수 JS 패키지만, 몇 초

# 필수: 잠자기 방지
termux-wake-lock

# 부팅 시 자동 실행: Termux:Boot 애드온 설치 후
# ~/.termux/boot/start-hub.sh 배치
```

`start-hub.sh` 요구사항:
- `termux-wake-lock` 실행
- Node 프로세스 감시 후 죽으면 재시작 (간단한 while 루프면 충분)
- 로그를 `~/hub.log`에 append, 10MB 초과 시 로테이트

**하드웨어 주의**
- 배터리 최적화 예외 + Wi-Fi 절전 해제
- 100% 상시 충전은 2~3년 내 배터리 스웰링 유발 → 케이스 제거, 통풍 확보
- 가능하면 충전 제한 앱으로 80% 유지

---

## 7. 단계별 구현 계획

각 Phase는 **반드시 완료 기준을 통과한 뒤** 다음으로 넘어간다. 특히 Phase 2를 건너뛰고 진도를 빼면 나중에 전부 되돌아온다.

### Phase 0 — 프로젝트 셋업 (0.5일)

- 모노레포 스캘폴딩 (§3 구조)
- `CLAUDE.md`, `PROTOCOL.md` 작성
- 허브: `npm init` + ws + ulid (SQLite 는 Node 내장 `node:sqlite`)
- 앱: 빈 Compose 프로젝트, minSdk 26 / targetSdk 35

**완료 기준**: 허브가 8787 포트에서 WS 연결을 수락하고 에코를 반환한다.

---

### Phase 1 — 같은 Wi-Fi, 평문 통신 (2일)

> 암호화·Tailscale·인증을 **전부 뺀다.** 배관만 뚫는 단계.

- 허브: `deviceId`를 그냥 신뢰. `send` → 전원 브로드캐스트
- 허브: SQLite outbox 저장/조회/삭제
- 앱: Room + Repository + 최소 Compose 채팅 UI
- 앱: 접속 시 미수신 메시지 수신, `ack` 전송
- ULID 생성/정렬 적용

**완료 기준**
- 폰 2대가 같은 Wi-Fi에서 메시지를 주고받는다
- 한 대를 비행기 모드 → 메시지 발신 → 비행기 모드 해제 시 밀린 메시지가 도착한다
- 같은 메시지를 두 번 배달해도 UI에 하나만 뜬다

---

### Phase 2 — 연결 안정성 (3일, 가장 오래 걸림)

- Foreground Service 전환 + 상시 알림
- 지수 백오프 재연결, ping/pong 타임아웃 감지
- `BOOT_COMPLETED` 자동 시작
- 배터리 최적화 예외 요청 온보딩 화면
- 로컬 알림 생성
- Termux 부팅 스크립트 + 프로세스 감시

**완료 기준 (실측 필수)**
- 화면 끈 채 **8시간** 방치 후 메시지 수신 성공
- Wi-Fi ↔ LTE 전환 시 30초 내 자동 재연결
- 폰 재부팅 후 사용자 개입 없이 서비스 재시작
- 허브 폰을 강제 재부팅해도 자동 복구
- 24시간 배터리 소모 5% 이내

> 이 단계에서 실패 사례를 모두 기록해 둘 것. 제조사별 절전 정책이 다르므로 가족 폰 기종마다 개별 확인이 필요하다.

---

### Phase 3 — 외부망 (Tailscale) (1일)

- 전 기기 Tailscale 설치, 동일 tailnet 가입
- 허브 IP를 `100.x.x.x`로 고정, 앱 설정 화면에 입력란
- 허브 바인딩을 `0.0.0.0`이 아닌 **tailscale0 인터페이스로 제한**

**완료 기준**: 집 밖 LTE에서 정상 송수신. Tailscale 미가입 기기는 접속 불가.

---

### Phase 4 — 인증 + E2E 암호화 (3일)

- Ed25519 키페어 생성, Keystore 보관
- 챌린지-응답 핸드셰이크 (§4.3)
- X25519 `crypto_box` 암복호화, 수신자별 payload
- `enroll.js` CLI
- `android:allowBackup="false"` 확인

**완료 기준**
- 미등록 기기 접속 시 `AUTH_FAILED`
- **허브 SQLite를 직접 열어봤을 때 메시지 내용을 읽을 수 없다** ← 이 프로젝트의 존재 이유. 반드시 눈으로 확인
- 앱 재설치 후 키 재생성 → 재등록 절차가 문서대로 동작

---

### Phase 5 — 대면 키 검증 + 마감 (2일)

- 내 정보 QR 표시 / 상대 QR 스캔 → `verifiedAt` 기록
- 미검증 멤버 경고 UI
- 발신 상태 표시 (전송중/도착/읽음)
- APK 서명 및 배포. **서명 키를 별도 백업** (분실 시 전원 재설치)
- 로컬 대화 백업/복원 (암호화된 파일 export)

**완료 기준**: 가족 전원 폰에 설치 완료, 1주일 실사용 무장애.

---

### 이후 검토 항목 (Phase 6+)

- 이미지 전송 (썸네일 + 암호화 blob)
- 메시지 삭제/편집
- 허브 이중화 또는 자동 백업
- Double Ratchet 도입

---

## 8. Claude Code 실행 가이드

### 8.1 `CLAUDE.md`

프로젝트 루트의 `CLAUDE.md` 참조.

### 8.2 Phase별 시작 프롬프트

각 세션을 이 문장으로 시작하면 된다.

**Phase 1**
```
PLAN.md와 PROTOCOL.md를 읽어. Phase 1을 구현한다.
암호화와 인증은 아직 넣지 마라. hub/ 먼저 완성하고
Node.js로 된 더미 클라이언트 2개로 송수신·오프라인 큐잉·
중복 제거를 검증한 뒤 안드로이드 앱으로 넘어가라.
```

**Phase 2**
```
Phase 2를 구현한다. MessengerService를 Foreground Service로
전환하고 §6.3의 재연결·Doze 대응을 전부 적용해라.
제조사별 절전 설정 안내 문구도 온보딩에 포함해라.
```

**Phase 4**
```
Phase 4를 구현한다. §4.3 핸드셰이크와 §6.1 암호화를 적용해라.
작업 후 허브 SQLite를 직접 덤프해서 평문이 없음을 증명하는
검증 스크립트도 함께 작성해라.
```

### 8.3 Claude Code에게 맡기기 좋은 것 / 사람이 해야 하는 것

| Claude Code | 사람이 직접 |
|---|---|
| 허브 서버 전체 | 실기기 8시간 방치 테스트 |
| 프로토콜 직렬화/파싱 | 제조사별 절전 설정 확인 |
| Room/SQLite 스키마 | Tailscale 가입 및 기기 승인 |
| 재연결 로직 | 가족 모여서 QR 대면 검증 |
| Compose UI | APK 서명 키 백업 |
| 암복호화 래퍼 | 허브 폰 물리 설치·발열 관리 |

---

## 9. 리스크 및 대응

| 리스크 | 영향 | 대응 |
|---|---|---|
| 제조사 절전이 서비스를 죽임 | 알림 미수신 (치명) | Phase 2에서 기종별 실측. 최후 수단으로 FCM 폴백 옵션 검토 |
| 허브 폰 배터리 스웰링 | 화재 위험 | 케이스 제거, 통풍, 80% 충전 제한, 연 1회 육안 점검 |
| 허브 사망 = 전체 중단 | 서비스 정지 | 앱이 로컬 이력 보관하므로 과거 대화는 안전. 허브 DB 주기 백업 |
| 앱 재설치 시 키 소실 | 재등록 필요 | 백업/복원 기능(Phase 5) + 재등록 절차 문서화 |
| 허브 공개키 바꿔치기 | 중간자 공격 | 대면 QR 검증으로 차단 (Phase 5) |
| 정전/인터넷 단절 | 일시 중단 | 앱 outbox가 보관 후 복구 시 재전송 |

---

## 10. 총 일정 요약

| Phase | 내용 | 기간 |
|---|---|---|
| 0 | 셋업 | 0.5일 |
| 1 | 평문 통신 | 2일 |
| 2 | 연결 안정성 | 3일 |
| 3 | Tailscale | 1일 |
| 4 | 인증 + 암호화 | 3일 |
| 5 | 키 검증 + 마감 | 2일 |
| | **합계** | **약 11.5일** |

Phase 2는 실기기 대기 시간이 포함되므로 달력 기준으로는 더 길어질 수 있다. Phase 2와 3을 병행하면 전체 일정을 줄일 수 있다.
