# 媒体生成（生图 / 视频）可配置化与预设 说明

> 对应需求 T00314：让「生图服务」「视频生成服务」具备与「模型配置」一致的可配置化能力，并提供预设选项。
> 本文档定义生图 / 视频服务的完整配置字段、预设清单、使用示例，以及「厂商 API 支持情况」标注。

## 1. 现状架构

媒体生成走「BYOK + 服务端兜底」双轨：

- **用户配置（BYOK）**：每用户独立，仅存浏览器 IndexedDB（`usercfg::media::<userId>`），
  由 `frontend/src/services/mediaConfig.ts` 读写；发起生成时把对应组随请求体透传给后端，后端不落盘。
- **服务端配置**：`api/src/config.ts` 的 `media.agnes` 段（管理员在 config.json 配置），
  当用户未提供 BYOK 配置时兜底，API key 优先级 `media.agnes.apiKey > llm.apiKeys.agnes > env[apiKeyRef]`。
- **预设（只读模板）**：`api/media-presets.json`，经 `GET /api/media/presets` 下发，
  前端下拉「一键应用」→ 合并进当前用户表单 → 用户再手动微调 → 保存为个人 BYOK 配置。

类型对齐（type-sync-rule）：前端 `frontend/src/types/media.ts` 与后端 `api/src/types.ts` 定义完全一致。

## 2. 生图服务配置字段

结构名 `MediaImageUserConfig`（用户 BYOK）；服务端 `MediaConfig.agnes` 对应同名字段含义。

| 字段 | 类型 | 默认值 | 枚举 / 约束 | 是否 Agnes 支持 | 说明 |
|---|---|---|---|---|---|
| `baseUrl` | string | `https://apihub.agnes-ai.com/v1` | URL | ✅ | OpenAI 兼容接口 base；随请求透传 |
| `apiKey` | string | `''` | — | ✅（鉴权用） | 用户个人 Key，仅存本地，绝不落服务端 |
| `model` | string | `agnes-image-2.5-flash` | 模型名 | ✅ | 图像模型；最新推荐 `agnes-image-2.5-flash` |
| `size` | string | `1024x768` | 档位 `1K/2K/3K/4K` 或精确尺寸如 `1024x768` | ✅ | 输出尺寸。Agnes 2.5 推荐用档位值并配合 `ratio` |
| `ratio` | string | `16:9` | `1:1 3:4 4:3 16:9 9:16 2:3 3:2 21:9` | ✅ | 宽高比；缺省走服务端默认 |
| `steps` | number? | 未填不发 | 1–150 | ⚠️ | 采样步数。Agnes 官方文档未列出，属预留扩展 → 显式设置才追加，厂商不识别则忽略 |
| `cfgScale` | number? | 未填不发 | 1–30 | ⚠️ | CFG 引导强度。同上，预留扩展 |
| `sampler` | string? | 未填不发 | 如 `DPM++ 2M Karras` | ⚠️ | 采样器名称。同上，预留扩展 |
| `seed` | number? | 未填不发 | 整数，`-1`=随机 | ⚠️ | 随机种子。同上，预留扩展 |
| `negativePrompt` | string? | 未填不发 | 文本 | ⚠️ | 负面词。透传为 `negative_prompt`，厂商不识别则忽略 |

> 说明：`steps/cfgScale/sampler/seed/negativePrompt` 统称「预留扩展」。
> 后端 `buildImageExtras()` 仅当字段**显式设置**时才追加进请求体，避免破坏既有请求；
> 若厂商 API 不支持则在服务端被忽略，不报错（见下"厂商支持矩阵"）。

## 3. 视频服务配置字段

结构名 `MediaVideoUserConfig`。

