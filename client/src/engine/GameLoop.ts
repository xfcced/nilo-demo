type GameLoopOptions = {
  fixedStepMs: number
  maxFrameMs: number
  update: (deltaMs: number) => void
  drawFrame: (frameMs: number, alpha: number) => void
}

export class GameLoop {
  private accumulatorMs = 0
  private previousFrameTime = performance.now()

  constructor(private options: GameLoopOptions) {}

  start(): void {
    window.requestAnimationFrame((now) => this.frame(now))
  }

  private frame(now: number): void {
    const frameMs = Math.min(now - this.previousFrameTime, this.options.maxFrameMs)
    this.previousFrameTime = now
    this.accumulatorMs += frameMs

    while (this.accumulatorMs >= this.options.fixedStepMs) {
      this.options.update(this.options.fixedStepMs)
      this.accumulatorMs -= this.options.fixedStepMs
    }

    this.options.drawFrame(frameMs, this.accumulatorMs / this.options.fixedStepMs)
    window.requestAnimationFrame((nextNow) => this.frame(nextNow))
  }
}
