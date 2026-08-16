# 가족 메신저 — 허브

가족 전용 종단간 암호화 메신저의 서버(허브) 쪽. 집에 상시 전원 연결된 구형 안드로이드 폰의
Termux 위에서 도는 Node.js WebSocket 중계 서버다.

**허브는 암호문을 옮기고 잠시 보관할 뿐, 메시지 내용을 읽지 못한다.**
이건 주장이 아니라 [검사 스크립트](scripts/verify-no-plaintext.js)로 증명되는 성질이다.

- 안드로이드 앱: [family-messenger-app](https://github.com/cafealpa/family-messenger-app)

---

## 구조

```
src/
  index.js        진입점, 시그널 처리
  server.js       WebSocket 수명주기, 핸드셰이크 상태 기계
  auth.js         Ed25519 챌린지-응답, 멤버 목록/지문
  router.js       send/ack/ping 라우팅, 큐잉, presence
  db.js           SQLite 열기 + 스키마
  tailscale.js    100.64.0.0/10 판별, 바인딩 주소 결정
  config.js       환경변수
scripts/
  enroll.js                 기기 등록 CLI
  verify-no-plaintext.js    평문 부재 증명
  dummy-client.js           앱과 동일 프로토콜의 테스트 클라이언트
  start-hub.sh              Termux 부팅 + 감시 루프
test/                       50개
```

런타임 의존성은 **순수 JS 두 개뿐**이다: `ws`, `ulid`.
SQLite 는 Node 내장 `node:sqlite` 를 쓰므로 **네이티브 모듈이 없다** — 허브 폰에서
컴파일할 것이 없다는 뜻이다.
`tweetnacl`은 devDependency로, 테스트와 더미 클라이언트에서만 쓴다. 허브 서버 코드는
암복호화를 하지 않으며 그게 이 프로젝트의 존재 이유다.

---

## 요구 사항

**Node 22.5.0 이상.** 내장 SQLite(`node:sqlite`)가 그때 들어왔다.
`npm start` 는 `--experimental-sqlite` 플래그를 붙여 실행하므로 22.5~23.3 에서도 그대로 동작한다.

## 설치

```bash
pkg install nodejs-lts      # Termux
npm install
```

받는 것은 순수 JS 패키지뿐이라 몇 초면 끝난다. 컴파일 도구가 필요 없다.

## 실행

```bash
npm start
```

| 환경변수 | 기본값 | 설명 |
|---|---|---|
| `HUB_HOST` | `0.0.0.0` | `tailscale`이면 이 폰의 Tailscale 주소(100.x)에만 바인딩 |
| `HUB_PORT` | `8787` | |
| `HUB_DB` | `data/hub.sqlite` | |
| `HUB_REQUIRE_TAILSCALE` | 꺼짐 | `1`이면 tailnet 밖 주소 거절 |

`HUB_HOST=tailscale`인데 주소를 못 찾으면 **시작을 거부한다.**
조용히 `0.0.0.0`으로 물러서면 "잠갔다고 믿는데 실제로는 열려 있는" 상태가 되기 때문이다.

헬스체크: `http://<주소>:8787/health` → `{"ok":true,"online":2,"queued":0}`

### 부팅 시 자동 실행

```bash
mkdir -p ~/.termux/boot
cp scripts/start-hub.sh ~/.termux/boot/
chmod +x ~/.termux/boot/start-hub.sh
```

`Termux:Boot` 앱을 한 번 실행해야 훅이 등록된다. 설치만 하면 안 된다.

---

## 기기 등록

인증에 비밀번호가 없다. 기기는 Ed25519 개인키로 자신을 증명하고, **등록은 사람이 한다.**

```bash
node scripts/enroll.js '<앱의 "등록 정보 복사" 결과>'
node scripts/enroll.js --stdin          # 따옴표가 번거로울 때
node scripts/enroll.js --list
node scripts/enroll.js --remove dev_xxx
```

같은 `deviceId`를 다른 키로 재등록하면 `rekeyed` 경고가 뜬다.
앱 재설치라면 정상이고, 그런 적이 없다면 조사해야 한다.

---

## 허브가 정말 못 읽는지 확인

```bash
node scripts/verify-no-plaintext.js --expect "방금 보낸 문장"
```

스키마에 본문 컬럼이 없는지, outbox 내용이 읽을 수 없는 바이트인지, nonce가 재사용되지
않았는지, 로그에 본문이 새지 않았는지, DB 파일 바이트 어디에도 그 문장이 없는지를 검사한다.
**코드를 고친 뒤에는 반드시 돌린다.**

## 테스트

```bash
npm test        # 50개
```

## 더미 클라이언트

앱 없이 터미널만으로 송수신을 확인할 수 있다. 앱과 같은 프로토콜, 같은 암호화를 쓴다.

```bash
node scripts/dummy-client.js --id dev_dad --name 아빠 --keys dad.json --print-enrollment
# 출력된 JSON을 enroll.js에 넣은 뒤
node scripts/dummy-client.js --id dev_dad --name 아빠 --keys dad.json
```

---

## 문서

| 문서 | 내용 |
|---|---|
| [PROTOCOL.md](PROTOCOL.md) | **프로토콜 규격 정본.** 구현의 근거 |
| [OPERATIONS.md](OPERATIONS.md) | 설치·운영·장애 대응 런북 |
| [HANDOVER.md](HANDOVER.md) | 프로젝트 전체 파악, 검증 결과, 설계 근거 |
| [PLAN.md](PLAN.md) | 원래 설계와 일정 |
| [CLAUDE.md](CLAUDE.md) | 코드 작업 규칙과 불변 조건 |

프로토콜을 바꿀 때는 **PROTOCOL.md를 먼저 고치고** 양쪽 저장소를 함께 갱신한다.
