'use strict';

const server = require('./server');

/** sysexits.h 의 EX_CONFIG. start-hub.sh 가 이 값을 보고 재시도 간격을 늘린다. */
const EXIT_CONFIG = 78;

async function main() {
  const hub = await server.start();

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[hub] ${signal} received, shutting down`);
    try {
      await hub.close();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // 예상 못한 예외로 조용히 죽는 것을 막는다.
  // 허브가 죽으면 start-hub.sh 의 감시 루프가 살려낸다.
  process.on('uncaughtException', (err) => {
    console.error('[hub] uncaughtException', err);
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => {
    console.error('[hub] unhandledRejection', err);
    process.exit(1);
  });
}

main().catch((err) => {
  if (err && err.code === 'NO_TAILSCALE') {
    // 설정 문제다. 5초마다 재시도해도 의미가 없으니 부팅 스크립트가 천천히 물러나게 한다.
    console.error(`[hub] ${err.message}`);
    process.exit(EXIT_CONFIG);
  }
  console.error('[hub] failed to start', err);
  process.exit(1);
});
