"""
JMeter JTL 结果分析脚本
解析 results.jtl CSV 文件，计算关键性能指标，生成 Markdown 报告
"""
import csv
import statistics
import sys
from pathlib import Path
from collections import defaultdict
from datetime import datetime


def percentile(data, p):
    """计算分位数 p（0-100）"""
    if not data:
        return 0
    s = sorted(data)
    k = (len(s) - 1) * (p / 100)
    f = int(k)
    c = k - f
    if f + 1 < len(s):
        return s[f] + c * (s[f + 1] - s[f])
    return s[f]


def analyze(jtl_path: str):
    samples_by_label = defaultdict(list)
    errors_by_label = defaultdict(list)
    bytes_by_label = defaultdict(list)
    sent_bytes_by_label = defaultdict(list)
    latency_by_label = defaultdict(list)
    connect_by_label = defaultdict(list)

    total_samples = 0
    total_errors = 0
    first_ts = None
    last_ts = None

    with open(jtl_path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            label = row.get("label", "unknown")
            try:
                elapsed = float(row.get("elapsed", 0))
                ts = int(row.get("timeStamp", 0))
                success = row.get("success", "true").lower() == "true"
                code = row.get("responseCode", "")
                bytes_recv = int(row.get("bytes", 0) or 0)
                bytes_sent = int(row.get("sentBytes", 0) or 0)
                latency = float(row.get("Latency", 0) or 0)
                connect = float(row.get("ConnectTime", 0) or 0)
            except ValueError:
                continue

            samples_by_label[label].append({
                "elapsed": elapsed,
                "ts": ts,
                "code": code,
                "success": success,
            })
            bytes_by_label[label].append(bytes_recv)
            sent_bytes_by_label[label].append(bytes_sent)
            latency_by_label[label].append(latency)
            connect_by_label[label].append(connect)

            if not success:
                total_errors += 1
                errors_by_label[label].append(code)

            total_samples += 1
            if first_ts is None or ts < first_ts:
                first_ts = ts
            if last_ts is None or ts > last_ts:
                last_ts = ts

    return {
        "samples_by_label": samples_by_label,
        "errors_by_label": errors_by_label,
        "bytes_by_label": bytes_by_label,
        "sent_bytes_by_label": sent_bytes_by_label,
        "latency_by_label": latency_by_label,
        "connect_by_label": connect_by_label,
        "total_samples": total_samples,
        "total_errors": total_errors,
        "first_ts": first_ts,
        "last_ts": last_ts,
    }


def rate_endpoint(label):
    """评级响应时间"""
    if label <= 100:
        return "优秀"
    if label <= 200:
        return "良好"
    if label <= 500:
        return "一般"
    if label <= 1000:
        return "较差"
    return "差"


def rate_error_rate(err_pct):
    if err_pct == 0:
        return "优秀"
    if err_pct < 1:
        return "良好"
    if err_pct < 5:
        return "一般"
    return "差"


def render_markdown(stats: dict, out_path: str):
    lines = []
    lines.append("# Karpathy-Wiki 性能测试报告\n")
    lines.append(f"**生成时间**: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
    lines.append(f"**总样本数**: {stats['total_samples']}\n")
    lines.append(f"**总错误数**: {stats['total_errors']}\n")
    if stats["first_ts"] and stats["last_ts"]:
        duration_sec = (stats["last_ts"] - stats["first_ts"]) / 1000.0
        lines.append(f"**测试总时长**: {duration_sec:.1f} 秒\n")
        overall_tps = stats["total_samples"] / duration_sec if duration_sec > 0 else 0
        lines.append(f"**总体吞吐量**: {overall_tps:.2f} req/s ({overall_tps*60:.0f} req/min)\n")
    overall_err = stats["total_errors"] / stats["total_samples"] * 100 if stats["total_samples"] > 0 else 0
    lines.append(f"**整体错误率**: {overall_err:.2f}% ({rate_error_rate(overall_err)})\n")
    lines.append("\n---\n")

    lines.append("## 各端点详细指标\n")
    lines.append("| 端点 | 样本数 | 平均 (ms) | P50 (ms) | P90 (ms) | P95 (ms) | P99 (ms) | 最小 (ms) | 最大 (ms) | 错误数 | 错误率 | 评级 |")
    lines.append("|------|--------|-----------|----------|----------|----------|----------|-----------|-----------|--------|--------|------|")

    summary = []
    for label in sorted(stats["samples_by_label"].keys()):
        samples = stats["samples_by_label"][label]
        elapsed = [s["elapsed"] for s in samples]
        errors = stats["errors_by_label"].get(label, [])
        n = len(elapsed)
        if n == 0:
            continue
        avg = statistics.mean(elapsed)
        p50 = percentile(elapsed, 50)
        p90 = percentile(elapsed, 90)
        p95 = percentile(elapsed, 95)
        p99 = percentile(elapsed, 99)
        mn = min(elapsed)
        mx = max(elapsed)
        err_n = len(errors)
        err_pct = err_n / n * 100 if n > 0 else 0
        rate = rate_endpoint(avg)
        summary.append({
            "label": label,
            "n": n,
            "avg": avg,
            "p95": p95,
            "p99": p99,
            "max": mx,
            "err_pct": err_pct,
            "rate": rate,
        })
        lines.append(f"| {label} | {n} | {avg:.1f} | {p50:.1f} | {p90:.1f} | {p95:.1f} | {p99:.1f} | {mn:.1f} | {mx:.1f} | {err_n} | {err_pct:.2f}% | {rate} |")

    lines.append("\n## 吞吐量分析（按端点）\n")
    lines.append("| 端点 | 样本数 | 持续时间 (s) | TPS (req/s) | 平均响应字节 | 平均发送字节 | 平均延迟 (ms) |")
    lines.append("|------|--------|--------------|-------------|--------------|--------------|---------------|")
    for label in sorted(stats["samples_by_label"].keys()):
        samples = stats["samples_by_label"][label]
        ts_list = [s["ts"] for s in samples]
        if not ts_list:
            continue
        dur = (max(ts_list) - min(ts_list)) / 1000.0
        n = len(samples)
        tps = n / dur if dur > 0 else 0
        avg_bytes = statistics.mean(stats["bytes_by_label"][label]) if stats["bytes_by_label"][label] else 0
        avg_sent = statistics.mean(stats["sent_bytes_by_label"][label]) if stats["sent_bytes_by_label"][label] else 0
        avg_lat = statistics.mean(stats["latency_by_label"][label]) if stats["latency_by_label"][label] else 0
        lines.append(f"| {label} | {n} | {dur:.1f} | {tps:.2f} | {avg_bytes:.0f} | {avg_sent:.0f} | {avg_lat:.1f} |")

    if any(stats["errors_by_label"].values()):
        lines.append("\n## 错误分析\n")
        lines.append("| 端点 | 错误码 | 出现次数 |")
        lines.append("|------|--------|----------|")
        for label, codes in stats["errors_by_label"].items():
            code_counts = defaultdict(int)
            for c in codes:
                code_counts[c] += 1
            for code, cnt in code_counts.items():
                lines.append(f"| {label} | {code} | {cnt} |")

    lines.append("\n## 性能瓶颈识别\n")
    slowest = sorted(summary, key=lambda x: x["avg"], reverse=True)
    for i, s in enumerate(slowest[:3], 1):
        lines.append(f"{i}. **{s['label']}** - 平均响应时间 {s['avg']:.1f}ms，P95 {s['p95']:.1f}ms，P99 {s['p99']:.1f}ms，错误率 {s['err_pct']:.2f}%（评级：{s['rate']}）")

    Path(out_path).write_text("\n".join(lines), encoding="utf-8")
    print(f"报告已生成: {out_path}")
    print(f"总样本数: {stats['total_samples']}, 总错误数: {stats['total_errors']}")


if __name__ == "__main__":
    jtl = sys.argv[1] if len(sys.argv) > 1 else "results/results.jtl"
    out = sys.argv[2] if len(sys.argv) > 2 else "reports/perf-report.md"
    stats = analyze(jtl)
    render_markdown(stats, out)
