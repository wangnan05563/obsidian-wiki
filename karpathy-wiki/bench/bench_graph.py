# 知识图谱渲染性能基准（浏览器实测）
# 用法: python bench_graph.py [N1 N2 ...]  默认测试 300/500/800 节点三档
# 依赖真实前端（vite dev @5173, base=/wiki/），用 fetch mock 注入大规模图谱触发降级档。
# 采集指标：rAF 帧率（主线程单帧成本）、longtask 长任务（>50ms 卡顿）、JS 堆内存。
import sys
import json
import random

from playwright.sync_api import sync_playwright

SIZES = [int(x) for x in (sys.argv[1:] or ["300", "500", "800"])]
BASE_URL = "http://localhost:5173/wiki/"
SAMPLE_MS = 5000

DIRS = ["entities", "concepts", "comparisons", "queries", "qa", "solutions"]

# 管理员身份：拥有 graph 视图权限，供前端 restoreSession 通过
ADMIN = {"id": "1", "username": "bench", "role": "admin",
         "permissions": ["graph", "dashboard", "browse", "query", "ingest", "progress", "health"]}


def gen_graph(n):
    """生成 n 节点的大规模随机图，模拟知识库大规模场景（触发 large/huge 降级档）。"""
    nodes = [f"{DIRS[i % 6]}/page_{i}.md" for i in range(n)]
    m = int(n * 2.2)
    edges = []
    seen = set()
    for _ in range(m):
        a = random.randrange(n)
        b = random.randrange(n)
        if a == b:
            continue
        if a > b:
            a, b = b, a
        key = f"{a}_{b}"
        if key in seen:
            continue
        seen.add(key)
        edges.append({"from": nodes[a], "to": nodes[b]})
    return {"nodes": nodes, "edges": edges}


def make_init(graph_json):
    """注入页面加载前的 fetch mock：登录态 + 大图数据 + 空接口兜底。"""
    g = json.dumps(graph_json)
    a = json.dumps(ADMIN)
    return f"""
    (() => {{
      try {{ localStorage.setItem('authToken', 'bench-token'); }} catch(e){{}}
      const REAL = window.fetch.bind(window);
      const GRAPH = {g};
      const ADMIN = {a};
      window.fetch = (url, opts={{}}) => {{
        const u = String(url);
        const ok = (body) => Promise.resolve(new Response(JSON.stringify(body),
          {{status:200, headers:{{'Content-Type':'application/json'}}}}));
        if (u.includes('/api/graph')) return ok(GRAPH);
        if (u.includes('/api/auth/me'))  return ok(ADMIN);
        if (u.includes('/api/') || u.includes('/health')) return ok({{}});
        return REAL(url, opts);
      }};
    }})();
    """


SAMPLER = f"""
  () => new Promise((resolve) => {{
    const DURATION = {SAMPLE_MS};
    let frames = 0, prev = 0, maxGap = 0;
    const gaps = [];
    const longs = [];
    const start = performance.now();
    const lo = new PerformanceObserver((list) => {{
      for (const e of list.getEntries()) longs.push(e.duration);
    }});
    try {{ lo.observe({{type:'longtask', buffered:true}}); }} catch(e){{}}
    const tick = (t) => {{
      if (prev) {{ const gap = t - prev; gaps.push(gap); if (gap > maxGap) maxGap = gap; }}
      prev = t; frames++;
      if (performance.now() - start < DURATION) requestAnimationFrame(tick);
      else {{
        gaps.sort((x, y) => x - y);
        const avg = gaps.length ? gaps.reduce((s, x) => s + x, 0) / gaps.length : 0;
        const p50 = gaps.length ? gaps[Math.floor(gaps.length * 0.5)] : 0;
        const p95 = gaps.length ? gaps[Math.floor(gaps.length * 0.95)] : 0;
        const mem = (performance.memory && performance.memory.usedJSHeapSize) || 0;
        resolve({{
          frames, avgGapMs: avg, fps: avg ? 1000 / avg : 0,
          p50GapMs: p50, p95GapMs: p95, maxGapMs: maxGap,
          longTasks: longs.length, longTaskTotalMs: longs.reduce((s, x) => s + x, 0),
          usedJSHeapB: mem
        }});
      }}
    }};
    requestAnimationFrame(tick);
  }})
"""


def run_case(p, n):
    browser = p.chromium.launch(headless=True, args=["--enable-precise-memory-info"])
    ctx = browser.new_context(viewport={"width": 1280, "height": 800})
    page = ctx.new_page()
    page.add_init_script(make_init(gen_graph(n)))
    page.goto(BASE_URL, wait_until="networkidle", timeout=60000)
    # 进入图谱视图：点击侧边栏"图谱"菜单
    page.get_by_role("button", name="图谱").first.click(timeout=15000)
    # 等待 vis canvas 出现，再等待物理稳定
    page.wait_for_selector(".graph-canvas canvas", timeout=20000)
    page.wait_for_timeout(7000)  # 让 barnesHut 稳定 + 流光启动
    result = page.evaluate(SAMPLER)
    # 节点数
    nstat = page.locator(".graph-stats .chip-num").nth(0).inner_text(timeout=3000)
    mem = round(result["usedJSHeapB"] / 1048576, 1)
    summary = {
        "nodes": int(nstat or 0),
        "fps": round(result["fps"], 1),
        "avgGapMs": round(result["avgGapMs"], 2),
        "p50GapMs": round(result["p50GapMs"], 2),
        "p95GapMs": round(result["p95GapMs"], 2),
        "longTasks": result["longTasks"],
        "longTaskTotalMs": round(result["longTaskTotalMs"], 1),
        "jsHeapMB": mem,
    }
    browser.close()
    return summary


def main():
    out = []
    with sync_playwright() as p:
        for n in SIZES:
            print(f">> bench {n} nodes ...", flush=True)
            try:
                r = run_case(p, n)
            except Exception as e:  # noqa: BLE001
                r = {"nodes": n, "error": str(e)}
            print(json.dumps(r, ensure_ascii=False), flush=True)
            out.append(r)
    print("== ALL ==", flush=True)
    for r in out:
        print(json.dumps(r, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()