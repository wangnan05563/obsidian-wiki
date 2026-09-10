// v3 媒体生成工作流：图像/PPT/视频生成
// 设计哲学与 multimodal-output-workflow.ts / podcast-workflow.ts 一致：
// 1. 图像/PPT 复用 collectContextPages 收集上下文 + harness 单轮 LLM 调用
// 2. 图像生成调用 Agnes Image API（OpenAI 兼容），下载归档到 vault queries/
// 3. PPT 生成用 LLM 产出 Marp Markdown，归档到 vault queries/
// 4. 视频生成是异步任务：generateVideo 创建任务（不阻塞），pollVideoTask 轮询状态
// 为什么视频走独立端点：视频生成需数分钟，超出 query SSE 60 秒超时

import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { HarnessConfig } from '@wiki/harness';
import { Harness } from '@wiki/harness';
import type { VaultService } from '../vault/vault-service.js';
import type {
  MediaConfig,
  MediaImageUserConfig,
  MediaVideoUserConfig,
  VideoTaskResult,
  AppConfig,
} from '../types.js';
// 复用 multimodal-output-workflow 的上下文收集逻辑，避免重复实现
import { collectContextPages } from './multimodal-output-workflow.js';
import { getPromptPath } from '../utils/runtime.js';
// PPT 原生 .pptx 渲染：解析 Marp Markdown → pptxgenjs 生成，供前端下载
import { generatePptxFile } from './pptx-renderer.js';

// 加载 prompt 单点存储（与 query/multimodal/podcast 共用 prompts/ 目录）
// 路径解析统一走 runtime.ts，兼容开发模式与 SEA 打包模式
async function loadImagePrompt(): Promise<string> {
  return fs.readFile(getPromptPath('image-generation.md'), 'utf8');
}

async function loadPptPrompt(): Promise<string> {
  return fs.readFile(getPromptPath('ppt-generation.md'), 'utf8');
}

// 时间戳格式化：YYYYMMDD-HHmmss（仅用于 .md 归档内容展示与排序，不再用于公开媒体文件名）
function formatTimestamp(): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

// 公开媒体（图像/视频）文件名用的随机 ID：不可猜测，避免 /api/media/file/* 公开路由被枚举遍历泄露他人内容。
// 文件名 = media-<randomUUID>，randomUUID 仅含 [0-9a-f-]，对文件名与 URL 均安全（无需 encodeURIComponent）。
function randomMediaId(): string {
  return randomUUID();
}

// 解析 Agnes API key：优先级 media.agnes.apiKey > llm.apiKeys.agnes > process.env[apiKeyRef]
// 为什么三级回退：media 段可选，密钥可能只配在 llm.apiKeys.agnes（config.json 已有）或环境变量
function resolveAgnesApiKey(mediaConfig: MediaConfig | undefined, appConfig?: AppConfig): string | null {
  if (!mediaConfig) return null;
  if (mediaConfig.agnes.apiKey) return mediaConfig.agnes.apiKey;
  if (appConfig?.llm.apiKeys?.agnes) return appConfig.llm.apiKeys.agnes;
  const envKey = process.env[mediaConfig.agnes.apiKeyRef];
  if (envKey) return envKey;
  return null;
}

