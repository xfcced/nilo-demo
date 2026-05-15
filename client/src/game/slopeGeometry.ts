import * as THREE from 'three'
import RAPIER, { type World } from '@dimforge/rapier3d-compat'
import { gameConfig } from './config'

export type SlopeConfig = typeof gameConfig.slope

export type SlopeWallSide = 'left' | 'right'

export function eulerToQuaternion(rotationX: number, rotationY: number, rotationZ: number): THREE.Quaternion {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(rotationX, rotationY, rotationZ, 'XYZ'))
}

export function slopeRotation(slope: SlopeConfig = gameConfig.slope): THREE.Quaternion {
  return eulerToQuaternion(slope.rotationX, slope.rotationY, slope.rotationZ)
}

/** World-space center for a side wall cuboid flush with the slope edge, sharing slope tilt. */
export function sideWallWorldCenter(slope: SlopeConfig, side: SlopeWallSide): THREE.Vector3 {
  const wallHalfThickness = slope.sideWallThickness / 2
  const localOffsetX =
    side === 'left' ? -(slope.halfX + wallHalfThickness) : slope.halfX + wallHalfThickness
  const localOffset = new THREE.Vector3(localOffsetX, 0, 0)
  localOffset.applyQuaternion(slopeRotation(slope))
  return new THREE.Vector3(slope.centerX, slope.centerY, slope.centerZ).add(localOffset)
}

export function sideWallHalfExtents(slope: SlopeConfig): { hx: number; hy: number; hz: number } {
  return {
    hx: slope.sideWallThickness / 2,
    hy: slope.sideWallHeight / 2,
    hz: slope.halfZ + 0.2,
  }
}

export function addSlopeColliders(world: World, slope: SlopeConfig = gameConfig.slope): void {
  const rotation = slopeRotation(slope)
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(slope.halfX, slope.halfY, slope.halfZ)
      .setTranslation(slope.centerX, slope.centerY, slope.centerZ)
      .setRotation(rotation)
      .setFriction(slope.friction ?? 1),
  )

  const { hx, hy, hz } = sideWallHalfExtents(slope)
  for (const side of ['left', 'right'] as const) {
    const center = sideWallWorldCenter(slope, side)
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, hy, hz)
        .setTranslation(center.x, center.y, center.z)
        .setRotation(rotation)
        .setFriction(1),
    )
  }
}

export function createSlopeMesh(slope: SlopeConfig, material: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(slope.halfX * 2, slope.halfY * 2, slope.halfZ * 2),
    material,
  )
  mesh.position.set(slope.centerX, slope.centerY, slope.centerZ)
  mesh.quaternion.copy(slopeRotation(slope))
  return mesh
}

export function createSideWallMesh(slope: SlopeConfig, side: SlopeWallSide, material: THREE.Material): THREE.Mesh {
  const { hx, hy, hz } = sideWallHalfExtents(slope)
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2), material)
  const center = sideWallWorldCenter(slope, side)
  mesh.position.copy(center)
  mesh.quaternion.copy(slopeRotation(slope))
  return mesh
}

export function buildSideWallMeshes(slope: SlopeConfig, material: THREE.Material): THREE.Mesh[] {
  return [createSideWallMesh(slope, 'left', material), createSideWallMesh(slope, 'right', material)]
}

/** World position on the slope top surface (local +Y face), with optional clearance above the surface. */
export function slopeSurfaceWorldPosition(
  slope: SlopeConfig,
  localX: number,
  localZ: number,
  clearanceAboveSurface: number,
): THREE.Vector3 {
  const localPoint = new THREE.Vector3(localX, slope.halfY + clearanceAboveSurface, localZ)
  localPoint.applyQuaternion(slopeRotation(slope))
  return new THREE.Vector3(slope.centerX, slope.centerY, slope.centerZ).add(localPoint)
}

export function boxLaunchLocalZ(slope: SlopeConfig, row: number, rowSpacing: number): number {
  return slope.halfZ - slope.launchLocalZInset - row * rowSpacing
}
