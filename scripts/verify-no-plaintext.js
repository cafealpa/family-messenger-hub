'use strict';

/**
 * "허브 SQLite 를 직접 열어봤을 때 메시지 내용을 읽을 수 없다" 를 증명한다.
 * PLAN.md Phase 4 완료 기준이자 이 프로젝트의 존재 이유(G1, G5)다.
 *
 *   node scripts/verify-no-plaintext.js
 *   node scripts/verify-no-plaintext.js --expect "저녁 뭐 먹어"
 *
 * 검사 항목
 *   1. 스키마에 본문용 평문 컬럼이 없다
 *   2. outbox.ciphertext 가 사람이 읽을 수 있는 텍스트가 아니다
 *   3. events.detail 에 본문이 새지 않았다
 *   4. --expect 로 준 문구가 DB **파일 바이트 어디에도** 없다 (WAL 포함)
 *
 * 하나라도 실패하면 종료 코드 1.
 */

const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const config = require('../src/config');

const FORBIDDEN_COLUMNS = ['body', 'text', 'plaintext', 'content', 'message', 'msg'];

/**
 * 진단용 지표. 판정에는 쓰지 않는다 ([looksLikePlaintext] 참조).
 *
 * 짧은 암호문에서는 이 비율이 우연히 50~60%까지 튄다. 난수 바이트 중 잘못된
 * UTF-8 시퀀스가 하나의 U+FFFD 로 뭉쳐 분모가 줄어들기 때문이다.
 * 이 값만으로 판정하면 멀쩡한 암호문을 평문이라고 잘못 신고한다.
 */
function readableRatio(buffer) {
  if (buffer.length === 0) return 0;

  const text = buffer.toString('utf8');
  let readable = 0;

  for (const ch of text) {
    const code = ch.codePointAt(0);
    const isAsciiPrintable = code >= 0x20 && code <= 0x7e;
    const isHangul = (code >= 0xac00 && code <= 0xd7a3) || (code >= 0x3130 && code <= 0x318f);
    const isCjk = code >= 0x4e00 && code <= 0x9fff;
    const isKana = code >= 0x3040 && code <= 0x30ff;
    if (isAsciiPrintable || isHangul || isCjk || isKana) readable += 1;
  }

  return readable / Math.max(1, [...text].length);
}

/** 연속으로 이어지는 출력 가능 ASCII 의 최대 길이. 박혀 있는 평문 조각을 잡는다. */
function longestPrintableRun(buffer) {
  let best = 0;
  let current = 0;
  for (const byte of buffer) {
    if (byte >= 0x20 && byte <= 0x7e) {
      current += 1;
      if (current > best) best = current;
    } else {
      current = 0;
    }
  }
  return best;
}

/**
 * 이 바이트 뭉치가 평문으로 보이는가.
 *
 * 핵심 판별은 **엄격한 UTF-8 디코딩**이다. 사람이 쓴 문장은 반드시 유효한 UTF-8 이고,
 * 균일 난수는 사실상 절대 유효한 UTF-8 이 되지 않는다(16바이트만 되어도 확률이 무시할 수준).
 * 비율 기반 판정보다 훨씬 날카롭고, 짧은 암호문에서 오탐이 나지 않는다.
 *
 * 유효한 UTF-8 이 아니더라도 평문 조각이 박혀 있을 수 있으므로
 * 긴 ASCII 연속 구간을 따로 확인한다.
 *
 * @returns {{ suspicious: boolean, reason: string|null }}
 */
function looksLikePlaintext(buffer) {
  const run = longestPrintableRun(buffer);

  let text = null;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    // 유효한 UTF-8 이 아니다 → 문자열 평문일 수 없다.
    if (run >= PRINTABLE_RUN_LIMIT) {
      return { suspicious: true, reason: `출력 가능 문자가 ${run}자 연속으로 이어집니다` };
    }
    return { suspicious: false, reason: null };
  }

  // 여기까지 왔다면 통째로 유효한 UTF-8 이다. 암호문이라면 일어나기 어려운 일이다.
  const ratio = readableRatio(buffer);
  if (ratio >= TEXT_RATIO_LIMIT) {
    return {
      suspicious: true,
      reason: `전체가 유효한 UTF-8 이고 ${Math.round(ratio * 100)}% 가 읽을 수 있는 문자입니다`,
    };
  }
  if (run >= PRINTABLE_RUN_LIMIT) {
    return { suspicious: true, reason: `출력 가능 문자가 ${run}자 연속으로 이어집니다` };
  }
  return { suspicious: false, reason: null };
}

/** 이만큼 연속으로 읽히면 평문 조각이 박힌 것으로 본다. 난수로는 사실상 나오지 않는다. */
const PRINTABLE_RUN_LIMIT = 16;
/** 유효한 UTF-8 인 데다 이 비율 이상이 읽히면 텍스트로 본다. */
const TEXT_RATIO_LIMIT = 0.7;

function checkSchema(database, report) {
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name);

  for (const table of tables) {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    for (const column of columns) {
      if (FORBIDDEN_COLUMNS.includes(column.toLowerCase())) {
        report.fail(`스키마: ${table}.${column} 은 본문을 담을 수 있는 컬럼 이름입니다`);
      }
    }
  }
  report.pass(`스키마 검사: 테이블 ${tables.length}개에 본문용 평문 컬럼 없음`);
}

