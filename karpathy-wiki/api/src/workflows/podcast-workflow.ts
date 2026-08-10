import fs from 'node:fs/promises';
import type { HarnessConfig } from '@wiki/harness';
import { Harness } from '@wiki/harness';
import type { VaultService } from '../vault/vault-service.js';
import { searchPages } from '../search-util.js';
import type { AppConfig, PodcastConfig, PodcastResult } from '../types.js';
import { getPromptPath } from '../utils/runtime.js';

// FR-09-3 Podcast (Audio Overview) workflow
// 设计哲学与 multimodal-output-workflow.ts 一致：
// 1. 复用 harness 调用 LLM 生成脚本（单轮，禁用工具）
// 2. TTS 合成为可选阶段：未配置 podcast.ttsApiKey 时仅返回脚本
// 3. 归档到 queries/podcast-{timestamp}.md 含 frontmatter（AC-09-7/8）

// 加载 podcast prompt 单点存储（与 query/compile/multimodal 共用 prompts/ 目录）
// 为什么独立 prompt：播客脚本有严格的对话格式约束，混入 query.md 会污染主问答 prompt
// 路径解析统一走 runtime.ts，兼容开发模式与 SEA 打包模式
async function loadPodcastPrompt(): Promise<string> {
  return fs.readFile(getPromptPath('podcast.md'), 'utf8');
}

