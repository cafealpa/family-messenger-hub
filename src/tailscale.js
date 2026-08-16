'use strict';

const os = require('os');

/**
 * Tailscale 주소 다루기 (PLAN.md Phase 3).
 *
 * Tailscale 은 항상 **100.64.0.0/10** (CGNAT 대역)에서 주소를 나눠 준다.
 * 인터페이스 **이름**(tailscale0 / tun0 / utun3 …)은 OS 와 플랫폼마다 다르므로
 * 이름이 아니라 주소 대역으로 판별한다. 안드로이드의 Tailscale 앱은 VpnService 를
 * 쓰기 때문에 Termux 에서 인터페이스가 `tun0` 으로 보이는 경우가 흔하다.
 */

const TAILSCALE_CIDR = '100.64.0.0/10';

/** @param {string} ip @returns {boolean} 100.64.0.0/10 안에 있는가 */
function isTailscaleIp(ip) {
  if (typeof ip !== 'string') return false;

  // WebSocket 클라이언트가 IPv4-mapped IPv6 (::ffff:100.x.x.x)로 들어오는 경우가 있다.
  const normalized = ip.startsWith('::ffff:') ? ip.slice(7) : ip;

  const parts = normalized.split('.');
  if (parts.length !== 4) return false;

  const octets = parts.map((p) => Number(p));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;

  // 100.64.0.0/10 → 첫 옥텟 100, 둘째 옥텟 64~127
  return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

/**
 * 이 기기에 붙어 있는 Tailscale 주소를 찾는다.
 * @param {NodeJS.Dict<os.NetworkInterfaceInfo[]>} [interfaces] 테스트 주입용
 * @returns {{ address: string, iface: string } | null}
 */
function findTailscaleAddress(interfaces = os.networkInterfaces()) {
  for (const [iface, addresses] of Object.entries(interfaces)) {
    for (const info of addresses ?? []) {
      if (info.family !== 'IPv4' && info.family !== 4) continue;
      if (isTailscaleIp(info.address)) return { address: info.address, iface };
    }
  }
  return null;
}

/**
 * 바인딩할 주소를 정한다.
 *
 * `HUB_HOST=tailscale` 이면 Tailscale 주소를 찾아 **거기에만** 묶는다.
 * 못 찾으면 0.0.0.0 으로 조용히 물러서지 않고 **에러를 던진다.**
 * 조용히 물러서면 "Tailscale 로 잠갔다고 믿는데 실제로는 온 세상에 열려 있는" 상태가 된다.
 *
 * @param {string} configured
 * @param {NodeJS.Dict<os.NetworkInterfaceInfo[]>} [interfaces]
 * @returns {{ host: string, iface: string|null, tailscaleOnly: boolean }}
 */
function resolveBindHost(configured, interfaces = os.networkInterfaces()) {
  if (configured !== 'tailscale') {
    return { host: configured, iface: null, tailscaleOnly: false };
  }

  const found = findTailscaleAddress(interfaces);
  if (!found) {
    const err = new Error(
      'HUB_HOST=tailscale 인데 이 기기에서 Tailscale 주소(100.64.0.0/10)를 찾지 못했습니다.\n' +
        'Tailscale 앱이 켜져 있고 tailnet 에 로그인돼 있는지 확인하세요.\n' +
        '집 안 Wi-Fi 로만 쓰려면 HUB_HOST=0.0.0.0 으로 실행하세요.',
    );
    // 부팅 스크립트가 "설정 문제"와 "그냥 죽음"을 구분할 수 있게 표시한다.
    err.code = 'NO_TAILSCALE';
    throw err;
  }

  return { host: found.address, iface: found.iface, tailscaleOnly: true };
}

/**
 * 이 기기에서 남들이 접속할 수 있는 IPv4 주소들.
 *
 * 0.0.0.0 에 바인딩하면 로그에 "0.0.0.0" 이 찍히는데 그건 접속 주소가 아니라
 * "모든 인터페이스에서 듣는다"는 뜻이다. 앱 설정에 0.0.0.0 을 넣으면 당연히 안 붙는다.
 * 그 혼동을 없애려고 시작할 때 실제로 넣어야 할 주소를 찍어 준다.
 *
 * @param {NodeJS.Dict<os.NetworkInterfaceInfo[]>} [interfaces] 테스트 주입용
 * @returns {Array<{ iface: string, address: string, tailscale: boolean }>}
 */
function listReachableAddresses(interfaces = os.networkInterfaces()) {
  const found = [];

  for (const [iface, addresses] of Object.entries(interfaces)) {
    for (const info of addresses ?? []) {
      if (info.family !== 'IPv4' && info.family !== 4) continue;
      if (info.internal) continue; // 127.0.0.1 은 다른 기기에서 못 쓴다
      found.push({ iface, address: info.address, tailscale: isTailscaleIp(info.address) });
    }
  }

  // Tailscale 주소를 먼저 보여 준다. 외부망까지 쓰는 경우 그게 정답이기 때문이다.
  return found.sort((a, b) => Number(b.tailscale) - Number(a.tailscale));
}

module.exports = {
  isTailscaleIp,
  findTailscaleAddress,
  listReachableAddresses,
  resolveBindHost,
  TAILSCALE_CIDR,
};
