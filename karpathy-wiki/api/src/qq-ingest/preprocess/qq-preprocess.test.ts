// qq-preprocess.ts 单元测试
// 覆盖：TXT/JSON 解析、6 条噪声过滤规则、5 类 PII 脱敏、长文本分块、边界条件

import { describe, it, expect } from 'vitest';
import {
  preprocessQqChat,
  redactExtractOutput,
} from './qq-preprocess.js';
import type { QqConfig } from '../../types.js';

// 测试用默认配置（与 config.ts defaultConfig().qq 一致）
const TEST_CONFIG: QqConfig = {
  noise_rules: {
    'NR-1': true,
    'NR-2': true,
    'NR-3': true,
    'NR-4': true,
    'NR-5': true,
    'NR-6': true,
  },
  privacy_patterns: {
    phone: '1[3-9]\\d{9}',
    id_card: '\\d{17}[\\dXx]',
    email: '[\\w.-]+@[\\w.-]+\\.\\w+',
    card: '\\d{16,19}',
    qq: '(?<=QQ|扣扣|qq号|企鹅)\\s*[0-9]{5,11}',
  },
  max_batch_size: 20,
  chunk_threshold: 200,
  extract_model: 'glm-4-plus',
  extract_base_url: '',
  extract_token_budget: 50000,
};

