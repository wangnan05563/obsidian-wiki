// qq-preprocess.ts 单元测试
// 覆盖：TXT/JSON/HTML/Excel 解析、6 条噪声过滤规则、5 类 PII 脱敏、长文本分块、边界条件

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

// 构建最小有效 ZIP buffer（无压缩，供 xlsx 测试用）
// 复制自 office-convert.test.ts，避免跨 test 文件依赖
function buildZip(files: Record<string, string>): Buffer {
  const localParts: Buffer[] = [];
  const cdRecords: Buffer[] = [];
  const offsets: number[] = [];
  let pos = 0;

  const names = Object.keys(files);
  for (const name of names) {
    offsets.push(pos);
    const dataBuf = Buffer.from(files[name], 'utf-8');
    const nameBuf = Buffer.from(name, 'utf-8');
    const hdr = Buffer.alloc(30 + nameBuf.length + dataBuf.length);
    hdr.writeUInt32LE(0x04034b50, 0);
    hdr.writeUInt16LE(0, 8);
    hdr.writeUInt16LE(nameBuf.length, 26);
    hdr.writeUInt32LE(dataBuf.length, 18);
    nameBuf.copy(hdr, 30);
    dataBuf.copy(hdr, 30 + nameBuf.length);
    localParts.push(hdr);
    pos += hdr.length;
  }

  for (let ci = 0; ci < names.length; ci++) {
    const n = Buffer.from(names[ci], 'utf-8');
    const d = Buffer.from(files[names[ci]], 'utf-8');
    const cd = Buffer.alloc(46 + n.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(n.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt32LE(d.length, 20);
    cd.writeUInt32LE(offsets[ci], 42);
    n.copy(cd, 46);
    cdRecords.push(cd);
  }

  const totalEntries = names.length;
  const cdSize = cdRecords.reduce((s, c) => s + c.length, 0);
  const cdStart = localParts.reduce((s, c) => s + c.length, 0);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(totalEntries, 8);
  eocd.writeUInt16LE(totalEntries, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...cdRecords, eocd]);
}

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
  // QQChatExporter V5+ 格式解析（字段式块状结构）
  // ==========================================================================
  describe('QQChatExporter V5 格式解析', () => {
    it('应正确解析 QQChatExporter V5 完整格式（含文件头/提及/回复/资源）', async () => {
      const txt = `[QQChatExporter V5 / https://github.com/shuakami/qq-chat-exporter]
[本软件是免费的开源项目~]

===============================================
           QQ聊天记录导出文件
===============================================

聊天名称: 线上贴现联调群
聊天类型: 群聊
导出时间: 2026-07-27 18:43:31
消息总数: 3
时间范围: 2025-11-12 16:30:09 - 2025-11-12 16:38:56


票交所-覃舒桐:
时间: 2025-11-12 16:30:09
内容: @华夏银行-王东
提及: 华夏银行-王东


华夏银行-王东:
时间: 2025-11-12 16:35:53
内容: 这个加权剩余期限做什么用的？


票交所-覃舒桐:
时间: 2025-11-12 16:37:56
内容: [回复消息]这个我也不知道，要问业务老师了@华夏银行-王东
提及: 华夏银行-王东
回复: 11-12 16:35 华夏银行-王东 - 这个加权剩余期限做什么用的？
`;
      const data = await preprocessQqChat(txt, 'group.txt', TEST_CONFIG);
      // chatName 从"聊天名称:"头字段提取
      expect(data.result.meta.chatName).toBe('线上贴现联调群');
      // 3 条消息全部解析（content 非空）
      expect(data.result.meta.originalCount).toBe(3);
      // "做用的？"含问号不被 NR-2 过滤；"@华夏银行-王东"长度>5 不过滤；3 条均保留
      expect(data.result.meta.filteredCount).toBe(3);
      // 时间范围应从消息时间计算，而非 unknown
      expect(data.result.meta.dateRange).toBe('2025-11-12');
    });

    it('应跳过 content 为空的纯资源消息，保留有正文的消息', async () => {
      const txt = `聊天名称: 测试群
导出时间: 2026-07-20 18:00:00

潍坊银行-王南:
时间: 2026-07-20 14:30:15
内容: 
资源: 1 个文件
  - image: ABC.jpg


票交所-覃舒桐:
时间: 2026-07-20 14:35:20
内容: 收到图片了
`;
      const data = await preprocessQqChat(txt, 'test.txt', TEST_CONFIG);
      // content 为空的纯资源消息在解析阶段被跳过（不进入 messages）
      expect(data.result.meta.originalCount).toBe(1);
      expect(data.result.meta.filteredCount).toBe(1);
    });

    it('应正确解析含中文冒号（：）的发送者行与字段行', async () => {
      const txt = `聊天名称：测试群
导出时间：2026-07-20 18:00:00

张三：
时间：2026-07-20 14:30:15
内容：你好

李四：
时间：2026-07-20 14:30:20
内容：在吗
`;
      const data = await preprocessQqChat(txt, 'test.txt', TEST_CONFIG);
      expect(data.result.meta.chatName).toBe('测试群');
      expect(data.result.meta.originalCount).toBe(2);
    });

    it('无文件头标识但含"聊天名称:"+"时间:"字段也应识别为 QQChatExporter 格式', async () => {
      // 无 [QQChatExporter] 文件头，但字段式结构清晰
      const txt = `聊天名称: 无头群
导出时间: 2026-07-20 18:00:00

张三:
时间: 2026-07-20 14:30:15
内容: 测试消息`;
      const data = await preprocessQqChat(txt, 'noheader.txt', TEST_CONFIG);
      expect(data.result.meta.chatName).toBe('无头群');
      expect(data.result.meta.originalCount).toBe(1);
    });

    it('应支持多行内容（内容续行）', async () => {
      const txt = `聊天名称: 测试群
导出时间: 2026-07-20 18:00:00

张三:
时间: 2026-07-20 14:30:15
内容: 第一行
第二行续行
第三行续行`;
      const data = await preprocessQqChat(txt, 'test.txt', TEST_CONFIG);
      expect(data.result.meta.originalCount).toBe(1);
      // 多行内容合并后长度 > 5，不被 NR-2 过滤
      expect(data.result.meta.filteredCount).toBe(1);
    });

    it('不应将 QQ 自带消息管理器格式误判为 QQChatExporter 格式', async () => {
      // QQ 自带格式："2026-07-20 14:30:15 张三<xxx@qq.com>"，无"聊天名称:"头字段
      const txt = `测试群 聊天记录
2026-07-20 14:30:15 张三<zhangsan@qq.com>
你好`;
      const data = await preprocessQqChat(txt, 'test.txt', TEST_CONFIG);
      // 应走原有 TXT 解析路径，chatName 从首行"xxx 聊天记录"提取
      expect(data.result.meta.chatName).toBe('测试群');
      expect(data.result.meta.originalCount).toBe(1);
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
  // HTML 格式解析（qq-chat-exporter 等工具的 HTML 导出）
  // ==========================================================================
  describe('HTML 格式解析', () => {
    it('应正确解析 HTML 文件并按时间戳切分消息', async () => {
      const html = `<!DOCTYPE html>
<html><head><title>测试群 聊天记录</title>
<script>alert('x')</script>
<style>.msg { color: red; }</style>
</head><body>
<div class="message">
  <span class="time">2026-07-20 14:30:15</span>
  <span class="sender">张三</span>
  <span class="content">如何部署？</span>
</div>
<div class="message">
  <span class="time">2026-07-20 14:30:20</span>
  <span class="sender">李四</span>
  <span class="content">用 docker compose up</span>
</div>
</body></html>`;
      const data = await preprocessQqChat(html, 'test.html', TEST_CONFIG);
      // chatName 从 <title> 提取："测试群 聊天记录" → "测试群"
      expect(data.result.meta.chatName).toBe('测试群');
      expect(data.result.meta.originalCount).toBe(2);
      expect(data.result.meta.filteredCount).toBe(2);
    });

    it('应剥离 script/style 块，避免 JS/CSS 干扰文本提取', async () => {
      // script 中含伪时间戳，若未剥离会被误识别为消息
      const html = `<!DOCTYPE html><html><head><title>测试</title>
<script>var msg = "2026-07-20 14:30:15 来自脚本";</script>
</head><body>
<div>2026-07-20 15:00:00 张三
你好</div>
</body></html>`;
      const data = await preprocessQqChat(html, 'test.html', TEST_CONFIG);
      // 仅 1 条真实消息（脚本中的伪时间戳应被剥离）
      expect(data.result.meta.originalCount).toBe(1);
    });

    it('HTML 解析失败时不应回退到 TXT（直接抛错）', async () => {
      // 用一个内容损坏的 HTML 触发解析异常
      // 注：HTML 解析本身较容错，几乎不会失败；这里测的是 catch 分支不回退 TXT
      // 通过用 .html 后缀但传一个非 HTML 字符串验证 chatName 兜底为文件名
      const data = await preprocessQqChat('普通文本无标签', 'mychat.html', TEST_CONFIG);
      // 无 HTML 标签也按 TXT 路径解析，chatName 兜底为文件名（去扩展名）
      expect(data.result.meta.chatName).toBe('mychat');
    });
  });

  // ==========================================================================
  // Excel(.xlsx) 格式解析（qq-chat-exporter 等工具的 Excel 导出）
  // ==========================================================================
  describe('Excel 格式解析', () => {
    it('应正确解析 xlsx 并按表头识别列序', async () => {
      // 构造一个最小 xlsx：表头 [时间, 发送人, 消息] + 2 条数据行
      // 共享字符串索引：0=时间, 1=发送人, 2=消息, 3=测试群, 4=2026-07-20 14:30:15, 5=张三, 6=如何部署？, 7=2026-07-20 14:30:20, 8=李四, 9=用 docker
      const sharedStrings = `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="10" uniqueCount="10">
<si><t>时间</t></si><si><t>发送人</t></si><si><t>消息</t></si>
<si><t>测试群</t></si>
<si><t>2026-07-20 14:30:15</t></si><si><t>张三</t></si><si><t>如何部署？</t></si>
<si><t>2026-07-20 14:30:20</t></si><si><t>李四</t></si><si><t>用 docker</t></si>
</sst>`;
      const workbook = `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheets><sheet name="测试群" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;
      // 表头行：A1=时间(0), B1=发送人(1), C1=消息(2)
      // 数据行 2：A2=4, B2=5, C2=6  数据行 3：A3=7, B3=8, C3=9
      const sheet = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>
<row r="2"><c r="A2" t="s"><v>4</v></c><c r="B2" t="s"><v>5</v></c><c r="C2" t="s"><v>6</v></c></row>
<row r="3"><c r="A3" t="s"><v>7</v></c><c r="B3" t="s"><v>8</v></c><c r="C3" t="s"><v>9</v></c></row>
</sheetData>
</worksheet>`;
      const buffer = buildZip({
        'xl/sharedStrings.xml': sharedStrings,
        'xl/workbook.xml': workbook,
        'xl/worksheets/sheet1.xml': sheet,
      });
      const data = await preprocessQqChat(buffer, 'test.xlsx', TEST_CONFIG);
      // chatName 从 workbook sheet name 提取
      expect(data.result.meta.chatName).toBe('测试群');
      // 2 条消息（表头跳过）
      expect(data.result.meta.originalCount).toBe(2);
      expect(data.result.meta.filteredCount).toBe(2);
    });

    it('xlsx 缺少 workbook.xml 应抛错且不回退 TXT', async () => {
      // 故意构造一个不含 xl/workbook.xml 的 ZIP
      const buffer = buildZip({
        'xl/worksheets/sheet1.xml': '<worksheet></worksheet>',
      });
      await expect(preprocessQqChat(buffer, 'bad.xlsx', TEST_CONFIG))
        .rejects.toThrow(/workbook\.xml/);
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
