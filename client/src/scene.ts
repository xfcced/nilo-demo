import * as THREE from 'three'

export class ArenaScene {
  private renderer: THREE.WebGLRenderer
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera
  private player: THREE.Mesh
  private animationFrame = 0

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setClearColor(0xe9eef2)

    this.scene = new THREE.Scene()
    this.scene.fog = new THREE.Fog(0xe9eef2, 24, 46)

    this.camera = new THREE.PerspectiveCamera(48, 1, 0.1, 100)
    this.camera.position.set(8, 8, 10)
    this.camera.lookAt(0, 0, 0)

    this.player = this.createPlayer()
    this.buildArena()
    this.resize()

    window.addEventListener('resize', () => this.resize())
  }

  start(): void {
    const animate = () => {
      this.animationFrame = window.requestAnimationFrame(animate)
      this.player.rotation.y += 0.01
      this.renderer.render(this.scene, this.camera)
    }

    animate()
  }

  dispose(): void {
    window.cancelAnimationFrame(this.animationFrame)
    this.renderer.dispose()
  }

  private buildArena(): void {
    const ambientLight = new THREE.HemisphereLight(0xffffff, 0x7c8790, 2.8)
    this.scene.add(ambientLight)

    const keyLight = new THREE.DirectionalLight(0xffffff, 2.4)
    keyLight.position.set(6, 10, 8)
    this.scene.add(keyLight)

    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(12, 0.24, 12),
      new THREE.MeshStandardMaterial({ color: 0xf7f9fb, roughness: 0.82 })
    )
    floor.position.y = -0.12
    this.scene.add(floor)

    this.addWall(0, 0.55, -6, 12.4, 1.1, 0.24)
    this.addWall(0, 0.55, 6, 12.4, 1.1, 0.24)
    this.addWall(-6, 0.55, 0, 0.24, 1.1, 12.4)
    this.addWall(6, 0.55, 0, 0.24, 1.1, 12.4)

    this.addBox(-2.8, 0.45, -1.4, 0xb55f4d)
    this.addBox(1.8, 0.45, -0.2, 0xd8a640)
    this.addBox(0.2, 0.45, 2.4, 0x4a8b74)
    this.addGoalZone(3.8, 0.01, 3.8)
    this.scene.add(this.player)
  }

  private addWall(x: number, y: number, z: number, width: number, height: number, depth: number): void {
    const wall = new THREE.Mesh(
      new THREE.BoxGeometry(width, height, depth),
      new THREE.MeshStandardMaterial({ color: 0x485763, roughness: 0.75 })
    )
    wall.position.set(x, y, z)
    this.scene.add(wall)
  }

  private addBox(x: number, y: number, z: number, color: number): void {
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 0.9, 0.9),
      new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.02 })
    )
    box.position.set(x, y, z)
    this.scene.add(box)
  }

  private addGoalZone(x: number, y: number, z: number): void {
    const zone = new THREE.Mesh(
      new THREE.CylinderGeometry(1.25, 1.25, 0.04, 48),
      new THREE.MeshStandardMaterial({ color: 0x2f83cc, transparent: true, opacity: 0.46 })
    )
    zone.position.set(x, y, z)
    this.scene.add(zone)
  }

  private createPlayer(): THREE.Mesh {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.42, 32, 24),
      new THREE.MeshStandardMaterial({ color: 0x2f6fda, roughness: 0.55 })
    )
    mesh.position.set(0, 0.42, -3.3)
    return mesh
  }

  private resize(): void {
    const width = window.innerWidth
    const height = window.innerHeight
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
  }
}
