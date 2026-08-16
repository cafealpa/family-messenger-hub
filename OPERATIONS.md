# 운영 매뉴얼

> 허브 폰을 설치하고 굴리는 사람을 위한 문서. 장애가 났을 때는 §5 로 바로 간다.
> 전체 구조는 [HANDOVER.md](HANDOVER.md), 가족 구성원용 안내는
> [USER-GUIDE.md](https://github.com/cafealpa/family-messenger-app/blob/main/USER-GUIDE.md).

---

## 1. 허브 폰 준비

### 1.1 하드웨어 선택

- 안드로이드 7.0(API 24) 이상이면 충분하다. Termux가 도는 폰이면 된다.
- **배터리가 부풀지 않은 폰**을 쓴다. 상시 충전 상태로 24시간 돌릴 것이므로.
- 유심은 필요 없다. Wi-Fi만 되면 된다.

### 1.2 폰 설정 (앱 설치 전에)

| 설정 | 값 | 이유 |
|---|---|---|
| 화면 잠금 | 없음 또는 자동 잠금 해제 | 재부팅 후 사람 개입 없이 올라와야 한다 |
| 절전 모드 | 끔 | |
| Wi-Fi 절전 | 끔 (개발자 옵션 또는 Wi-Fi 고급 설정) | 화면 꺼지면 Wi-Fi를 끊는 기종이 있다 |
| 자동 업데이트 | 끔 | 새벽에 재부팅되는 것을 막는다 |
| 화면 시간 제한 | 짧게 (15초) | 발열 감소 |
| 밝기 | 최소 | |

### 1.3 물리 설치 (중요)

상시 100% 충전은 2~3년 안에 배터리 스웰링(부풀음)을 부른다. 최악의 경우 화재다.

- **케이스를 벗긴다.** 열이 빠져나가야 한다.
- 통풍되는 곳에 둔다. 서랍이나 상자 안은 안 된다.
- 이불, 종이, 천 위에 두지 않는다.
- 가능하면 충전 제한 앱으로 80% 유지 (삼성은 "배터리 보호" 기본 제공).
- **연 1회 육안 점검**: 뒷판이 들뜨거나 화면이 볼록해지면 즉시 교체.

---

## 2. 설치

### 2.1 Termux

Termux는 구글 플레이 버전이 오래되어 동작하지 않는다. **F-Droid 또는 GitHub 릴리스**에서
받는다. `Termux:Boot` 애드온도 같은 출처에서 받아야 서명이 맞는다.

```bash
pkg update
pkg install nodejs-lts git
node -v          # 22.5.0 이상이어야 한다
```

Node 가 22.5 보다 낮으면 허브가 시작되지 않는다. 내장 SQLite(`node:sqlite`)가 필요하기 때문이다.
`pkg upgrade nodejs-lts` 로 올린다.

#### `sqlite` 패키지에 대해

**허브는 Termux 의 `sqlite` 패키지를 필요로 하지 않는다.** SQLite 는 Node 바이너리 안에 있다.
(예전 문서에는 설치 목록에 있었지만 그때도 쓰이지 않았다.)

다만 **이미 깔려 있다면 지우지 말 것.** 두 가지 이유다.

- Termux 는 바이너리 크기를 줄이려고 Node 를 시스템 라이브러리에 링크해 빌드하는 경우가 있다.
  Node 가 `libsqlite3.so` 를 참조하고 있으면 패키지를 지우는 순간 허브가 실행되지 않는다.
  확인: `ldd $(command -v node) | grep -i sqlite` — 출력이 있으면 반드시 남겨둔다.
- `sqlite3` CLI 는 DB 를 직접 들여다볼 때 편하다. 없어도 §5 의 `node -e` 한 줄짜리들로 대신할 수 있다.

깔려 있으면 이런 식으로 쓸 수 있다:

```bash
sqlite3 ~/family-messenger/hub/data/hub.sqlite \
  "SELECT device_id, display_name, datetime(last_seen_at/1000,'unixepoch','localtime') AS last_seen FROM devices;"
```

### 2.2 허브 코드

```bash
git clone <저장소> ~/family-messenger
cd ~/family-messenger/hub
npm install
```

받는 것은 순수 JS 패키지 두 개(`ws`, `ulid`)뿐이라 몇 초면 끝난다.
컴파일 도구(python, make, clang)가 필요 없다.

> 예전에는 `better-sqlite3` 를 썼는데 Termux 에서 설치가 되지 않았다. 동봉된 미리 빌드
> 바이너리가 glibc·musl 용뿐인데 Termux 는 Bionic libc 를 쓰기 때문이다.
> 지금은 Node 내장 SQLite 를 쓰므로 그 문제가 없다.

### 2.3 동작 확인

```bash
npm start
```

```
[hub] listening on ws://0.0.0.0:8787/ws
```

다른 터미널(또는 같은 Wi-Fi의 PC)에서:

```bash
curl http://<허브IP>:8787/health
# {"ok":true,"serverTime":...,"online":0,"queued":0}
```

`Ctrl+C`로 종료.

---

## 3. 실행과 자동 시작

### 3.1 환경변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `HUB_HOST` | `0.0.0.0` | `tailscale`이면 이 폰의 100.x 주소에만 바인딩 |
| `HUB_PORT` | `8787` | |
| `HUB_DB` | `hub/data/hub.sqlite` | |
| `HUB_REQUIRE_TAILSCALE` | 꺼짐 | `1`이면 tailnet 밖 주소 거절 |

**집 안에서만 쓸 때**는 기본값(`0.0.0.0`) 그대로.
**집 밖에서도 쓸 때**는 `HUB_HOST=tailscale`. 이 값이면 Tailscale 주소를 못 찾았을 때
**시작을 거부한다.** 조용히 전체 인터페이스에 열리는 것보다 안 켜지는 편이 안전하기 때문이다.

### 3.2 부팅 시 자동 실행

```bash
mkdir -p ~/.termux/boot
cp ~/family-messenger/hub/scripts/start-hub.sh ~/.termux/boot/
chmod +x ~/.termux/boot/start-hub.sh
```

`Termux:Boot` 앱을 **한 번 실행**해야 부팅 훅이 등록된다. 설치만 하면 안 된다.

`start-hub.sh`가 하는 일:

1. `termux-wake-lock` — CPU가 잠들면 소켓이 조용히 죽는다. 이 줄이 없으면 밤새 먹통이다.
2. Node 프로세스 실행, 죽으면 5초 뒤 재시작
3. 설정 오류(종료 코드 78, 예: Tailscale 미기동)면 30초 간격으로 재시도
4. 로그를 `~/hub.log`에 append, 10MB 초과 시 `~/hub.log.1`로 로테이트

`HUB_HOST` 기본값이 스크립트 안에서는 `tailscale`이다. 집 안 전용으로 쓰려면
스크립트 상단을 `0.0.0.0`으로 바꾸거나 `HUB_HOST=0.0.0.0`을 환경에 넣는다.

### 3.3 재부팅 확인

폰을 재부팅하고 5분쯤 뒤:

```bash
curl http://<허브IP>:8787/health
tail -20 ~/hub.log
```

`online` 값이 접속 중인 가족 수와 맞으면 정상이다.

---

## 4. 기기 등록과 해제

인증에 비밀번호가 없다. 기기는 Ed25519 개인키로 자신을 증명하고, **등록은 사람이 한다.**

### 4.1 등록

1. 가족이 앱에서 `메뉴 → 허브에 기기 등록 → 등록 정보 복사`
2. 그 문자열을 허브 폰으로 전달 (메신저·메모 무엇이든. 공개키뿐이라 새어도 안전하다)
3. 허브에서:

```bash
cd ~/family-messenger/hub
node scripts/enroll.js '<붙여넣기>'
```

따옴표가 번거로우면:

```bash
node scripts/enroll.js --stdin
# 프롬프트가 뜨면 한 줄 붙여넣고 엔터
```

### 4.2 목록과 해제

```bash
node scripts/enroll.js --list
node scripts/enroll.js --remove dev_xxxxx   # 그 기기 앞 대기 메시지도 함께 삭제
```

### 4.3 재등록(rekey)

앱을 재설치하면 키가 새로 생긴다. 다시 등록하면 이렇게 나온다:

```
⚠ dev_xxx 의 공개키를 새 값으로 덮어썼습니다.
  앱을 재설치한 경우라면 정상입니다.
  그런 적이 없다면 누군가 다른 기기를 끼워 넣으려는 것일 수 있습니다.
```

**아무도 재설치하지 않았는데 이 경고가 뜨면 멈추고 확인한다.**

재등록 후에는 가족들의 앱에서 그 사람의 대면 검증이 자동으로 해제된다.
다시 만나서 안전 번호를 대조해야 한다.

> 앱 재설치 시 `deviceId`도 새로 생기므로 보통은 새 항목으로 등록된다.
> 옛 항목은 `--remove`로 지워야 유령 멤버가 남지 않는다.

---

## 5. 장애 대응 런북

### 증상: 메시지가 안 온다 / 알림이 안 뜬다

가장 흔한 문제다. 위에서부터 확인한다.

**1) 허브가 살아 있나**

