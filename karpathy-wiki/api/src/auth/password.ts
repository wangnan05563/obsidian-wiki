import crypto from 'node:crypto';
import { promisify } from 'node:util';
import process from 'node:process';

// 密码哈希与验证模块
// 为什么用 PBKDF2 而非 bcrypt：Node.js 内置 crypto 即可，无需额外依赖
// 参数：PBKDF2-SHA512，迭代 100000 次，盐 16 字节，输出 64 字节
// 这些参数由 AuthConfig.pbkdf2Iterations 控制，从 config 读取避免硬编码

// 默认参数（未配置时使用）
// 为什么默认 100000：NIST SP 800-132 推荐，兼顾安全与性能（现代机器 < 100ms）
const DEFAULT_ITERATIONS = 100000;
const SALT_BYTES = 16;
const KEY_BYTES = 64;
const DIGEST = 'sha512';

// 异步 PBKDF2：避免 pbkdf2Sync 阻塞 Node.js 事件循环
// 为什么必须异步：100k 迭代约耗时 80ms，同步会阻塞所有并发请求（含其他路由）
const pbkdf2Async = promisify(crypto.pbkdf2);

// 生成密码盐（16 字节随机数，base64 编码）
export function generateSalt(): string {
  return crypto.randomBytes(SALT_BYTES).toString('base64');
}

// 哈希密码：PBKDF2-SHA512（异步版本）
// 为什么 base64：JSON 友好，避免二进制存储问题
// 为什么 async：pbkdf2Sync 阻塞事件循环，并发登录会序列化执行
export async function hashPassword(password: string, salt: string, iterations: number = DEFAULT_ITERATIONS): Promise<string> {
  const saltBuffer = Buffer.from(salt, 'base64');
  const derived = await pbkdf2Async(password, saltBuffer, iterations, KEY_BYTES, DIGEST);
  return derived.toString('base64');
}

// 验证密码：使用恒定时间比较防止时序攻击
// 为什么不用 ===：字符串比较会短路，可通过响应时间推断前缀正确性
export async function verifyPassword(password: string, salt: string, expectedHash: string, iterations: number = DEFAULT_ITERATIONS): Promise<boolean> {
  const actualHash = await hashPassword(password, salt, iterations);
  // timingSafeEqual 长度不同会抛错，先做长度校验
  const a = Buffer.from(actualHash, 'base64');
  const b = Buffer.from(expectedHash, 'base64');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// 会话 Token 生成：32 字节随机数 + HMAC-SHA256 签名
// 格式：{randomBase64Url}.{hmacBase64Url}
// 为什么用 HMAC：防止攻击者伪造 token（即使知道格式也无法生成有效签名）
export function generateSessionToken(secret: string): string {
  const random = crypto.randomBytes(32);
  const randomStr = random.toString('base64url');
  const hmac = crypto.createHmac('sha256', secret).update(randomStr).digest('base64url');
  return `${randomStr}.${hmac}`;
}

// 验证会话 Token 的签名
export function verifySessionToken(token: string, secret: string): boolean {
  // 可选链合并 nullish 守卫与属性访问（S6582）：token 为空或不含 '.' 均返回 false
  if (!token?.includes('.')) return false;
  const [randomStr, hmac] = token.split('.');
  if (!randomStr || !hmac) return false;
  const expectedHmac = crypto.createHmac('sha256', secret).update(randomStr).digest('base64url');
  // 恒定时间比较签名
  const a = Buffer.from(hmac, 'base64url');
  const b = Buffer.from(expectedHmac, 'base64url');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// 从环境变量读取会话密钥（与 llm.apiKeyRef 一致的引用模式）
// 为什么回退到随机值：开发模式下未配置环境变量也能启动，但重启后会话失效
export function getSessionSecret(secretRef: string): string {
  const envSecret = process.env[secretRef];
  if (envSecret && envSecret.length >= 16) return envSecret;
  // 开发模式回退：生成临时密钥（重启后所有会话失效，需重新登录）
  // 为什么 console.warn：让开发者知道需要配置环境变量
  console.warn(`[auth] 环境变量 ${secretRef} 未配置或长度不足 16，使用临时密钥（重启后所有会话失效）`);
  return crypto.randomBytes(32).toString('base64url');
}