| 字段 | 类型 | 默认值 | 枚举 / 约束 | 是否 Agnes 支持 | 说明 |
|---|---|---|---|---|---|
| `baseUrl` | string | `https://apihub.agnes-ai.com/v1` | URL | ✅ | OpenAI Videos 兼容接口 base |
| `apiKey` | string | `''` | — | ✅（鉴权用） | 用户个人 Key，仅存本地 |
| `videoModel` | string | `agnes-video-2.5-flash` | 模型名 | ✅ | 视频模型；最新推荐 `agnes-video-2.5-flash` |
| `size` | string | `1280x720` | v2.0 用像素如 `1280x720`；2.5-Flash 固定 `720P` | ✅ | 输出尺寸。**注意**：2.5-Flash 仅支持字符串 `"720P"` |
| `seconds` | number | `5` | 1–60（2.5-Flash 支持 `"4"–"12"`） | ✅ | 视频时长；后端转成字符串传给 API |
| `fps` | number? | 未填不发 | 1–60 | ⚠️ | 帧率。预留扩展，官方文档未列出 |
| `motion` | number? | 未填不发 | 0–10 | ⚠️ | 运动强度。预留扩展，官方文档未列出 |
| `seed` | number? | 未填不发 | 整数，`-1`=随机 | ✅(2.5-Flash) | 随机种子。2.5-Flash 文档支持 `seed` |
| `negativePrompt` | string? | 未填不发 | 文本 | ⚠️ | 负面词。透传为 `negative_prompt` |

> 视频 2.5-Flash 额外支持 `aspect_ratio`（`21:9 16:9 4:3 1:1 3:4 9:16`，默认 16:9）。
> 当前配置未暴露该字段；如需锁定画幅，2.5-Flash 下请把 `size` 固定为 `720P` 并（未来）新增 `aspectRatio`。

## 4. 厂商 API 支持矩阵（如实标注）

参考 Agnes 官方文档（`agnes-image-25-flash`、`agnes-video-25-flash`）：

| 参数 | Agnes Image 2.1/2.5 | Agnes Video 2.0/2.5-Flash |
|---|---|---|
| model / size / ratio / seconds | ✅ model、size、ratio | ✅ model、size、seconds |
| steps / cfgScale / sampler | ❌ 文档未支持（忽略） | — |
| seed | ❌ 文档未列出 | ✅ 2.5-Flash 支持 |
| negativePrompt | ❌ 文档未支持（忽略） | ❌ 文档未支持（忽略） |
| fps / motion | — | ❌ 官方文档未列出（忽略） |

> 结论：核心字段（model/size/ratio/seconds）厂商均支持，可直接生效；
> 「预留扩展」字段为跨厂商通用参数，Agnes 官方文档未列出，发送后被服务端忽略，不会导致 400。

## 5. 预设清单

数据文件：`api/media-presets.json`，经 `GET /api/media/presets` 下发（需登录）。

### 生图预设（5 个）
| key | label | model | size | ratio | steps | cfgScale | sampler | negativePrompt |
|---|---|---|---|---|---|---|---|---|
| `photo-real` | 高清写实 | agnes-image-2.5-flash | 1024x768 | 16:9 | 30 | 7 | DPM++ 2M Karras | blurry, low quality, deformed, watermark |
| `product-photo` | 产品摄影 | agnes-image-2.5-flash | 1024x1024 | 1:1 | 32 | 6.5 | DPM++ 2M Karras | blurry, low quality, deformed, text |
| `anime` | 动漫插画 | agnes-image-2.5-flash | 1024x1024 | 1:1 | 28 | 5.5 | — | blurry, low quality, photorealistic, extra limbs |
| `flat-design` | 扁平插画 | agnes-image-2.5-flash | 1024x1024 | 1:1 | 24 | 6 | — | photorealistic, blurry, low quality, 3d render |
| `cyberpunk` | 赛博朋克 | agnes-image-2.5-flash | 1024x768 | 16:9 | 30 | 7 | — | blurry, low quality, deformed, watermark |

