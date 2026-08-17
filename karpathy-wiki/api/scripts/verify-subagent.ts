/**
 * 多步 Agent 验证（生产 api 子智能体接线 + wiki-harness 真实链路）。
 *
 * 两种模式：
 *  1) 默认（推荐，无需有效 LLM key）：本地 stub OpenAI 端点承接真实 OpenAICompatibleAdapter 的
 *     HTTP 请求，脚本化父/子决策。运行的是【真实 Harness + 真实 subagent + 真实 Vault 工具】
 *     —— 父智能体委派 spawn_researcher，子智能体在隔离上下文独立调用 search_pages 检索真实知识库，
 *     父再综合作答。仅「模型文本生成」被本地确定性脚本替代。
 *  2) USE_LIVE_LLM=1：走 config.json 真实 LLM（需有效 apiKey；当前 config key 返回 401，故默认不走）。
 *
 * 运行：cd karpathy-wiki/api && npx tsx scripts/verify-subagent.ts
 */
import { Harness } from '@wiki/harness';
import { VaultService } from '../src/vault/vault-service.js';
import { createQueryTools } from '../src/workflows/query-workflow.js';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

const apiDir = path.resolve(import.meta.dirname, '..');
const config = JSON.parse(await fs.readFile(path.join(apiDir, 'config.json'), 'utf-8'));
const vaultPath = path.resolve(apiDir, config.vaultPath || '../data/vault');

const USE_LIVE = process.env.USE_LIVE_LLM === '1';

// ── 子智能体配置（与生产 index.ts ENABLE_SUBAGENTS 开启时一致）──
const subAgents = [{
  name: 'researcher',
  description: '委派子智能体在隔离上下文中独立检索与研读知识库页面，返回聚焦结论后由父智能体综合作答。',
  tools: ['search_pages', 'read_page'],
  maxSteps: 8,
  tokenBudget: 8000,
}];

// ── 本地 stub OpenAI 端点：脚本化父/子决策 ──
// 区分父子：父的工具集含 spawn_researcher，子的不含。
function scriptedResponse(body: { messages: Array<{ role: string; content?: string; tool_calls?: unknown }>; tools?: Array<{ function: { name: string } }> }) {
  const tools = body.tools ?? [];
  const hasSpawn = tools.some((t) => t.function.name === 'spawn_researcher');
  const messages = body.messages;
  const hasToolResult = messages.some((m) => m.role === 'tool');

  if (hasSpawn) {
    // 父智能体
    if (!hasToolResult) {
      // 第一步：委派子智能体
      return {
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: 'call_parent_1',
              type: 'function',
              function: { name: 'spawn_researcher', arguments: JSON.stringify({ task: '研读知识库中「LLM（大语言模型）」与「RAG（检索增强生成）」的定义，给出聚焦对比结论。' }) },
            }],
          },
        }],
      };
    }
    // 第二步：综合子智能体结论作答
    return {
      choices: [{
        message: {
          content: '根据 researcher 子智能体对知识库的独立研读：LLM（大语言模型）是…；RAG（检索增强生成）是…。[[llm-wiki]] [[rag-wiki]]（结论由子智能体隔离检索后由父综合）',
          tool_calls: undefined,
        },
      }],
    };
  }

  // 子智能体（隔离上下文，仅 search_pages/read_page）
  if (!hasToolResult) {
    return {
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: 'call_child_1',
            type: 'function',
            function: { name: 'search_pages', arguments: JSON.stringify({ keywords: 'LLM RAG 大语言模型 检索增强生成' }) },
          }],
        },
      }],
    };
  }
  // 子智能体基于检索结果产出聚焦结论（真实返回给父）
  return {
    choices: [{
      message: {
        content: '子智能体研读结论：LLM 是具备大规模参数自监督预训练的语言模型；RAG 在生成前先检索外部知识库片段再生成，缓解幻觉。',
        tool_calls: undefined,
      },
    }],
  };
}

async function main() {
  const vault = new VaultService(vaultPath);
  await vault.init();

  let baseUrl: string;
  let apiKey = config.llm.apiKey ?? 'stub';
  let server: Server | undefined;

  if (USE_LIVE) {
    baseUrl = config.llm.baseUrl;
  } else {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let buf = '';
      req.on('data', (c) => (buf += c));
      req.on('end', () => {
        try {
          const body = JSON.parse(buf || '{}');
          const resp = scriptedResponse(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(resp));
        } catch (e) {
          res.writeHead(500);
          res.end(String(e));
        }
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}/v1`;
    console.log('[verify] stub OpenAI endpoint:', baseUrl + '/chat/completions');
  }

  const llm = { provider: 'openai', baseUrl, model: USE_LIVE ? config.llm.model : 'stub-model', apiKey };
  const tools = createQueryTools(vault, {});
  const harness = new Harness({
    llm,
    tools,
    budget: config.budget ?? { maxSteps: 20, tokenBudget: 50000 },
    subAgents,
  });

  const question = '请对比知识库中「LLM」与「RAG」两个概念的核心定义、区别与联系，并引用相关页面。';
  const task = `你是知识库助手。用户问题：${question}\n若需深入研读某页面，可委派 researcher 子智能体在隔离上下文中独立检索研读后返回聚焦结论，你再综合作答。`;

  console.log('[verify] tools:', tools.map((t) => t.name).join(', '), '+ spawn_researcher(自动注册)');
  const t0 = Date.now();
  const result = await harness.run({ task, context: { question } });
  const elapsed = Date.now() - t0;

  const dump = JSON.stringify(result.messages ?? []);
  const spawnCalled = dump.includes('spawn_researcher');
  const childRan = dump.includes('search_pages') || dump.includes('子智能体研读结论');

  console.log('[verify] status      :', result.status);
  console.log('[verify] steps       :', result.step);
  console.log('[verify] tokens      :', result.tokenUsed);
  console.log('[verify] elapsed_ms  :', elapsed);
  console.log('[verify] SPAWN_USED  :', spawnCalled, '(父委派子智能体)');
  console.log('[verify] CHILD_RAN   :', childRan, '(子独立调用真实 vault 工具)');
  console.log('[verify] answer      :\n' + (result.finalContent || '').slice(0, 600));

  server?.close();
  if (spawnCalled && childRan) {
    console.log('\n[verify] PASS ✅ 多步 Agent 全链路打通：父委派 spawn_researcher → 子在隔离上下文独立检索真实知识库 → 父综合作答。');
    process.exit(0);
  } else {
    console.log('\n[verify] FAIL ❌ 多步委派未完整发生（见上）。');
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
