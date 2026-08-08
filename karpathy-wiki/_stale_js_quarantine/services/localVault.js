// 本地密钥保险库（FR-RM-07）：管理由登录密码派生的 AES-GCM 密钥的生命周期。
//
// 密钥驻留策略：
//   - 内存（登录期间可用）
//   - 镜像到 sessionStorage（同一标签页刷新可免重新输入密码）
//   - 关闭标签页即清除（sessionStorage 随标签页销毁）→ 加密的本地数据需重新登录（输入密码）方可解密
//
// 威胁模型：浏览器关闭 / 标签页关闭后，磁盘上只有密文（IndexedDB）+ 设备盐（localStorage，非机密），
// 派生密钥不在磁盘常驻，从而实质性缓解「同设备其他进程在浏览器关闭态读取明文 IndexedDB」（风险 R-3）。
// 设备盐仅用于 PBKDF2 抗彩虹表，非机密，存 localStorage 即可。
//
// 约束（FR-RM-07）：明文密码不落盘；遗忘登录密码将导致本地密文不可逆，
// 须凭「导出备份」（独立口令，见 backup.ts）恢复 —— 故 R-2 与 FR-RM-07 配套。
import { deriveKey, getCrypto, randomBytes, bytesToBase64, base64ToBytes } from './crypto';
const DEVICE_SALT_KEY = 'karpathy-wiki-device-salt';
const SESSION_KEY_KEY = 'karpathy-wiki-local-key';
let memKey = null;
function getDeviceSalt() {
    let raw = localStorage.getItem(DEVICE_SALT_KEY);
    if (!raw) {
        raw = bytesToBase64(randomBytes(16));
        localStorage.setItem(DEVICE_SALT_KEY, raw);
    }
    return base64ToBytes(raw);
}
export function isUnlocked() {
    return memKey !== null;
}
// 用登录密码派生并装入内存密钥（登录 / 注册成功时调用）
export async function unlock(password) {
    const key = await deriveKey(password, getDeviceSalt());
    memKey = key;
    // 镜像到 sessionStorage，刷新同标签页时免重新输入密码
    try {
        const raw = await getCrypto().subtle.exportKey('raw', key);
        sessionStorage.setItem(SESSION_KEY_KEY, bytesToBase64(new Uint8Array(raw)));
    }
    catch {
        // sessionStorage 不可用时仅保留内存密钥
    }
}
// 应用启动时调用：若 sessionStorage 中存在密钥（同标签页刷新场景），恢复内存密钥
export async function restoreKeyFromSession() {
    try {
        const raw = sessionStorage.getItem(SESSION_KEY_KEY);
        if (!raw)
            return false;
        memKey = await getCrypto().subtle.importKey('raw', base64ToBytes(raw), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        return true;
    }
    catch {
        return false;
    }
}
// 登出 / 锁定：清除内存与 sessionStorage 中的密钥
export function lock() {
    memKey = null;
    try {
        sessionStorage.removeItem(SESSION_KEY_KEY);
    }
    catch {
        // 忽略
    }
}
export function getKey() {
    return memKey;
}
// 修改登录密码时：用新密码重派生并替换内存密钥（FR-RM-07 约束：改密触发本地数据重加密）。
// 上层应随后调用 chatDb 的迁移把明文 / 旧密钥密文重写为新密钥密文。
export async function rotateKey(newPassword) {
    await unlock(newPassword);
}
