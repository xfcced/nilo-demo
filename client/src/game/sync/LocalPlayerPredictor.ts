import RAPIER, { init as initRapier, type RigidBody, type World } from '@dimforge/rapier3d-compat'
import { FIXED_STEP_SECONDS, gameConfig } from '../config'
import type { PlayerSnapshot } from '../net/protocol'
import type { RenderPlayer } from '../renderState'

export type MovementInput = {
  up: boolean
  down: boolean
  left: boolean
  right: boolean
}

export type PredictionMetrics = {
  pendingInputCount: number
  lastReceivedInputSeq: number
  predictionError: number
  correctionCount: number
}

type PredictedPosition = {
  x: number
  y: number
  z: number
}

export type LocalPredictionDebugState = {
  authoritative: PredictedPosition | null
  predictedPhysics: PredictedPosition | null
  renderedVisual: PredictedPosition | null
}

const IGNORE_ERROR_METERS = 0.02
const SNAP_ERROR_METERS = 0.5
const CORRECTION_DURATION_SECONDS = 0.1

let rapierReady: Promise<void> | null = null

export class LocalPlayerPredictor {
  private inputHistory = new Map<number, MovementInput>()
  private world: World | null = null
  private playerBody: RigidBody | null = null
  private correctionOffsetX = 0
  private correctionOffsetY = 0
  private correctionOffsetZ = 0
  private correctionElapsedSeconds = CORRECTION_DURATION_SECONDS
  private lastAuthoritativePosition: PredictedPosition | null = null
  private lastRenderedPosition: PredictedPosition | null = null
  private lastAuthoritativeTick = 0
  private lastReceivedInputSeq = 0
  private localPredictionTick = 0
  private predictionError = 0
  private correctionCount = 0
  private ready = false

  constructor() {
    rapierReady ??= initRapier()
    void rapierReady.then(() => {
      this.ready = true
    })
  }

  // Stores local input and immediately predicts one local physics step.
  pushLocalInput(tick: number, input: MovementInput): void {
    this.localPredictionTick = Math.max(this.localPredictionTick, tick)
    this.inputHistory.set(tick, { ...input })

    if (!this.playerBody || !this.world) {
      return
    }

    this.stepWorld(input)
  }

  // Replays only the inputs newer than the latest server-authoritative tick.
  reconcile(authoritative: PlayerSnapshot, authoritativeTick: number, lastReceivedInputSeq: number): void {
    this.lastAuthoritativePosition = {
      x: authoritative.x,
      y: authoritative.y,
      z: authoritative.z,
    }
    this.lastAuthoritativeTick = Math.max(this.lastAuthoritativeTick, authoritativeTick)
    this.lastReceivedInputSeq = Math.max(this.lastReceivedInputSeq, lastReceivedInputSeq)
    this.trimInputHistory(authoritativeTick)

    if (!this.ready) {
      return
    }

    if (!this.world || !this.playerBody) {
      this.createWorld(authoritative)
    }

    const previousRenderedPosition = this.lastRenderedPosition ?? this.renderPosition(0)
    const previousPredictedPosition = this.physicsPosition()
    this.resetPlayerToAuthoritative(authoritative)

    for (let tick = authoritativeTick + 1; tick <= this.localPredictionTick; tick += 1) {
      const input = this.inputHistory.get(tick)
      if (!input) {
        continue
      }
      this.stepWorld(input)
    }

    const corrected = this.physicsPosition()
    this.predictionError = previousPredictedPosition && corrected ? distance(previousPredictedPosition, corrected) : 0

    if (this.predictionError < IGNORE_ERROR_METERS) {
      return
    }

    this.correctionCount += 1
    if (this.predictionError > SNAP_ERROR_METERS || !previousRenderedPosition || !corrected) {
      this.correctionOffsetX = 0
      this.correctionOffsetY = 0
      this.correctionOffsetZ = 0
      this.correctionElapsedSeconds = CORRECTION_DURATION_SECONDS
      return
    }

    this.correctionOffsetX = previousRenderedPosition.x - corrected.x
    this.correctionOffsetY = previousRenderedPosition.y - corrected.y
    this.correctionOffsetZ = previousRenderedPosition.z - corrected.z
    this.correctionElapsedSeconds = 0
  }

