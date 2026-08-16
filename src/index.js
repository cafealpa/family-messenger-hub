'use strict';

/** sysexits.h 의 EX_CONFIG. start-hub.sh 가 이 값을 보고 재시도 간격을 늘린다. */
const EXIT_CONFIG = 78;

// node:sqlite 는 Node 22.5 부터 있다. 없으면 아래 require 가 알아보기 어려운 예외를 던지므로
// 먼저 확인해서 무엇을 해야 하는지 알려 준다.
try {
  require('node:sqlite');
} catch {
  console.error(
    `[hub] 이 Node 로는 실행할 수 없습니다 (현재 ${process.version}).\n` +
      '      내장 SQLite(node:sqlite)가 필요하며 Node 22.5.0 이상이어야 합니다.\n' +
      '      Termux: pkg upgrade nodejs-lts\n' +
      '      22.5 ~ 23.3 이라면 --experimental-sqlite 플래그가 필요합니다 (npm start 는 이미 붙여서 실행합니다).',
  );
  process.exit(EXIT_CONFIG);
}

const server = require('./server');

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