// 收集相关页面内容作为 LLM 上下文（复用 multimodal-output-workflow 模式）
// 为什么 Top-8 而非 Top-5：播客脚本比结构化输出需要更多素材填充 5+ 分钟对话
// 为什么读完整内容而非摘要：LLM 需要准确细节才能生成有深度的对话
async function collectContextPages(
  vault: VaultService,
  topic: string,
  maxPages = 8,
  scopeFilter?: { tags?: string[]; folder?: string },
): Promise<{ path: string; title: string; content: string }[]> {
  const pages: { path: string; title: string; content: string }[] = [];

  // AC-09-6 主题范围限定：按 tag/folder 过滤，避免全库噪音
  // 为什么先过滤再搜索：减少 searchPages 输入集，提高相关性
  let searchBase = topic;
  if (scopeFilter?.folder) {
    // 文件夹限定：在搜索关键词前加文件夹名作为 hint
    // 为什么不用 vault.listFiles + filter：searchPages 已有索引，性能更好
    searchBase = `${scopeFilter.folder} ${topic}`;
  }

  // 去除开头常见疑问短语 + 标点，让核心词命中
  const keywords = searchBase
    .replace(/^(什么是|如何|为什么|怎么|请|介绍一下|介绍下|解释下|说明下)/, '')
    .replace(/[？?。.!！，,、；;：:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);

  const hits = await searchPages(vault, keywords, maxPages * 2); // 多取一倍用于过滤

  for (const hit of hits) {
    if (pages.length >= maxPages) break;
    try {
      const content = await vault.readFile(hit.path);
      // tag 过滤：页面 frontmatter 必须包含至少一个指定 tag
      // 为什么用简单正则：避免引入 gray-matter 依赖（compile-workflow 已有，但此处轻量场景够用）
      if (scopeFilter?.tags && scopeFilter.tags.length > 0) {
        const tagMatch = content.match(/^---\s*[\s\S]*?tags:\s*\[([^\]]*)\]\s*[\s\S]*?---/m);
        const pageTagsStr = tagMatch?.[1] ?? '';
        const pageTags = pageTagsStr.split(',').map((t) => t.trim().replace(/['"]/g, ''));
        const hasMatchTag = pageTags.some((t) => scopeFilter.tags!.includes(t));
        if (!hasMatchTag) continue; // 跳过不匹配 tag 的页面
      }
      // folder 过滤：路径必须以指定文件夹开头
      if (scopeFilter?.folder && !hit.path.startsWith(scopeFilter.folder + '/')) {
        continue;
      }
      pages.push({
        path: hit.path,
        title: hit.title,
        content: content.slice(0, 3000), // 截断单页避免上下文过长
      });
    } catch {
      // 跳过读取失败的页面
    }
  }
  return pages;
}

// 构造 LLM 输入 prompt：播客脚本指令 + 上下文页面 + 主题
async function buildPodcastPrompt(
  pages: { path: string; title: string; content: string }[],
  topic: string,
): Promise<string> {
  const promptTemplate = await loadPodcastPrompt();
  const pageContext = pages
    .map((p, i) => `### 页面 ${i + 1}: ${p.title}\n路径: ${p.path}\n内容:\n${p.content}`)
    .join('\n\n---\n\n');

  return `${promptTemplate}

## 用户主题
${topic}

## 已检索到的知识库页面（作为对话素材）
${pageContext}

## 任务
请基于上述知识库内容，生成一段关于「${topic}」的对话式播客脚本。严格遵守 podcast.md 中的格式与内容要求。`;
}

// 解析脚本为 TTS 段落：按 ## Host A/B 分割
// 为什么解析：TTS 需要按段落合成，避免单次请求超长导致失败
interface ScriptSegment {
  speaker: 'A' | 'B';
  text: string;
}

export function parseScriptSegments(script: string): ScriptSegment[] { // NOSONAR - 认知复杂度：正则循环解析逻辑
  const segments: ScriptSegment[] = [];
  // 匹配 ## Host A: xxx 或 ## Host B: xxx
  // 为什么用正则：脚本格式由 prompt 约定，简单正则足够稳定
  const lines = script.split('\n');
  let currentSpeaker: 'A' | 'B' | null = null;
  let currentText: string[] = [];

  for (const line of lines) {
    const match = line.match(/^##\s*Host\s+([AB])\s*[:：]\s*(.*)/i);
    if (match) {
      // 保存前一段
      if (currentSpeaker && currentText.length > 0) {
        segments.push({
          speaker: currentSpeaker,
          text: currentText.join('\n').trim(),
        });
      }
      currentSpeaker = match[1].toUpperCase() as 'A' | 'B';
      currentText = match[2] ? [match[2]] : [];
    } else if (currentSpeaker) {
      // 跳过子话题标记行（### 子话题：xxx），TTS 不朗读
      if (line.match(/^###\s/)) continue;
      currentText.push(line);
    }
  }
  // 保存最后一段
  if (currentSpeaker && currentText.length > 0) {
    segments.push({
      speaker: currentSpeaker,
      text: currentText.join('\n').trim(),
    });
  }
  return segments;
}

// 调用 TTS API 合成单段音频
// 为什么直接 fetch 而非通过 harness：TTS 不是 LLM 工具，是独立的音频合成服务
async function synthesizeSegment(
  text: string,
  voice: string,
  rate: number,
  config: PodcastConfig,
): Promise<Buffer | null> {
  // 解析 API key：优先 config.ttsApiKey，回退环境变量
  const apiKey = config.ttsApiKey ?? (config.ttsApiKeyRef ? process.env[config.ttsApiKeyRef] ?? '' : '');
  if (!apiKey) {
    return null;
  }

  const body = {
    text,
    voice,
    rate,
    // 后端 /api/tts/synthesize 预期格式（与前端 doubaoTtsProvider 一致）
  };

  try {
    const response = await fetch(`${config.ttsBaseUrl}/api/tts/synthesize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      // 60s 超时：单段 TTS 合成不应超过 60s
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      return null;
    }

    // 后端返回 { audioBase64: string } 或直接音频流
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const data = (await response.json()) as { audioBase64?: string; url?: string };
      if (data.audioBase64) {
        return Buffer.from(data.audioBase64, 'base64');
      }
      if (data.url) {
        // 下载 URL 音频
        const audioResp = await fetch(data.url);
        if (audioResp.ok) {
          return Buffer.from(await audioResp.arrayBuffer());
        }
      }
      return null;
    }
    // 直接音频流
    return Buffer.from(await response.arrayBuffer());
  } catch {
    return null;
  }
}

// 估算音频时长（中文 TTS 约 4-5 字/秒）
// 为什么估算：TTS 未配置或失败时仍需返回大致时长供 UI 展示
function estimateDurationSec(script: string): number {
  // 去除 Markdown 标记后计算字符数
  const cleanText = script
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/[*_`~]/g, '')
    .trim();
  // 中文 4.5 字/秒，英文 3 词/秒，这里取中文近似值
  return Math.ceil(cleanText.length / 4.5);
}

// FR-09-3 播客生成工作流入口
// 调用时机：用户在 Query 页面选择 podcast 输出模式时
// 失败策略：脚本生成失败抛错；TTS 合成失败降级为仅脚本（仍可归档）
export async function generatePodcast(
  harnessConfig: HarnessConfig,
  vault: VaultService,
  topic: string,
  appConfig?: AppConfig,
  scopeFilter?: { tags?: string[]; folder?: string },
): Promise<PodcastResult> {
  // 1. 收集相关页面作为对话素材（AC-09-6 支持 tag/folder 范围限定）
  const pages = await collectContextPages(vault, topic, 8, scopeFilter);
  if (pages.length === 0) {
    throw new Error('podcast: no relevant pages found for topic');
  }

  // 2. 构造 prompt
  const task = await buildPodcastPrompt(pages, topic);

  // 3. 复用 harnessConfig 的 LLM 配置，但禁用工具（单轮生成）
  // 为什么 maxSteps:1：避免 ReAct 循环浪费 token，播客脚本只需单轮 LLM 调用
  // 为什么 tokenBudget 较大：播客脚本 3000-5000 字，需要 16000 token 空间
  const podcastConfig: HarnessConfig = {
    ...harnessConfig,
    tools: [],
    budget: { maxSteps: 1, tokenBudget: 16000 },
    hooks: {},
  };
  const harness = new Harness(podcastConfig);

  const result = await harness.run({ task });
  if (result.status === 'failed') {
    throw new Error(result.finalContent || 'podcast script generation failed');
  }

  const script = (result.finalContent || '').trim();
  if (script.length < 100) {
    throw new Error('podcast script too short (likely LLM output truncated)');
  }

  // 4. TTS 合成（可选）
  const podcastTtsConfig = appConfig?.podcast;
  const audioFiles: string[] = [];
  let ttsEnabled = false;

  if (podcastTtsConfig?.ttsApiKey) {
    ttsEnabled = true;
    const segments = parseScriptSegments(script);
    const timestamp = formatTimestamp();

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const voice = seg.speaker === 'A'
        ? (podcastTtsConfig.voiceA ?? 'BV001_streaming')
        : (podcastTtsConfig.voiceB ?? 'BV002_streaming');
      const rate = podcastTtsConfig.rate ?? 1.0; // NOSONAR

      const audioBuf = await synthesizeSegment(seg.text, voice, rate, podcastTtsConfig);
      if (audioBuf) {
        // 保存到 vault 的 queries/ 目录（AC-09-7）
        const audioPath = `queries/podcast-${timestamp}-seg${i + 1}-${seg.speaker}.mp3`;
        await vault.writeFile(audioPath, audioBuf);
        audioFiles.push(audioPath);
      }
    }
  }

  // 5. 估算时长
  const durationSec = estimateDurationSec(script);

  // 6. 归档到 queries/podcast-{timestamp}.md（AC-09-7/8）
  const timestamp = formatTimestamp();
  const archivePath = `queries/podcast-${timestamp}.md`;
  const archiveContent = buildArchiveMarkdown(script, topic, audioFiles, durationSec, ttsEnabled, scopeFilter);
  await vault.writeFile(archivePath, archiveContent);

  return {
    script,
    audioFiles,
    durationSec,
    archivePath,
    ttsEnabled,
  };
}

// 时间戳格式化：YYYYMMDD-HHmmss
function formatTimestamp(): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

// 构造归档 Markdown（AC-09-8 frontmatter type: query, output_mode, generated_at）
function buildArchiveMarkdown(
  script: string,
  topic: string,
  audioFiles: string[],
  durationSec: number,
  ttsEnabled: boolean,
  scopeFilter?: { tags?: string[]; folder?: string },
): string {
  const now = new Date().toISOString();
  const frontmatter = [
    '---',
    'type: query',
    'output_mode: podcast',
    `generated_at: ${now}`,
    `topic: ${topic}`,
    `duration_sec: ${durationSec}`,
    `tts_enabled: ${ttsEnabled}`,
    scopeFilter?.tags ? `scope_tags: [${scopeFilter.tags.join(', ')}]` : null,
    scopeFilter?.folder ? `scope_folder: ${scopeFilter.folder}` : null,
    `audio_files: [${audioFiles.map((f) => `"${f}"`).join(', ')}]`,
    '---',
  ]
    .filter(Boolean)
    .join('\n');

  return `${frontmatter}

# 播客脚本：${topic}

> 生成时间：${now}
> 预计时长：${Math.floor(durationSec / 60)} 分 ${durationSec % 60} 秒
> TTS 合成：${ttsEnabled ? '已启用' : '未启用（仅脚本）'}

${script}

---

## 音频文件

${audioFiles.length > 0 ? audioFiles.map((f) => `- [${f}](${f})`).join('\n') : '（TTS 未启用，无音频文件）'}
`;
}