// 应用用户 BYOK 生图覆盖到服务端媒体配置：返回新的 MediaConfig（不修改入参）。
// 优先级：用户显式字段 > media.shared（T00320 管理员全局「共享生图」）> media.agnes 默认。
//   baseUrl/apiKey/model/size/ratio 为核心可配置项；预留扩展（steps/cfgScale/sampler/seed/negativePrompt）
//   仅在用户或共享配置显式设置时覆盖（见 generateImage 内 buildImageExtras 的合并）。
// 为什么 API key 也覆盖：BYOK 下用户用自己的 key 生图，覆盖进 media.agnes.apiKey 后，
//   resolveAgnesApiKey 会优先取它，实现"用户自己的额度/配置"；无 BYOK 时共享 key 同理兜底。
// export 供 routes/ai.ts 的生图测试连接复用（测试用同一套"用户覆盖优先"规则，保证测试口径与真实生成一致）。
export function applyImageOverride(base: MediaConfig | undefined, o: MediaImageUserConfig | undefined): MediaConfig {
  // 为什么 a 给完整默认对象而非 {}：MediaConfig.agnes 均为 required，空对象类型推断为 {}
  //   访问 a.baseUrl 等会报 TS2339；显式补全默认让 a 具备类型，且 base 缺失时可独立成立。
  const a: MediaConfig['agnes'] = base?.agnes ?? {
    baseUrl: '', apiKey: '', apiKeyRef: 'AGNES_API_KEY', imageModel: '', videoModel: '',
    defaultImageSize: '', defaultImageRatio: '', defaultVideoSize: '', defaultVideoSeconds: 0,
  };
  const s = base?.shared?.image; // T00320 管理员全局「共享生图」：介于 BYOK 与 agnes 兜底之间
  return {
    agnes: {
      // 为什么全部字段显式给默认：用户配置可独立于服务端 media.agnes 成立（BYOK），
      // base 为空时也要产出可直接调用的 agnes 视图，字段均为 required 需补安全默认。
      // 取值优先级：BYOK(o) > 共享(s) > agnes 兜底(a)；共享缺少的字段继续回退 agnes 默认。
      baseUrl: o?.baseUrl?.trim() || s?.baseUrl?.trim() || a.baseUrl || '',
      apiKey: o?.apiKey?.trim() || s?.apiKey?.trim() || a.apiKey || '',
      apiKeyRef: a.apiKeyRef || 'AGNES_API_KEY',
      imageModel: o?.model?.trim() || s?.model?.trim() || a.imageModel || '',
      videoModel: a.videoModel || '',
      defaultImageSize: o?.size?.trim() || s?.size?.trim() || a.defaultImageSize || '1024x768',
      defaultImageRatio: o?.ratio?.trim() || s?.ratio?.trim() || a.defaultImageRatio || '16:9',
      defaultVideoSize: a.defaultVideoSize || '1280x720',
      defaultVideoSeconds: a.defaultVideoSeconds ?? 5,
    },
  };
}

// 应用用户 BYOK 视频覆盖到服务端媒体配置（video override 覆盖 video 相关字段）。
// 优先级与 applyImageOverride 一致：BYOK(o) > media.shared.video(s) > media.agnes 兜底(a)。
function applyVideoOverride(base: MediaConfig | undefined, o: MediaVideoUserConfig | undefined): MediaConfig {
  const a: MediaConfig['agnes'] = base?.agnes ?? {
    baseUrl: '', apiKey: '', apiKeyRef: 'AGNES_API_KEY', imageModel: '', videoModel: '',
    defaultImageSize: '', defaultImageRatio: '', defaultVideoSize: '', defaultVideoSeconds: 0,
  };
  const s = base?.shared?.video;
  return {
    agnes: {
      baseUrl: o?.baseUrl?.trim() || s?.baseUrl?.trim() || a.baseUrl || '',
      apiKey: o?.apiKey?.trim() || s?.apiKey?.trim() || a.apiKey || '',
      apiKeyRef: a.apiKeyRef || 'AGNES_API_KEY',
      imageModel: a.imageModel || '',
      videoModel: o?.videoModel?.trim() || s?.videoModel?.trim() || a.videoModel || '',
      defaultImageSize: a.defaultImageSize || '1024x768',
      defaultImageRatio: a.defaultImageRatio || '16:9',
      defaultVideoSize: o?.size?.trim() || s?.size?.trim() || a.defaultVideoSize || '1280x720',
      defaultVideoSeconds: o?.seconds ?? s?.seconds ?? a.defaultVideoSeconds ?? 5,
    },
  };
}

