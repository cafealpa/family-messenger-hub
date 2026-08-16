'use strict';

/**
 * 기기 등록 CLI (PLAN.md §6.2).
 *
 * 앱이 화면에 보여 주는 QR/JSON 문자열을 그대로 붙여넣으면 된다.
 * 카메라로 QR 을 읽는 것보다 복사-붙여넣기가 훨씬 간단하다.
 *
 *   node scripts/enroll.js '{"deviceId":"dev_abc","name":"아빠","signPub":"b64","boxPub":"b64"}'
 *   node scripts/enroll.js --stdin        (줄 하나 붙여넣고 엔터)
 *   node scripts/enroll.js --list
 *   node scripts/enroll.js --remove dev_abc
 *
 * 이미 있는 deviceId 를 다시 등록하면 **공개키를 덮어쓴다.**
 * 앱을 재설치해 키가 바뀌었을 때 쓰는 정상 경로다. 대신 경고를 띄운다.
 */

const readline = require('readline');
const db = require('../src/db');
const config = require('../src/config');

const KEY_BYTES = 32;
const DEVICE_ID_RE = /^[A-Za-z0-9_.-]{3,64}$/;

/**
 * 붙여넣기 과정에서 딸려 오는 쓰레기를 걷어낸다.
 * BOM(편집기·PowerShell 파이프), 앞뒤 공백, 감싸는 따옴표를 제거한다.
 * 이걸 안 하면 "왜 안 되는지 알 수 없는" 등록 실패로 시간을 버린다.
 */
function cleanJson(raw) {
  let text = String(raw).replace(/^﻿/, '').trim();
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('“') && text.endsWith('”'))) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

function decodeKey(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} 가 없습니다`);
  }
  const buf = Buffer.from(value, 'base64');
  if (buf.length !== KEY_BYTES) {
    throw new Error(`${label} 는 base64 로 인코딩된 ${KEY_BYTES}바이트여야 합니다 (받은 값: ${buf.length}바이트)`);
  }
  return buf;
}

function enroll(database, payload) {
  const { deviceId, name, signPub, boxPub } = payload;

  if (typeof deviceId !== 'string' || !DEVICE_ID_RE.test(deviceId)) {
    throw new Error('deviceId 형식이 잘못되었습니다 ([A-Za-z0-9_.-]{3,64})');
  }
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('name 이 비어 있습니다');
  }

  const signKey = decodeKey(signPub, 'signPub');
  const boxKey = decodeKey(boxPub, 'boxPub');

  const existing = database
    .prepare('SELECT display_name, sign_pub_key FROM devices WHERE device_id = ?')
    .get(deviceId);

  const now = Date.now();

  if (existing) {
    const changed = !Buffer.from(existing.sign_pub_key).equals(signKey);
    database
      .prepare(
        `UPDATE devices
            SET display_name = ?, sign_pub_key = ?, box_pub_key = ?, last_seen_at = NULL
          WHERE device_id = ?`,
      )
      .run(name.trim(), signKey, boxKey, deviceId);

    db.logEvent(database, 'enroll', deviceId, changed ? 're-enrolled with new keys' : 're-enrolled');
    return { action: changed ? 'rekeyed' : 'updated', deviceId, name: name.trim() };
  }

  database
    .prepare(
      `INSERT INTO devices (device_id, display_name, sign_pub_key, box_pub_key, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    )
    .run(deviceId, name.trim(), signKey, boxKey, now);

  db.logEvent(database, 'enroll', deviceId, 'enrolled');
  return { action: 'enrolled', deviceId, name: name.trim() };
}

function list(database) {
  const rows = database
    .prepare('SELECT device_id, display_name, created_at, last_seen_at FROM devices ORDER BY created_at')
    .all();

  if (rows.length === 0) {
    console.log('등록된 기기가 없습니다.');
    return;
  }

  console.log(`등록된 기기 ${rows.length}대:`);
  for (const row of rows) {
    const seen = row.last_seen_at ? new Date(row.last_seen_at).toISOString() : '(접속한 적 없음)';
    console.log(`  ${row.device_id.padEnd(24)} ${row.display_name.padEnd(12)} 마지막 접속: ${seen}`);
  }
}

function remove(database, deviceId) {
  const info = database.prepare('DELETE FROM devices WHERE device_id = ?').run(deviceId);
  if (info.changes === 0) {
    console.error(`${deviceId} 는 등록돼 있지 않습니다.`);
    process.exitCode = 1;
    return;
  }
  // 큐에 남은 그 기기 앞 메시지도 함께 지운다. 받을 사람이 없어졌다.
  const queued = database.prepare('DELETE FROM outbox WHERE recipient_id = ?').run(deviceId);
  db.logEvent(database, 'enroll', deviceId, 'removed');
  console.log(`${deviceId} 등록을 해제했습니다. (대기 중이던 메시지 ${queued.changes}건도 삭제)`);
}

function readStdinLine() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin });
    rl.once('line', (line) => {
      rl.close();
      resolve(line);
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const database = db.open(config.dbFile);

  try {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      console.log(`사용법:
  node scripts/enroll.js '<앱이 보여 준 JSON>'
  node scripts/enroll.js --stdin
  node scripts/enroll.js --list
  node scripts/enroll.js --remove <deviceId>

DB: ${config.dbFile}`);
      return;
    }

    if (args[0] === '--list') return list(database);
    if (args[0] === '--remove') {
      if (!args[1]) throw new Error('--remove 뒤에 deviceId 를 적어 주세요');
      return remove(database, args[1]);
    }

    const raw = args[0] === '--stdin'
      ? (console.log('앱 화면의 JSON 한 줄을 붙여넣고 엔터:'), await readStdinLine())
      : args[0];

    let payload;
    try {
      payload = JSON.parse(cleanJson(raw));
    } catch (err) {
      throw new Error(`JSON 을 읽지 못했습니다: ${err.message}`);
    }

    const result = enroll(database, payload);

    if (result.action === 'rekeyed') {
      console.log(`⚠ ${result.deviceId} 의 공개키를 새 값으로 덮어썼습니다.`);
      console.log('  앱을 재설치한 경우라면 정상입니다.');
      console.log('  그런 적이 없다면 누군가 다른 기기를 끼워 넣으려는 것일 수 있습니다.');
    }
    console.log(`${result.name} (${result.deviceId}) — ${result.action}`);
    console.log('이제 그 기기에서 접속하면 인증을 통과합니다.');
  } catch (err) {
    console.error(`등록 실패: ${err.message}`);
    process.exitCode = 1;
  } finally {
    database.close();
  }
}

if (require.main === module) {
  main();
}

module.exports = { enroll, decodeKey };
