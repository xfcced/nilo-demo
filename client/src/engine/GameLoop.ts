type GameLoopOptions = {
  fixedStepMs: number
  maxFrameMs: number
  fixedUpdate: () => void
  drawFrame: (renderDeltaMs: number, fixedStepAlpha: number) => void
}

export class GameLoop {
  private accumulatorMs = 0
  private previousFrameTime = performance.now()

  constructor(private options: GameLoopOptions) {}

  start(): void {
    window.requestAnimationFrame((now) => this.frame(now))
  }

  private frame(now: number): void {
    const renderDeltaMs = Math.min(now - this.previousFrameTime, this.options.maxFrameMs)
    this.previousFrameTime = now
    this.accumulatorMs += renderDeltaMs

    while (this.accumulatorMs >= this.options.fixedStepMs) {
      this.options.fixedUpdate()
      this.accumulatorMs -= this.options.fixedStepMs
    }

    this.options.drawFrame(renderDeltaMs, this.accumulatorMs / this.options.fixedStepMs)
    window.requestAnimationFrame((nextNow) => this.frame(nextNow))
  }
}
