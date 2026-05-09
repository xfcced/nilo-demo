import * as THREE from 'three'
import type { BoxSnapshot, PlayerSnapshot } from './net/protocol'

export class ArenaScene {
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

    this.camera = new THREE.PerspectiveCamera(48, 1, 0.1, 100)
    this.camera.position.set(8, 8, 10)
    this.camera.lookAt(0, 0, 0)

    this.buildArena()
    this.resize()

    window.addEventListener('resize', () => this.resize())
  }

  update(_deltaSeconds: number): void {
    // 当前 demo 的位置由服务端 state 驱动，这里先保留客户端场景更新入口。
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

  setPlayers(snapshots: PlayerSnapshot[]): void {
    const activePlayerIds = new Set<number>()

    for (const snapshot of snapshots) {
      activePlayerIds.add(snapshot.playerId)

      let player = this.players.get(snapshot.playerId)
      if (!player) {
        player = this.createPlayer(snapshot.playerId === this.localPlayerId)
        this.players.set(snapshot.playerId, player)
        this.scene.add(player)
      }

      player.position.set(snapshot.x, snapshot.y, snapshot.z)
      this.setPlayerMaterial(player, snapshot.playerId === this.localPlayerId)
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

  setBoxes(snapshots: BoxSnapshot[]): void {
    const activeBoxIds = new Set<number>()

    for (const snapshot of snapshots) {
      activeBoxIds.add(snapshot.boxId)

      let box = this.boxes.get(snapshot.boxId)
      if (!box) {
        box = this.createBox(snapshot.boxId)
        this.boxes.set(snapshot.boxId, box)
        this.scene.add(box)
      }

      box.position.set(snapshot.x, snapshot.y, snapshot.z)
      box.quaternion.set(snapshot.qx, snapshot.qy, snapshot.qz, snapshot.qw)
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

    const floor = new THREE.Mesh(new THREE.BoxGeometry(12, 0.24, 12), new THREE.MeshStandardMaterial({ color: 0xf7f9fb, roughness: 0.82 }))
    floor.position.y = -0.12
    this.scene.add(floor)

    this.addWall(0, 0.55, -6, 12.4, 1.1, 0.24)
    this.addWall(0, 0.55, 6, 12.4, 1.1, 0.24)
    this.addWall(-6, 0.55, 0, 0.24, 1.1, 12.4)
    this.addWall(6, 0.55, 0, 0.24, 1.1, 12.4)

    this.addGoalZone(3.8, 0.01, 3.8)
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
