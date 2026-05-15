export type RenderPlayer = {
  playerId: number
  isLocal: boolean
  x: number
  y: number
  z: number
}

export type RenderBox = {
  boxId: number
  x: number
  y: number
  z: number
  qx: number
  qy: number
  qz: number
  qw: number
}

export type RenderWorldState = {
  players: RenderPlayer[]
  boxes: RenderBox[]
}
