import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { SkillMeta, SkillDetail, SkillImportResult, SkillListResponse } from '../types';

// 技能导入 store：管理技能列表、上传状态、当前查看技能详情。
// 为什么需要 store：Skill.vue 切换视图后状态保留，避免重复请求列表；
//   上传进行中的状态也需跨视图保留，避免用户切走再切回时上传中断。
export const useSkillStore = defineStore('skill', () => {
  // 技能列表（按 importedAt 倒序）
  const skills = ref<SkillMeta[]>([]);

  // 当前查看的技能详情（null 表示未选择）
  const currentDetail = ref<SkillDetail | null>(null);

  // 列表加载状态
  const loading = ref(false);
  const error = ref<string>('');

  // 上传状态
  const uploading = ref(false);
  const uploadProgress = ref(0); // 0-100
  const lastImportResult = ref<SkillImportResult | null>(null);
  const lastImportWarnings = ref<string[]>([]);

  // 技能总数
  const totalCount = computed(() => skills.value.length);

  // 总占用字节数
  const totalSize = computed(() => skills.value.reduce((sum, s) => sum + s.size, 0));

  // 加载技能列表
  async function fetchSkills(): Promise<void> {
    loading.value = true;
    error.value = '';
    try {
      const res = await fetch('/api/skills');
      if (!res.ok) {
        throw new Error(`加载技能列表失败：${res.status}`);
      }
      const data: SkillListResponse = await res.json();
      // 按 importedAt 倒序（新导入的在前）
      skills.value = [...data.skills].sort((a, b) =>
        b.importedAt.localeCompare(a.importedAt),
      );
    } catch (e) {
      error.value = e instanceof Error ? e.message : '加载技能列表失败';
    } finally {
      loading.value = false;
    }
  }

  // 上传技能包（multipart）
  // file: 用户选择的文件（.skill 或 .md）
  async function uploadSkill(file: File): Promise<SkillImportResult | null> {
    uploading.value = true;
    uploadProgress.value = 0;
    lastImportResult.value = null;
    lastImportWarnings.value = [];

    try {
      const formData = new FormData();
      formData.append('file', file);

      const res = await fetch('/api/skills/import', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: '上传失败' }));
        throw new Error(errBody.error || `上传失败：${res.status}`);
      }

      const result: SkillImportResult = await res.json();
      lastImportResult.value = result;
      lastImportWarnings.value = result.warnings ?? [];

      // 上传成功后刷新列表
      await fetchSkills();
      uploadProgress.value = 100;
      return result;
    } catch (e) {
      error.value = e instanceof Error ? e.message : '上传技能失败';
      return null;
    } finally {
      uploading.value = false;
    }
  }

  // 查看技能详情
  async function fetchSkillDetail(id: string): Promise<SkillDetail | null> {
    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(id)}`);
      if (!res.ok) {
        throw new Error(`获取技能详情失败：${res.status}`);
      }
      const detail: SkillDetail = await res.json();
      currentDetail.value = detail;
      return detail;
    } catch (e) {
      error.value = e instanceof Error ? e.message : '获取技能详情失败';
      return null;
    }
  }

  // 删除技能
  async function deleteSkill(id: string): Promise<boolean> {
    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        throw new Error(`删除技能失败：${res.status}`);
      }
      // 删除成功后从列表中移除
      skills.value = skills.value.filter((s) => s.id !== id);
      // 如果当前查看的技能被删除，清空详情
      if (currentDetail.value?.id === id) {
        currentDetail.value = null;
      }
      return true;
    } catch (e) {
      error.value = e instanceof Error ? e.message : '删除技能失败';
      return false;
    }
  }

  // 清空错误状态
  function clearError(): void {
    error.value = '';
  }

  // 清空当前详情
  function clearDetail(): void {
    currentDetail.value = null;
  }

  // 清空上传结果（关闭提示用）
  function clearImportResult(): void {
    lastImportResult.value = null;
    lastImportWarnings.value = [];
  }

  return {
    skills,
    currentDetail,
    loading,
    error,
    uploading,
    uploadProgress,
    lastImportResult,
    lastImportWarnings,
    totalCount,
    totalSize,
    fetchSkills,
    uploadSkill,
    fetchSkillDetail,
    deleteSkill,
    clearError,
    clearDetail,
    clearImportResult,
  };
});
