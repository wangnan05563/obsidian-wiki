// 前端媒体生成（生图/视频）类型：与后端 api/src/types.ts 的 Media*UserConfig/Preset 对齐（type-sync-rule）。
// 作用：支撑"媒体可配置化 + 预设选项"，供 services/mediaConfig.ts（IndexedDB 每用户 BYOK）
//   与 Config.vue 配置表单 / Query 生成弹窗共用。

// 生图用户的 BYOK 配置（图像生成）
export interface MediaImageUserConfig {
  // API base URL（OpenAI 兼容接口）
  baseUrl: string;
  // 用户个人 API key（BYOK，仅存本地，随请求透传，后端不持久化）
  apiKey: string;
  // 图像生成模型名
  model: string;
  // 分辨率，如 1024x768
  size: string;
  // 比例，如 16:9；可选，缺省走服务端默认
  ratio?: string;
  // 预留扩展：步数/CFG/Sampler/Seed/负面词（后端仅显式设置才透传给 API）
  steps?: number;
  cfgScale?: number;
  sampler?: string;
  seed?: number;
  negativePrompt?: string;
}

// 视频生成用户的 BYOK 配置
export interface MediaVideoUserConfig {
  baseUrl: string;
  apiKey: string;
  videoModel: string;
  size: string;
  seconds: number;
  // 预留扩展：帧率/运动强度/Seed/负面词
  fps?: number;
  motion?: number;
  seed?: number;
  negativePrompt?: string;
}

// 前端随请求体透传的整包媒体生成配置（生图 + 视频两组，可只带其一）
export interface MediaGenerationConfig {
  image?: MediaImageUserConfig;
  video?: MediaVideoUserConfig;
}

// 生图预设模板（后端 /api/media/presets 返回；只读，可一键应用后微调保存为用户配置）
export interface MediaImagePreset {
  key: string;
  label: string;
  model: string;
  size: string;
  ratio?: string;
  steps?: number;
  cfgScale?: number;
  sampler?: string;
  seed?: number;
  negativePrompt?: string;
}

// 视频预设模板
export interface MediaVideoPreset {
  key: string;
  label: string;
  model: string;
  size: string;
  seconds: number;
  fps?: number;
  motion?: number;
  seed?: number;
  negativePrompt?: string;
}

// 后端 /api/media/presets 返回的整体结构
export interface MediaPresetsFile {
  imagePresets: MediaImagePreset[];
  videoPresets: MediaVideoPreset[];
}