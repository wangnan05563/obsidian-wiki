// v3 媒体生成工作流：图像/PPT/视频生成
// 设计哲学与 multimodal-output-workflow.ts / podcast-workflow.ts 一致：
// 1. 图像/PPT 复用 collectContextPages 收集上下文 + harness 单轮 LLM 调用
// 2. 图像生成调用 Agnes Image API（OpenAI 兼容），下载归档到 vault queries/
// 3. PPT 生成用 LLM 产出 Marp Markdown，归档到 vault queries/
// 4. 视频生成是异步任务：generateVideo 创建任务（不阻塞），pollVideoTask 轮询状态
// 为什么视频走独立端点：视频生成需数分钟，超出 query SSE 60 秒超时

import fs from 'node:fs/promises';
import path from 'node:path';
import type { HarnessConfig } from '@wiki/harness';
import { Harness } from '@wiki/harness';
import type { VaultService } from '../vault/vault-service.js';
import type { MediaConfig, VideoTaskResult, AppConfig } from '../types.js';
// 复用 multimodal-output-workflow 的上下文收集逻辑，避免重复实现
import { collectContextPages } from './multimodal-output-workflow.js';
import { getPromptPath } from '../utils/runtime.js';

// 加载 prompt 单点存储（与 query/multimodal/podcast 共用 prompts/ 目录）
// 路径解析统一走 runtime.ts，兼容开发模式与 SEA 打包模式
async function loadImagePrompt(): Promise<string> {
  return fs.readFile(getPromptPath('image-generation.md'), 'utf8');
}

async function loadPptPrompt(): Promise<string> {
  return fs.readFile(getPromptPath('ppt-generation.md'), 'utf8');
}

// 时间戳格式化：YYYYMMDD-HHmmss（与 podcast-workflow 一致，归档文件名排序友好）
function formatTimestamp(): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
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
): Promise<{ url: string; alt: string; archivePath: string }> {
  if (!mediaConfig) {
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
  const response = await fetchWithDiagnostics(`${mediaConfig.agnes.baseUrl}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: mediaConfig.agnes.imageModel,
      prompt: imagePrompt,
      size: mediaConfig.agnes.defaultImageSize,
      ratio: mediaConfig.agnes.defaultImageRatio,
    }),
    signal: AbortSignal.timeout(60000),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Agnes Image API failed (${response.status}): ${errText}`);
  }

  const data = (await response.json()) as {
    data?: Array<{ url?: string; b64_json?: string }>;
  };
  const item = data.data?.[0];
  if (!item) {
    throw new Error('Agnes Image API returned no data');
  }

  // 4. 下载图片到 vault queries/ 目录
  const timestamp = formatTimestamp();
  const imagePath = `queries/image-${timestamp}.png`;
  let imageBuffer: Buffer;
  if (item.url) {
    const imgResp = await fetchWithDiagnostics(item.url, { signal: AbortSignal.timeout(60000) });
    if (!imgResp.ok) {
      throw new Error(`download image failed (${imgResp.status})`);
    }
    imageBuffer = Buffer.from(await imgResp.arrayBuffer());
  } else if (item.b64_json) {
    imageBuffer = Buffer.from(item.b64_json, 'base64');
  } else {
    throw new Error('Agnes Image API returned neither url nor b64_json');
  }
  await vault.writeFile(imagePath, imageBuffer);

  // 5. 归档 Markdown（frontmatter type: query, output_mode: image）
  const archivePath = `queries/image-${timestamp}.md`;
  const archiveContent = buildImageArchiveMarkdown(imagePrompt, question, imagePath, timestamp);
  await vault.writeFile(archivePath, archiveContent);

  // url 返回 /api/files 路径，前端通过此路径访问归档图片
  return {
    url: `/api/files?path=${encodeURIComponent(imagePath)}`,
    alt: question,
    archivePath,
  };
}

// v3 PPT 生成：LLM 生成 Marp Markdown → 归档
// 调用时机：queryWorkflow outputMode='ppt' 时，在 done 之前推送 ppt 事件
// 失败策略：抛错让上层 wrapWithMultimodal catch，yield thinking 提示失败，不阻塞主问答
export async function generatePpt(
  harnessConfig: HarnessConfig,
  vault: VaultService,
  question: string,
  contextPaths: string[] | undefined,
): Promise<{ markdown: string; title: string; archivePath: string }> {
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
  return { markdown, title, archivePath };
}

// v3 视频生成：创建 Agnes Video 异步任务（不阻塞，前端轮询）
// 调用时机：前端 POST /api/media/video，route 通过 adapter.generateVideo 调用
// 失败策略：抛错让 route 返回 500，前端显示错误
export async function generateVideo(
  prompt: string,
  mediaConfig: MediaConfig | undefined,
  appConfig?: AppConfig,
): Promise<VideoTaskResult> {
  if (!mediaConfig) {
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
): Promise<VideoTaskResult> {
  if (!mediaConfig) {
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
    const timestamp = formatTimestamp();
    const videoPath = `queries/video-${timestamp}.mp4`;
    // 为什么 120 秒超时：视频文件较大，下载耗时
    const videoResp = await fetchWithDiagnostics(videoUrl, { signal: AbortSignal.timeout(120000) });
    if (!videoResp.ok) {
      throw new Error(`download video failed (${videoResp.status})`);
    }
    const videoBuffer = Buffer.from(await videoResp.arrayBuffer());
    await vault.writeFile(videoPath, videoBuffer);

    // 归档 Markdown
    const archivePath = `queries/video-${timestamp}.md`;
    const archiveContent = buildVideoArchiveMarkdown(taskId, videoUrl, videoPath, timestamp);
    await vault.writeFile(archivePath, archiveContent);

    return {
      taskId,
      videoId: data.video_id ?? taskId,
      status: 'completed',
      progress: 100,
      url: `/api/files?path=${encodeURIComponent(videoPath)}`,
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
