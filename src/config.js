'use strict';

const path = require('path');

/**
 * 허브 설정. 전부 환경변수로 덮어쓸 수 있다.
 *
 * HUB_HOST:
 *   'tailscale'  → 이 기기의 Tailscale 주소(100.64.0.0/10)에만 바인딩한다. **운영 권장값**
 *                  주소를 못 찾으면 시작을 거부한다 (조용히 전 세계에 열리는 것을 막는다).
 *   '0.0.0.0'    → 모든 인터페이스. Phase 1~2 처럼 집 안 Wi-Fi 로만 쓸 때.
 *   그 외        → 지정한 주소 그대로.
 *
 * HUB_REQUIRE_TAILSCALE=1:
 *   바인딩과 별개로, 접속해 온 상대의 IP 가 100.64.0.0/10 이 아니면 거절한다.
 *   0.0.0.0 에 바인딩할 수밖에 없는 환경에서의 2차 방어선.
 */
module.exports = {
  host: process.env.HUB_HOST || '0.0.0.0',
  port: Number(process.env.HUB_PORT || 8787),
  wsPath: process.env.HUB_WS_PATH || '/ws',

  requireTailscale: process.env.HUB_REQUIRE_TAILSCALE === '1',

  // PROTOCOL.md 와 일치해야 한다.
  protocolVersion: 1,

  dbFile: process.env.HUB_DB || path.join(__dirname, '..', 'data', 'hub.sqlite'),

  // ws 레벨 keepalive (프로토콜 ping/pong 과는 별개)
  heartbeatIntervalMs: 30_000,

  // 프레임 크기 상한. 텍스트 메시지만 다루므로 넉넉히 잡아도 이 정도면 충분하다.
  maxFrameBytes: 256 * 1024,
};
