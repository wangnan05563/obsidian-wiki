import { defineStore } from 'pinia';
import { ref } from 'vue';
import { useImageCompress } from '../composables/useImageCompress';
import { CHAT_STORES, dbGet, dbPut } from '../services/chatDb';
// §3.5 useAttachmentsStore — 图片附件管理。
// 职责：图片压缩→生成缩略图→存入 IndexedDB attachments store；提供 flush 返回 ids 供 SSE 请求携带。
// DB 复用：与 conversations.ts 共用同一个 DB_NAME='karpathy-wiki-chat'，attachments store 在 conversations.ts 的 upgrade 回调中创建。
const STORE_NAME = CHAT_STORES.attachments;
// 移到模块顶层避免每次 store 实例化重新创建函数实例（S7721）
// 仅依赖模块级常量 STORE_NAME 与 dbGet，无闭包变量
async function getThumbnail(id) {
    const record = await dbGet(STORE_NAME, id);
    return record?.thumbnail || null;
}
export const useAttachmentsStore = defineStore('attachments', () => {
    // 已存入 IndexedDB 但尚未随问答提交的附件 id 列表
    const pendingIds = ref([]);
    async function addImage(file) {
        const { compress, generateThumbnail } = useImageCompress();
        // 压缩到 ≤ 2MB，避免 IndexedDB 存储过大
        const compressed = await compress(file, 2);
        // 生成 200x200 缩略图用于列表展示
        const thumbnail = await generateThumbnail(compressed, 200);
        const id = crypto.randomUUID();
        const record = {
            id,
            filename: file.name,
            mimeType: file.type,
            size: compressed.size,
            blob: compressed,
            thumbnail,
        };
        await dbPut(STORE_NAME, record);
        pendingIds.value.push(id);
        return id;
    }
    function remove(id) {
        pendingIds.value = pendingIds.value.filter(i => i !== id);
    }
    // 提交问答时调用：返回 pending ids 并清空，后续由 query SSE 携带
    function flush() {
        const ids = [...pendingIds.value];
        pendingIds.value = [];
        return ids;
    }
    return { pendingIds, addImage, remove, getThumbnail, flush };
});
