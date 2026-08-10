// 进程内登录探针：与线上服务器完全一致（IS_SEA=true → AppData 用户库）。
// WIKI_SMOKE=1 守卫避免 index.ts 的 main() 触发 listen 撞端口。
import { buildApp } from './src/index.ts';
import { getDataDir } from './src/utils/runtime.ts';

const { app } = await buildApp();
await app.ready();
console.log('PROBE getDataDir=', getDataDir());

const cases = [
  { name: 'admin/admin123', body: { username: 'admin', password: 'admin123' } },
  { name: 'user/user123', body: { username: 'user', password: 'user123' } },
  { name: 'guest/guest123', body: { username: 'guest', password: 'guest123' } },
  { name: 'wrong/wrong', body: { username: 'admin', password: 'WRONG' } },
];

for (const c of cases) {
  const t = Date.now();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: c.body,
    });
    const ms = Date.now() - t;
    let okMsg = '';
    try { okMsg = JSON.parse(res.body).message || ''; } catch {}
    console.log(`LOGIN ${c.name} => status=${res.statusCode} (${ms}ms) ${okMsg}`);
  } catch (e) {
    console.log(`LOGIN ${c.name} => ERROR ${e.message}`);
  }
}
process.exit(0);
