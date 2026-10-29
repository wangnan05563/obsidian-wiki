import { API_BASE, apiFetch, downloadApiFile } from '../utils/apiBase';

// 已投递原始文档（T03611）：列表与下载。
// 权限由后端按当前登录用户归属过滤（他人 id 返回 404），前端不传用户标识。
export interface UploadedDocument {
  id: string;
  originalName: string;
  size: number;
  mimeType: string;
  uploadedAt: string;
  source: 'file' | 'batch';
}

export async function listUploadedDocuments(limit = 50): Promise<UploadedDocument[]> {
  const res = await apiFetch(`${API_BASE}/uploads?limit=${limit}`);
  if (!res.ok) {
    throw new Error(`加载已投递文档失败：HTTP ${res.status}`);
  }
  const data = (await res.json()) as { uploads?: UploadedDocument[] };
  return Array.isArray(data?.uploads) ? data.uploads : [];
}

export async function downloadUploadedDocument(doc: Pick<UploadedDocument, 'id' | 'originalName'>): Promise<void> {
  const url = `${API_BASE}/uploads/${encodeURIComponent(doc.id)}/download`;
  await downloadApiFile(url, doc.originalName);
}
