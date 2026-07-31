// 向后兼容层：useTTS 业务实现已迁移到 ./tts/ 目录的 TTSProvider 抽象层。
// 本文件仅做 re-export，避免外部调用方（MessageToolbar / FloatingChat 等）批量改 import 路径。
//
// 历史：useTTS.ts 早期直接封装 Web Speech API，后续需接入豆包 TTS 时重构为
//   TTSProvider 接口 + 多个 provider 实现，详见 ./tts/ 目录。

export { useTTS } from './tts';
export type { UseTTSReturn, TTSProviderType } from './tts';
export type { TTSProvider, TTSState, TTSSpeakOptions } from './tts/types';