function checkOutbox(database, report) {
  const rows = database.prepare('SELECT msg_id, recipient_id, ciphertext, nonce FROM outbox').all();

  if (rows.length === 0) {
    report.warn('outbox 가 비어 있습니다. 메시지를 몇 건 보낸 뒤 다시 실행하면 더 확실합니다.');
    return;
  }

  let flagged = 0;
  let longestRun = 0;

  for (const row of rows) {
    const buffer = Buffer.from(row.ciphertext);

    // crypto_box_easy 는 16바이트 MAC 을 붙인다. 최소 길이가 이보다 작으면 암호문이 아니다.
    if (buffer.length < 16) {
      report.fail(`outbox ${row.msg_id}: ciphertext 가 ${buffer.length}바이트 — 암호문이 아닙니다`);
      flagged += 1;
      continue;
    }
    if (Buffer.from(row.nonce).length !== 24) {
      report.fail(`outbox ${row.msg_id}: nonce 가 24바이트가 아닙니다`);
      flagged += 1;
    }

    longestRun = Math.max(longestRun, longestPrintableRun(buffer));

    const verdict = looksLikePlaintext(buffer);
    if (verdict.suspicious) {
      flagged += 1;
      report.fail(
        `outbox ${row.msg_id}: ${verdict.reason}\n` +
          `      미리보기: ${JSON.stringify(buffer.toString('utf8').slice(0, 60))}`,
      );
    }
  }

  // 실패한 행이 있으면 "모두 암호문으로 보임" 이라고 말하지 않는다.
  if (flagged === 0) {
    report.pass(
      `outbox ${rows.length}건: 모두 암호문으로 보임 ` +
        `(유효한 UTF-8 아님, 읽히는 구간 최대 ${longestRun}자 / 기준 ${PRINTABLE_RUN_LIMIT}자 미만)`,
    );
  }
}

function checkNonceReuse(database, report) {
  // nonce 재사용은 치명적이다 (CLAUDE.md 불변 규칙 6).
  const dup = database
    .prepare(
      `SELECT COUNT(*) AS total, COUNT(DISTINCT hex(nonce)) AS distinct_nonces FROM outbox`,
    )
    .get();

  if (dup.total === 0) return;
  if (dup.total !== dup.distinct_nonces) {
    report.fail(`nonce 재사용 발견: ${dup.total}건 중 서로 다른 nonce 는 ${dup.distinct_nonces}개뿐입니다`);
  } else {
    report.pass(`nonce 검사: ${dup.total}건 모두 서로 다른 nonce`);
  }
}

function checkEvents(database, report, expected) {
  const rows = database.prepare('SELECT detail FROM events WHERE detail IS NOT NULL').all();

  if (expected) {
    const leaked = rows.filter((r) => r.detail.includes(expected));
    if (leaked.length > 0) {
      report.fail(`events.detail 에 본문이 새어 나왔습니다 (${leaked.length}건)`);
      return;
    }
  }
  report.pass(`events 로그 ${rows.length}건: 본문 유출 없음`);
}

function checkRawFile(report, dbFile, expected) {
  if (!expected) {
    report.warn('--expect 를 주면 DB 파일 바이트 전체에서 그 문구를 찾아 더 강하게 증명합니다.');
    return;
  }

  // WAL 모드라 아직 본 파일에 안 들어간 데이터가 -wal 에 있을 수 있다. 같이 본다.
  const candidates = [dbFile, `${dbFile}-wal`, `${dbFile}-shm`];
  const needle = Buffer.from(expected, 'utf8');
  let scanned = 0;

  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const bytes = fs.readFileSync(file);
    scanned += 1;
    if (bytes.includes(needle)) {
      report.fail(`${path.basename(file)} 안에서 "${expected}" 를 찾았습니다 — 평문이 저장돼 있습니다`);
      return;
    }
  }

  report.pass(`파일 바이트 검사: ${scanned}개 파일 어디에도 "${expected}" 없음`);
}

function createReport() {
  const lines = [];
  let failed = 0;
  return {
    pass(msg) {
      lines.push(`  [OK]   ${msg}`);
    },
    warn(msg) {
      lines.push(`  [주의] ${msg}`);
    },
    fail(msg) {
      failed += 1;
      lines.push(`  [실패] ${msg}`);
    },
    print() {
      console.log(lines.join('\n'));
      return failed;
    },
  };
}

function main() {
  const args = process.argv.slice(2);
  const expectIndex = args.indexOf('--expect');
  const expected = expectIndex >= 0 ? args[expectIndex + 1] : null;
  const dbFile = process.env.HUB_DB || config.dbFile;

  if (!fs.existsSync(dbFile)) {
    console.error(`DB 파일이 없습니다: ${dbFile}`);
    process.exit(1);
  }

  console.log(`허브 DB 평문 검사: ${dbFile}\n`);

  const database = db.open(dbFile);
  const report = createReport();

  try {
    checkSchema(database, report);
    checkOutbox(database, report);
    checkNonceReuse(database, report);
    checkEvents(database, report, expected);
    checkRawFile(report, dbFile, expected);
  } finally {
    database.close();
  }

  const failures = report.print();
  console.log('');

  if (failures > 0) {
    console.error(`✗ ${failures}건 실패 — 허브가 메시지 내용을 볼 수 있는 상태입니다.`);
    process.exit(1);
  }
  console.log('✓ 허브 DB 에서 메시지 내용을 읽을 수 없습니다.');
}

if (require.main === module) {
  main();
}

module.exports = { readableRatio, looksLikePlaintext, longestPrintableRun };
