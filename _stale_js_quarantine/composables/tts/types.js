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
export {};
