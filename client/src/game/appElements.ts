import { getElement } from '../engine/dom'

export type AppElements = {
  urlInput: HTMLInputElement
  hashInput: HTMLInputElement
  connectButton: HTMLButtonElement
  disconnectButton: HTMLButtonElement
  canvas: HTMLCanvasElement
  movementButtons: NodeListOf<HTMLButtonElement>
}

export function getAppElements(): AppElements {
  return {
    urlInput: getElement('urlInput'),
    hashInput: getElement('hashInput'),
    connectButton: getElement('connectButton'),
    disconnectButton: getElement('disconnectButton'),
    canvas: getElement('scene'),
    movementButtons: document.querySelectorAll<HTMLButtonElement>('[data-movement-direction]'),
  }
}
