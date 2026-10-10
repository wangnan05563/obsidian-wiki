// FR-23 思考过程折叠：模型输出的 <think>…</think> 流式增量解析器。
// 为什么独立状态机而非在渲染层正则切分：
//   1. 流式场景下 <think> 与 </think> 可能被拆在相邻 chunk（半开标签），
//      逐 chunk 正则会把残缺标签当成普通文本渲染进答案，闭合后又无法回收；
//   2. 解析器是有状态对象（inThink + 半开缓冲），必须在「会话缓冲」上跨 chunk 存活，
//      放在 store 消费点（bufAppendAnswer）才能保证 thinking/answer 分区不错位。
//
// 用法（每个会话缓冲一个实例，随轮次重置）：
//   const p = createThinkStreamParser();
//   const { thinking, answer } = p.feed(chunkText);   // 每个 answer chunk 调用
//   const tail = p.flush();                            // 流结束（done/停止/出错）时调用一次
//
// 半开匹配策略：块尾部若与 '<think>' 或 '</think>' 的某段前缀完全一致，则暂扣不发；
// 直到后续 chunk 补齐判定（是真标签 → 切换状态；不是 → 扣留内容按当前模式原样输出）。
// 约束：扣留上限为 7 字符（'</think>' 长度），不会吞正文。

export interface ThinkParserResult {
  /** 本次 feed 判定为思考过程（think 模式）的文本片段 */
  thinking: string;
  /** 本次 feed 判定为正式回答的文本片段 */
  answer: string;
}

const OPEN_TAG = '<think>';
const CLOSE_TAG = '</think>';

export interface ThinkStreamParser {
  feed(text: string): ThinkParserResult;
  /** 流结束时调用：输出扣留中的半开标签内容（半开截断场景内容不丢失） */
  flush(): ThinkParserResult;
  /** 当前是否处于 think 模式（半开 <think> 未闭合） */
  isInThink(): boolean;
  /** 已解析的思考内容总字数（供折叠面板标题展示） */
  thinkingLength(): number;
}

export function createThinkStreamParser(): ThinkStreamParser {
  let inThink = false;
  let pending = ''; // 疑似半开标签的暂扣内容
  let thinkingAll = '';

  // 扣留判定：块尾部是标签（或闭合标签）的严格前缀时暂扣
  function pendingIfPartialTag(block: string): { safe: string; pending: string } {
    const max = Math.max(OPEN_TAG.length, CLOSE_TAG.length) - 1;
    for (let keep = Math.min(block.length, max); keep > 0; keep--) {
      const tail = block.slice(block.length - keep);
      if (OPEN_TAG.startsWith(tail) || CLOSE_TAG.startsWith(tail)) {
        return { safe: block.slice(0, block.length - keep), pending: tail };
      }
    }
    return { safe: block, pending: '' };
  }

  function feed(text: string): ThinkParserResult {
    let buf = pending + text;
    pending = '';
    let thinking = '';
    let answer = '';

    while (buf.length > 0) {
      if (inThink) {
        const closeIdx = buf.indexOf(CLOSE_TAG);
        if (closeIdx >= 0) {
          // 闭合：闭合前的内容全部归思考区
          thinking += buf.slice(0, closeIdx);
          buf = buf.slice(closeIdx + CLOSE_TAG.length);
          inThink = false;
          continue;
        }
        const { safe, pending: p } = pendingIfPartialTag(buf);
        thinking += safe;
        pending = p;
        break;
      }

      const openIdx = buf.indexOf(OPEN_TAG);
      if (openIdx >= 0) {
        answer += buf.slice(0, openIdx);
        buf = buf.slice(openIdx + OPEN_TAG.length);
        inThink = true;
        continue;
      }
      const { safe, pending: p } = pendingIfPartialTag(buf);
      answer += safe;
      pending = p;
      break;
    }

    thinkingAll += thinking;
    return { thinking, answer };
  }

  function flush(): ThinkParserResult {
    const held = pending;
    pending = '';
    // 半开截断（连接中断）：扣留内容按当前模式归属，内容不丢失、不混入答案
    const result = inThink ? { thinking: held, answer: '' } : { thinking: '', answer: held };
    thinkingAll += result.thinking;
    return result;
  }

  return {
    feed,
    flush,
    isInThink: () => inThink,
    thinkingLength: () => thinkingAll.length,
  };
}