```bash
curl http://<허브IP>:8787/health
```

- 응답 없음 → §5.1
- `online`이 0 또는 예상보다 적음 → 해당 폰 쪽 문제. 4)로

**2) 큐가 쌓여 있나**

`queued`가 계속 늘어나기만 하면 수신자가 못 받고 있는 것이다.
누구 앞으로 쌓였는지 확인:

```bash
cd ~/family-messenger/hub
node -e "const db=require('./src/db').open(require('./src/config').dbFile);console.table(db.prepare('SELECT recipient_id, COUNT(*) n FROM outbox GROUP BY recipient_id').all());db.close()"
```

**3) 그 폰이 최근에 붙은 적 있나**

```bash
node scripts/enroll.js --list
```

`마지막 접속` 시각을 본다.

**4) 폰 쪽 확인** (가장 흔한 원인)

- 앱 상단에 "연결됨"이 뜨는가? "연결 끊김"이면 네트워크·주소 문제
- 상시 알림("가족 메신저")이 알림 그림자에 있는가? 없으면 서비스가 죽은 것
- `메뉴 → 절전 설정`에서 배터리 최적화 예외가 "완료됨"인가?
- 제조사 절전 설정(자동 시작 허용 등)을 했는가?

서비스가 죽었으면 앱을 한 번 열면 다시 뜬다. 반복되면 절전 설정 문제다.