// 生图请求体追加"预留扩展"参数：仅当值显式定义才加入，API 不识别则忽略，避免破坏既有请求。
// 为什么参数是 Partial：调用处传入 [{...shared.image, ...imageOverride}] 合对象，字段均可选
//   （共享/用户可能都没填扩展项），仅需读取可选扩展字段，无需强类型完整配置。
// 为什么 exporter 独立逻辑抽取：保持 generateImage 请求体构造可读（S3776），并集中管理扩展字段映射。
function buildImageExtras(o: Partial<MediaImageUserConfig> | undefined): Record<string, unknown> {
  if (!o) return {};
  return {
    ...(o.steps !== undefined ? { steps: o.steps } : {}),
    ...(o.cfgScale !== undefined ? { cfgScale: o.cfgScale } : {}),
    ...(o.sampler ? { sampler: o.sampler } : {}),
    ...(o.seed !== undefined ? { seed: o.seed } : {}),
    ...(o.negativePrompt ? { negative_prompt: o.negativePrompt } : {}),
  };
}

// 视频请求体追加"预留扩展"参数：帧率/运动强度/Seed/负面词，仅显式设置时加入（尽力透传）。
function buildVideoExtras(o: Partial<MediaVideoUserConfig> | undefined): Record<string, unknown> {
  if (!o) return {};
  return {
    ...(o.fps !== undefined ? { fps: o.fps } : {}),
    ...(o.motion !== undefined ? { motion: o.motion } : {}),
    ...(o.seed !== undefined ? { seed: o.seed } : {}),
    ...(o.negativePrompt ? { negative_prompt: o.negativePrompt } : {}),
  };
}

// 包装 fetch 调用，把 Node 原生 fetch 的 "fetch failed" 翻译为可读的诊断信息。
// 为什么需要：undici 在网络层失败（DNS/连接超时/TLS）时统一抛 TypeError("fetch failed")，
// 真因藏在 err.cause 里。若不包装，用户只能看到 "fetch failed" 无法定位问题。
// 为什么用 cause.code 进一步分类：UND_ERR_CONNECT_TIMEOUT/ENOTFOUND/ECONNREFUSED 等代码
// 能直接区分网络不可达、DNS 解析失败、端口未开放等场景。
// 为什么 export：单元测试需直接验证错误转换逻辑，避免通过 generateImage 间接测试带来的 Harness mock 复杂度
export async function fetchWithDiagnostics(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const code = cause?.code;
    let hint: string;
    if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') {
      hint = `网络连接超时（${url} 不可达），请检查网络或代理设置`;
    } else if (code === 'ENOTFOUND') {
      hint = `域名解析失败（${new URL(url).hostname}），请检查 DNS 或网络连接`;
    } else if (code === 'ECONNREFUSED') {
      hint = `连接被拒绝（${new URL(url).host}），目标服务未启动或端口被防火墙拦截`;
    } else if (code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
      hint = `TLS 证书校验失败（${code}），请检查系统时间或证书链`;
    } else if (code === 'UND_ERR_ABORTED') {
      hint = `请求超时或被中止，请确认目标服务响应是否过慢`;
    } else {
      hint = cause?.message || (err instanceof Error ? err.message : String(err));
    }
    throw new Error(`请求 ${url} 失败：${hint}（${code || 'unknown'}）`);
  }
}

// 走全局 fetch（undici，已通过 setGlobalDispatcher 配置代理，出网稳定）POST JSON，
// 并手动跟随 301/302/307/308 重定向（最多 5 跳）。
// 为什么不用默认 redirect:'follow'：undici 对 POST 的 301/302 重定向默认会丢弃 body 或挂起直到超时，
// 实测 Agnes Image API 经 Cloudflare 触发重定向，导致 fetch 60s 超时、生图永远失败；手动跟随可精确控制。
// 为什么用全局 fetch 而非原生 http/https：原生模块不走代理，直连 apihub.agnes-ai.com 不稳定（偶发超时），
// 全局 fetch 复用后端代理配置，出网可靠（与 chat/video 接口一致）。
export async function postJsonFollowRedirect(
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
  redirectsLeft = 5,
): Promise<{ status: number; body: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
  // 手动跟随重定向（保留 POST 方法与 body 用于 307/308；301/302 降级为 GET，符合浏览器语义）
  if ([301, 302, 307, 308].includes(res.status) && redirectsLeft > 0) {
    const loc = res.headers.get('location');
    if (!loc) throw new Error(`redirect with no location (${res.status})`);
    const next = new URL(loc, url).toString();
    const nextMethod = res.status === 307 || res.status === 308 ? 'POST' : 'GET';
    const nextBody = nextMethod === 'POST' ? body : undefined;
    return postJsonFollowRedirect(next, headers, nextBody ?? '', timeoutMs, redirectsLeft - 1);
  }
  const text = await res.text();
  return { status: res.status, body: text };
}

