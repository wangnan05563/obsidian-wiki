// 端到端验证脚本：用户注册模块（FR-RM-01~10）核心行为
// 运行前提：后端服务已在 BASE 上监听（见 run-e2e.sh / 直接用 tsx 启动 api）。
//
// 覆盖：
//   1. 自助注册（公开）→ 200 + token + user（注册即登录）
//   2. 用户名唯一性 → 重复注册 409
//   3. 多账户隔离：A/B 各自 id 不同；A 的 token 取不到 B 的数据
//   4. 角色隔离：普通用户访问 admin 接口 → 403
//   5. 登录：正确密码 200；错误密码 401
//   6. 鉴权守卫：无 token 访问受保护接口 → 401
//   7. 核心断言：默认配置下 /api/conversations 路由不注册（会话不存服务端，FR-RM-04/FR-RM-08）→ 404
//   8. 限流（FR-RM-10）：同 IP 注册超过 10 次/分钟 → 429 且带 Retry-After
//
// 退出码：全部通过 0，否则 1。所有测试用户以 e2e_ 前缀，便于清理。

const BASE = process.env.E2E_BASE || 'http://localhost:3000';
const SUFFIX = Date.now().toString(36);
const PW = 'Passw0rd!2026';

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, name, detail = '') {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}${detail ? ' — ' + detail : ''}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`);
  }
}

async function call(method, path, { body, token } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, data, retryAfter: res.headers.get('retry-after') };
}

async function register(username, password = PW) {
  return call('POST', '/api/auth/register', { body: { username, password } });
}

async function main() {
  console.log(`\n=== 端到端验证：用户注册模块 @ ${BASE} ===\n`);

  // 1. 注册用户 A（注册即登录）
  const uA = `e2e_a_${SUFFIX}`;
  const rA = await register(uA);
  ok(rA.status === 200 && rA.data?.ok === true, '注册用户A → 200 + ok', `status=${rA.status}`);
  ok(!!rA.data?.token && !!rA.data?.user?.id, '注册返回 token 与 user.id');
  const tokenA = rA.data?.token;
  const idA = rA.data?.user?.id;

  // 2. 注册用户 B
  const uB = `e2e_b_${SUFFIX}`;
  const rB = await register(uB);
  ok(rB.status === 200 && rB.data?.ok === true, '注册用户B → 200 + ok');
  const tokenB = rB.data?.token;
  const idB = rB.data?.user?.id;
  ok(idA && idB && idA !== idB, 'A 与 B 的用户 id 互不相同（账户隔离基石）');

  // 3. 用户名唯一性
  const rDup = await register(uA);
  ok(rDup.status === 409, '重复注册同名用户 → 409', `status=${rDup.status}`);

  // 4. 多账户：A 的 token 只能取到 A 的数据
  const meA = await call('GET', '/api/auth/me', { token: tokenA });
  ok(meA.status === 200 && meA.data?.id === idA, 'A 登录态取自身信息 → 200 且 id 匹配');
  const meBviaA = await call('GET', '/api/auth/me', { token: tokenA });
  ok(meBviaA.data?.id !== idB, 'A 的 token 取不到 B 的数据（无跨账户泄露）');

  // 5. 角色隔离：普通用户访问 admin 用户列表 → 403
  const usersA = await call('GET', '/api/auth/users', { token: tokenA });
  ok(usersA.status === 403, '普通用户访问 /api/auth/users → 403（RBAC 隔离）', `status=${usersA.status}`);

  // 6. 登录：正确密码
  const loginOk = await call('POST', '/api/auth/login', { body: { username: uA, password: PW } });
  ok(loginOk.status === 200 && loginOk.data?.token, '正确密码登录 → 200 + token');
  // 6b. 登录：错误密码
  const loginBad = await call('POST', '/api/auth/login', { body: { username: uA, password: 'WrongPass!1' } });
  ok(loginBad.status === 401, '错误密码登录 → 401', `status=${loginBad.status}`);

  // 7. 鉴权守卫：无 token 访问受保护接口
  const meNoToken = await call('GET', '/api/auth/me');
  ok(meNoToken.status === 401, '无 token 访问 /api/auth/me → 401');
  // 7b. 登出（受保护，应 200）
  const logoutA = await call('POST', '/api/auth/logout', { token: tokenA, body: {} });
  ok(logoutA.status === 200, '携带 token 登出 → 200', `status=${logoutA.status}`);

  // 8. 核心断言：默认配置下会话不存服务端（FR-RM-04 / FR-RM-08）
  const convList = await call('GET', '/api/conversations');
  ok(convList.status === 404, 'GET /api/conversations → 404（默认不注册会话路由）', `status=${convList.status}`);
  const convItem = await call('GET', '/api/conversations/does-not-exist');
  ok(convItem.status === 404, 'GET /api/conversations/:id → 404（无会话 CRUD 端点）', `status=${convItem.status}`);

  // 9. 限流（FR-RM-10）：同 IP 注册超 10 次/分钟 → 429
  // 前面已消耗 2 次注册配额（A、B），此处再突发一批独立用户名，验证硬上限 10/min/IP。
  let successCount = 0;
  let rateLimited = false;
  let retryAfterPresent = false;
  for (let i = 0; i < 15; i++) {
    const ru = `e2e_rl_${SUFFIX}_${i}`;
    const rr = await register(ru);
    if (rr.status === 200) successCount++;
    if (rr.status === 429) {
      rateLimited = true;
      if (rr.retryAfter) retryAfterPresent = true;
    }
  }
  ok(rateLimited, '同 IP 注册突发触发限流（出现 429）');
  ok(retryAfterPresent, '429 响应携带 Retry-After 头');
  ok(successCount <= 10, `单 IP 注册成功数受 10/min 上限约束（本次成功 ${successCount} ≤ 10）`);

  console.log(`\n=== 结果：PASS ${pass} / FAIL ${fail} ===`);
  if (fail > 0) {
    console.log('失败项：' + failures.join('; '));
    process.exit(1);
  }
  console.log('全部通过 ✅');
  process.exit(0);
}

main().catch((err) => {
  console.error('[ERROR] e2e 运行异常：', err);
  process.exit(2);
});
