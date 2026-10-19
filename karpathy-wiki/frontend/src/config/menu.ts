// wiki三期 T02449（PRD N1）：侧栏菜单分组配置与纯分组函数
// 4 组：知识 / 生产 / 运维 / 系统；组内按使用频率排序，同权限点的清理类相邻摆放（缓存与日志清理+页面质量清洗）
// 为什么抽成独立模块：分组逻辑可单测（纯函数），App.vue 只消费；新增菜单只改此处
import type { AuthPermission } from '../types';

export type ViewName =
  | 'dashboard'
  | 'ingest'
  | 'progress'
  | 'browse'
  | 'query'
  | 'graph'
  | 'health'
  | 'config'
  | 'tunnel'
  | 'cleanup'
  | 'about'
  | 'help'
  | 'users'
  | 'skill'
  | 'dataclean';

export type MenuGroupKey = 'knowledge' | 'produce' | 'ops' | 'system';

export interface MenuItem {
  key: ViewName;
  icon: string;
  label: string;
  permission: AuthPermission;
  group: MenuGroupKey;
}

export interface MenuGroupDef {
  key: MenuGroupKey;
  label: string;
}

export interface MenuGroup {
  key: MenuGroupKey;
  label: string;
  items: MenuItem[];
}

// 分组定义（渲染顺序即此顺序）
export const menuGroupDefs: MenuGroupDef[] = [
  { key: 'knowledge', label: '知识' },
  { key: 'produce', label: '生产' },
  { key: 'ops', label: '运维' },
  { key: 'system', label: '系统' },
];

// 全量菜单（15 项）。注意：dataclean 紧随 cleanup（N1：同类项相邻，修复原「相隔 4 项」）
export const menuItems: MenuItem[] = [
  // 知识组：仪表盘（总览）+ 浏览/问答/图谱，按使用频率
  { key: 'dashboard', icon: 'dashboard', label: '仪表盘', permission: 'dashboard', group: 'knowledge' },
  { key: 'browse', icon: 'browse', label: '知识浏览', permission: 'browse', group: 'knowledge' },
  { key: 'query', icon: 'query', label: '知识问答', permission: 'query', group: 'knowledge' },
  { key: 'graph', icon: 'graph', label: '知识图谱', permission: 'graph', group: 'knowledge' },
  // 生产组：投递资料 / 编译进度
  { key: 'ingest', icon: 'ingest', label: '投递资料', permission: 'ingest', group: 'produce' },
  { key: 'progress', icon: 'progress', label: '编译进度', permission: 'progress', group: 'produce' },
  // 运维组：体检中心 / 缓存与日志清理 / 页面质量清洗（清理类相邻）
  // T02470 S5：原名「系统清理」与「数据清洗」职责不可辨（两页共用 cleanup 权限、名称近似），
  // 改成说清删的是什么的「缓存与日志清理」；菜单名 = 页标题 = 帮助文档条目名。
  { key: 'health', icon: 'health', label: '体检中心', permission: 'health', group: 'ops' },
  { key: 'cleanup', icon: 'cleanup', label: '缓存与日志清理', permission: 'cleanup', group: 'ops' },
  { key: 'dataclean', icon: 'dataclean', label: '页面质量清洗', permission: 'cleanup', group: 'ops' },
  // 系统组：配置 / 穿透 / 用户 / 技能 / 帮助 / 关于
  { key: 'config', icon: 'config', label: '配置中心', permission: 'dashboard', group: 'system' },
  { key: 'tunnel', icon: 'tunnel', label: '内网穿透', permission: 'tunnel', group: 'system' },
  { key: 'users', icon: 'users', label: '用户管理', permission: 'users', group: 'system' },
  { key: 'skill', icon: 'skill', label: '技能管理', permission: 'skill', group: 'system' },
  { key: 'help', icon: 'help', label: '帮助文档', permission: 'help', group: 'system' },
  { key: 'about', icon: 'about', label: '关于', permission: 'about', group: 'system' },
];

/**
 * 纯分组函数：按 defs 顺序把 items 分到各组，过滤空组，组内保持 items 相对顺序。
 * 调用方先做权限过滤（filterVisibleMenus）再传入，因此无权限的组自动消失。
 */
export function groupMenuItems(items: MenuItem[], defs: MenuGroupDef[] = menuGroupDefs): MenuGroup[] {
  return defs
    .map((d) => ({ key: d.key, label: d.label, items: items.filter((m) => m.group === d.key) }))
    .filter((g) => g.items.length > 0);
}
