import * as THREE from 'three'
import { gameConfig } from './config'
import type { LocalPredictionDebugState } from './sync/LocalPlayerPredictor'
import type { RenderBox, RenderPlayer, RenderWorldState } from './renderState'

type DebugMarkerName = keyof LocalPredictionDebugState

export class ArenaScene {
  private renderer: THREE.WebGLRenderer
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera
  private players = new Map<number, THREE.Mesh>()
  private boxes = new Map<number, THREE.Mesh>()
  private predictionDebugMarkers = new Map<DebugMarkerName, THREE.Mesh>()
  private predictionDebugLine: THREE.Line | null = null
  private localPlayerId: number | null = null

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setClearColor(0xe9eef2)

    this.scene = new THREE.Scene()
    this.scene.fog = new THREE.Fog(0xe9eef2, 24, 46)

    this.camera = new THREE.PerspectiveCamera(48, 1, 0.1, 120)
    this.camera.position.set(15, 16, 18)
    this.camera.lookAt(0, 0, 0)

    this.buildArena()
    this.resize()

    window.addEventListener('resize', () => this.resize())
  }

  render(): void {
    this.renderer.render(this.scene, this.camera)
  }

  dispose(): void {
    this.clearPlayers()
    this.clearBoxes()
    this.clearLocalPredictionDebug()
    this.renderer.dispose()
  }

  setLocalPlayerId(playerId: number | null): void {
    this.localPlayerId = playerId
    for (const [id, player] of this.players) {
      this.setPlayerMaterial(player, id === this.localPlayerId)
    }
  }

  applyRenderState(state: RenderWorldState): void {
    this.setPlayers(state.players)
    this.setBoxes(state.boxes)
  }

  setLocalPredictionDebug(state: LocalPredictionDebugState | null): void {
    if (!state) {
      this.clearLocalPredictionDebug()
      return
    }

    const markerColors: Record<DebugMarkerName, number> = {
      authoritative: 0xff3b30,
      predictedPhysics: 0xffcc00,
      renderedVisual: 0x00c7d9,
    }

    const markerOrder: DebugMarkerName[] = ['authoritative', 'predictedPhysics', 'renderedVisual']
    const linePoints: THREE.Vector3[] = []

    for (const markerName of markerOrder) {
      const position = state[markerName]
      if (!position) {
        this.removePredictionDebugMarker(markerName)
        continue
      }

      let marker = this.predictionDebugMarkers.get(markerName)
      if (!marker) {
        marker = this.createPredictionDebugMarker(markerColors[markerName])
        this.predictionDebugMarkers.set(markerName, marker)
        this.scene.add(marker)
      }

      marker.position.set(position.x, position.y, position.z)
      linePoints.push(new THREE.Vector3(position.x, position.y, position.z))
    }

    this.setPredictionDebugLine(linePoints)
  }

  private setPlayers(players: RenderPlayer[]): void {
    const activePlayerIds = new Set<number>()

    for (const playerState of players) {
      activePlayerIds.add(playerState.playerId)

      let player = this.players.get(playerState.playerId)
      if (!player) {
        player = this.createPlayer(playerState.isLocal)
        this.players.set(playerState.playerId, player)
        this.scene.add(player)
      }

      player.position.set(playerState.x, playerState.y, playerState.z)
      this.setPlayerMaterial(player, playerState.isLocal)
    }

    for (const [playerId, player] of this.players) {
      if (!activePlayerIds.has(playerId)) {
        this.scene.remove(player)
        this.disposePlayer(player)
        this.players.delete(playerId)
      }
    }
  }

  clearPlayers(): void {
    for (const player of this.players.values()) {
      this.scene.remove(player)
      this.disposePlayer(player)
    }
    this.players.clear()
  }

  private setBoxes(boxes: RenderBox[]): void {
    const activeBoxIds = new Set<number>()

    for (const boxState of boxes) {
      activeBoxIds.add(boxState.boxId)

      let box = this.boxes.get(boxState.boxId)
      if (!box) {
        box = this.createBox(boxState.boxId)
        this.boxes.set(boxState.boxId, box)
        this.scene.add(box)
      }

      box.position.set(boxState.x, boxState.y, boxState.z)
      box.quaternion.set(boxState.qx, boxState.qy, boxState.qz, boxState.qw)
    }

    for (const [boxId, box] of this.boxes) {
      if (!activeBoxIds.has(boxId)) {
        this.scene.remove(box)
        this.disposeMesh(box)
        this.boxes.delete(boxId)
      }
    }
  }

  clearBoxes(): void {
    for (const box of this.boxes.values()) {
      this.scene.remove(box)
      this.disposeMesh(box)
    }
    this.boxes.clear()
  }

  clearLocalPredictionDebug(): void {
    for (const marker of this.predictionDebugMarkers.values()) {
      this.scene.remove(marker)
      this.disposeMesh(marker)
    }
    this.predictionDebugMarkers.clear()

    if (this.predictionDebugLine) {
      this.scene.remove(this.predictionDebugLine)
      this.predictionDebugLine.geometry.dispose()
      const material = this.predictionDebugLine.material
      if (Array.isArray(material)) {
        material.forEach((entry) => entry.dispose())
      } else {
        material.dispose()
      }
      this.predictionDebugLine = null
    }
  }

  private buildArena(): void {
    const ambientLight = new THREE.HemisphereLight(0xffffff, 0x7c8790, 2.8)
    this.scene.add(ambientLight)

    const keyLight = new THREE.DirectionalLight(0xffffff, 2.4)
    keyLight.position.set(6, 10, 8)
    this.scene.add(keyLight)

    const { arena } = gameConfig
    const arenaSize = arena.halfSize * 2
    const wallSpan = arenaSize + arena.wallThickness * 2
    const floorHalfThickness = arena.floorThickness / 2

    const floor = new THREE.Mesh(new THREE.BoxGeometry(arenaSize, arena.floorThickness, arenaSize), new THREE.MeshStandardMaterial({ color: 0xf7f9fb, roughness: 0.82 }))
    floor.position.y = -floorHalfThickness
    this.scene.add(floor)

    this.addWall(0, arena.wallHeight / 2, -arena.halfSize, wallSpan, arena.wallHeight, arena.wallThickness)
    this.addWall(0, arena.wallHeight / 2, arena.halfSize, wallSpan, arena.wallHeight, arena.wallThickness)
    this.addWall(-arena.halfSize, arena.wallHeight / 2, 0, arena.wallThickness, arena.wallHeight, wallSpan)
    this.addWall(arena.halfSize, arena.wallHeight / 2, 0, arena.wallThickness, arena.wallHeight, wallSpan)

    this.addGoalZone(arena.goalZone.x, arena.goalZone.y, arena.goalZone.z)
  }

  private addWall(x: number, y: number, z: number, width: number, height: number, depth: number): void {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), new THREE.MeshStandardMaterial({ color: 0x485763, roughness: 0.75 }))
    wall.position.set(x, y, z)
    this.scene.add(wall)
  }

  private addGoalZone(x: number, y: number, z: number): void {
    const { radius, height } = gameConfig.arena.goalZone
    const zone = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, 48), new THREE.MeshStandardMaterial({ color: 0x2f83cc, transparent: true, opacity: 0.46 }))
    zone.position.set(x, y, z)
    this.scene.add(zone)
  }

  private createPlayer(isLocal: boolean): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(gameConfig.player.radius, 32, 24), new THREE.MeshStandardMaterial({ color: isLocal ? 0x2f6fda : 0xb55f4d, roughness: 0.55 }))
    return mesh
  }

  private createBox(boxId: number): THREE.Mesh {
    const colors = [0xb55f4d, 0xd8a640, 0x4a8b74]
    return new THREE.Mesh(
      new THREE.BoxGeometry(gameConfig.boxes.halfExtent * 2, gameConfig.boxes.halfExtent * 2, gameConfig.boxes.halfExtent * 2),
      new THREE.MeshStandardMaterial({
        color: colors[(boxId - 1) % colors.length],
        roughness: 0.7,
        metalness: 0.02,
      }),
    )
  }

  private createPredictionDebugMarker(color: number): THREE.Mesh {
    return new THREE.Mesh(
      new THREE.SphereGeometry(gameConfig.player.radius * 1.12, 16, 12),
      new THREE.MeshBasicMaterial({
        color,
        wireframe: true,
        depthTest: false,
      }),
    )
  }

  private removePredictionDebugMarker(markerName: DebugMarkerName): void {
    const marker = this.predictionDebugMarkers.get(markerName)
    if (!marker) {
      return
    }

    this.scene.remove(marker)
    this.disposeMesh(marker)
    this.predictionDebugMarkers.delete(markerName)
  }

  private setPredictionDebugLine(points: THREE.Vector3[]): void {
    if (points.length < 2) {
      if (this.predictionDebugLine) {
        this.scene.remove(this.predictionDebugLine)
        this.predictionDebugLine.geometry.dispose()
        const material = this.predictionDebugLine.material
        if (Array.isArray(material)) {
          material.forEach((entry) => entry.dispose())
        } else {
          material.dispose()
        }
        this.predictionDebugLine = null
      }
      return
    }

    const geometry = new THREE.BufferGeometry().setFromPoints(points)
    if (!this.predictionDebugLine) {
      this.predictionDebugLine = new THREE.Line(
        geometry,
        new THREE.LineBasicMaterial({
          color: 0x111111,
          depthTest: false,
          transparent: true,
          opacity: 0.72,
        }),
      )
      this.scene.add(this.predictionDebugLine)
      return
    }

    this.predictionDebugLine.geometry.dispose()
    this.predictionDebugLine.geometry = geometry
  }

  private setPlayerMaterial(player: THREE.Mesh, isLocal: boolean): void {
    const material = player.material
    if (material instanceof THREE.MeshStandardMaterial) {
      material.color.setHex(isLocal ? 0x2f6fda : 0xb55f4d)
    }
  }

  private disposePlayer(player: THREE.Mesh): void {
    this.disposeMesh(player)
  }

  private disposeMesh(mesh: THREE.Mesh): void {
    mesh.geometry.dispose()
    if (Array.isArray(mesh.material)) {
      mesh.material.forEach((material) => material.dispose())
    } else {
      mesh.material.dispose()
    }
  }

  private resize(): void {
    const width = window.innerWidth
    const height = window.innerHeight
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
  }
}
