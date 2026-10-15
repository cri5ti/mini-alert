export const PLAYER_COLORS = [
  0x2f7edb, 0xd64545, 0x3cde73, 0xf0c040, 0xb45ad6, 0x3ec8c8, 0xf08a3c, 0xe85aad, 0x8fd14f, 0x6a8cff, 0xc4a574,
  0xff6b6b, 0x4ad6c8, 0xd6d24a, 0x9b6bff, 0xf2f2f2,
] as const

export function playerColor(id: number): number {
  return PLAYER_COLORS[(id - 1) % PLAYER_COLORS.length]
}

/** Whether `owner`'s units and buildings are hostile to `viewer`; owner 0 is neutral. */
export function hostile(viewer: number, owner: number): boolean {
  return owner !== 0 && owner !== viewer
}
