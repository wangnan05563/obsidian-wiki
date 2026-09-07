// 消息输入框个人偏好 store（按用户隔离）。
//
// 设计对齐 CODING-SESSION-ISOLATION（前端多账户会话状态隔离）与 CODING-BYOK（每用户配置本地命名空间）：
//   - 不同用户在同一浏览器登录时，各自的输入框设置（字体大小 / 主题 / 快捷回复 / 历史偏好等）
//     必须互不干扰、互不可见。底层复用 chatDb 的 preferences 仓库，键名内嵌 userId：
//     'usercfg::inputbox::<userId>'，应用层只读取"当前登录用户"的命名空间，天然隔离。
//   - 存储位于客户端 IndexedDB，后端重部署 / 升级 / 重装均不影响用户本地偏好（与"个人配置仅存本地"约定一致）。
//
// 关键隔离约束（避免"上一账户设置残留到下一账户"）：
//   1. state ref 必须全部 return（漏加则赋值不可观测，等于死状态）；
//   2. 账户切换 / 登出时消费侧必须调 applyForUser(newId)，且内部先同步重置为默认，再异步按新 userId 加载；
//   3. 异步加载带竞态防护（loadToken + editedToken）：仅当本次加载仍是当前用户、且用户尚未对该用户做过编辑时
//      才写入；防止"加载早于编辑完成"时陈旧默认值覆盖刚保存的偏好（切换账户/挂载即编辑的竞态）；
//   4. 持久化严格按当前 userId 命名空间写入，绝不跨用户。

import { defineStore } from 'pinia';
import { ref } from 'vue';
import {
  clone,
  loadInputBoxSettings,
  saveInputBoxSettings,
  DEFAULT_INPUT_BOX_SETTINGS,
  type InputBoxSettings,
} from '../services/userConfig';

export const useInputBoxSettings = defineStore('inputBoxSettings', () => {
  // 当前作用用户（null=游客，不持久化偏好）
  const userId = ref<string | null>(null);
  // 当前用户的输入框偏好（响应式，绑定到输入框 UI）
  const settings = ref<InputBoxSettings>(clone(DEFAULT_INPUT_BOX_SETTINGS));
  // 异步加载完成标记（避免首帧闪默认值误判）
  const ready = ref(false);

  // 加载代际：每次 applyForUser 自增；editedToken 记录"最近一次编辑所属代际"。
  // 用于竞态防护：applyForUser 触发的异步加载仅当"仍是当前代际且本代际未被编辑"才写入 settings，
  // 否则丢弃（避免加载早于编辑完成时，陈旧默认值覆盖用户刚保存的偏好）。
  let loadToken = 0;
  let editedToken = -1;

  // 按用户隔离加载：先同步重置为默认（阻断上一账户偏好残留），再异步按 userId 命名空间读取。
  function applyForUser(id: string | null = null): void {
    const targetId = id;
    // 同步重置：下一账户实时 UI 立即回到默认，绝不沿用上一账户字体/主题/快捷回复
    userId.value = targetId;
    settings.value = clone(DEFAULT_INPUT_BOX_SETTINGS);
    ready.value = false;
    const myToken = ++loadToken;
    if (!targetId) {
      // 游客：无命名空间，保留默认且标记就绪（UI 仍可交互，只是不持久化）
      ready.value = true;
      return;
    }
    void loadInputBoxSettings(targetId)
      .then((loaded) => {
        // 已切换到其他账户（代际变化）或本代际已被用户编辑过 -> 丢弃陈旧/过期结果
        if (loadToken !== myToken || editedToken === myToken) return;
        settings.value = loaded;
        ready.value = true;
      })
      .catch(() => {
        if (loadToken !== myToken || editedToken === myToken) return;
        ready.value = true; // 加载失败也标记就绪，降级为默认，不阻断输入
      });
  }

  // 局部更新并持久化（按当前 userId 命名空间；游客仅内存生效）
  async function update(partial: Partial<InputBoxSettings>): Promise<void> {
    settings.value = { ...settings.value, ...partial };
    editedToken = loadToken; // 标记当前代际已被编辑，阻止迟到加载覆盖
    if (!userId.value) return;
    await saveInputBoxSettings(userId.value, settings.value);
  }

  // 恢复默认并持久化
  async function resetToDefaults(): Promise<void> {
    settings.value = clone(DEFAULT_INPUT_BOX_SETTINGS);
    editedToken = loadToken;
    if (!userId.value) return;
    await saveInputBoxSettings(userId.value, settings.value);
  }

  return { userId, settings, ready, applyForUser, update, resetToDefaults };
});
