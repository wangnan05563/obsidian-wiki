// 运行状态存储的目录合流包装（T02772）。
//
// 为什么需要这一层：harness 只在未提供 stateStore 时回退到 `new FileStateStore()`，
// 而那个默认值的目录是**相对进程 CWD** 的 `.harness/state`——写入位置随启动目录漂移，
// 清理与读取都追不上（详见 utils/run-state-dirs.ts 的头注释）。
//
// 做法：写入一律落规范目录（可写、与 vault 同级、SEA 下也稳定）；读取先查规范目录，
// 查不到再回退遗留目录。为什么读取必须回退：升级前跑过的编译/问答，其断点续传状态
// 还在遗留目录里，若只认新目录，用户点「继续」会被告知没有可恢复的运行——
// 那是把「清不到」的缺陷换成「恢复不了」的缺陷，不可接受。
//
// 为什么复用 FileStateStore 而不是自己读写 JSON：runId 的 UUID 校验（防路径穿越）
// 与旧版 messages→events 的兼容迁移都在它里面，另写一份必然漏抄。
import { FileStateStore } from '@wiki/harness';
import type { StateStore } from '@wiki/harness';
import { getRunStateDirs } from '../utils/run-state-dirs.js';

// dirs 可注入：生产不传（取真实目录清单），单测传临时目录。
// 为什么容忍空数组兜底：dirs 为空会让 primary 变成 undefined，运行期才炸；
// 这里显式回退到默认清单，配置错误在调用点就修好而不是留到断点续传时。
export function createRunStateStore(dirs: string[] = getRunStateDirs()): StateStore {
  const stores = (dirs.length > 0 ? dirs : getRunStateDirs()).map((dir) => new FileStateStore(dir));
  const [primary, ...fallbacks] = stores;

  return {
    // 只写规范目录：遗留目录从此不再新增文件，清完即收敛
    async save(runId, state) {
      await primary.save(runId, state);
    },

    async load(runId) {
      const hit = await primary.load(runId);
      if (hit) return hit;
      for (const store of fallbacks) {
        const legacy = await store.load(runId);
        if (legacy) return legacy;
      }
      return null;
    },

    // 列表取并集：续传入口要能同时看到新写入的与历史遗留的运行
    async list() {
      const ids = new Set<string>();
      for (const store of stores) {
        for (const id of await store.list()) ids.add(id);
      }
      return [...ids];
    },
  };
}
