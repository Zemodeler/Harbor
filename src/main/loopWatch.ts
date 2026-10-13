import { LoopDetector, type LoopEvent, type LoopLimits, type LoopVerdict } from './loopGuard';
import { PROBE_INTERVAL_MS, type ProgressProbe } from './progressProbe';

/** Injected loop-guard settings (ServiceOptions.stall.loopGuard): tests control the probe, the limits and the probe interval. */
export interface LoopGuardSettings {
  /** Default true. False turns the guard off entirely. */
  enabled?: boolean;
  /** Worktree fingerprint for edit helpers (default: progressProbe.gitProgressProbe over Harbor's Git). */
  probe?: ProgressProbe;
  limits?: Partial<LoopLimits>;
  probeIntervalMs?: number;
}

/**
 * One run's loop guard: the detector plus its probe timer. The probe runs in the background (never blocks the run), one at a time,
 * and its errors are swallowed (no information). `observe` is called for every chunk; `stop` when the run ends.
 */
export class LoopWatch {
  private readonly det: LoopDetector;
  private cancel: () => void = () => {};
  private probing = false;
  private stopped = false;

  constructor(private readonly o: {
    canEdit: boolean; probeCwd?: string; probe?: ProgressProbe; limits?: Partial<LoopLimits>; probeIntervalMs?: number;
    setTimer: (fn: () => void, ms: number) => () => void; now: () => number;
  }) {
    const probed = !!(o.probeCwd && o.probe);
    this.det = new LoopDetector({ canEdit: o.canEdit, probed, limits: o.limits, startedAt: o.now() });
    // The first probe waits one interval: a short run never spends git calls on the guard.
    if (probed) this.arm();
  }

  private arm(): void {
    this.cancel = this.o.setTimer(() => { if (this.stopped) return; void this.runProbe(); this.arm(); }, this.o.probeIntervalMs ?? PROBE_INTERVAL_MS);
  }

  private async runProbe(): Promise<void> {
    if (this.probing || this.stopped) return;
    this.probing = true;
    try {
      const fp = await this.o.probe!(this.o.probeCwd!).catch(() => undefined);
      if (!this.stopped) this.det.probe(fp, this.o.now());
    } finally { this.probing = false; }
  }

  observe(c: LoopEvent): LoopVerdict {
    return this.stopped ? { loop: false } : this.det.observe(c, this.o.now());
  }

  stop(): void { this.stopped = true; this.cancel(); }
}
