// T02449：菜单分组配置与纯分组函数测试（PRD N1）
// 覆盖：菜单完整性（15 项/key 唯一）/ 清理类相邻 / 分组顺序 / 组内保序 / 空组过滤 / 入参不可变
import { describe, it, expect } from 'vitest';
import { menuItems, menuGroupDefs, groupMenuItems, type MenuItem } from '../src/config/menu';

describe('menuItems 完整性', () => {
  it('共 15 项且 key 唯一', () => {
    expect(menuItems).toHaveLength(15);
    expect(new Set(menuItems.map((m) => m.key)).size).toBe(15);
  });

  it('每项 label/icon/permission 非空且 group 合法', () => {
    for (const m of menuItems) {
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.icon.length).toBeGreaterThan(0);
      expect(m.permission.length).toBeGreaterThan(0);
      expect(menuGroupDefs.some((g) => g.key === m.group)).toBe(true);
    }
  });

  it('清理类相邻：ops 组内为 体检/系统清理/数据清洗', () => {
    const ops = menuItems.filter((m) => m.group === 'ops').map((m) => m.key);
    expect(ops).toEqual(['health', 'cleanup', 'dataclean']);
  });

  it('仪表盘在知识组首位', () => {
    const knowledge = menuItems.filter((m) => m.group === 'knowledge').map((m) => m.key);
    expect(knowledge[0]).toBe('dashboard');
  });

  it('图标互斥：15 项图标全部不同（T02451 N7 回归）', () => {
    // 历史坑：users 复用 about、skill 复用 config、dataclean 复用 cleanup，视觉重复
    expect(new Set(menuItems.map((m) => m.icon)).size).toBe(15);
  });
});

describe('groupMenuItems', () => {
  it('按 defs 顺序输出 4 组（知识/生产/运维/系统）', () => {
    const groups = groupMenuItems(menuItems);
    expect(groups.map((g) => g.key)).toEqual(['knowledge', 'produce', 'ops', 'system']);
    expect(groups.map((g) => g.label)).toEqual(['知识', '生产', '运维', '系统']);
  });

  it('组内保持传入顺序', () => {
    const groups = groupMenuItems(menuItems);
    expect(groups[0].items.map((m) => m.key)).toEqual(['dashboard', 'browse', 'query', 'graph']);
    expect(groups[3].items.map((m) => m.key)).toEqual(['config', 'tunnel', 'users', 'skill', 'help', 'about']);
  });

  it('过滤空组（模拟无权限用户只见知识组）', () => {
    const onlyKnowledge = menuItems.filter((m) => m.group === 'knowledge');
    const groups = groupMenuItems(onlyKnowledge);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('knowledge');
  });

  it('全部组为空时返回空数组', () => {
    expect(groupMenuItems([])).toEqual([]);
  });

  it('不修改入参', () => {
    const input: MenuItem[] = [menuItems[0], menuItems[4]];
    const snapshot = JSON.stringify(input);
    groupMenuItems(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