  // Returns the predicted local player state for rendering.
  renderPlayer(playerId: number, fixedStepAlpha: number, renderDeltaSeconds: number): RenderPlayer | null {
    this.decayCorrection(renderDeltaSeconds)

    const rendered = this.renderPosition(fixedStepAlpha)
    if (!rendered) {
      return null
    }

    this.lastRenderedPosition = rendered
    return {
      playerId,
      isLocal: true,
      x: rendered.x,
      y: rendered.y,
      z: rendered.z,
    }
  }

  // Exposes prediction state for the debug panel.
  metrics(): PredictionMetrics {
    return {
      pendingInputCount: Math.max(0, this.localPredictionTick - this.lastAuthoritativeTick),
      lastReceivedInputSeq: this.lastReceivedInputSeq,
      predictionError: this.predictionError,
      correctionCount: this.correctionCount,
    }
  }

  debugState(): LocalPredictionDebugState {
    return {
      authoritative: this.lastAuthoritativePosition,
      predictedPhysics: this.physicsPosition(),
      renderedVisual: this.lastRenderedPosition,
    }
  }

  // Clears local prediction state when the session ends.
  reset(): void {
    this.inputHistory.clear()
    this.world?.free()
    this.world = null
    this.playerBody = null
    this.correctionOffsetX = 0
    this.correctionOffsetY = 0
    this.correctionOffsetZ = 0
    this.correctionElapsedSeconds = CORRECTION_DURATION_SECONDS
    this.lastAuthoritativePosition = null
    this.lastRenderedPosition = null
    this.lastAuthoritativeTick = 0
    this.lastReceivedInputSeq = 0
    this.localPredictionTick = 0
    this.predictionError = 0
    this.correctionCount = 0
  }

  private trimInputHistory(authoritativeTick: number): void {
    for (const tick of this.inputHistory.keys()) {
      if (tick <= authoritativeTick) {
        this.inputHistory.delete(tick)
      }
    }
  }

  private createWorld(authoritative: PlayerSnapshot): void {
    this.world?.free()
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
    this.world.integrationParameters.dt = FIXED_STEP_SECONDS
    this.buildStaticArena()

    const body = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(authoritative.x, authoritative.y, authoritative.z)
      .setLinvel(authoritative.vx, authoritative.vy, authoritative.vz)
      .lockRotations()
      .setLinearDamping(2.5)
    this.playerBody = this.world.createRigidBody(body)
    const collider = RAPIER.ColliderDesc.ball(gameConfig.player.radius).setFriction(1.0).setRestitution(0.0)
    this.world.createCollider(collider, this.playerBody)
  }

  private buildStaticArena(): void {
    if (!this.world) {
      return
    }

    const arenaHalfSize = gameConfig.arena.halfSize
    const wallHeight = gameConfig.arena.wallHeight
    const wallThickness = gameConfig.arena.wallThickness
    const floorHalfThickness = gameConfig.arena.floorThickness / 2

    this.addFixedCuboid(0, -floorHalfThickness, 0, arenaHalfSize, floorHalfThickness, arenaHalfSize)
    this.addFixedCuboid(0, wallHeight / 2, -arenaHalfSize, arenaHalfSize + wallThickness, wallHeight / 2, wallThickness / 2)
    this.addFixedCuboid(0, wallHeight / 2, arenaHalfSize, arenaHalfSize + wallThickness, wallHeight / 2, wallThickness / 2)
    this.addFixedCuboid(-arenaHalfSize, wallHeight / 2, 0, wallThickness / 2, wallHeight / 2, arenaHalfSize + wallThickness)
    this.addFixedCuboid(arenaHalfSize, wallHeight / 2, 0, wallThickness / 2, wallHeight / 2, arenaHalfSize + wallThickness)
  }

