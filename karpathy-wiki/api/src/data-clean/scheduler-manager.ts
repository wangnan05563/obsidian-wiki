import fs from 'node:fs/promises';
import path from 'node:path';
import { scanVault } from './quality-scanner.js';
import type { VaultService } from '../vault/vault-service.js';
import type { ScanSchedule } from '../types.js';

const SCHEDULE_FILE = 'data-clean-schedules.json';

export class SchedulerManager {
  private schedules: ScanSchedule[] = [];
  private filePath: string;
  private vaultRef: VaultService | undefined;
  private intervalId?: NodeJS.Timeout;
  private running: Map<string, boolean> = new Map();

  constructor(vaultPath: string) {
    this.filePath = path.join(path.dirname(vaultPath), SCHEDULE_FILE);
  }

  async load(): Promise<void> {
    try {
      const data = await fs.readFile(this.filePath, 'utf-8');
      this.schedules = JSON.parse(data) as ScanSchedule[];
    } catch {
      this.schedules = [];
    }
  }

  async save(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(this.schedules, null, 2), 'utf-8');
  }

  getAll(): ScanSchedule[] {
    return [...this.schedules];
  }

  getById(id: string): ScanSchedule | undefined {
    return this.schedules.find(s => s.id === id);
  }

  async add(schedule: Omit<ScanSchedule, 'id'>): Promise<ScanSchedule> {
    const newSchedule: ScanSchedule = {
      ...schedule,
      id: 'sched_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    };
    this.schedules.push(newSchedule);
    await this.save();
    if (newSchedule.enabled) {
      this.startInterval(newSchedule.id);
    }
    return newSchedule;
  }

  async update(id: string, updates: Partial<Omit<ScanSchedule, 'id'>>): Promise<ScanSchedule | undefined> {
    const idx = this.schedules.findIndex(s => s.id === id);
    if (idx === -1) return undefined;

    const existing = this.schedules[idx];
    Object.assign(existing, updates);

    if (updates.enabled !== undefined && !existing.enabled!) {
      this.stopInterval(id);
    } else if (updates.enabled === true && !(this.running.get(id))) {
      this.startInterval(id);
    }

    await this.save();
    return existing;
  }

  async remove(id: string): Promise<boolean> {
    const idx = this.schedules.findIndex(s => s.id === id);
    if (idx === -1) return false;
    this.schedules.splice(idx, 1);
    this.stopInterval(id);
    await this.save();
    return true;
  }

  async runScan(id: string): Promise<ScanSchedule['lastResult'] | null> {
    const sched = this.getById(id);
    if (!sched || !this.vaultRef) return null;
    if (this.running.get(id)) {
      console.log('[SCHEDULER] Skip: already running for ' + id);
      return null;
    }

    this.running.set(id, true);
    try {
      const pages = await scanVault(this.vaultRef);
      const passed = pages.filter(p => p.qualityScore < 40).length === 0;
      const result = {
        passed,
        scannedFiles: pages.length,
        errors: pages.filter(p => p.issues.length > 0).length,
        warnings: pages.filter(p => p.qualityScore >= 40 && p.qualityScore < 80).length,
      };

      sched.lastRun = new Date().toISOString();
      sched.lastResult = result;
      await this.save();
      console.log('[SCHEDULER] Run ' + id + ': scanned ' + result.scannedFiles + ' files, passed=' + result.passed);
      return result;
    } catch (err) {
      console.error('[SCHEDULER] Run ' + id + ' failed:', err);
      return null;
    } finally {
      this.running.delete(id);
    }
  }

  private startInterval(id: string) {
    this.stopInterval(id);
    const sched = this.getById(id);
    if (!sched) return;

    let intervalMs = 6 * 60 * 60 * 1000; // default: 6 hours
    const cronMatch = sched.cron.match(/^every\s+(\d+)\s*(min|hour|day)s?$/i);
    if (cronMatch) {
      const value = parseInt(cronMatch[1]);
      const unit = cronMatch[2].toLowerCase();
      switch (unit) {
        case 'min': intervalMs = value * 60 * 1000; break;
        case 'hour': intervalMs = value * 60 * 60 * 1000; break;
        case 'day': intervalMs = value * 24 * 60 * 60 * 1000; break;
      }
    }

    this.intervalId = setInterval(() => {
      void this.runScan(id);
    }, intervalMs);
  }

  private stopInterval(id: string) {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }
}