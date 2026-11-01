export class OperationTiming {
  private readonly startedAt: number;
  private stageStartedAt: number;
  private label = "";
  private readonly durations = new Map<string, number>();
  private readonly counts = new Map<string, number>();

  files(label: string, count: number): void { this.counts.set(label, count); }

  constructor(private readonly clock: () => number = () => typeof performance === "undefined" ? Date.now() : performance.now()) {
    this.startedAt = this.stageStartedAt = this.clock();
  }

  get currentStage(): string { return this.label || "准备"; }

  stage(label: string): void {
    const now = this.clock();
    if (this.label) this.durations.set(this.label,
      (this.durations.get(this.label) ?? 0) + Math.max(0, now - this.stageStartedAt));
    this.label = label;
    this.stageStartedAt = now;
  }

  summary(): string {
    const now = this.clock();
    const durations = new Map(this.durations);
    if (this.label) durations.set(this.label,
      (durations.get(this.label) ?? 0) + Math.max(0, now - this.stageStartedAt));
    const seconds = (milliseconds: number): string => `${(milliseconds / 1000).toFixed(2)} 秒`;
    return [`总耗时 ${seconds(Math.max(0, now - this.startedAt))}`,
      ...[...durations].map(([label, milliseconds]) => `${label}：${this.counts.has(label) ? `${this.counts.get(label)} 个文件 · ` : ""}${seconds(milliseconds)}`)].join("\n");
  }
}
