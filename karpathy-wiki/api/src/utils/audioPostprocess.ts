// 音频后处理：参考 20_News 项目的 edge-tts 方案（app/workflow/tts/audio_postprocess.py）。
//
// 目标：让分段合成的 MP3 听感更一致、更"干净"，进一步拟人化：
//   1. 响度归一化（FFmpeg loudnorm）：统一各段响度到 -16 LUFS，避免拼接后音量跳变/爆音
//   2. 去首尾静音（FFmpeg silenceremove）：去掉 Edge TTS 常在句首/句尾生成的停顿，衔接更自然
//
// 与 20_News 的差异与收敛：
//   - 20_News 强制依赖 ffmpeg 二进制；本项目将其改为**可选**：检测到 ffmpeg 才处理，
//     否则原样返回（绝不因缺少 ffmpeg 而让 TTS 失败）。这样在沙箱/未装 ffmpeg 的环境也能正常朗读。
//   - 单段合成场景下，后处理主要收益是"去首尾静音"（让每段更干净），
//     响度归一化在分段拼接场景收益更大（本项目前端逐段播放，作用有限但无副作用）。
//
// 安全约束：
//   - 所有 ffmpeg 调用通过 child_process.execFile（非 shell），避免命令注入
//   - 临时文件写入 os.tmpdir()，单段处理失败（含临时目录不可写）时降级返回原音频，不影响朗读

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 缓存 ffmpeg 可用性探测结果（同一进程只探测一次） */
let ffmpegChecked: boolean | null = null;

/** 检测 ffmpeg 是否可用（在 PATH 中且可调用） */
export function isFfmpegAvailable(): boolean {
  if (ffmpegChecked !== null) return ffmpegChecked;
  try {
    // 必须用 execFileSync（同步）：execFile 是异步的，不会在 spawn 时同步抛出
    // ENOENT，导致缺失 ffmpeg 时仍返回 true → 后续 readTemp 读到不存在的输出文件。
    // 注意：本项目仅使用 ffmpeg（loudnorm / silenceremove），不依赖 ffprobe，
    //   移除冗余的 ffprobe 探测（评审 S6）。
    execFileSync('ffmpeg', ['-version'], { timeout: 5000, stdio: 'ignore' });
    ffmpegChecked = true;
  } catch {
    ffmpegChecked = false;
  }
  return ffmpegChecked;
}

/** 写临时文件，返回路径；失败抛错（由调用方捕获降级） */
function writeTemp(data: Buffer, suffix: string): string {
  const dir = os.tmpdir();
  const p = path.join(dir, `tts_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}_${suffix}`);
  fs.writeFileSync(p, data);
  return p;
}

function readTemp(p: string): Buffer {
  return fs.readFileSync(p);
}

function cleanupTemp(...paths: string[]): void {
  for (const p of paths) {
    try { fs.unlinkSync(p); } catch { /* 容忍不存在 */ }
  }
}

function runFfmpeg(args: string[]): void {
  // 同步执行（TTS 合成本身已是异步等待），超时 15s。
  // 必须用 execFileSync：execFile 是异步的，调用后立即返回，
  // 此处 readTemp 会读到尚未生成的输出文件 → 永远降级返回原音频。
  execFileSync('ffmpeg', ['-y', ...args], { timeout: 15_000, stdio: 'ignore' });
}

/** 响度归一化（loudnorm 滤镜），统一到 -16 LUFS */
async function normalizeLoudness(audio: Buffer): Promise<Buffer> {
  const inPath = writeTemp(audio, '.mp3');
  const outPath = `${inPath}.norm.mp3`;
  try {
    runFfmpeg([
      '-i', inPath,
      '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
      '-ar', '24000', '-ac', '1', '-b:a', '48k',
      outPath,
    ]);
    return readTemp(outPath);
  } finally {
    cleanupTemp(inPath, outPath);
  }
}

/** 去首尾静音（silenceremove 滤镜），阈值 -50dB */
async function trimSilence(audio: Buffer): Promise<Buffer> {
  const inPath = writeTemp(audio, '.mp3');
  const outPath = `${inPath}.trim.mp3`;
  try {
    runFfmpeg([
      '-i', inPath,
      '-af', 'silenceremove=start_periods=1:start_threshold=-50dB:stop_periods=-1:stop_threshold=-50dB:stop_duration=0.3',
      '-b:a', '48k',
      outPath,
    ]);
    return readTemp(outPath);
  } finally {
    cleanupTemp(inPath, outPath);
  }
}

/**
 * 应用音频后处理（响度归一化 + 去首尾静音）。
 *
 * 若 ffmpeg 不可用或任一步骤失败，均降级返回原始音频，绝不抛错中断 TTS。
 * 与 20_News 对齐：先归一化再去静音，顺序保证响度一致后切除静音。
 */
export async function applyAudioPostprocess(audio: Buffer): Promise<Buffer> {
  if (!isFfmpegAvailable()) return audio;
  try {
    let out = await normalizeLoudness(audio);
    out = await trimSilence(out);
    return out;
  } catch (err) {
    console.warn('[音频后处理] ffmpeg 处理失败，降级返回原音频：', (err as Error).message);
    return audio;
  }
}