### 5.1 허브가 응답하지 않는다

```bash
# 프로세스 확인
ps aux | grep node

# 로그 확인
tail -50 ~/hub.log
```

| 로그 내용 | 원인 | 조치 |
|---|---|---|
| `Tailscale 주소를 찾지 못했습니다` | Tailscale 미기동 | Tailscale 앱 실행·로그인. 30초 뒤 자동 재시도 |
| `EADDRINUSE` | 8787 포트를 이미 누가 씀 | 옛 프로세스 종료: `pkill -f 'node src/index.js'` |
| `Cannot find module` | npm install 안 함 | `cd ~/family-messenger/hub && rm -rf node_modules && npm install` |
| `내장 SQLite(node:sqlite)가 필요하며` | Node 가 22.5 미만 | `pkg upgrade nodejs-lts` |
| 로그가 갱신 안 됨 | 부팅 훅이 안 걸림 | Termux:Boot 앱을 한 번 실행 |
| 아무것도 없음 | wake-lock 없이 폰이 잠듦 | `termux-wake-lock` 확인, 배터리 최적화 예외 |

수동 재시작:

```bash
pkill -f 'node src/index.js'
# 감시 루프가 5초 뒤 되살린다. 루프 자체가 죽었으면:
cd ~/family-messenger/hub && npm start &
```

### 5.2 인증 실패 (`UNKNOWN_DEVICE` / `AUTH_FAILED`)

앱 로그(또는 개발자에게 요청): `adb logcat -s MessengerRepository`

| 코드 | 의미 | 조치 |
|---|---|---|
| `UNKNOWN_DEVICE` | 등록 안 됨 | §4.1 등록 |
| `AUTH_FAILED: signature does not match` | 등록된 키와 앱의 키가 다름 | 앱을 재설치했으면 §4.3 재등록. 아니면 **조사할 것** |
| `AUTH_FAILED: challenge expired` | 폰과 허브 사이 지연 60초 초과 | 네트워크 확인 |
| `UNSUPPORTED_VERSION` | 앱과 허브 버전 불일치 | 양쪽을 같은 커밋으로 맞춘다 |

### 5.3 메시지 순서가 이상하다

메시지 옆에 `⚠ 시계 어긋남`이 보이면 발신자 폰의 시계가 5분 이상 틀어진 것이다.
그 폰의 설정에서 자동 시간 동기화를 켠다.

표시 순서 자체는 허브 시각 기준이라 전원이 같은 순서를 본다. 뒤집히지 않는다.

### 5.4 저장 공간이 찬다

정상 상태에서 `hub.sqlite`는 작다. 전달이 끝난 메시지를 지우기 때문이다.

```bash
ls -lh ~/family-messenger/hub/data/
du -h ~/hub.log*
```

