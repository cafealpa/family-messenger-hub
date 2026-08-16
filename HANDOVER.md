# 인수인계 보고서

> 이 문서 하나로 프로젝트 전체를 파악할 수 있게 쓴 인수인계 문서다.
> 설계 의도는 [PLAN.md](PLAN.md), 프로토콜 규격은 [PROTOCOL.md](PROTOCOL.md),
> 작업 규칙은 [CLAUDE.md](CLAUDE.md) 참조.
> 운영은 [OPERATIONS.md](https://github.com/cafealpa/family-messenger-hub/blob/main/OPERATIONS.md),
> 가족용 안내는 [USER-GUIDE.md](https://github.com/cafealpa/family-messenger-app/blob/main/USER-GUIDE.md).
>
> 작성 시점: Phase 0~5 구현 완료 직후

## 저장소 두 개

코드는 두 저장소로 나뉘어 있다. 배포 주기가 다르기 때문이다.

| 저장소 | 내용 |
|---|---|
| [family-messenger-hub](https://github.com/cafealpa/family-messenger-hub) | Node.js 허브. **PROTOCOL.md 정본**, 운영 문서 |
| [family-messenger-app](https://github.com/cafealpa/family-messenger-app) | 안드로이드 앱. 가족용 사용 설명서 |

이 문서는 두 저장소를 함께 설명한다. 아래에서 경로 앞의 `hub/` 와 `app/` 는
각각 그 저장소의 **루트**를 가리킨다. 예를 들어 `hub/src/server.js` 는
family-messenger-hub 저장소의 `src/server.js` 다.

**프로토콜을 바꿀 때는 허브 저장소의 PROTOCOL.md 를 먼저 고치고 양쪽을 함께 갱신한다.**
저장소를 나눈 대가로 이 변경만은 원자적이지 않다.

---

## 1. 한눈에 보기

| 항목 | 내용 |
|---|---|
| 무엇 | 가족 전용 종단간 암호화 메신저. 집에 둔 구형 안드로이드 폰이 서버 역할 |
| 왜 | 제3자 서버에 메시지가 남지 않게. 허브 운영자(가족)조차 내용을 못 읽게 |
| 구성 | Node.js 허브(Termux) + 안드로이드 앱(Kotlin/Compose) |
| 상태 | Phase 0~5 구현 완료. 자동 검증 통과. **실기기 장기 테스트는 미완** |
| 테스트 | 96개 통과 (허브 50 / 앱 JVM 34 / 실기기 암호화 12) |
| 코드 규모 | 허브 JS 7개 + 스크립트 4개, 앱 Kotlin 20개 |

**지금 당장 가족이 쓸 수 있는가?** 기능적으로는 그렇다. 다만 §9의 실기기 확인 5가지를
끝내기 전에는 "밤새 알림이 끊기지 않는다"를 보장할 수 없다.

---

## 2. 아키텍처

```
   아빠 폰            엄마 폰            형 폰
  ┌────────┐        ┌────────┐        ┌────────┐
  │ 앱      │        │ 앱      │        │ 앱      │
  │ 평문    │        │ 평문    │        │ 평문    │
  │ 개인키  │        │ 개인키  │        │ 개인키  │
  └───┬────┘        └───┬────┘        └───┬────┘
      │  암호문만 흐름     │                 │
      └────────┬─────────┴────────┬────────┘
               ▼                  ▼
        ┌────────────────────────────┐
        │  허브 (집에 둔 구형 폰)        │
        │  Termux → Node.js → SQLite  │
        │                            │
        │  하는 일: 중계, 임시 보관     │
        │  못 하는 일: 복호화          │
        └────────────────────────────┘
```

### 왜 이 구조인가

P2P 메신저의 어려운 부분(상대 발견, NAT 홀펀칭, 상대가 꺼져 있을 때의 보관)을
허브 하나로 전부 우회한다. 대신 허브가 단일 장애점이 되지만, 가족용이므로
"허브가 죽으면 재부팅한다" 수준으로 감당 가능하다.

허브는 SPOF지만 **데이터의 단일 지점은 아니다.** 각 폰이 자기 대화 이력을 갖고 있고,
허브는 전달이 끝난 메시지를 지운다. 허브 폰이 물에 빠져도 과거 대화는 무사하다.

### 메시지 한 통의 여정

```
1. 아빠 앱: 평문 "저녁 뭐 먹어?"
2. 아빠 앱: 수신자별로 따로 암호화
     엄마용 = crypto_box(평문, nonce₁, 엄마_공개키, 아빠_비밀키)
     형용   = crypto_box(평문, nonce₂, 형_공개키,   아빠_비밀키)
3. 허브: 암호문 2건을 outbox 에 저장 (recv_at 기록 = 정렬 기준)
4. 허브: 접속 중인 수신자에게 즉시 밀어줌. 오프라인이면 큐에 남김
5. 엄마 앱: 아빠 공개키로 복호화 → Room 저장 → 알림 → ack
6. 허브: ack 받은 행 DELETE. 원 발신자에게 receipt 전달
```

허브는 3~4번에서 **바이트를 옮길 뿐**이다. 이걸 스스로 증명하는 스크립트가
`hub/scripts/verify-no-plaintext.js`다.

---

## 3. 저장소 구성

### 허브 (`hub/`)

| 파일 | 역할 | 주의 |
|---|---|---|
| `src/index.js` | 진입점, 시그널 처리, 종료 코드 | 설정 오류는 78(EX_CONFIG)로 종료 → 부팅 스크립트가 구분 |
| `src/server.js` | WebSocket 수명주기, 핸드셰이크 상태 기계 | 인증 전에는 hello/auth 만 받는다 |
| `src/auth.js` | Ed25519 챌린지-응답, 멤버 목록/지문 | nonce 1회용, 60초 만료 |
| `src/router.js` | send/ack/ping 라우팅, 큐잉, presence | **ack 전에는 절대 삭제 안 함** |
| `src/db.js` | SQLite 열기 + 스키마 | 본문 컬럼 추가 금지 |
| `src/tailscale.js` | 100.64.0.0/10 판별, 바인딩 주소 결정 | 못 찾으면 시작 거부 |
| `src/config.js` | 환경변수 | |
| `scripts/enroll.js` | 기기 등록 CLI | 재등록 시 `rekeyed` 경고 |
| `scripts/verify-no-plaintext.js` | 평문 부재 증명 | 프로젝트 존재 이유의 검사기 |
| `scripts/dummy-client.js` | 앱과 동일 프로토콜의 테스트 클라이언트 | 라이브러리 겸 CLI |
| `scripts/start-hub.sh` | Termux 부팅 + 감시 루프 | wake-lock, 로그 로테이트 |

### 앱 (`app/app/src/main/java/com/family/messenger/`)

| 파일 | 역할 |
|---|---|
| `FamilyMessengerApp.kt` | 앱 시작 시 키 생성, 싱글턴 조립 |
| `MainActivity.kt` | 화면 라우팅만. 연결 유지는 서비스 담당 |
| `crypto/SodiumCrypto.kt` | libsodium 얇은 래퍼 (Ed25519, crypto_box) |
| `crypto/KeyManager.kt` | 개인키 보관 (Keystore + EncryptedSharedPreferences) |
| `crypto/SafetyNumber.kt` | 대면 검증용 20자리 번호 계산 |
| `crypto/BackupCrypto.kt` | 백업 파일 암호화 (Argon2id + secretbox) |
| `net/HubClient.kt` | 소켓, 재연결 4중 방어, 챌린지 응답 |
| `net/NetworkWatcher.kt` | Wi-Fi↔LTE 전환 감지 |
| `net/Frames.kt` | 프로토콜 직렬화/파싱 |
| `net/Ulid.kt` | 단조 ULID 생성기 |
| `data/MessengerRepository.kt` | 프레임 ↔ Room 연결, 암복호화 지점 |
| `data/Settings.kt` `Entities.kt` `Daos.kt` `AppDatabase.kt` | 설정과 저장소 |
| `data/BackupManager.kt` | 대화 내보내기/복원 |
| `service/MessengerService.kt` | 포그라운드 서비스 (연결 유지의 핵심) |
| `service/BootReceiver.kt` | 재부팅 후 자동 시작 |
| `service/PowerSettings.kt` | 제조사별 절전 설정 안내와 인텐트 |
| `notify/Notifications.kt` | 로컬 알림 (FCM 미사용) |
| `ui/*.kt` | Compose 화면 6개 |

### 읽는 순서 추천

처음 보는 사람은 이 순서가 빠르다:

1. `PROTOCOL.md` — 두 쪽이 무슨 말을 주고받는지
2. `hub/src/server.js` — 연결이 어떻게 성립하는지
3. `hub/src/router.js` — 메시지가 어떻게 흐르는지
4. `app/.../data/MessengerRepository.kt` — 앱 쪽 전체 흐름이 여기 모여 있다
5. `app/.../net/HubClient.kt` — 가장 까다로운 부분(재연결)

---

## 4. 핵심 설계 결정과 근거

### 4.1 ack 전에는 지우지 않는다

허브는 수신자가 명시적으로 `ack` 하기 전까지 outbox 행을 유지한다.
그 결과 **중복 배달이 정상 동작**이 되고, 클라이언트가 `msgId`(PK 충돌)로 걸러낸다.

앱은 Room 저장이 끝난 **뒤에** ack 한다. 순서가 반대면 허브가 지운 직후
앱이 죽었을 때 메시지가 영영 사라진다.

### 4.2 정렬은 recvAt(허브 시각), ID는 단조 ULID

가족 중 한 명의 폰 시계가 틀어져 있으면 `sentAt` 기준 정렬은 메시지를 과거로 보낸다.
허브 시계 하나만 신뢰하면 **전원이 같은 순서를 본다.**

`recvAt` 동률일 때 `msgId`로 순서를 가르는데, 표준 ULID는 같은 밀리초 안에서
랜덤 80비트를 새로 뽑아 정렬 순서를 보장하지 못한다. 그래서 양쪽 모두
**단조 생성기**를 쓴다 (`monotonicFactory` / `Ulid.next()`).

### 4.3 수신자별 개별 암호화

그룹키를 공유하지 않는다. 멤버가 바뀔 때마다 키 로테이션을 해야 하고,
그 로직이 이 규모에서 감당할 가치가 없다. 텍스트 메시지라 N배 복사해도 용량이 무의미하다.

nonce는 **메시지·수신자 조합마다** 새로 만든다. 재사용은 치명적이다.

### 4.4 멤버 변경은 지문으로 감지

허브는 `welcome`으로만 멤버 정보를 배포한다. 초기 구현은 "처음 접속하는 기기면
다른 기기에 welcome 재전송"이었는데, 연결 종료 처리(`last_seen_at` 갱신)와 경합해
갱신을 놓치는 일이 있었다. 지금은 devices 테이블의 SHA-256 지문을 연결마다 기억해
두고 달라졌을 때만 재전송한다. 등록·이름 변경·해제를 모두 잡는다.

### 4.5 연결 유지 4중 방어 (`HubClient.kt`)

1. OkHttp 프레임 ping 30초 — TCP 수준 사망 감지
2. **프로토콜 ping/pong, 60초 무응답이면 강제 재연결** — Doze에서 소켓이
   "열린 채로 조용히 죽는" 상태를 잡는 유일한 수단
3. 지수 백오프 1s→60s, 지터 ±20% — 정전 복구 때 가족 폰이 동시에 몰리는 것 방지
4. `ConnectivityManager` 콜백으로 백오프 대기를 즉시 깨움

welcome까지 도달했던 연결이면 백오프를 리셋한다. 8시간 붙어 있다가 한 번 끊긴
경우 60초를 기다리는 대신 1초 만에 복귀한다.

---

## 5. Phase별 완료 기준 검증

### Phase 0 — 셋업

| 기준 | 결과 | 근거 |
|---|---|---|
| 8787에서 WS 수락 + 에코 | ✅ | 실제 포트 접속으로 왕복 확인 |

### Phase 1 — 평문 통신

| 기준 | 결과 | 근거 |
|---|---|---|
| 두 참여자 송수신 | ✅ | 에뮬레이터 앱 ↔ 더미 클라이언트 양방향 |
| 오프라인 후 밀린 메시지 도착 | ✅ | 양방향 확인. 앱 종료 중 2건 큐잉 후 재시작 시 순서대로 수신 |
| 중복 배달 시 UI에 1건 | ✅ | 같은 msgId 2회 실제 배달 → deliver 2회, DB 1행 |

> 완료 기준 1은 **실기기 2대가 아니라** 에뮬레이터 1대 + 더미 클라이언트로 확인했다.

### Phase 2 — 연결 안정성

| 기준 | 결과 | 근거 |
|---|---|---|
| 백그라운드 수신 + 알림 | ✅ | `channel=messages` importance=4 알림 2건 + 상시 알림 |
| 프로세스 강제 종료 후 복구 | ✅ | `kill -9` PID 4519 → 20초 내 PID 4678로 재시작, 허브 재연결 |
| 재부팅 후 자동 시작 | ✅ | 앱을 열지 않고 BootReceiver → FGS → 접속 |
| Wi-Fi↔LTE 30초 내 재연결 | ✅ | **1.6초** (비행기 모드 해제 기준) |
| 허브 강제 종료 후 복구 | ✅ | 허브 재기동 즉시 복귀 |
| **화면 끈 채 8시간 방치** | ⚠️ 미검증 | 에뮬레이터 강제 Doze는 네트워크를 실제로 차단하지 않아 무의미 |
| **24시간 배터리 5% 이내** | ⚠️ 미검증 | 실기기 필요 |

포그라운드 서비스는 `types=40000000`(SPECIAL_USE)로 실행 중임을 dumpsys로 확인했다.

### Phase 3 — 외부망 (Tailscale)

| 기준 | 결과 | 근거 |
|---|---|---|
| Tailscale 미가입 기기 접속 불가 | ✅ | `HUB_REQUIRE_TAILSCALE=1` 시 tailnet 밖 주소 거절 (테스트) |
| 주소 판별 정확성 | ✅ | 100.63.255.255 / 100.128.0.0 경계, IPv4-mapped IPv6 포함 테스트 |
| 주소 못 찾으면 시작 거부 | ✅ | 조용히 0.0.0.0으로 물러서지 않음 (테스트) |
| **집 밖 LTE에서 송수신** | ⚠️ 미검증 | 실제 tailnet 필요 |

### Phase 4 — 인증 + E2E 암호화

| 기준 | 결과 | 근거 |
|---|---|---|
| 미등록 기기 접속 거부 | ✅ | 실앱에서 `UNKNOWN_DEVICE` 후 지수 백오프 재시도 |
| **허브 DB에서 내용을 읽을 수 없다** | ✅ | 아래 원시 덤프 참조 + 검증 스크립트 5개 항목 통과 |
| 재설치 후 재등록 절차 동작 | ✅ | 옛 키 → `signature does not match enrolled key` → `rekeyed` 등록 → 접속 성공 |

실제 허브 DB에서 뽑은 한 행:

```
msg_id     : 01M04KTBC67MFG926WFRV4KN4G
from -> to : dev_emuphone -> dev_mom
ciphertext : 90555413e11378209cef0727c591bb5021bc2c0a8decf8cce132d4c65098656f9f485f026b0f
as utf8    : "�UT�x ��'..."
nonce      : 277d49e7e7bf74ecf9f3cdeaad40240b5e5758122c58bf87
```

검증 스크립트 출력:

```
[OK] 스키마 검사: 테이블 3개에 본문용 평문 컬럼 없음
[OK] outbox 1건: 모두 암호문으로 보임 (가장 읽을 만한 행도 41%, 기준 50% 미만)
[OK] nonce 검사: 1건 모두 서로 다른 nonce
[OK] events 로그 18건: 본문 유출 없음
[OK] 파일 바이트 검사: 3개 파일 어디에도 "hub-must-not-read-this" 없음
✓ 허브 DB 에서 메시지 내용을 읽을 수 없습니다.
```

Kotlin(lazysodium) ↔ Node(tweetnacl/crypto) **교차 구현 검증**이라는 점이 중요하다.
한쪽 구현의 버그가 다른 쪽에서 드러난다.

### Phase 5 — 대면 검증 + 마감

| 기준 | 결과 | 근거 |
|---|---|---|
| 안전 번호가 양쪽에서 일치 | ✅ | 앱 표시 `92005 50284 06206 80312` = 독립 계산값 |
| 검증 기록 + 미검증 경고 UI | ✅ | `verifiedAt` 저장, 배너 표시/해제 확인 |
| 발신 상태 표시 | ✅ | 전송중 / 전송됨 / 도착 |
| 백업 내보내기·복원 | ✅ | 실기기 SAF 왕복, `FMBK1` 매직 + 암호문 확인 |
| APK 서명 설정 | ✅ | `keystore.properties` 기반. 키 자체는 저장소에 없음 |
| **1주일 실사용 무장애** | ⚠️ 미검증 | 사용자 몫 |

---

## 6. 계획서에서 벗어난 결정

| 항목 | 계획서 | 실제 | 이유 |
|---|---|---|---|
| FGS 타입 | `dataSync` | `specialUse` | Android 15가 dataSync를 BOOT_COMPLETED에서 금지하고 하루 6시간으로 제한. 완료 기준 두 개를 정면으로 위반 |
| 대면 검증 | 상대 QR 스캔 | 안전 번호 대조 | 보안 성질 동일(양쪽 공개키 해시), 카메라 권한 불필요, 검증 가능. 내 정보 QR 표시는 유지 |
| ULID | 명시 없음 | 단조 생성기 강제 | 표준 생성기는 같은 ms 안 정렬을 보장 못 해 연타 메시지가 뒤집힘 |
| release 난독화 | "Phase 5에서 켠다" | 끈 채로 둠 | Room/serialization/JNA가 리플렉션 사용. 스토어 배포 없어 크기 이득 없음 |
| 허브 의존성 | ws/better-sqlite3/ulid | + `tweetnacl` (dev) | 더미 클라이언트가 앱과 같은 암호화를 해야 E2E 검증이 성립. **런타임 아님** |

추가한 것(계획서에 없던 것):

- `/health` HTTP 엔드포인트 — 감시 스크립트와 육안 확인용
- `send` 분당 60개 레이트 제한 — 앱 재전송 루프 폭주로부터 허브 저장소 보호
- `HUB_REQUIRE_TAILSCALE` — 바인딩과 별개의 2차 방어선
- 공개키가 바뀌면 `verifiedAt` 자동 무효화 — 재설치든 공격이든 재확인이 필요

---

## 7. 개발 중 발견해 고친 실제 버그

전부 테스트가 잡았다. 기록해 두는 이유는 같은 함정을 다시 밟지 않기 위해서다.

1. **ULID가 같은 밀리초 안에서 시간순 정렬을 깨뜨림**
   `첫째/둘째/셋째`가 `둘째/첫째/셋째`로 뒤집혔다. 표준 `ulid()`는 호출마다
   랜덤을 새로 뽑는다. → 단조 생성기로 교체, PROTOCOL.md §7.1 신설.

2. **먼저 설치한 사람이 나중에 합류한 가족에게 메시지를 못 보냄**
   앱은 멤버를 `welcome`으로만 배우는데 접속 직후 한 번뿐이었다. `presence`에는
   이름도 공개키도 없어 새 멤버를 만들 수 없다. 에뮬레이터에서 `members` 테이블이
   빈 채 남는 것을 확인했다. → 멤버 구성 변경 시 welcome 재전송.

3. **멤버 변경 감지가 연결 종료 처리와 경합**
   `last_seen_at IS NULL`로 신규 기기를 판정했는데, 클라이언트 close 후 서버의
   close 핸들러가 비동기로 `touchLastSeen`을 실행해 판정을 놓쳤다.
   → devices 테이블 지문(SHA-256) 비교로 교체.

4. **JNA 중복 클래스로 dex 실패**
   lazysodium이 끌고 오는 jna(jar)와 안드로이드용 jna(aar)가 충돌.
   → lazysodium에서 jna 제외 후 aar만 사용.

테스트 하니스 자체의 버그도 두 건 있었다(프레임 큐 이중 소비, EventEmitter의
리스너 없는 `error` 이벤트). 프로덕션 코드 문제는 아니지만 고쳐 뒀다.

---

## 8. 알려진 한계

| 한계 | 영향 | 대응 |
|---|---|---|
| outbox의 send 프레임은 **작성 시점의 멤버 목록·공개키가 굳어 있다** | 오프라인 중 새로 등록한 가족은 그 메시지를 못 받음 | 감수. 다음 메시지부터는 정상 |
| 앱 재설치 시 deviceId와 키가 모두 새로 생김 | 옛 기기가 유령 멤버로 남음 | `enroll.js --remove`로 수동 정리 |
| 전방향 비밀성(Double Ratchet) 없음 | 개인키 유출 시 그 기기가 받은 과거 메시지 복호화 가능 | 계획서가 명시한 범위 밖. 필요해지면 재검토 |
| 허브는 "누가 언제 보냈는지"를 안다 | 메타데이터 노출 | 비목표(PLAN.md §1.3). 가족이므로 수용 |
| 허브가 오프라인 감지에 최대 ~60초 | presence 표시가 잠깐 낡음 | 감수 |
| 그룹 1개 고정 | 개별 대화 불가 | 비목표 |
| 이미지·파일 전송 없음 | 텍스트만 | Phase 6 검토 항목 |

---

## 9. 남은 작업 — 사람이 직접 해야 하는 것

우선순위 순.

1. **실기기 8시간 방치 테스트** (가장 중요)
   가족 폰 기종마다 개별 확인. 화면 끄고 8시간 뒤 메시지가 도착하는지.
   실패하면 §6의 제조사별 절전 설정을 다시 점검한다.
   이 프로젝트에서 가장 깨지기 쉬운 지점이다.

2. **24시간 배터리 소모 측정** — 5% 이내가 목표.

3. **Tailscale 가입 및 실제 LTE 접속 확인**
   전 기기를 같은 tailnet에 넣고, 허브를 `HUB_HOST=tailscale`로 실행한 뒤
   집 밖에서 송수신을 확인한다.

4. **가족이 모여 안전 번호 대조**
   하기 전까지는 허브가 공개키를 바꿔치기했을 가능성을 배제할 수 없다.

5. **APK 서명 키 생성 및 별도 백업**
   분실하면 전원 재설치다. README의 "APK 서명" 절 참조.

6. **허브 폰 물리 설치** — 케이스 제거, 통풍 확보, 가능하면 80% 충전 제한.

---

## 10. 테스트 실행

```bash
cd hub && npm test                              # 50개
cd app && ./gradlew testDebugUnitTest           # 34개 (JVM)
cd app && ./gradlew connectedDebugAndroidTest   # 12개 (기기 필요, 네이티브 암호화)
```

`connectedDebugAndroidTest`는 실행 후 앱을 제거한다. 이어서 손으로 확인할 거라면
다시 설치하고 허브에 재등록해야 한다(키가 새로 생기므로 `rekeyed`).

### 테스트가 지키고 있는 불변 규칙

| 규칙 | 지키는 테스트 |
|---|---|
| 허브에 평문 없음 | `hub/test/schema.test.js`, `e2e-crypto.test.js`, `verify-no-plaintext.js` |
| msgId는 ULID, 정렬은 recvAt | `hub/test/phase1.test.js`, `app/.../UlidTest.kt` |
| nonce 재사용 금지 | `e2e-crypto.test.js`, verify 스크립트의 중복 검사 |
| 미등록 기기 거부 | `hub/test/auth.test.js` |
| 백업 파일에 평문 없음 | `CryptoInstrumentedTest.kt` |

---

## 11. 개발 환경 메모

- 허브: Node.js 20+. `better-sqlite3`는 네이티브 모듈이라 **허브 폰에서 직접 설치**해야 한다.
  PC의 `node_modules`를 복사하면 동작하지 않는다.
- 앱: **JDK 17~21**. 시스템 기본이 25면 AGP 8.7이 거부한다.
  Android Studio 번들 JBR 21로 검증했다.
- Windows PowerShell에서 `enroll.js`에 JSON을 넘길 때는 `--stdin`을 쓴다.
  작은따옴표가 벗겨지고 BOM이 붙는다(스크립트가 BOM은 걷어내지만 따옴표 문제는 남는다).
- 검증에 쓴 에뮬레이터 AVD 이름은 `familychat_test` (android-34, x86_64).
