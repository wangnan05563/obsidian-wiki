// FR-23 流式 <think> 解析器状态机单测（T01744 测试计划第 1 项）
// 覆盖：正常闭合 / 流式分片 / 半开标签扣留 / 截断 flush / 多 think 块 / 无 think 透传 / 续传重放
import { describe, expect, it } from 'vitest';
import { createThinkStreamParser } from '../src/utils/think-parser';

describe('think-parser', () => {
  it('非流式一次性输入：think 与答案正确分区', () => {
    const p = createThinkStreamParser();
    const r1 = p.feed('<think>推理过程</think>最终答案');
    expect(r1.thinking).toBe('推理过程');
    expect(r1.answer).toBe('最终答案');
    const tail = p.flush();
    expect(tail.thinking).toBe('');
    expect(tail.answer).toBe('');
  });

  it('无 think 输出：原样透传（零面板场景）', () => {
    const p = createThinkStreamParser();
    const r = p.feed('普通回答内容，包含 <b>HTML</b> 与 1<2 比较');
    expect(r.thinking).toBe('');
    expect(r.answer).toBe('普通回答内容，包含 <b>HTML</b> 与 1<2 比较');
  });

  it('流式分片：标签跨 chunk 拆分（半开）仍正确分区', () => {
    const p = createThinkStreamParser();
    const chunks = ['<th', 'ink>先分析', '问题本', '质</thi', 'nk>结论是', '这样'];
    let thinking = '';
    let answer = '';
    for (const c of chunks) {
      const r = p.feed(c);
      thinking += r.thinking;
      answer += r.answer;
    }
    const tail = p.flush();
    thinking += tail.thinking;
    answer += tail.answer;
    expect(thinking).toBe('先分析问题本质');
    expect(answer).toBe('结论是这样');
  });

  it('正文含疑似半开标签但非真标签：扣留后原样输出，不吞正文', () => {
    const p = createThinkStreamParser();
    // '<th' 疑似 '<think>' 前缀，但后续 'inking' 不是标签延续
    const r1 = p.feed('数学表达式 x <think');
    const r2 = p.feed('ing 大于 0');
    expect(r1.answer).toBe('数学表达式 x ');
    expect((r2.answer + p.flush().answer)).toContain('thinking 大于 0');
  });

  it('半开截断（连接中断）：flush 后已缓冲思考不丢失、不混入答案', () => {
    const p = createThinkStreamParser();
    const r = p.feed('<think>中断前的思考内容没有被闭合');
    // 思考内容在 feed 时即已归入思考区（未闭合不影响逐块输出）
    expect(r.thinking).toBe('中断前的思考内容没有被闭合');
    expect(r.answer).toBe('');
    const tail = p.flush();
    expect(tail.thinking).toBe('');
    expect(tail.answer).toBe('');
    expect(p.thinkingLength()).toBe('中断前的思考内容没有被闭合'.length);
  });

  it('多 think 块：全部归思考区，块间正文归答案区', () => {
    const p = createThinkStreamParser();
    const a = p.feed('<think>一</think>答1');
    const b = p.feed('<think>二</think>答2');
    expect(a.thinking).toBe('一');
    expect(a.answer).toBe('答1');
    expect(b.thinking).toBe('二');
    expect(b.answer).toBe('答2');
  });

  it('续传重放场景：重置后重新喂完整响应，分区不错位', () => {
    // 模拟断线重连：新解析器实例（store bufResetForResume 重建）重放完整响应
    const p = createThinkStreamParser();
    const chunks = ['<think>重放的思考', '内容</think>', '重放的答案'];
    let thinking = '';
    let answer = '';
    for (const c of chunks) {
      const r = p.feed(c);
      thinking += r.thinking;
      answer += r.answer;
    }
    const tail = p.flush();
    expect(thinking + tail.thinking).toBe('重放的思考内容');
    expect(answer + tail.answer).toBe('重放的答案');
    expect(p.thinkingLength()).toBe('重放的思考内容'.length);
  });

  it('答案开头紧邻闭合标签：<think></think> 空思考不产生内容', () => {
    const p = createThinkStreamParser();
    const r = p.feed('<think></think>直接答案');
    expect(r.thinking).toBe('');
    expect(r.answer).toBe('直接答案');
  });
});