  private addFixedCuboid(x: number, y: number, z: number, hx: number, hy: number, hz: number): void {
    this.world?.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z).setFriction(1.0))
  }

  private resetPlayerToAuthoritative(authoritative: PlayerSnapshot): void {
    if (!this.playerBody) {
      return
    }

    this.playerBody.setTranslation({ x: authoritative.x, y: authoritative.y, z: authoritative.z }, true)
    this.playerBody.setLinvel({ x: authoritative.vx, y: authoritative.vy, z: authoritative.vz }, true)
    this.playerBody.setAngvel({ x: 0, y: 0, z: 0 }, true)
  }

  private stepWorld(input: MovementInput): void {
    if (!this.world || !this.playerBody) {
      return
    }

    this.world.integrationParameters.dt = FIXED_STEP_SECONDS
    this.applyPlayerInput(input)
    this.world.step()
  }

  private applyPlayerInput(input: MovementInput): void {
    if (!this.playerBody) {
      return
    }

    let dx = 0
    let dz = 0

    if (input.left) {
      dx -= 1
    }
    if (input.right) {
      dx += 1
    }
    if (input.up) {
      dz -= 1
    }
    if (input.down) {
      dz += 1
    }

    const length = Math.hypot(dx, dz)
    if (length > 0) {
      dx /= length
      dz /= length
    }

    const { maxSpeed, acceleration, deceleration } = gameConfig.player
    const maxDelta = (length > 0 ? acceleration : deceleration) * FIXED_STEP_SECONDS
    const velocity = this.playerBody.linvel()
    this.playerBody.setLinvel(
      {
        x: moveToward(velocity.x, dx * maxSpeed, maxDelta),
        y: velocity.y,
        z: moveToward(velocity.z, dz * maxSpeed, maxDelta),
      },
      true,
    )
  }

  private decayCorrection(renderDeltaSeconds: number): void {
    if (this.correctionElapsedSeconds >= CORRECTION_DURATION_SECONDS) {
      return
    }

    const previousProgress = this.correctionElapsedSeconds / CORRECTION_DURATION_SECONDS
    this.correctionElapsedSeconds = Math.min(CORRECTION_DURATION_SECONDS, this.correctionElapsedSeconds + renderDeltaSeconds)
    const currentProgress = this.correctionElapsedSeconds / CORRECTION_DURATION_SECONDS
    const previousRemaining = 1 - previousProgress
    const currentRemaining = 1 - currentProgress

    if (currentRemaining <= 0 || previousRemaining <= 0) {
      this.correctionOffsetX = 0
      this.correctionOffsetY = 0
      this.correctionOffsetZ = 0
      return
    }

    const scale = currentRemaining / previousRemaining
    this.correctionOffsetX *= scale
    this.correctionOffsetY *= scale
    this.correctionOffsetZ *= scale
  }

  private renderPosition(fixedStepAlpha = 0): PredictedPosition | null {
    const state = this.extrapolatedPhysicsPosition(fixedStepAlpha)
    if (!state) {
      return null
    }

    return {
      x: state.x + this.correctionOffsetX,
      y: state.y + this.correctionOffsetY,
      z: state.z + this.correctionOffsetZ,
    }
  }

  private extrapolatedPhysicsPosition(fixedStepAlpha: number): PredictedPosition | null {
    const position = this.physicsPosition()
    const velocity = this.playerBody?.linvel()
    if (!position || !velocity) {
      return position
    }

    const clampedFixedStepAlpha = Math.max(0, Math.min(1, fixedStepAlpha))
    const frameLeadSeconds = clampedFixedStepAlpha * FIXED_STEP_SECONDS
    return {
      x: position.x + velocity.x * frameLeadSeconds,
      y: position.y + velocity.y * frameLeadSeconds,
      z: position.z + velocity.z * frameLeadSeconds,
    }
  }

  private physicsPosition(): PredictedPosition | null {
    const position = this.playerBody?.translation()
    if (!position) {
      return null
    }

    return {
      x: position.x,
      y: position.y,
      z: position.z,
    }
  }
}

function moveToward(current: number, target: number, maxDelta: number): number {
  const delta = target - current
  if (Math.abs(delta) <= maxDelta) {
    return target
  }

  return current + Math.sign(delta) * maxDelta
}

function distance(a: PredictedPosition, b: PredictedPosition): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}
