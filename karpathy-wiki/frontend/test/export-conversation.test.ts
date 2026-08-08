// 会话导出工具测试（F-3.3 增强：exportConversation）
// 验证 Markdown 渲染内容与文件名字段清洗（纯函数，无需 DOM）。
import { describe, it, expect } from 'vitest';
import type { ConversationRecord, ChatMessage, Reference } from '../src/types';
import { buildConversationMarkdown, buildConversationFilename } from '../src/utils/exportConversation';

function ref(title: string, url?: string): Reference {
  return { title, url, snippet: '', source: 'vault', citeIndex: 1 };
}

function record(over: Partial<ConversationRecord> = {}): ConversationRecord {
  const messages: ChatMessage[] = [
    { id: '1', role: 'user', content: '什么是机器学习？', createdAt: '' },
    { id: '2', role: 'assistant', content: '机器学习是人工智能的一个分支。', refs: [ref('entities/ML.md', 'http://x/ml')], createdAt: '' },
  ];
  return {
    id: 'c1',
    title: '我的问答',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    messageCount: messages.length,
    isPinned: false,
    preview: 'p',
    messages,
    threadId: 't1',
    ownerId: 'admin',
    ...over,
  } as ConversationRecord;
}

describe('buildConversationMarkdown 渲染 Markdown', () => {
  it('包含标题、导出元信息与每一轮问答的发送方标签', () => {
    const md = buildConversationMarkdown(record());
    expect(md).toContain('# 我的问答');
    expect(md).toContain('> 消息数：2');
    expect(md).toContain('**用户：**');
    expect(md).toContain('**AI：**');
    expect(md).toContain('什么是机器学习？');
    expect(md).toContain('机器学习是人工智能的一个分支。');
  });

  it('渲染引用页面（Reference[] 新格式，含 url）', () => {
    const md = buildConversationMarkdown(record());
    expect(md).toContain('*参考：*');
    expect(md).toContain('entities/ML.md');
    expect(md).toContain('http://x/ml');
  });

  it('兼容 refs 为 string[] 老格式', () => {
    const recWithStrRefs = record();
    recWithStrRefs.messages[1].refs = ['old/page.md'] as unknown as Reference[];
    const md = buildConversationMarkdown(recWithStrRefs);
    expect(md).toContain('- old/page.md');
  });

  it('空消息内容渲染为占位符，避免空白行', () => {
    const recEmpty = record();
    recEmpty.messages = [{ id: 'x', role: 'user', content: '   ', createdAt: '' }];
    const md = buildConversationMarkdown(recEmpty);
    expect(md).toContain('_(空)_');
  });
});

describe('buildConversationFilename 文件名字段清洗', () => {
  it('在标题后追加 .md', () => {
    expect(buildConversationFilename(record())).toBe('我的问答.md');
  });

  it('清洗文件系统非法字符（\\ / : * ? " < > |）', () => {
    const r = record({ title: 'a/b:c*?"<>.txt' });
    expect(buildConversationFilename(r)).toBe('a_b_c_____.txt.md');
  });

  it('标题清洗后为空时回退为 conversation.md', () => {
    const r = record({ title: '   ' });
    expect(buildConversationFilename(r)).toBe('conversation.md');
  });
});
