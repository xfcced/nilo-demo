import RAPIER, { init as initRapier, type RigidBody, type World } from '@dimforge/rapier3d-compat'
import { gameConfig } from '../config'
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
  lastAckedInputSeq: number
  predictionError: number
  correctionCount: number
}

type PendingInput = MovementInput & {
  seq: number
}

type PredictedState = {
  x: number
  y: number
  z: number
}

const IGNORE_ERROR_METERS = 0.02
const SNAP_ERROR_METERS = 0.5
const CORRECTION_DURATION_SECONDS = 0.1

let rapierReady: Promise<void> | null = null

export class LocalPlayerPredictor {
  private pendingInputs: PendingInput[] = []
  private world: World | null = null
  private playerBody: RigidBody | null = null
  private previousVisualState: PredictedState | null = null
  private currentVisualState: PredictedState | null = null
  private correctionOffsetX = 0
  private correctionOffsetY = 0
  private correctionOffsetZ = 0
  private lastAckedInputSeq = 0
  private predictionError = 0
  private correctionCount = 0
  private ready = false

  constructor() {
    rapierReady ??= initRapier()
    void rapierReady.then(() => {
      this.ready = true
    })
  }

  pushLocalInput(seq: number, input: MovementInput, deltaSeconds: number): void {
    this.pendingInputs.push({ seq, ...input })

    if (!this.playerBody || !this.world) {
      return
    }

    this.stepWorld(input, deltaSeconds)
    this.recordVisualState()
    this.decayCorrection(deltaSeconds)
  }

  reconcile(authoritative: PlayerSnapshot, lastProcessedInputSeq: number, deltaSeconds: number): void {
    this.lastAckedInputSeq = Math.max(this.lastAckedInputSeq, lastProcessedInputSeq)
    this.pendingInputs = this.pendingInputs.filter((input) => input.seq > this.lastAckedInputSeq)

    if (!this.ready) {
      return
    }

    if (!this.world || !this.playerBody) {
      this.createWorld(authoritative)
    }

    const previousRenderState = this.renderState()
    this.resetPlayerToAuthoritative(authoritative)

    for (const input of this.pendingInputs) {
      this.stepWorld(input, deltaSeconds)
    }

    const corrected = this.physicsState()
    this.predictionError = previousRenderState && corrected ? distance(previousRenderState, corrected) : 0

    if (this.predictionError < IGNORE_ERROR_METERS) {
      this.recordVisualState()
      return
    }

    this.correctionCount += 1
    this.resetVisualStateToCurrentPhysics()
    if (this.predictionError > SNAP_ERROR_METERS || !previousRenderState || !corrected) {
      this.correctionOffsetX = 0
      this.correctionOffsetY = 0
      this.correctionOffsetZ = 0
      return
    }

    this.correctionOffsetX = previousRenderState.x - corrected.x
    this.correctionOffsetY = previousRenderState.y - corrected.y
    this.correctionOffsetZ = previousRenderState.z - corrected.z
  }

  renderPlayer(playerId: number, alpha: number): RenderPlayer | null {
    const rendered = this.renderState(alpha)
    if (!rendered) {
      return null
    }

    return {
      playerId,
      isLocal: true,
      x: rendered.x,
      y: rendered.y,
      z: rendered.z,
    }
  }

  metrics(): PredictionMetrics {
    return {
      pendingInputCount: this.pendingInputs.length,
      lastAckedInputSeq: this.lastAckedInputSeq,
      predictionError: this.predictionError,
      correctionCount: this.correctionCount,
    }
  }

  reset(): void {
    this.pendingInputs = []
    this.world?.free()
    this.world = null
    this.playerBody = null
    this.previousVisualState = null
    this.currentVisualState = null
    this.correctionOffsetX = 0
    this.correctionOffsetY = 0
    this.correctionOffsetZ = 0
    this.lastAckedInputSeq = 0
    this.predictionError = 0
    this.correctionCount = 0
  }

  private createWorld(authoritative: PlayerSnapshot): void {
    this.world?.free()
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
    this.world.integrationParameters.dt = 1 / gameConfig.simulation.tickRate
    this.buildStaticArena()

    const body = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(authoritative.x, authoritative.y, authoritative.z)
      .setLinvel(authoritative.vx, authoritative.vy, authoritative.vz)
      .lockRotations()
      .setLinearDamping(2.5)
    this.playerBody = this.world.createRigidBody(body)
    const collider = RAPIER.ColliderDesc.ball(gameConfig.player.radius).setFriction(1.0).setRestitution(0.0)
    this.world.createCollider(collider, this.playerBody)
    this.recordVisualState()
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

  private stepWorld(input: MovementInput, deltaSeconds: number): void {
    if (!this.world || !this.playerBody) {
      return
    }

    this.world.integrationParameters.dt = deltaSeconds
    this.applyPlayerInput(input, deltaSeconds)
    this.world.step()
  }

  private applyPlayerInput(input: MovementInput, deltaSeconds: number): void {
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
    const maxDelta = (length > 0 ? acceleration : deceleration) * deltaSeconds
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

  private renderState(alpha = 1): PredictedState | null {
    const state = this.visualState(alpha) ?? this.physicsState()
    if (!state) {
      return null
    }

    return {
      x: state.x + this.correctionOffsetX,
      y: state.y + this.correctionOffsetY,
      z: state.z + this.correctionOffsetZ,
    }
  }

  private recordVisualState(): void {
    const state = this.physicsState()
    if (!state) {
      return
    }

    this.previousVisualState = this.currentVisualState ?? state
    this.currentVisualState = state
  }

  private resetVisualStateToCurrentPhysics(): void {
    const state = this.physicsState()
    if (!state) {
      return
    }

    this.previousVisualState = state
    this.currentVisualState = state
  }

  private visualState(alpha: number): PredictedState | null {
    if (!this.currentVisualState) {
      return null
    }

    if (!this.previousVisualState) {
      return this.currentVisualState
    }

    const t = Math.max(0, Math.min(1, alpha))
    return {
      x: lerp(this.previousVisualState.x, this.currentVisualState.x, t),
      y: lerp(this.previousVisualState.y, this.currentVisualState.y, t),
      z: lerp(this.previousVisualState.z, this.currentVisualState.z, t),
    }
  }

  private physicsState(): PredictedState | null {
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

  private decayCorrection(deltaSeconds: number): void {
    const alpha = Math.min(1, deltaSeconds / CORRECTION_DURATION_SECONDS)
    this.correctionOffsetX = moveToward(this.correctionOffsetX, 0, Math.abs(this.correctionOffsetX) * alpha)
    this.correctionOffsetY = moveToward(this.correctionOffsetY, 0, Math.abs(this.correctionOffsetY) * alpha)
    this.correctionOffsetZ = moveToward(this.correctionOffsetZ, 0, Math.abs(this.correctionOffsetZ) * alpha)
  }
}

function moveToward(current: number, target: number, maxDelta: number): number {
  const delta = target - current
  if (Math.abs(delta) <= maxDelta) {
    return target
  }

  return current + Math.sign(delta) * maxDelta
}

function lerp(from: number, to: number, alpha: number): number {
  return from + (to - from) * alpha
}

function distance(a: PredictedState, b: PredictedState): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}