### 视频预设（3 个）
| key | label | model | size | seconds | fps | motion | negativePrompt |
|---|---|---|---|---|---|---|---|
| `documentary` | 自然写实 | agnes-video-2.5-flash | 1280x720 | 5 | 24 | 3 | blurry, low quality, distorted motion |
| `anime-storyboard` | 动漫分镜 | agnes-video-2.5-flash | 1280x720 | 5 | 24 | 5 | photorealistic, blurry, low quality |
| `cinematic` | 电影感运镜 | agnes-video-2.5-flash | 1280x720 | 8 | 30 | 8 | shaky, blurry, low quality, cut jump |

> 预设可扩展：只需在 `api/media-presets.json` 追加一项（`key` 全局唯一、`label` 为展示名），重启后即出现在预设下拉。
> 模型升级建议：生图切 `agnes-image-2.5-flash`（size 用档位 + ratio）；视频切 `agnes-video-2.5-flash`（size 固定 `720P`）。

## 6. 一键应用逻辑

- 前端 `mergeImagePreset` / `mergeVideoPreset`：把预设的 `model/size/ratio/steps/cfgScale/sampler/seed/fps/motion/negativePrompt/seconds` 合并进当前用户配置；
  **保留** `baseUrl/apiKey`（预设是场景模板，不含用户密钥，避免冲掉已填密钥）。
- 后端只读下发预设（`GET /api/media/presets`），不持久化到用户配置。

## 7. 配置使用示例（JSON）

```jsonc
// 用户 BYOK 配置整包（存 IndexedDB usercfg::media::<userId>，可随生成请求体透传 mediaConfig）
{
  "image": {
    "baseUrl": "https://apihub.agnes-ai.com/v1",
    "apiKey": "sk-xxxx",            // 仅存本地，随请求透传
    "model": "agnes-image-2.5-flash",
    "size": "1024x768",
    "ratio": "16:9",
    "steps": 30,
    "cfgScale": 7,
    "sampler": "DPM++ 2M Karras",
    "seed": 123456,
    "negativePrompt": "blurry, low quality"
  },
  "video": {
    "baseUrl": "https://apihub.agnes-ai.com/v1",
    "apiKey": "sk-xxxx",
    "videoModel": "agnes-video-2.5-flash",
    "size": "1280x720",
    "seconds": 5,
    "fps": 24,
    "motion": 4,
    "seed": 42,
    "negativePrompt": "shaky, blurry"
  }
}
```

```jsonc
// 服务端兜底配置（config.json media.agnes 段，管理员配置；API key 三级回退）
{
  "media": {
    "agnes": {
      "baseUrl": "https://apihub.agnes-ai.com/v1",
      "apiKeyRef": "AGNES_API_KEY",
      "imageModel": "agnes-image-2.5-flash",
      "videoModel": "agnes-video-2.5-flash",
      "defaultImageSize": "1024x768",
      "defaultImageRatio": "16:9",
      "defaultVideoSize": "1280x720",
      "defaultVideoSeconds": 5
    }
  }
}
```

```jsonc
// YAML 形式（等价，非项目实际加载格式，仅示意）
// image:
//   baseUrl: https://apihub.agnes-ai.com/v1
//   model: agnes-image-2.5-flash
//   size: 1024x768
//   ratio: '16:9'
// video:
//   videoModel: agnes-video-2.5-flash
//   size: 1280x720
//   seconds: 5
```

## 8. 校验 / 序列化

- **序列化**：`loadMediaUserConfig` / `saveMediaUserConfig` 经 IndexedDB（`chatDb.preferences`）JSON 存取，`loadUserConfig` 与默认值深合并后返回。
- **校验**：前后端以 TypeScript 接口（`MediaImageUserConfig` 等）作为 Schema；可选字段（预留扩展）仅在**显式设置**时由后端追加进请求体（`buildImageExtras` / `buildVideoExtras`），缺省不下发。
- **不引入校验库**：项目约束「不引入多余依赖」，故不引入 zod 等运行时校验；后端对请求体做最小守卫（字段选择性透传 + 类型提示）。