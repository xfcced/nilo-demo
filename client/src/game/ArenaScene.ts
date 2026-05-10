import * as THREE from 'three'
import type { RenderBox, RenderPlayer, RenderWorldState } from './renderState'

export class ArenaScene {
  private static readonly ARENA_HALF_SIZE = 12
  private renderer: THREE.WebGLRenderer
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera
  private players = new Map<number, THREE.Mesh>()
  private boxes = new Map<number, THREE.Mesh>()
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

  update(_deltaSeconds: number): void {
    // Scene animation hooks belong here; network interpolation is handled outside this renderer.
  }

  render(): void {
    this.renderer.render(this.scene, this.camera)
  }

  dispose(): void {
    this.clearPlayers()
    this.clearBoxes()
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

  private buildArena(): void {
    const ambientLight = new THREE.HemisphereLight(0xffffff, 0x7c8790, 2.8)
    this.scene.add(ambientLight)

    const keyLight = new THREE.DirectionalLight(0xffffff, 2.4)
    keyLight.position.set(6, 10, 8)
    this.scene.add(keyLight)

    const arenaSize = ArenaScene.ARENA_HALF_SIZE * 2
    const wallSpan = arenaSize + 0.4

    const floor = new THREE.Mesh(new THREE.BoxGeometry(arenaSize, 0.24, arenaSize), new THREE.MeshStandardMaterial({ color: 0xf7f9fb, roughness: 0.82 }))
    floor.position.y = -0.12
    this.scene.add(floor)

    this.addWall(0, 0.55, -ArenaScene.ARENA_HALF_SIZE, wallSpan, 1.1, 0.24)
    this.addWall(0, 0.55, ArenaScene.ARENA_HALF_SIZE, wallSpan, 1.1, 0.24)
    this.addWall(-ArenaScene.ARENA_HALF_SIZE, 0.55, 0, 0.24, 1.1, wallSpan)
    this.addWall(ArenaScene.ARENA_HALF_SIZE, 0.55, 0, 0.24, 1.1, wallSpan)

    this.addGoalZone(8.5, 0.01, 8.5)
  }

  private addWall(x: number, y: number, z: number, width: number, height: number, depth: number): void {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), new THREE.MeshStandardMaterial({ color: 0x485763, roughness: 0.75 }))
    wall.position.set(x, y, z)
    this.scene.add(wall)
  }

  private addGoalZone(x: number, y: number, z: number): void {
    const zone = new THREE.Mesh(new THREE.CylinderGeometry(1.25, 1.25, 0.04, 48), new THREE.MeshStandardMaterial({ color: 0x2f83cc, transparent: true, opacity: 0.46 }))
    zone.position.set(x, y, z)
    this.scene.add(zone)
  }

  private createPlayer(isLocal: boolean): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.42, 32, 24), new THREE.MeshStandardMaterial({ color: isLocal ? 0x2f6fda : 0xb55f4d, roughness: 0.55 }))
    return mesh
  }

  private createBox(boxId: number): THREE.Mesh {
    const colors = [0xb55f4d, 0xd8a640, 0x4a8b74]
    return new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 0.9, 0.9),
      new THREE.MeshStandardMaterial({
        color: colors[(boxId - 1) % colors.length],
        roughness: 0.7,
        metalness: 0.02,
      }),
    )
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
