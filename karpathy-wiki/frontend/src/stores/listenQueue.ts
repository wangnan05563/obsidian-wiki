import { defineStore } from 'pinia';
import { ref } from 'vue';

// T02942：移动端「聆听」播放列表的共享数据源。
// 背景：MobileListen 的队列原先是组件内 ref，MobileQuery 的「加入聆听」无法触达；
// MobileListen 用 v-show 常驻挂载（后台播放不中断），因此把队列提到 store 即可让两个 Tab 共用同一份清单。
// 口径沿用 MobileListen 既有 QueueItem：path 作去重键、title 作展示名、body 为待朗读正文。
export interface ListenQueueItem {
  path: string;
  title: string;
  body: string;
  voice?: string;
}

export const useListenQueueStore = defineStore('listenQueue', () => {
  const queue = ref<ListenQueueItem[]>([]);

  function has(path: string): boolean {
    return queue.value.some((q) => q.path === path);
  }

  /** 入列；重复 path 返回 false（与 MobileListen 原 enqueue 的去重口径一致） */
  function add(item: ListenQueueItem): boolean {
    if (has(item.path)) return false;
    queue.value.push(item);
    return true;
  }

  function clear(): void {
    queue.value = [];
  }

  return { queue, has, add, clear };
});
