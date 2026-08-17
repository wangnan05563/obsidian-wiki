// Generates JMeter 5.6.3 test plans for the karpathy-wiki performance test.
// Run: node tooling/perf-tests/gen-jmx.mjs
// Produces:
//   tooling/perf-tests/karpathy-perf.jmx           (Plan A: deterministic read + login, 17 TGs)
//   tooling/perf-tests/karpathy-perf-ai.jmx        (Plan B: /api/query + /api/tags/suggest, mock-backed SSE)
//   tooling/perf-tests/karpathy-perf-write.jmx     (Plan C: login-concurrent + write-page + auth-me + auth-users)
//   tooling/perf-tests/karpathy-perf-compilelock.jmx (Plan D: /api/compile (mock) run concurrently with /api/stats)
//
// Design notes:
//  - All plans reuse a setUp ThreadGroup that logs in (admin/admin123) and stores the
//    token into the `auth.token` property, consumed via Bearer ${__P(auth.token,)}.
//  - Plan A thread groups run SERIALLY (TestPlan.serialize_threadgroups=true) so each
//    endpoint's metrics are isolated -> clean per-endpoint bottleneck identification.
//  - ConstantThroughputTimer (10/min in the legacy file) is intentionally REMOVED; load
//    is now driven by thread count, with a small 100ms think-time for realism.
//  - Plan B/D use mock LLM at http://localhost:4000/v1 ; SSE responses assert on
//    `data: [DONE]`. /api/query uses a UNIQUE question per request (${__threadNum}-${__counter})
//    because the backend serializes identical questions via withSessionLock.

import { writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = __dirname;

const HOST = '127.0.0.1';
const PORT = '3000';
const MOCK = 'http://127.0.0.1:4000/v1';

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------- building blocks ----------

function userVars(extra = {}) {
  const base = {
    host: '${__P(host,' + HOST + ')}',
    port: '${__P(port,' + PORT + ')}',
    duration: '${__P(duration,60)}',
    threads: '${__P(threads,5)}',
    username: 'admin',
    password: 'admin123',
    ...extra,
  };
  const items = Object.entries(base)
    .map(
      ([k, v]) => `          <elementProp name="${k}" elementType="Argument">
            <stringProp name="Argument.name">${k}</stringProp>
            <stringProp name="Argument.value">${v}</stringProp>
            <stringProp name="Argument.metadata">=</stringProp>
          </elementProp>`
    )
    .join('\n');
  return `      <elementProp name="TestPlan.user_defined_variables" elementType="Arguments" guiclass="ArgumentsPanel" testclass="Arguments">
        <collectionProp name="Arguments.arguments">
${items}
        </collectionProp>
      </elementProp>`;
}

function assert200() {
  return `          <ResponseAssertion guiclass="AssertionGui" testclass="ResponseAssertion" testname="Assert 200">
            <collectionProp name="Asserion.test_strings">
              <stringProp name="49586">200</stringProp>
            </collectionProp>
            <stringProp name="Assertion.custom_message"></stringProp>
            <stringProp name="Assertion.test_field">Assertion.response_code</stringProp>
            <boolProp name="Assertion.assume_success">false</boolProp>
            <intProp name="Assertion.test_type">2</intProp>
          </ResponseAssertion>
          <hashTree/>`;
}

function assertSSE() {
  // confirm the stream started AND completed
  const one = (pat) => `          <ResponseAssertion guiclass="AssertionGui" testclass="ResponseAssertion" testname="Assert SSE ${esc(pat)}">
            <collectionProp name="Asserion.test_strings">
              <stringProp name="49586">${esc(pat)}</stringProp>
            </collectionProp>
            <stringProp name="Assertion.test_field">Assertion.response_data</stringProp>
            <boolProp name="Assertion.assume_success">false</boolProp>
            <intProp name="Assertion.test_type">2</intProp>
          </ResponseAssertion>
          <hashTree/>`;
  return one('data: [DONE]') + '\n' + one('data: {');
}

function authHeader() {
  return `          <HeaderManager guiclass="HeaderPanel" testclass="HeaderManager" testname="Auth Header">
            <collectionProp name="HeaderManager.headers">
              <elementProp name="" elementType="Header">
                <stringProp name="Header.name">Authorization</stringProp>
                <stringProp name="Header.value">Bearer \${__P(auth.token,)}</stringProp>
              </elementProp>
            </collectionProp>
          </HeaderManager>
          <hashTree/>`;
}

function contentTypeHeader() {
  return `          <HeaderManager guiclass="HeaderPanel" testclass="HeaderManager" testname="HTTP Headers">
            <collectionProp name="HeaderManager.headers">
              <elementProp name="" elementType="Header">
                <stringProp name="Header.name">Content-Type</stringProp>
                <stringProp name="Header.value">application/json</stringProp>
              </elementProp>
            </collectionProp>
          </HeaderManager>
          <hashTree/>`;
}

function getSampler(name, path) {
  return `        <HTTPSamplerProxy guiclass="HttpTestSampleGui" testclass="HTTPSamplerProxy" testname="${name}">
          <stringProp name="HTTPSampler.domain">\${host}</stringProp>
          <stringProp name="HTTPSampler.port">\${port}</stringProp>
          <stringProp name="HTTPSampler.protocol">http</stringProp>
          <stringProp name="HTTPSampler.path">${esc(path)}</stringProp>
          <stringProp name="HTTPSampler.method">GET</stringProp>
          <boolProp name="HTTPSampler.follow_redirects">true</boolProp>
          <boolProp name="HTTPSampler.use_keepalive">true</boolProp>
        </HTTPSamplerProxy>`;
}

function postSampler(name, path, method, bodyJson, opts = {}) {
  const raw = bodyJson != null
    ? `          <boolProp name="HTTPSampler.postBodyRaw">true</boolProp>
          <elementProp name="HTTPsampler.Arguments" elementType="Arguments">
            <collectionProp name="Arguments.arguments">
              <elementProp name="" elementType="HTTPArgument">
                <boolProp name="HTTPArgument.always_encode">false</boolProp>
                <stringProp name="Argument.value">${esc(bodyJson)}</stringProp>
                <stringProp name="Argument.metadata">=</stringProp>
              </elementProp>
            </collectionProp>
          </elementProp>`
    : '';
  const ct = bodyJson != null ? `\n          <stringProp name="HTTPSampler.contentEncoding">UTF-8</stringProp>
          <stringProp name="HTTPSampler.content_type">application/json</stringProp>` : '';
  const to = opts.timeout ? `\n          <stringProp name="HTTPSampler.response_timeout">${opts.timeout}</stringProp>` : '';
  return `        <HTTPSamplerProxy guiclass="HttpTestSampleGui" testclass="HTTPSamplerProxy" testname="${name}">
          ${raw}
          <stringProp name="HTTPSampler.domain">\${host}</stringProp>
          <stringProp name="HTTPSampler.port">\${port}</stringProp>
          <stringProp name="HTTPSampler.protocol">http</stringProp>
          <stringProp name="HTTPSampler.path">${esc(path)}</stringProp>
          <stringProp name="HTTPSampler.method">${method}</stringProp>
          <boolProp name="HTTPSampler.follow_redirects">true</boolProp>
          <boolProp name="HTTPSampler.auto_redirects">false</boolProp>
          <boolProp name="HTTPSampler.use_keepalive">true</boolProp>
          <boolProp name="HTTPSampler.DO_MULTIPART_POST">false</boolProp>${ct}${to}
        </HTTPSamplerProxy>`;
}

function thinkTimer() {
  return `        <ConstantTimer guiclass="ConstantTimerGui" testclass="ConstantTimer" testname="Think 100ms">
          <stringProp name="ConstantTimer.delay">100</stringProp>
        </ConstantTimer>
        <hashTree/>`;
}

function tgRead(name, path, serialize = false) {
  return `      <ThreadGroup guiclass="ThreadGroupGui" testclass="ThreadGroup" testname="${name}">
        <stringProp name="ThreadGroup.on_sample_error">continue</stringProp>
        <elementProp name="ThreadGroup.main_controller" elementType="LoopController" guiclass="LoopControlPanel" testclass="LoopController">
          <boolProp name="LoopController.continue_forever">false</boolProp>
          <stringProp name="LoopController.loops">-1</stringProp>
        </elementProp>
        <stringProp name="ThreadGroup.num_threads">\${threads}</stringProp>
        <stringProp name="ThreadGroup.ramp_time">5</stringProp>
        <boolProp name="ThreadGroup.scheduler">true</boolProp>
        <stringProp name="ThreadGroup.duration">\${duration}</stringProp>
      </ThreadGroup>
      <hashTree>
        ${getSampler(name, path)}
        <hashTree>
          ${authHeader()}
          ${assert200()}
        </hashTree>
        ${thinkTimer()}
      </hashTree>`;
}

function tgPost(name, path, method, bodyJson, child, opts = {}) {
  return `      <ThreadGroup guiclass="ThreadGroupGui" testclass="ThreadGroup" testname="${name}">
        <stringProp name="ThreadGroup.on_sample_error">continue</stringProp>
        <elementProp name="ThreadGroup.main_controller" elementType="LoopController" guiclass="LoopControlPanel" testclass="LoopController">
          <boolProp name="LoopController.continue_forever">false</boolProp>
          <stringProp name="LoopController.loops">-1</stringProp>
        </elementProp>
        <stringProp name="ThreadGroup.num_threads">\${threads}</stringProp>
        <stringProp name="ThreadGroup.ramp_time">5</stringProp>
        <boolProp name="ThreadGroup.scheduler">true</boolProp>
        <stringProp name="ThreadGroup.duration">\${duration}</stringProp>
      </ThreadGroup>
      <hashTree>
        ${postSampler(name, path, method, bodyJson, opts)}
        <hashTree>
          ${child}
        </hashTree>
        ${thinkTimer()}
      </hashTree>`;
}

function setupGroup() {
  return `      <SetupThreadGroup guiclass="SetupThreadGroupGui" testclass="SetupThreadGroup" testname="setUp - Login">
        <stringProp name="ThreadGroup.on_sample_error">stoptestnow</stringProp>
        <elementProp name="ThreadGroup.main_controller" elementType="LoopController" guiclass="LoopControlPanel" testclass="LoopController">
          <boolProp name="LoopController.continue_forever">false</boolProp>
          <stringProp name="LoopController.loops">1</stringProp>
        </elementProp>
        <stringProp name="ThreadGroup.num_threads">1</stringProp>
        <stringProp name="ThreadGroup.ramp_time">1</stringProp>
        <boolProp name="ThreadGroup.scheduler">false</boolProp>
      </SetupThreadGroup>
      <hashTree>
        ${postSampler('POST /api/auth/login', '/api/auth/login', 'POST', '{"username":"${username}","password":"${password}"}')}
        <hashTree>
          ${contentTypeHeader()}
          ${assert200()}
          <JSONPostProcessor guiclass="JSONPostProcessorGui" testclass="JSONPostProcessor" testname="Extract Token">
            <stringProp name="JSONPostProcessor.referenceNames">authToken</stringProp>
            <stringProp name="JSONPostProcessor.jsonPathExprs">$.token</stringProp>
            <stringProp name="JSONPostProcessor.match_numbers">1</stringProp>
            <stringProp name="JSONPostProcessor.defaultValues"></stringProp>
          </JSONPostProcessor>
          <hashTree/>
          <JSR223PostProcessor guiclass="TestBeanGUI" testclass="JSR223PostProcessor" testname="Save Token to Property">
            <stringProp name="scriptLanguage">groovy</stringProp>
            <stringProp name="parameters"></stringProp>
            <stringProp name="filename"></stringProp>
            <stringProp name="cacheKey">true</stringProp>
            <stringProp name="script">props.put('auth.token', vars.get('authToken')); log.info('Token saved: ' + (vars.get('authToken') != null ? 'OK' : 'MISSING'));</stringProp>
          </JSR223PostProcessor>
          <hashTree/>
        </hashTree>
      </hashTree>`;
}

function listeners() {
  return `      <ResultCollector guiclass="SummaryReport" testclass="ResultCollector" testname="Summary Report">
        <boolProp name="ResultCollector.error_logging">false</boolProp>
        <objProp>
          <name>saveConfig</name>
          <value class="SampleSaveConfiguration">
            <time>true</time>
            <latency>true</latency>
            <timestamp>true</timestamp>
            <success>true</success>
            <label>true</label>
            <code>true</code>
            <message>true</message>
            <threadName>true</threadName>
            <dataType>true</dataType>
            <encoding>false</encoding>
            <assertions>true</assertions>
            <subresults>true</subresults>
            <responseData>false</responseData>
            <samplerData>false</samplerData>
            <xml>false</xml>
            <fieldNames>true</fieldNames>
            <responseHeaders>false</responseHeaders>
            <requestHeaders>false</requestHeaders>
            <responseDataOnError>false</responseDataOnError>
            <saveAssertionResultsFailureMessage>true</saveAssertionResultsFailureMessage>
            <assertionsResultsToSave>0</assertionsResultsToSave>
            <bytes>true</bytes>
            <sentBytes>true</sentBytes>
            <url>true</url>
            <threadCounts>true</threadCounts>
            <idleTime>true</idleTime>
            <connectTime>true</connectTime>
          </value>
        </objProp>
        <stringProp name="filename"></stringProp>
      </ResultCollector>
      <hashTree/>
      <ResultCollector guiclass="AggregateReport" testclass="ResultCollector" testname="Aggregate Report">
        <boolProp name="ResultCollector.error_logging">false</boolProp>
        <objProp>
          <name>saveConfig</name>
          <value class="SampleSaveConfiguration">
            <time>true</time><latency>true</latency><timestamp>true</timestamp><success>true</success>
            <label>true</label><code>true</code><message>true</message><threadName>true</threadName>
            <dataType>true</dataType><encoding>false</encoding><assertions>true</assertions><subresults>true</subresults>
            <responseData>false</responseData><samplerData>false</samplerData><xml>false</xml><fieldNames>true</fieldNames>
            <responseHeaders>false</responseHeaders><requestHeaders>false</requestHeaders><responseDataOnError>false</responseDataOnError>
            <saveAssertionResultsFailureMessage>true</saveAssertionResultsFailureMessage><assertionsResultsToSave>0</assertionsResultsToSave>
            <bytes>true</bytes><sentBytes>true</sentBytes><url>true</url><threadCounts>true</threadCounts>
            <idleTime>true</idleTime><connectTime>true</connectTime>
          </value>
        </objProp>
        <stringProp name="filename"></stringProp>
      </ResultCollector>
      <hashTree/>`;
}

function wrap(planName, comments, vars, serialize, groups) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<jmeterTestPlan version="1.2" properties="5.0" jmeter="5.6.3">
  <hashTree>
    <TestPlan guiclass="TestPlanGui" testclass="TestPlan" testname="${planName}">
      <boolProp name="TestPlan.serialize_threadgroups">${serialize}</boolProp>
      <stringProp name="TestPlan.comments">${esc(comments)}</stringProp>
${userVars(vars)}
      <stringProp name="TestPlan.user_define_classpath"></stringProp>
    </TestPlan>
    <hashTree>
${setupGroup()}
${groups.join('\n')}
${listeners()}
    </hashTree>
  </hashTree>
</jmeterTestPlan>`;
}

// ---------- Plans ----------

// Plan A: deterministic read + login (serial, isolated metrics)
const planAEndpoints = [
  ['TG1 - GET /health', '/health'],
  ['TG2 - GET /api/stats', '/api/stats'],
  ['TG3 - GET /api/files/pages', '/api/files/pages'],
  ['TG4 - GET /api/graph', '/api/graph'],
  ['TG5 - GET /api/schema', '/api/schema'],
  ['TG6 - GET /api/tags/pending', '/api/tags/pending'],
  ['TG7 - POST /api/auth/login', '/api/auth/login'],
  ['TG8 - GET /api/search', '/api/search?q=test'],
  ['TG9 - GET /api/files/tree', '/api/files/tree'],
  ['TG10 - GET /api/cleanup/status', '/api/cleanup/status'],
  ['TG11 - GET /api/data-clean/precheck', '/api/data-clean/precheck'],
  ['TG12 - GET /api/ai/config', '/api/ai/config'],
  ['TG13 - GET /api/config', '/api/config'],
  ['TG14 - GET /api/about', '/api/about'],
  ['TG15 - GET /api/tools/config', '/api/tools/config'],
  ['TG16 - GET /api/skills', '/api/skills'],
  ['TG17 - GET /api/prompts', '/api/prompts'],
];

const planAGroups = planAEndpoints.map(([name, path]) => {
  if (name.includes('auth/login')) {
    return tgPost(
      name,
      path,
      'POST',
      '{"username":"${username}","password":"${password}"}',
      `          ${contentTypeHeader()}\n          ${assert200()}`
    );
  }
  return tgRead(name, path);
});

const planA = wrap(
  'Karpathy-Wiki 性能测试计划 (Plan A: 只读核心)',
  'Plan A: 17 deterministic read/login endpoints, run serially for isolated per-endpoint metrics. Rate-limit disabled on server (WIKI_DISABLE_RATE_LIMIT=1). Load driven by threads; 100ms think-time.',
  {},
  true,
  planAGroups
);

// Plan B: AI/SSE via mock LLM
const queryBody = JSON.stringify({
  question: '请解释节点 ${__threadNum}-${__counter(TRUE,)} 的概念',
  stream: true,
  llmConfig: { provider: 'openai', baseUrl: MOCK, model: 'mock', apiKey: 'sk-mock' },
});
const suggestBody = JSON.stringify({
  text: 'karpathy 神经网络 dropout 正则化 反向传播',
  llmConfig: { provider: 'openai', baseUrl: MOCK, model: 'mock', apiKey: 'sk-mock' },
});
const planBGroups = [
  tgPost('TG-AI-query (SSE)', '/api/query', 'POST', queryBody, `          ${contentTypeHeader()}\n          ${assertSSE()}`, { timeout: 120000 }),
  tgPost('TG-AI-tags-suggest', '/api/tags/suggest', 'POST', suggestBody, `          ${contentTypeHeader()}\n          ${assert200()}`),
];
const planB = wrap(
  'Karpathy-Wiki 性能测试计划 (Plan B: AI/SSE mock)',
  'Plan B: /api/query (SSE) + /api/tags/suggest, backend pointed at local mock LLM (http://localhost:4000/v1) via BYOK llmConfig. Each /api/query uses a UNIQUE question to bypass withSessionLock serialization. Rate-limit disabled.',
  {},
  false,
  planBGroups
);

// Plan C: write / auth / concurrency
const writeBody = '# 负载测试页面\n\n由 JMeter 性能测试自动创建，测试结束后清理。';
const planCGroups = [
  tgPost('TG-login-concurrent', '/api/auth/login', 'POST', '{"username":"${username}","password":"${password}"}', `          ${contentTypeHeader()}\n          ${assert200()}`),
  tgPost(
    'TG-write-page (PUT /api/files)',
    '/api/files?path=perf-test/load-${__threadNum}-${__counter(TRUE,)}.md',
    'PUT',
    writeBody,
    `          ${contentTypeHeader()}\n          ${assert200()}`,
    { timeout: 30000 }
  ),
  tgRead('TG-auth-me', '/api/auth/me'),
  tgRead('TG-auth-users', '/api/auth/users'),
];
const planC = wrap(
  'Karpathy-Wiki 性能测试计划 (Plan C: 写/认证/并发)',
  'Plan C: concurrent login (PBKDF2), PUT /api/files write, GET /api/auth/me, GET /api/auth/users. Run on a backed-up vault; perf-test/ pages cleaned after. Rate-limit disabled.',
  {},
  false,
  planCGroups
);

// Plan D: compile-lock verification (compile + stats concurrently)
const compileBody = JSON.stringify({
  type: 'text',
  text: '# 编译锁压测页面\n\n这是一个用于验证全局编译锁是否会阻塞其他端点的自动生成页面。',
  llmConfig: { provider: 'openai', baseUrl: MOCK, model: 'mock', apiKey: 'sk-mock' },
});
const planDGroups = [
  tgPost('TG-compile (mock, 占全局编译锁)', '/api/compile', 'POST', compileBody, `          ${contentTypeHeader()}\n          ${assert200()}`, { timeout: 120000 }),
  tgRead('TG-stats-parallel', '/api/stats'),
];
const planD = wrap(
  'Karpathy-Wiki 性能测试计划 (Plan D: 编译锁阻塞验证)',
  'Plan D: run /api/compile (mock LLM, occupies the global compile-lock) concurrently with /api/stats. If /api/stats latency rises in lockstep with compile activity, the global lock is the bottleneck. Run on a backed-up vault. Rate-limit disabled.',
  {},
  false,
  planDGroups
);

// ---------- write files (backup originals) ----------
const files = {
  'karpathy-perf.jmx': planA,
  'karpathy-perf-ai.jmx': planB,
  'karpathy-perf-write.jmx': planC,
  'karpathy-perf-compilelock.jmx': planD,
};

for (const [name, content] of Object.entries(files)) {
  const target = join(OUT, name);
  if (existsSync(target)) {
    const bak = join(OUT, name + '.bak');
    if (!existsSync(bak)) copyFileSync(target, bak);
  }
  writeFileSync(target, content, 'utf-8');
  console.log('wrote', name, '(' + content.length + ' bytes)');
}
