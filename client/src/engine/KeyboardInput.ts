export type MovementInput = {
  up: boolean
  down: boolean
  left: boolean
  right: boolean
}

export type MovementDirection = keyof MovementInput

export class KeyboardInput {
  private pressedKeys = new Set<string>()
  private virtualMovement: MovementInput = {
    up: false,
    down: false,
    left: false,
    right: false,
  }

  constructor() {
    window.addEventListener('keydown', (event) => {
      if (isMovementKey(event.code)) {
        this.pressedKeys.add(event.code)
        event.preventDefault()
      }
    })

    window.addEventListener('keyup', (event) => {
      if (isMovementKey(event.code)) {
        this.pressedKeys.delete(event.code)
        event.preventDefault()
      }
    })

    window.addEventListener('blur', () => {
      this.pressedKeys.clear()
      this.clearVirtualMovement()
    })
  }

  setVirtualDirection(direction: MovementDirection, pressed: boolean): void {
    this.virtualMovement[direction] = pressed
  }

  currentMovement(): MovementInput {
    return {
      up: this.virtualMovement.up || this.pressedKeys.has('KeyW') || this.pressedKeys.has('ArrowUp'),
      down: this.virtualMovement.down || this.pressedKeys.has('KeyS') || this.pressedKeys.has('ArrowDown'),
      left: this.virtualMovement.left || this.pressedKeys.has('KeyA') || this.pressedKeys.has('ArrowLeft'),
      right: this.virtualMovement.right || this.pressedKeys.has('KeyD') || this.pressedKeys.has('ArrowRight'),
    }
  }

  private clearVirtualMovement(): void {
    this.virtualMovement.up = false
    this.virtualMovement.down = false
    this.virtualMovement.left = false
    this.virtualMovement.right = false
  }
}

function isMovementKey(code: string): boolean {
  return (
    code === 'KeyW' ||
    code === 'KeyA' ||
    code === 'KeyS' ||
    code === 'KeyD' ||
    code === 'ArrowUp' ||
    code === 'ArrowDown' ||
    code === 'ArrowLeft' ||
    code === 'ArrowRight'
  )
}