// 走全局 fetch（代理出网）GET 字节流并手动跟随重定向（最多 5 跳），用于下载生图/视频等二进制资源。
// 为什么单独写二进制版本：图片下载需要 Buffer；对 GET 类重定向（CDN 常用 302）也手动跟随，避免漏下载。
export async function fetchBufferFollowRedirect(
  url: string,
  timeoutMs: number,
  redirectsLeft = 5,
): Promise<Buffer> {
  const res = await fetch(url, {
    method: 'GET',
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if ([301, 302, 307, 308].includes(res.status) && redirectsLeft > 0) {
    const loc = res.headers.get('location');
    if (!loc) throw new Error(`redirect with no location (${res.status})`);
    const next = new URL(loc, url).toString();
    return fetchBufferFollowRedirect(next, timeoutMs, redirectsLeft - 1);
  }
  if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

// 构造图像归档 Markdown（frontmatter type: query, output_mode: image）
function buildImageArchiveMarkdown(
  imagePrompt: string,
  question: string,
  imagePath: string,
  timestamp: string,
): string {
  const now = new Date().toISOString();
  return `---
type: query
output_mode: image
generated_at: ${now}
question: ${question}
image_file: ${imagePath}
---

# 图像生成：${question}

> 生成时间：${now}
> 图像 prompt：${imagePrompt}

![${question}](${imagePath})
`;
}

// 构造 PPT 归档 Markdown（含 marp frontmatter，归档文件本身可直接用 Marp 渲染）
function buildPptArchiveMarkdown(
  slidesContent: string,
  question: string,
  timestamp: string,
): string {
  const now = new Date().toISOString();
  // 为什么把 marp 字段与归档字段放同一 frontmatter：Marp 渲染器读 marp: true，
  // 归档系统读 type: query，两者无冲突，合并避免双重 frontmatter
  return `---
marp: true
theme: default
type: query
output_mode: ppt
generated_at: ${now}
question: ${question}
---

${slidesContent}
`;
}

// 构造视频归档 Markdown
function buildVideoArchiveMarkdown(
  taskId: string,
  sourceUrl: string,
  videoPath: string,
  timestamp: string,
): string {
  const now = new Date().toISOString();
  return `---
type: query
output_mode: video
generated_at: ${now}
task_id: ${taskId}
video_file: ${videoPath}
source_url: ${sourceUrl}
---

# 视频生成归档

> 生成时间：${now}
> 任务 ID：${taskId}

[播放视频](${videoPath})
`;
}

// v3 图像生成：LLM 优化 prompt → Agnes Image API → 下载归档
// 调用时机：queryWorkflow outputMode='image' 时，在 done 之前推送 image 事件
// 失败策略：抛错让上层 wrapWithMultimodal catch，yield thinking 提示失败，不阻塞主问答
export async function generateImage(
  harnessConfig: HarnessConfig,
  vault: VaultService,
  question: string,
  contextPaths: string[] | undefined,
  mediaConfig: MediaConfig | undefined,
  appConfig?: AppConfig,
  imageOverride?: MediaImageUserConfig,
): Promise<{ url: string; alt: string; archivePath: string }> {
  // 用户 BYOK 万能覆盖：前端透传 imageOverride 优先，服务端 media.agnes 作默认兜底。
  // applyImageOverride 在 mediaConfig 为空时也能用 imageOverride 独立构造配置。
  // 为什么先捕获共享配置：applyImageOverride 返回的 agnes 视图不含 media.shared（shared 被消费进 agnes 字段），
  //   扩展参数（steps 等）需由 [{...shared.image, ...imageOverride}] 合并在请求体附加，此处提前引用原 mediaConfig。
  const sharedImage = mediaConfig?.shared?.image;
  mediaConfig = applyImageOverride(mediaConfig, imageOverride);
  if (!mediaConfig.agnes.imageModel && !mediaConfig.agnes.apiKey) {
    throw new Error('image generation: media config not configured');
  }
  const apiKey = resolveAgnesApiKey(mediaConfig, appConfig);
  if (!apiKey) {
    throw new Error(
      `image generation: Agnes API key not configured (set media.agnes.apiKey or llm.apiKeys.agnes or env ${mediaConfig.agnes.apiKeyRef})`,
    );
  }

  // 1. 收集相关页面作为上下文（复用 multimodal 的 collectContextPages）
  const pages = await collectContextPages(vault, question, 5, contextPaths);

  // 2. LLM 生成英文图像 prompt（单轮，禁用工具）
  const promptTemplate = await loadImagePrompt();
  const pageContext = pages
    .map((p, i) => `### 页面 ${i + 1}: ${p.title}\n内容:\n${p.content}`)
    .join('\n\n');
  const task = `${promptTemplate}

## 用户问题
${question}

## 知识库上下文
${pageContext}

## 任务
请将上述内容转化为适合图像生成的英文 prompt。`;

  // 为什么 maxSteps:1 + tokenBudget:4000：图像 prompt 简短，单轮 LLM 足够
  const imagePromptConfig: HarnessConfig = {
    ...harnessConfig,
    tools: [],
    budget: { maxSteps: 1, tokenBudget: 4000 },
    hooks: {},
  };
  const harness = new Harness(imagePromptConfig);
  const result = await harness.run({ task });
  if (result.status === 'failed') {
    throw new Error(result.finalContent || 'image prompt generation failed');
  }
  const imagePrompt = (result.finalContent || '').trim();

  // 3. 调用 Agnes Image API（OpenAI 兼容接口 POST /v1/images/generations）
  // 为什么 60 秒超时：图像生成通常 10-30 秒，60 秒兜底
  // 为什么用原生 https（postJsonFollowRedirect）而非 fetch：Agnes Image API 经 Cloudflare
  // 触发 301 重定向，fetch 对 POST 重定向会挂起至超时；原生 http/https 手动跟随重定向稳定返回 200。
  const imgResp = await postJsonFollowRedirect(
    `${mediaConfig.agnes.baseUrl}/images/generations`,
    {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    JSON.stringify({
      model: mediaConfig.agnes.imageModel,
      prompt: imagePrompt,
      size: mediaConfig.agnes.defaultImageSize,
      ratio: mediaConfig.agnes.defaultImageRatio,
      // 预留扩展（步数/CFG/Sampler/Seed/负面词）：仅显式设置才追加，API 不识别则忽略。
      // 合并 [{...shared.image, ...imageOverride}]：管理员共享扩展参数作为兜底，用户 BYOK 显式值覆盖之。
      ...buildImageExtras({ ...sharedImage, ...(imageOverride ?? {}) }),
    }),
    60000,
  );

  if (imgResp.status < 200 || imgResp.status >= 300) {
    throw new Error(`Agnes Image API failed (${imgResp.status}): ${imgResp.body}`);
  }

  const data = JSON.parse(imgResp.body) as {
    data?: Array<{ url?: string; b64_json?: string }>;
  };
  const item = data.data?.[0];
  if (!item) {
    throw new Error('Agnes Image API returned no data');
  }

  // 4. 下载图片到 vault queries/media/ 子目录（仅该子目录对公开媒体路由可见）
  const timestamp = formatTimestamp(); // 仅用于 .md 内容展示/排序
  const mediaId = randomMediaId(); // 文件名用随机 ID，公开路由不可枚举
  const mediaFilename = `image-${mediaId}.png`; // 仅文件名，公开 URL 直接用
  const imagePath = `queries/media/${mediaFilename}`;
  let imageBuffer: Buffer;
  if (item.url) {
    // 为什么用原生 https 下载：返回的图片 URL 可能在 CDN 上再次 302，
    // fetch 的 POST/GET 重定向语义不稳；fetchBufferFollowRedirect 手动跟随且返回 Buffer。
    imageBuffer = await fetchBufferFollowRedirect(item.url, 60000);
  } else if (item.b64_json) {
    imageBuffer = Buffer.from(item.b64_json, 'base64');
  } else {
    throw new Error('Agnes Image API returned neither url nor b64_json');
  }
  await vault.writeFile(imagePath, imageBuffer);

  // 5. 归档 Markdown（frontmatter type: query, output_mode: image）——与 png 同 mediaId 同目录，保持侧车一致
  const archivePath = `queries/media/image-${mediaId}.md`;
  const archiveContent = buildImageArchiveMarkdown(imagePrompt, question, imagePath, timestamp);
  await vault.writeFile(archivePath, archiveContent);

  // url 返回 /api/media/file 路径（公开路由，无需认证），前端 <img>/<video> 标签可直接加载
  return {
    url: `/api/media/file/${mediaFilename}`,
    alt: question,
    archivePath,
  };
}

// 生图连接测试：直接调用 Agnes Image API 做一次最小 prompt 请求，验证 Key + 网络可用。
// 与 generateImage 共享原生 https 调用（绕过 fetch 在 POST 301 重定向上挂起的问题）。
// 为什么独立导出：配置中心「图像生成」连接测试按钮需要，且不触发 LLM prompt 生成与归档，避免无谓耗时与副作用。
export async function testImageGeneration(
  mediaConfig: MediaConfig | undefined,
  appConfig?: AppConfig,
): Promise<{ ok: boolean; detail: string; model?: string }> {
  if (!mediaConfig) {
    return { ok: false, detail: '未配置媒体（生图）服务：media.agnes 缺失' };
  }
  const apiKey = resolveAgnesApiKey(mediaConfig, appConfig);
  if (!apiKey) {
    return {
      ok: false,
      detail: `未配置生图 API Key（media.agnes.apiKey / llm.apiKeys.agnes / 环境变量 ${mediaConfig.agnes.apiKeyRef} 均无）`,
    };
  }
  const model = mediaConfig.agnes.imageModel;
  try {
    const resp = await postJsonFollowRedirect(
      `${mediaConfig.agnes.baseUrl}/images/generations`,
      {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      JSON.stringify({
        model,
        prompt: 'a simple test image: a red dot on white background',
        size: mediaConfig.agnes.defaultImageSize,
        ratio: mediaConfig.agnes.defaultImageRatio,
      }),
      30000,
    );
    if (resp.status < 200 || resp.status >= 300) {
      return { ok: false, detail: `Agnes Image API 返回 ${resp.status}：${resp.body.slice(0, 200)}`, model };
    }
    const parsed = JSON.parse(resp.body) as { data?: Array<{ url?: string; b64_json?: string }> };
    if (!parsed.data?.[0]?.url && !parsed.data?.[0]?.b64_json) {
      return { ok: false, detail: 'Agnes Image API 返回结构异常（缺少 url / b64_json）', model };
    }
    return { ok: true, detail: '连接成功，生图 API 可用', model };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `连接失败：${msg}`, model };
  }
}

// v3 PPT 生成：LLM 生成 Marp Markdown → 归档
// 调用时机：queryWorkflow outputMode='ppt' 时，在 done 之前推送 ppt 事件
// 失败策略：抛错让上层 wrapWithMultimodal catch，yield thinking 提示失败，不阻塞主问答
export async function generatePpt(
  harnessConfig: HarnessConfig,
  vault: VaultService,
  question: string,
  contextPaths: string[] | undefined,
): Promise<{ markdown: string; title: string; archivePath: string; pptxUrl?: string }> {
  // 1. 收集相关页面作为生成上下文
  const pages = await collectContextPages(vault, question, 5, contextPaths);
  if (pages.length === 0) {
    throw new Error('ppt generation: no relevant pages found for context');
  }

  // 2. 构造 prompt
  const promptTemplate = await loadPptPrompt();
  const pageContext = pages
    .map((p, i) => `### 页面 ${i + 1}: ${p.title}\n路径: ${p.path}\n内容:\n${p.content}`)
    .join('\n\n---\n\n');
  const task = `${promptTemplate}

## 用户问题
${question}

## 已检索到的知识库页面（作为生成依据）
${pageContext}

## 任务
请基于上述知识库内容生成 Marp Markdown 幻灯片。严格遵守 ppt-generation.md 中的格式与内容要求。`;

  // 为什么 maxSteps:1 + tokenBudget:16000：PPT 内容较多，单轮 LLM 调用，16000 token 足够 8-12 页
  const pptConfig: HarnessConfig = {
    ...harnessConfig,
    tools: [],
    budget: { maxSteps: 1, tokenBudget: 16000 },
    hooks: {},
  };
  const harness = new Harness(pptConfig);
  const result = await harness.run({ task });
  if (result.status === 'failed') {
    throw new Error(result.finalContent || 'ppt generation failed');
  }

  const slidesContent = (result.finalContent || '').trim();
  if (slidesContent.length < 100) {
    throw new Error('ppt markdown too short (likely LLM output truncated)');
  }

  // 3. 归档：在幻灯片内容前添加 marp frontmatter（含 type/output_mode 归档字段）
  const timestamp = formatTimestamp();
  const archivePath = `queries/ppt-${timestamp}.md`;
  const markdown = buildPptArchiveMarkdown(slidesContent, question, timestamp);
  await vault.writeFile(archivePath, markdown);

  // title 取问题前 30 字符，用于前端展示
  const title = question.slice(0, 30);

  // 4. 解析 Marp 内容生成原生 .pptx（供前端下载，和浏览器预览互补）。
  // 失败降级：仅丢弃 pptxUrl 不影响预览，绝不能因 .pptx 渲染失败而让整个 PPT 问答报错。
  let pptxUrl: string | undefined;
  try {
    pptxUrl = (await generatePptxFile(vault, markdown, title)).url;
  } catch {
    pptxUrl = undefined;
  }

  return { markdown, title, archivePath, pptxUrl };
}

// v3 视频生成：创建 Agnes Video 异步任务（不阻塞，前端轮询）
// 调用时机：前端 POST /api/media/video，route 通过 adapter.generateVideo 调用
// 失败策略：抛错让 route 返回 500，前端显示错误
export async function generateVideo(
  prompt: string,
  mediaConfig: MediaConfig | undefined,
  appConfig?: AppConfig,
  videoOverride?: MediaVideoUserConfig,
): Promise<VideoTaskResult> {
  // 用户 BYOK 封面覆盖：videoOverride 优先，服务端 media.agnes 作默认兜底。
  // 为什么先捕获共享配置：applyVideoOverride 返回的 agnes 视图不含 media.shared，扩展参数需提前引用原 mediaConfig。
  const sharedVideo = mediaConfig?.shared?.video;
  mediaConfig = applyVideoOverride(mediaConfig, videoOverride);
  if (!mediaConfig.agnes.videoModel && !mediaConfig.agnes.apiKey) {
    throw new Error('video generation: media config not configured');
  }
  const apiKey = resolveAgnesApiKey(mediaConfig, appConfig);
  if (!apiKey) {
    throw new Error(
      `video generation: Agnes API key not configured (set media.agnes.apiKey or llm.apiKeys.agnes or env ${mediaConfig.agnes.apiKeyRef})`,
    );
  }

  // 调用 Agnes Video API 创建任务 POST /v1/videos
  // 为什么 30 秒超时：创建任务应秒级返回，30 秒兜底
  const response = await fetchWithDiagnostics(`${mediaConfig.agnes.baseUrl}/videos`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: mediaConfig.agnes.videoModel,
      prompt,
      size: mediaConfig.agnes.defaultVideoSize,
      // Agnes Video API 的 Go 后端要求 seconds 为 string 类型，
      // 传 number 会导致 400 "cannot unmarshal number into ...seconds of type string"
      seconds: String(mediaConfig.agnes.defaultVideoSeconds),
      // 预留扩展（帧率/运动/Seed/负面词）：仅显式设置才发送。
      // 合并 [{...shared.video, ...videoOverride}]：共享扩展参数兜底，用户 BYOK 显式值覆盖之。
      ...buildVideoExtras({ ...sharedVideo, ...(videoOverride ?? {}) }),
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Agnes Video API create task failed (${response.status}): ${errText}`);
  }

  const data = (await response.json()) as {
    task_id?: string;
    video_id?: string;
    status?: string;
    progress?: number;
  };
  if (!data.task_id) {
    throw new Error('Agnes Video API returned no task_id');
  }

  return {
    taskId: data.task_id,
    videoId: data.video_id ?? data.task_id,
    status: (data.status as VideoTaskResult['status']) ?? 'queued',
    progress: data.progress ?? 0,
  };
}

// v3 视频任务轮询：查询状态，完成时下载视频并归档到 vault
// 调用时机：前端 GET /api/media/video/:taskId 轮询，route 通过 adapter.pollVideoTask 调用
// 为什么每次轮询单独请求：视频生成是长时任务，前端控制轮询间隔（5 秒），后端不阻塞
export async function pollVideoTask(
  taskId: string,
  vault: VaultService,
  mediaConfig: MediaConfig | undefined,
  appConfig?: AppConfig,
  videoOverride?: MediaVideoUserConfig,
): Promise<VideoTaskResult> {
  // 轮询需用与 create 时相同的用户 key/baseUrl 去 probe/下载，故应用同一 videoOverride（routes 用 taskMap 关联）。
  mediaConfig = applyVideoOverride(mediaConfig, videoOverride);
  if (!mediaConfig.agnes.baseUrl && !mediaConfig.agnes.apiKey) {
    throw new Error('video poll: media config not configured');
  }
  const apiKey = resolveAgnesApiKey(mediaConfig, appConfig);
  if (!apiKey) {
    throw new Error(
      `video poll: Agnes API key not configured (set media.agnes.apiKey or llm.apiKeys.agnes or env ${mediaConfig.agnes.apiKeyRef})`,
    );
  }

  // 轮询接口 GET /v1/videos/<TASK_ID>（兼容方式）
  // 为什么 30 秒超时：通过代理访问 Agnes API 可能 10-20 秒，10 秒太短导致误超时
  const response = await fetchWithDiagnostics(`${mediaConfig.agnes.baseUrl}/videos/${taskId}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Agnes Video API poll failed (${response.status}): ${errText}`);
  }

  const data = (await response.json()) as {
    task_id?: string;
    video_id?: string;
    status?: string;
    progress?: number;
    url?: string;
    error?: string;
    // Agnes Video API 完成时视频 URL 在 metadata.url 中（与 size_mapping 同级，非嵌套其内）
    metadata?: { url?: string; size_mapping?: { width?: number; height?: number } };
  };

  const status = (data.status as VideoTaskResult['status']) ?? 'processing';
  const progress = data.progress ?? 0;

  // 完成时下载视频并归档
  // 为什么兼容两种 URL 路径：Agnes API 可能返回顶层 url 或 metadata.url
  const videoUrl = data.url || data.metadata?.url;
  if (status === 'completed' && videoUrl) {
    const timestamp = formatTimestamp(); // 仅用于 .md 内容展示/排序
    const mediaId = randomMediaId(); // 文件名用随机 ID，公开路由不可枚举
    const mediaFilename = `video-${mediaId}.mp4`; // 仅文件名，公开 URL 直接用
    const videoPath = `queries/media/${mediaFilename}`;
    // 为什么 120 秒超时：视频文件较大，下载耗时
    const videoResp = await fetchWithDiagnostics(videoUrl, { signal: AbortSignal.timeout(120000) });
    if (!videoResp.ok) {
      throw new Error(`download video failed (${videoResp.status})`);
    }
    const videoBuffer = Buffer.from(await videoResp.arrayBuffer());
    await vault.writeFile(videoPath, videoBuffer);

    // 归档 Markdown——与 mp4 同 mediaId 同目录，保持侧车一致
    const archivePath = `queries/media/video-${mediaId}.md`;
    const archiveContent = buildVideoArchiveMarkdown(taskId, videoUrl, videoPath, timestamp);
    await vault.writeFile(archivePath, archiveContent);

    return {
      taskId,
      videoId: data.video_id ?? taskId,
      status: 'completed',
      progress: 100,
      url: `/api/media/file/${mediaFilename}`,
      archivePath,
    };
  }

  return {
    taskId,
    videoId: data.video_id ?? taskId,
    status,
    progress,
    error: status === 'failed' ? (data.error ?? 'video generation failed') : undefined,
  };
}
