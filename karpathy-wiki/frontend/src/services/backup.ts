// 本地备份导出 / 导入（风险 R-2）：将本地 IndexedDB 的会话（及附件）加密导出为自包含文件，
// 可凭独立口令恢复，缓解「清缓存 / 换设备 / 重装导致本地数据丢失」。
//
// 设计要点：
//   - 备份文件自带 salt + iv，与设备盐 / 登录密码无关 → 即使遗忘登录密码，凭备份口令仍可恢复。
//   - 与 FR-RM-07 的「登录密码派生密钥」相互独立：本地静态加密防同设备读取；备份防丢失。
//   - 导出内容经 dbGetAll 读取（若本地已加密则先透明解密），再用备份口令重新加密落盘。

import { dbGetAll, dbPut } from './chatDb';
import { deriveKey, encryptString, decryptString, randomBytes, bytesToBase64, base64ToBytes } from './crypto';

const BACKUP_FORMAT = 'karpathy-wiki-backup';
const BACKUP_VERSION = 1;

export interface BackupFile {
  format: string;
  version: number;
  exportedAt: string;
  // 自包含：备份口令派生的盐与本次加密的 IV，不依赖设备盐
  salt: string;
  iv: string;
  ct: string;
}

interface BackupPayload {
  conversations: unknown[];
  attachments: unknown[];
}

export async function createBackup(password: string): Promise<BackupFile> {
  const conversations = await dbGetAll('conversations');
  const attachments = await dbGetAll('attachments');
  const payload: BackupPayload = { conversations, attachments };
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt);
  const { iv, ct } = await encryptString(key, JSON.stringify(payload));
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    salt: bytesToBase64(salt),
    iv,
    ct,
  };
}

export async function restoreBackup(file: BackupFile, password: string): Promise<{ conversations: number; attachments: number }> {
  const salt = base64ToBytes(file.salt);
  const key = await deriveKey(password, salt);
  let payload: BackupPayload;
  try {
    const json = await decryptString(key, file.iv, file.ct);
    payload = JSON.parse(json) as BackupPayload;
  } catch {
    throw new Error('备份口令错误或文件已损坏');
  }
  const conversations = payload.conversations ?? [];
  const attachments = payload.attachments ?? [];
  for (const c of conversations) await dbPut('conversations', c as never);
  for (const a of attachments) await dbPut('attachments', a as never);
  return { conversations: conversations.length, attachments: attachments.length };
}

export function downloadBackup(file: BackupFile): void {
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `karpathy-wiki-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function readBackupFile(file: File): Promise<BackupFile> {
  const text = await file.text();
  const obj = JSON.parse(text) as BackupFile;
  if (obj.format !== BACKUP_FORMAT || typeof obj.salt !== 'string' || typeof obj.iv !== 'string' || typeof obj.ct !== 'string') {
    throw new Error('不是有效的备份文件');
  }
  return obj;
}