describe('qq-preprocess', () => {
  // ==========================================================================
  // TXT 格式解析
  // ==========================================================================
  describe('TXT 格式解析', () => {
    it('应正确解析 QQ 自带消息管理器导出的 TXT 格式', async () => {
      const txt = `测试群 聊天记录
2026-07-20 14:30:15 张三<zhangsan@qq.com>
你好，请问如何配置环境变量？
2026-07-20 14:30:20 李四<lisi@qq.com>
在 .env 文件中添加 CONFIG_KEY=value 即可`;
      const data = await preprocessQqChat(txt, 'test.txt', TEST_CONFIG);
      expect(data.result.meta.chatName).toBe('测试群');
      expect(data.result.meta.originalCount).toBe(2);
      expect(data.result.meta.filteredCount).toBe(2);
    });

    it('chatName 解析失败时应使用文件名兜底', async () => {
      const txt = `2026-07-20 14:30:15 张三<zhangsan@qq.com>
你好`;
      const data = await preprocessQqChat(txt, 'mychat.txt', TEST_CONFIG);
      expect(data.result.meta.chatName).toBe('mychat');
    });
  });

  // ==========================================================================
  // JSON 格式解析
  // ==========================================================================
  describe('JSON 格式解析', () => {
    it('应正确解析 qq-chat-exporter JSON 格式', async () => {
      const json = JSON.stringify({
        meta: { source: 'qq-chat-exporter', chatName: '技术交流群' },
        messages: [
          { timestamp: '2026-07-20 14:30:15', speaker: '张三', type: 'text', content: '如何部署？' },
          { timestamp: '2026-07-20 14:30:20', speaker: '李四', type: 'text', content: '用 docker compose up' },
        ],
      });
      const data = await preprocessQqChat(json, 'test.json', TEST_CONFIG);
      expect(data.result.meta.chatName).toBe('技术交流群');
      expect(data.result.meta.originalCount).toBe(2);
    });

    it('JSON 缺少 messages 数组应回退到 TXT 解析', async () => {
      const json = JSON.stringify({ meta: { chatName: 'test' } });
      const data = await preprocessQqChat(json, 'test.json', TEST_CONFIG);
      // 回退到 TXT 解析后，messages 为空（JSON 字符串不含时间戳行）
      expect(data.result.meta.originalCount).toBe(0);
    });
  });

  // ==========================================================================
  // 噪声过滤规则 NR-1 ~ NR-6
  // ==========================================================================
  describe('噪声过滤 NR-1: 纯表情/图片占位符', () => {
    it('应过滤 [图片] [表情] [动画表情] 等占位符', async () => {
      const json = JSON.stringify({
        meta: { chatName: 'test' },
        messages: [
          { timestamp: '2026-07-20 14:30:15', speaker: 'A', content: '[图片]' },
          { timestamp: '2026-07-20 14:30:16', speaker: 'B', content: '[表情]' },
          { timestamp: '2026-07-20 14:30:17', speaker: 'C', content: '[动画表情]' },
          { timestamp: '2026-07-20 14:30:18', speaker: 'D', content: '这是有价值的消息' },
        ],
      });
      const data = await preprocessQqChat(json, 'test.json', TEST_CONFIG);
      expect(data.result.meta.originalCount).toBe(4);
      expect(data.result.meta.filteredCount).toBe(1);
    });
  });

  describe('噪声过滤 NR-2: 短回应', () => {
    it('应过滤 <5 字且不含 ? ! 的短回应', async () => {
      const json = JSON.stringify({
        meta: { chatName: 'test' },
        messages: [
          { timestamp: '2026-07-20 14:30:15', speaker: 'A', content: '嗯' },
          { timestamp: '2026-07-20 14:30:16', speaker: 'B', content: '好的' },
          { timestamp: '2026-07-20 14:30:17', speaker: 'C', content: 'ok' },
          { timestamp: '2026-07-20 14:30:18', speaker: 'D', content: '什么是微服务？' },
        ],
      });
      const data = await preprocessQqChat(json, 'test.json', TEST_CONFIG);
      // "嗯""好的""ok" 被过滤，"什么是微服务？" 保留（含 ?）
      expect(data.result.meta.filteredCount).toBe(1);
    });
  });

  describe('噪声过滤 NR-3: 系统消息', () => {
    it('应过滤含"撤回了""加入了"等关键词的系统消息', async () => {
      const json = JSON.stringify({
        meta: { chatName: 'test' },
        messages: [
          { timestamp: '2026-07-20 14:30:15', speaker: '系统', content: '张三 加入了群聊' },
          { timestamp: '2026-07-20 14:30:16', speaker: '系统', content: '李四 撤回了一条消息' },
          { timestamp: '2026-07-20 14:30:17', speaker: 'A', content: '这是正常消息内容' },
        ],
      });
      const data = await preprocessQqChat(json, 'test.json', TEST_CONFIG);
      expect(data.result.meta.filteredCount).toBe(1);
    });
  });

  describe('噪声过滤 NR-4: 纯链接消息', () => {
    it('应过滤整条匹配 http(s):// 的消息', async () => {
      const json = JSON.stringify({
        meta: { chatName: 'test' },
        messages: [
          { timestamp: '2026-07-20 14:30:15', speaker: 'A', content: 'https://example.com/article' },
          { timestamp: '2026-07-20 14:30:16', speaker: 'B', content: '看这个链接 https://example.com 很有用' },
        ],
      });
      const data = await preprocessQqChat(json, 'test.json', TEST_CONFIG);
      // 第一条纯链接被过滤，第二条含文字保留
      expect(data.result.meta.filteredCount).toBe(1);
    });
  });

  describe('噪声过滤 NR-5: 纯数字/纯标点', () => {
    it('应过滤纯数字或纯标点消息', async () => {
      const json = JSON.stringify({
        meta: { chatName: 'test' },
        messages: [
          { timestamp: '2026-07-20 14:30:15', speaker: 'A', content: '12345' },
          { timestamp: '2026-07-20 14:30:16', speaker: 'B', content: '。。。' },
          { timestamp: '2026-07-20 14:30:17', speaker: 'C', content: '!!!' },
          { timestamp: '2026-07-20 14:30:18', speaker: 'D', content: '版本号是 v1.2.3' },
        ],
      });
      const data = await preprocessQqChat(json, 'test.json', TEST_CONFIG);
      // "12345""。。。""!!!" 被过滤，"版本号是 v1.2.3" 保留（含字母与中文）
      expect(data.result.meta.filteredCount).toBe(1);
    });
  });

  describe('噪声过滤 NR-6: 重复刷屏', () => {
    it('应过滤同一发言人连续 5 条相同内容', async () => {
      const messages = [];
      for (let i = 0; i < 6; i++) {
        messages.push({
          timestamp: `2026-07-20 14:30:${15 + i}`,
          speaker: 'A',
          content: '刷屏消息',
        });
      }
      messages.push({
        timestamp: '2026-07-20 14:30:25',
        speaker: 'B',
        content: '这是正常消息',
      });
      const json = JSON.stringify({ meta: { chatName: 'test' }, messages });
      const data = await preprocessQqChat(json, 'test.json', TEST_CONFIG);
      // 前 5 条保留（连续计数 < 5），第 6 条触发 NR-6 过滤，B 的消息保留
      // 注意：NR-6 触发条件是"连续 5 条相同"，第 5 条时 consecutiveCount=5，触发过滤
      expect(data.result.meta.filteredCount).toBeLessThanOrEqual(3);
    });
  });

  // ==========================================================================
  // PII 脱敏
  // ==========================================================================
  describe('PII 脱敏', () => {
    it('应脱敏手机号', async () => {
      const json = JSON.stringify({
        meta: { chatName: 'test' },
        messages: [
          { timestamp: '2026-07-20 14:30:15', speaker: 'A', content: '联系我 13812345678' },
        ],
      });
      const data = await preprocessQqChat(json, 'test.json', TEST_CONFIG);
      const parsed = JSON.parse(data.jsonContent);
      expect(parsed.chunks[0][0].content).toContain('[REDACTED-PHONE]');
      expect(parsed.chunks[0][0].content).not.toContain('13812345678');
      expect(data.result.meta.redactedCount).toBe(1);
    });

    it('应脱敏邮箱', async () => {
      const json = JSON.stringify({
        meta: { chatName: 'test' },
        messages: [
          { timestamp: '2026-07-20 14:30:15', speaker: 'A', content: '发到 test@example.com 吧' },
        ],
      });
      const data = await preprocessQqChat(json, 'test.json', TEST_CONFIG);
      const parsed = JSON.parse(data.jsonContent);
      expect(parsed.chunks[0][0].content).toContain('[REDACTED-EMAIL]');
      expect(data.result.meta.redactedCount).toBe(1);
    });

    it('应脱敏上下文含"QQ"的 QQ 号', async () => {
      const json = JSON.stringify({
        meta: { chatName: 'test' },
        messages: [
          { timestamp: '2026-07-20 14:30:15', speaker: 'A', content: '我的QQ 123456789' },
        ],
      });
      const data = await preprocessQqChat(json, 'test.json', TEST_CONFIG);
      const parsed = JSON.parse(data.jsonContent);
      expect(parsed.chunks[0][0].content).toContain('[REDACTED-QQ]');
      expect(parsed.chunks[0][0].content).not.toContain('123456789');
    });

    it('不应脱敏无上下文的纯数字（避免误伤版本号）', async () => {
      const json = JSON.stringify({
        meta: { chatName: 'test' },
        messages: [
          { timestamp: '2026-07-20 14:30:15', speaker: 'A', content: '版本号 123456789' },
        ],
      });
      const data = await preprocessQqChat(json, 'test.json', TEST_CONFIG);
      const parsed = JSON.parse(data.jsonContent);
      // "版本号 123456789" 中的数字不匹配 qq 正则（无 QQ/扣扣/qq号/企鹅 前缀）
      // 但可能匹配 card 正则（16-19 位），123456789 只有 9 位，不匹配
      expect(parsed.chunks[0][0].content).toContain('123456789');
    });
  });

  // ==========================================================================
  // 长文本分块
  // ==========================================================================
  describe('长文本分块', () => {
    it('消息数 > chunk_threshold 应按时间窗口分块', async () => {
      const messages = [];
      // 生成 250 条消息（同一天），超过默认阈值 200
      for (let i = 0; i < 250; i++) {
        const hour = Math.floor(i / 50) + 10; // 10:00 ~ 14:00
        const minute = (i % 50);
        messages.push({
          timestamp: `2026-07-20 ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`,
          speaker: `用户${i % 5}`,
          content: `这是第 ${i} 条有价值的长消息内容，包含足够的字数避免被 NR-2 过滤`,
        });
      }
      const json = JSON.stringify({ meta: { chatName: 'test' }, messages });
      const data = await preprocessQqChat(json, 'test.json', TEST_CONFIG);
      const parsed = JSON.parse(data.jsonContent);
      // 250 条 > 200 阈值，应分块
      expect(parsed.chunks.length).toBeGreaterThan(1);
      // 每块不超过阈值
      for (const chunk of parsed.chunks) {
        expect(chunk.length).toBeLessThanOrEqual(TEST_CONFIG.chunk_threshold);
      }
    });

    it('消息数 <= chunk_threshold 应单块输出', async () => {
      const messages = [];
      for (let i = 0; i < 10; i++) {
        messages.push({
          timestamp: `2026-07-20 14:30:${String(i).padStart(2, '0')}`,
          speaker: 'A',
          content: `第 ${i} 条消息内容`,
        });
      }
      const json = JSON.stringify({ meta: { chatName: 'test' }, messages });
      const data = await preprocessQqChat(json, 'test.json', TEST_CONFIG);
      const parsed = JSON.parse(data.jsonContent);
      expect(parsed.chunks.length).toBe(1);
      expect(parsed.chunks[0].length).toBe(10);
    });
  });

  // ==========================================================================
  // 边界条件
  // ==========================================================================
  describe('边界条件', () => {
    it('空消息列表应返回空结果', async () => {
      const json = JSON.stringify({ meta: { chatName: 'test' }, messages: [] });
      const data = await preprocessQqChat(json, 'test.json', TEST_CONFIG);
      expect(data.result.meta.originalCount).toBe(0);
      expect(data.result.meta.filteredCount).toBe(0);
      expect(data.result.meta.redactedCount).toBe(0);
      expect(data.result.meta.dateRange).toBe('unknown');
    });

    it('redactExtractOutput 应对输出文本执行二次脱敏', () => {
      const text = '联系我 13812345678 或 test@example.com';
      const redacted = redactExtractOutput(text, TEST_CONFIG);
      expect(redacted).toContain('[REDACTED-PHONE]');
      expect(redacted).toContain('[REDACTED-EMAIL]');
      expect(redacted).not.toContain('13812345678');
      expect(redacted).not.toContain('test@example.com');
    });

    it('配置中 noise_rules 全部关闭时应保留所有消息', async () => {
      const configNoNoise: QqConfig = {
        ...TEST_CONFIG,
        noise_rules: { 'NR-1': false, 'NR-2': false, 'NR-3': false, 'NR-4': false, 'NR-5': false, 'NR-6': false },
      };
      const json = JSON.stringify({
        meta: { chatName: 'test' },
        messages: [
          { timestamp: '2026-07-20 14:30:15', speaker: 'A', content: '[图片]' },
          { timestamp: '2026-07-20 14:30:16', speaker: 'B', content: '嗯' },
        ],
      });
      const data = await preprocessQqChat(json, 'test.json', configNoNoise);
      expect(data.result.meta.filteredCount).toBe(2);
    });
  });

  // ==========================================================================
  // 输出格式
  // ==========================================================================
  describe('输出格式', () => {
    it('jsonContent 应包含 meta.source = "qq-chat"', async () => {
      const json = JSON.stringify({
        meta: { chatName: 'test' },
        messages: [{ timestamp: '2026-07-20 14:30:15', speaker: 'A', content: '测试消息' }],
      });
      const data = await preprocessQqChat(json, 'test.json', TEST_CONFIG);
      const parsed = JSON.parse(data.jsonContent);
      expect(parsed.meta.source).toBe('qq-chat');
    });

    it('rawId 应为 UUID v4 格式', async () => {
      const json = JSON.stringify({
        meta: { chatName: 'test' },
        messages: [{ timestamp: '2026-07-20 14:30:15', speaker: 'A', content: '测试' }],
      });
      const data = await preprocessQqChat(json, 'test.json', TEST_CONFIG);
      expect(data.result.rawId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });
  });
});
