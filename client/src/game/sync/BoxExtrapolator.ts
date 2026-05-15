import * as THREE from 'three'
import { gameConfig } from '../config'
import type { BoxSnapshot, ServerMessage } from '../net/protocol'
import type { RenderBox } from '../renderState'

const SERVER_TICK_MS = 1000 / gameConfig.simulation.tickRate
const MAX_EXTRAPOLATION_SECONDS = 0.15
const MIN_ANGULAR_SPEED = 0.0001

type StateMessage = Extract<ServerMessage, { type: 'state' }>

type BoxState = BoxSnapshot & {
  serverTick: number
}

export class BoxExtrapolator {
  private latestBoxStates = new Map<number, BoxState>()
  private latestServerTick = 0
  private latestSnapshotReceivedAtMs = 0

  pushSnapshot(snapshot: StateMessage, receivedAtMs: number): void {
    if (snapshot.serverTick < this.latestServerTick) {
      return
    }

    this.latestServerTick = snapshot.serverTick
    this.latestSnapshotReceivedAtMs = receivedAtMs

    for (const box of snapshot.boxes) {
      this.latestBoxStates.set(box.boxId, { ...box, serverTick: snapshot.serverTick })
    }
  }

  sample(nowMs: number): RenderBox[] {
    if (this.latestServerTick <= 0) {
      return []
    }

    const elapsedSinceLatestSnapshotTicks = (nowMs - this.latestSnapshotReceivedAtMs) / SERVER_TICK_MS
    const extrapolatedBoxes: RenderBox[] = []

    for (const box of this.latestBoxStates.values()) {
      const elapsedTicks = this.latestServerTick + elapsedSinceLatestSnapshotTicks - box.serverTick
      const deltaSeconds = Math.min(MAX_EXTRAPOLATION_SECONDS, Math.max(0, elapsedTicks / gameConfig.simulation.tickRate))
      const rotation = extrapolateRotation(box, deltaSeconds)

      extrapolatedBoxes.push({
        boxId: box.boxId,
        x: box.x + box.vx * deltaSeconds,
        y: box.y + box.vy * deltaSeconds,
        z: box.z + box.vz * deltaSeconds,
        qx: rotation.x,
        qy: rotation.y,
        qz: rotation.z,
        qw: rotation.w,
      })
    }

    return extrapolatedBoxes
  }

  reset(): void {
    this.latestBoxStates.clear()
    this.latestServerTick = 0
    this.latestSnapshotReceivedAtMs = 0
  }
}

function extrapolateRotation(box: BoxState, deltaSeconds: number): THREE.Quaternion {
  const rotation = new THREE.Quaternion(box.qx, box.qy, box.qz, box.qw).normalize()
  const angularSpeed = Math.hypot(box.wx, box.wy, box.wz)

  if (angularSpeed < MIN_ANGULAR_SPEED || deltaSeconds <= 0) {
    return rotation
  }

  const axis = new THREE.Vector3(box.wx / angularSpeed, box.wy / angularSpeed, box.wz / angularSpeed)
  const deltaRotation = new THREE.Quaternion().setFromAxisAngle(axis, angularSpeed * deltaSeconds)
  return rotation.premultiply(deltaRotation).normalize()
}
