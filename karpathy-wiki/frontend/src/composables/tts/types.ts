// TTS Provider 抽象层：统一不同 TTS 后端的 play/pause/resume/stop 状态机。
// 设计动机：当前 useTTS.ts 直接耦合 Web Speech API（speechSynthesis），
//   后续接入豆包等云端 TTS 时需重写 useTTS 全量逻辑。
//   抽象为接口后，新增 provider 仅实现 TTSProvider 即可，
//   业务侧 useTTS composable 保持不变。
//
// 约束：
//   - 所有 provider 必须实现 stop()，用于切换朗读时清空队列避免堆积。
//   - state 是 readonly ref 暴露给外部，provider 内部维护，禁止外部写入。
//   - speak() 同步返回（不 await 播放结束），由 state 反映生命周期。

/** 朗读生命周期状态 */
export type TTSState = 'idle' | 'playing' | 'paused';

/** 朗读选项：所有字段可选，让 provider 自行决定默认值 */
export interface TTSSpeakOptions {
  /** BCP-47 语言标签，如 'zh-CN' / 'en-US' */
  lang?: string;
  /** 语速倍率，0.5 - 2.0，clamp 由 provider 负责 */
  rate?: number;
  /** 音量偏移（百分点，-30 ~ +30，0 为默认 +0%） */
  volume?: number;
  /** 音调偏移（赫兹，-10 ~ +10，0 为默认 +0Hz） */
  pitch?: number;
  /** 说话风格（Edge TTS neural 专属，如 narration-relaxed / chat），空串表示标准 */
  style?: string;
  /** provider 特定参数（如豆包 voice_id / model），透传给具体实现 */
  voice?: string;
}

/** TTS Provider 接口：所有 TTS 后端必须实现的方法 */
export interface TTSProvider {
  /** Provider 名称，用于 UI 展示与日志 */
  readonly name: string;
  /** 当前是否可用（运行时探测，如浏览器特性检测 / API key 配置检查） */
  isSupported(): boolean;
  /** 开始朗读；切换前会自动 stop 当前朗读避免队列堆积 */
  speak(text: string, options?: TTSSpeakOptions): void;
  /** 暂停（可由 resume 继续） */
  pause(): void;
  /** 继续暂停中的朗读 */
  resume(): void;
  /** 停止并清空朗读队列，state 回到 idle */
  stop(): void;
  /** 释放资源（如关闭 AudioContext、移除事件监听） */
  dispose(): void;
}