- **outbox가 계속 커진다** → 누군가 오랫동안 오프라인이다. §5 2)로 확인 후,
  그 기기를 안 쓸 거면 `--remove`로 정리한다.
- **events 테이블이 크다** → 운영 로그다. 내용은 없다. 안전하게 비울 수 있다:

```bash
node -e "const db=require('./src/db').open(require('./src/config').dbFile);db.prepare('DELETE FROM events WHERE at < ?').run(Date.now()-30*86400000);db.exec('VACUUM');db.close()"
```

- **hub.log가 크다** → 10MB에서 자동 로테이트된다. `hub.log.1`은 지워도 된다.

### 5.5 허브 폰을 교체해야 한다

```bash
# 옛 폰에서
cd ~/family-messenger/hub
cp data/hub.sqlite ~/hub-backup.sqlite     # 미전달 메시지 + 기기 등록 정보
```

새 폰에 §2대로 설치한 뒤 `data/hub.sqlite`를 복원하면 **재등록 없이** 이어진다.
DB를 못 살렸다면 가족 전원이 §4.1로 다시 등록하면 된다.
과거 대화는 각자 폰에 있으므로 잃지 않는다.

허브 주소가 바뀌면 가족 전원이 앱의 `메뉴 → 연결 설정`에서 새 주소를 넣어야 한다.

---

## 6. 정기 점검

### 매주

```bash
curl http://<허브IP>:8787/health
```

`queued`가 0에 가깝고 `online`이 예상과 맞으면 정상.

### 매월

```bash
cd ~/family-messenger/hub
node scripts/enroll.js --list        # 모르는 기기가 없는지
tail -100 ~/hub.log | grep -i error
cp data/hub.sqlite ~/hub-backup-$(date +%Y%m).sqlite
```

가족들에게 `메뉴 → 대화 백업`으로 내보내라고 상기시킨다.

### 매년

- 허브 폰 **배터리 육안 점검** (뒷판 들뜸, 화면 볼록)
- `node scripts/verify-no-plaintext.js` — 코드를 고친 뒤라면 반드시
- 모르는 기기가 등록돼 있지 않은지 재확인

---

## 7. 로그 읽는 법

```bash
tail -f ~/hub.log
```

| 로그 | 의미 |
|---|---|
| `listening on ws://...` | 정상 기동 |
| `binding to Tailscale address 100.x` | tailnet 전용 모드로 떴다 |
| `WARNING: 0.0.0.0 에 바인딩합니다` | 같은 네트워크의 누구나 접속 가능. 집 안 전용이면 정상 |
| `authenticated dev_xxx` | 인증 성공 |
| `auth failed for dev_xxx: ...` | 인증 실패. §5.2 |
| `membership changed, refreshing dev_xxx` | 새 기기 등록 후 다른 기기에 목록 갱신 |
| `flushed N queued message(s)` | 오프라인이던 기기가 밀린 메시지를 받아감 |
| `replacing existing connection` | 같은 기기가 새 소켓으로 붙음. 재연결 시 정상 |
| `rejecting non-tailnet peer` | tailnet 밖에서 접속 시도. 정상 차단 |
| `RATE_LIMITED` | 분당 60개 초과. 앱 버그이거나 폭주 |

**로그에는 메시지 내용이 절대 남지 않는다.** `01J8XK... accepted=2 dropped=0`처럼
ID와 개수만 기록된다. 이건 설계이자 테스트로 강제되는 규칙이다.

---

## 8. 보안 점검

### 허브가 정말 못 읽는지 확인

```bash
cd ~/family-messenger/hub
node scripts/verify-no-plaintext.js --expect "방금 보낸 문장"
```

`--expect`에 최근 보낸 실제 문장을 넣으면 DB 파일 바이트 전체(WAL 포함)를 뒤져
그 문장이 없음을 확인한다. 코드를 수정한 뒤에는 반드시 돌린다.

### 절대 하지 말아야 할 것

- 허브 코드에 메시지 내용을 로그로 찍는 줄 추가
- `outbox`에 본문 컬럼 추가
- 편의를 위해 앱의 개인키를 파일로 내보내기
- `HUB_HOST=tailscale`이 실패할 때 `0.0.0.0`으로 바꿔서 "일단 되게" 하기
  (외부망을 쓰는 상황이라면 이건 허브를 인터넷에 노출시키는 것이다)

앞의 두 가지는 테스트가 막고 있다. 뒤의 두 가지는 사람이 지켜야 한다.
