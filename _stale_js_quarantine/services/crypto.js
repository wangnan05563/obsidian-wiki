// 本地加密工具（FR-RM-07）：基于 Web Crypto（浏览器 / Node 22 均内置）。
// 用途：PBKDF2(密码, 设备盐) 派生 AES-GCM 密钥，对本地 IndexedDB 会话做静态加密，
// 降低同设备其他进程 / 用户在浏览器关闭态读取明文 IndexedDB 的风险（风险 R-3）。
// 密钥不离开本地；加密密钥由登录密码派生，明文密码不落盘。
const PBKDF2_ITERATIONS = 200_000;
export function getCrypto() {
    const c = globalThis.crypto;
    if (!c || !c.subtle || !c.getRandomValues) {
        throw new Error('当前环境不支持 Web Crypto');
    }
    return c;
}
export function randomBytes(n) {
    const arr = new Uint8Array(n);
    getCrypto().getRandomValues(arr);
    return arr;
}
export function bytesToBase64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++)
        bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}
export function base64ToBytes(b64) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++)
        arr[i] = bin.charCodeAt(i);
    return arr;
}
// PBKDF2(SHA-256, 200k) → AES-GCM 256 密钥
export async function deriveKey(password, salt) {
    const subtle = getCrypto().subtle;
    const baseKey = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    return subtle.deriveKey({ name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' }, baseKey, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}
export async function encryptString(key, plaintext) {
    const subtle = getCrypto().subtle;
    const iv = randomBytes(12);
    const ctBuf = await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
    return { iv: bytesToBase64(iv), ct: bytesToBase64(new Uint8Array(ctBuf)) };
}
export async function decryptString(key, ivB64, ctB64) {
    const subtle = getCrypto().subtle;
    const ptBuf = await subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(ivB64) }, key, base64ToBytes(ctB64));
    return new TextDecoder().decode(ptBuf);
}
// 信封加密：保留明文索引字段（plainFields，用于主键 / 隔离 / 排序），其余字段加密进 ct。
// 解密时把 secret 与明文索引字段合并，对消费方透明（FR-RM-07 透明加密）。
export async function sealRecord(record, plainFields, key) {
    const plain = {};
    const secret = {};
    for (const [k, v] of Object.entries(record)) {
        if (k === '_enc' || k === 'iv' || k === 'ct')
            continue;
        if (plainFields.includes(k))
            plain[k] = v;
        else
            secret[k] = v;
    }
    const { iv, ct } = await encryptString(key, JSON.stringify(secret));
    return { ...plain, _enc: 1, iv, ct };
}
export async function openRecord(envelope, key) {
    const secretJson = await decryptString(key, envelope.iv, envelope.ct);
    const secret = JSON.parse(secretJson);
    const plain = {};
    for (const [k, v] of Object.entries(envelope)) {
        if (k === '_enc' || k === 'iv' || k === 'ct')
            continue;
        plain[k] = v;
    }
    return { ...secret, ...plain };
}
export function isSealed(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const o = value;
    return o._enc === 1 && typeof o.iv === 'string' && typeof o.ct === 'string';
}
