# 가족 메신저 프로젝트 규칙

> 코드는 두 저장소로 나뉘어 있다.
> [family-messenger-hub](https://github.com/cafealpa/family-messenger-hub) (Node.js 허브, PROTOCOL.md 정본),
> [family-messenger-app](https://github.com/cafealpa/family-messenger-app) (안드로이드 앱).
> 이 문서 안의 `hub/` `app/` 경로는 각 저장소의 루트를 가리킨다.
> **프로토콜 변경은 허브 저장소의 PROTOCOL.md 를 먼저 고치고 양쪽을 함께 갱신한다.**

## 아키텍처 불변 규칙 (절대 위반 금지)
1. 허브는 평문을 저장하거나 로그에 남기지 않는다.
   ciphertext 외 본문 컬럼 추가 금지.
2. 개인키는 앱 기기 밖으로 나가지 않는다.
3. FCM, Firebase, 외부 클라우드 SDK를 추가하지 않는다.
4. msgId는 ULID. UUIDv4로 바꾸지 않는다.
5. 메시지 정렬 기준은 recvAt(허브 시각). sentAt으로 정렬하지 않는다.
6. nonce는 절대 재사용하지 않는다.

이 규칙들은 회귀 테스트로 지켜진다:
- 1번 → `hub/test/schema.test.js`, `hub/scripts/verify-no-plaintext.js`
- 4·5번 → `hub/test/phase1.test.js`, `app/.../UlidTest.kt`
- 6번 → `hub/test/e2e-crypto.test.js`, verify-no-plaintext 의 nonce 중복 검사

## 코드 규칙
- 허브: Node.js 20+, CommonJS, **런타임** 의존성은 ws / better-sqlite3 / ulid 로 제한
  - 예외: `tweetnacl` 은 devDependency. 더미 클라이언트와 테스트에서만 쓴다.
    허브 서버 코드는 암복호화를 하지 않으며, 그게 이 프로젝트의 존재 이유다.
- 앱: Kotlin, Jetpack Compose, Room, OkHttp, lazysodium-android
- 프로토콜 변경 시 PROTOCOL.md를 먼저 수정하고 구현한다
- 네트워크 코드는 반드시 예외 처리와 재시도를 포함한다

## 작업 방식
- PLAN.md의 Phase 순서를 지킨다. 완료 기준 미충족 시 다음 Phase로 넘어가지 않는다
- 한 번에 한 Phase씩 작업하고, 끝나면 완료 기준 체크리스트를 보고한다
- 추측하지 말고 PROTOCOL.md를 근거로 구현한다

## 현재 진행 상황
- [x] Phase 0 — 프로젝트 셋업
- [x] Phase 1 — 같은 Wi-Fi, 평문 통신
- [x] Phase 2 — 연결 안정성 (8시간 방치·24시간 배터리는 실기기 측정 필요)
- [x] Phase 3 — 외부망 Tailscale (실제 LTE 접속은 사용자 확인 필요)
- [x] Phase 4 — 인증 + E2E 암호화
- [x] Phase 5 — 대면 키 검증 + 마감 (1주일 실사용은 사용자 몫)

## 계획서에서 벗어난 결정 (이유 포함)

| 항목 | 계획서 | 실제 | 이유 |
|---|---|---|---|
| 포그라운드 서비스 타입 | `dataSync` | `specialUse` | Android 15가 dataSync를 BOOT_COMPLETED에서 금지하고 하루 6시간으로 제한한다. 완료 기준 두 개를 정면으로 어긴다 |
| 대면 검증 방식 | 상대 QR 스캔 | 안전 번호 대조 | 보안 성질 동일(양쪽 공개키를 모두 해시), 카메라 권한 불필요, 실제로 검증 가능. 내 정보 QR 표시는 그대로 있다 |
| ULID 생성기 | 명시 없음 | 단조(monotonic) 강제 | 기본 생성기는 같은 ms 안에서 정렬 순서를 보장하지 않아 연타 메시지가 뒤집힌다 |
| release 난독화 | "Phase 5에서 켠다" | 끈 채로 둠 | Room/serialization/JNA가 모두 리플렉션을 쓴다. 스토어 배포가 없어 크기 이득도 없다 |

## 알려진 한계
- outbox 에 담긴 send 프레임은 **만들 때의 멤버 목록과 공개키가 굳어 있다.**
  그 뒤 새로 등록한 가족은 그 메시지를 못 받는다.
- 앱 재설치 시 deviceId 와 키가 모두 새로 생긴다. 옛 기기 항목은
  `enroll.js --remove` 로 직접 지워야 유령 멤버가 남지 않는다.
- 전방향 비밀성(Double Ratchet) 없음. 정적 키 방식이다. 개인키가 유출되면
  그 기기가 받은 과거 메시지를 복호화할 수 있다.
- 허브는 "누가 언제 보냈는지"를 안다. 메타데이터 은닉은 비목표(PLAN.md §1.3).

## 개발 환경 메모
- 개발 머신은 Windows. 허브 실전 구동 환경은 Termux(Android/aarch64).
  better-sqlite3는 네이티브 모듈이므로 **허브 폰에서 `npm install`이 필요**하다.
  node_modules를 그대로 복사해 옮기지 말 것.
- 앱 빌드는 JDK 17~21. 시스템 기본이 25면 AGP 8.7이 거부한다.
- 허브 실행: `cd hub && npm start` (기본 포트 8787, 경로 `/ws`)
- PowerShell 에서 `enroll.js` 에 JSON 을 넘길 때는 `--stdin` 을 쓸 것.
  작은따옴표가 벗겨지고 BOM 이 붙는다.
