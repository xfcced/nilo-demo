export type MovementInput = {
  up: boolean
  down: boolean
  left: boolean
  right: boolean
}

export class KeyboardInput {
  private pressedKeys = new Set<string>()

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
    })
  }

  currentMovement(): MovementInput {
    return {
      up: this.pressedKeys.has('KeyW') || this.pressedKeys.has('ArrowUp'),
      down: this.pressedKeys.has('KeyS') || this.pressedKeys.has('ArrowDown'),
      left: this.pressedKeys.has('KeyA') || this.pressedKeys.has('ArrowLeft'),
      right: this.pressedKeys.has('KeyD') || this.pressedKeys.has('ArrowRight'),
    }
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
