import { describe, expect, it } from 'vitest'
import { rememberSetting, rememberVolume, settingOn, volumeSetting } from './menu.ts'

function memory(): Storage {
  const items = new Map<string, string>()
  return {
    get length() {
      return items.size
    },
    clear() {
      items.clear()
    },
    getItem(key) {
      return items.get(key) ?? null
    },
    key(index) {
      return [...items.keys()][index] ?? null
    },
    removeItem(key) {
      items.delete(key)
    },
    setItem(key, value) {
      items.set(key, value)
    },
  }
}

describe('settings', () => {
  it('stay on until turned off, each on its own', () => {
    const store = memory()
    expect(settingOn('sounds', store)).toBe(true)
    rememberSetting('sounds', false, store)
    expect(settingOn('sounds', store)).toBe(false)
    expect(settingOn('music', store)).toBe(true)
    rememberSetting('sounds', true, store)
    expect(settingOn('sounds', store)).toBe(true)
  })
})

describe('volume', () => {
  it('is remembered, 0 included, each on its own', () => {
    const store = memory()
    expect(volumeSetting('musicVolume', store)).toBeNull()
    rememberVolume('musicVolume', 0, store)
    expect(volumeSetting('musicVolume', store)).toBe(0)
    expect(volumeSetting('soundsVolume', store)).toBeNull()
  })
})
