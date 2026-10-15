import changelog from '../../changelog.md?raw'
import { version } from '../../package.json'

const SEEN_VERSION = 'rts.seen-version'

const HELP = `# Shortcuts

- **Select** — click one of your units
- **Select several** — drag a box around them
- **Move** — with units selected, click open ground
- **Attack** — click an enemy. Hold Ctrl or ⌘ and click one of your units to fire on it, or click the ground to shell that spot. Units also fire at enemies they can see
- **Build** — Factory, Turret, Airport, or Helipad goes on open ground beside a city you own. A shipyard goes on water beside a city you own. Building places one of the houses a city grows, only on a tile that city could grow. The price appears when you aim at that city. Right-click cancels
- **Orders** — the Build panel sorts its tiles into the Base, Land, Air, and Sea tabs. \`F1\`, \`F2\`, and so on press the tiles of the open tab, left to right and top to bottom. Shift with the key drops the latest order of that type
- **City hall** — click the hall of a city you hold. The Selected panel at the bottom left shows its slider, which leans that city toward money or growth
- **Train** — select a factory, airport, helipad, or shipyard, and the Build panel opens its tab: Land for a factory, Air for an airport or helipad, Sea for a shipyard. Click a tile to queue it there. The Queue line at the bottom of the panel has a chip for each type in production, from every building; click one to drop the latest order of that type
- **Waypoint** — with a factory selected, click the ground. Finished units move there
- **Ranges** — hold Ctrl or ⌘ with one unit selected to show its attack range and sight
- **Return** — \`Z\` sends selected jets and gunships back to their airport or helipad
- **Pan** — \`WASD\`, arrow keys, middle-drag, hold Space and drag, move the pointer within 25px of the screen edge, or drag with two fingers
- **Turn** — \`Q\` and \`E\` rotate the camera 45°
- **Zoom** — mouse wheel, or pinch with two fingers
- **Minimap** — drag to move the camera. A click orders selected units as if you clicked that tile. With nothing selected, a click moves the camera

# Rules

## Credits

You start with 10,000. Every 10 seconds, each city you hold pays **2** per population. A city pays nothing while an enemy unit is nearby. You cannot hold more than 10,000 plus 500 for each population. Income stops there, and losing population throws away anything above the new limit.

## Cities

Move a unit onto any city tile, including a street, and hold it to capture. A ring shows progress. A city resists for five seconds per population. Each unit wears that down by its unit count each second, so a scout takes five seconds on a one-population city and a heavy tank takes a quarter of that. If both sides stand on a city, the capture pauses. Leave, and the progress fades slowly until it is gone. The owner or another commander standing there pushes it back at the same rate they would capture.

Cities you hold grow on their own. You do not need a unit in the city. Streets extend in runs of one to four tiles, buildings can sit up to two tiles off a street, and a tree on a new street or building comes down. How wide a city gets follows the log of its population. As that population climbs, buildings near the center are replaced with denser ones. After one of those replacements, the city spends the next few growth steps on streets and new lots before it upgrades again. Each city starts with a city hall on a 2×2 block. It cannot be destroyed. Select it to lean the city: the slider starts in the middle. One step left doubles the money that city pays, and the next step quadruples it. One step right doubles how fast the city grows, and the next step quadruples that. Population is the sum of each building's density, from 1 to 20. The hall counts as 6. Houses and plants are the high numbers. Chimneys, tanks, containers, solar panels, and windmills stay on the low ones. Your army cannot grow past that population. Scouts count as 1, medium tanks, turrets, jets, and cruisers as 2, artillery and gunships as 3, and heavy tanks, factories, and helipads as 4. Shipyards count as 8 and airports as 12. The unit count turns red when it is over, and training and construction stop. Guns and shells bring down the other buildings. When the last of those falls, the city is neutral again. A street more than four tiles from a standing building comes up with it.

## Building

Factories, airports, helipads, and turrets take time to finish, and they can only be placed on open ground beside a city you own. A shipyard goes on water beside a city you own. An airport, helipad, or shipyard can be placed only after a factory is finished. An airport is a 3×3 field with a center runway and six parking spots, and it can hold six jets. A building is density 1, the same kind a young city grows, and it can only go on a tile that city could grow one. It appears at once and takes the full price. Aim at the city and the price appears: 100 while that city's population is 6 or less, and after that 100 times how much population it has beyond 5. It adds 1 population. A finished factory trains scouts, medium tanks, heavy tanks, and artillery. An airport trains jets, a helipad trains gunships, and a shipyard trains cruisers onto the water beside it. Select that building to see what it trains. Each one keeps its own queue, and a finished unit comes out of the building that trained it. Every tile of the open tab is shown, and a tile that cannot be used says why: Needs a factory for an airport, helipad, or shipyard before a factory is finished, Select a factory (or an airport, a helipad, a shipyard) until the building that trains it is selected, Not finished while that building goes up, Needs population when your army has no room for it, and Apron full when the airport's spots are taken. Click a tile to queue one, and click again to queue another. The number in a tile's top-left corner counts its orders, at the selected building for units, once one of them is waiting to start. Shift-click or right-click drops the latest queued order of that type, for units only at the selected building. Credits are spent while a unit or structure is built, and construction pauses if you run out.

Jets taxi from their spot onto the center runway, roll, climb, and circle the ordered tile until you send them back. Each carries five rockets and fires only after it is in the air. A rocket climbs as it flies. Each one hits twice as hard as a heavy tank shell, with a smaller splash, and the jet waits two seconds between shots. When the rack is empty the jet returns to the airport that launched it, lands, and taxis to its spot to reload. Click the airport, or press Z, to send selected aircraft home. A finished airport takes any of your jets that have no airport. A destroyed jet frees its spot. Gunships climb off the helipad, hover, and turn before they fly. Click the helipad to bring one back down. Cruisers spin in place, then pick up speed slowly, and they only travel on water. Vehicles and turrets shoot enemies and buildings of a city another commander holds. They leave neutral cities alone. Shots scatter more at long range, and more again when the shooter is moving. Shells splash, knock down trees, scar the ground, and bring down those buildings and streets. A shot aimed at an aircraft splashes only other aircraft. Artillery reaches farther and is easy to lose. Scouts are fast and light. Tanks turn in place. A friendly unit with nothing to do steps off a tile another unit needs; a unit already on its way is left to move, and the one behind waits.

## Sight

Fog covers ground you have not seen. Finished units reveal a circle around them, and a city you own reveals ten tiles around its center. Enemies outside that sight stay hidden. Ground you have already walked stays dim after you look away.
`

type MenuActions = {
  onMusic?(on: boolean): void
  onSounds?(on: boolean): void
  onMusicVolume?(volume: number): void
  onSoundsVolume?(volume: number): void
  onSurrender?(): void
}

export function bindMenu(actions: MenuActions = {}): void {
  const bar = document.querySelector<HTMLElement>('#menubar')
  const menu = document.querySelector<HTMLElement>('#menu')
  const sheet = document.querySelector<HTMLElement>('#sheet')
  const title = document.querySelector<HTMLElement>('#sheet-title')
  const body = document.querySelector<HTMLElement>('#sheet-body')
  if (!bar || !menu || !sheet || !title || !body) return

  const settings: Record<string, ((on: boolean) => void) | undefined> = { music: actions.onMusic, sounds: actions.onSounds }
  for (const toggle of bar.querySelectorAll<HTMLElement>('[data-toggle]')) {
    const name = toggle.dataset.toggle
    if (!name || settingOn(name)) continue
    setPressed(toggle, false)
    settings[name]?.(false)
  }

  const volumes: Record<string, ((volume: number) => void) | undefined> = {
    musicVolume: actions.onMusicVolume,
    soundsVolume: actions.onSoundsVolume,
  }
  for (const slider of bar.querySelectorAll<HTMLInputElement>('input[data-volume]')) {
    const name = slider.dataset.volume
    const readout = slider.parentElement?.querySelector('output')
    if (!name || !readout) continue
    const apply = () => {
      readout.textContent = `${slider.value}%`
      volumes[name]?.(slider.valueAsNumber / 100)
    }
    const remembered = volumeSetting(name)
    if (remembered !== null) slider.value = String(remembered)
    apply()
    slider.addEventListener('input', () => {
      rememberVolume(name, slider.valueAsNumber)
      apply()
    })
  }

  const openSheet = (label: string, markdown: string) => {
    closeMenu(menu)
    title.textContent = label
    body.innerHTML = renderMarkdown(stripMatchingTitle(markdown, label))
    sheet.hidden = false
    if (label === 'Changelog') markSeen(version)
  }

  const closeSheet = () => {
    sheet.hidden = true
  }

  bar.addEventListener('click', (event) => {
    const target = event.target
    if (!(target instanceof Element)) return
    const opener = target.closest<HTMLElement>('[data-open]')
    if (opener?.dataset.open === 'menu') {
      menu.classList.toggle('open')
      return
    }
    if (opener?.dataset.open === 'changelog') {
      openSheet('Changelog', changelog)
      return
    }
    if (opener?.dataset.open === 'help') {
      openSheet('Help', HELP)
      return
    }
    if (opener?.dataset.open === 'fullscreen') {
      closeMenu(menu)
      if (document.fullscreenElement) void document.exitFullscreen()
      else void document.documentElement.requestFullscreen()
      return
    }
    if (target.closest('[data-dismiss]')) {
      closeMenu(menu)
      actions.onSurrender?.()
      return
    }
    const toggle = target.closest<HTMLElement>('[data-toggle]')
    if (!toggle) return
    const on = toggle.getAttribute('aria-pressed') !== 'true'
    setPressed(toggle, on)
    const name = toggle.dataset.toggle
    if (!name) return
    rememberSetting(name, on)
    settings[name]?.(on)
  })

  sheet.addEventListener('click', (event) => {
    if (event.target === sheet) closeSheet()
  })
  document.querySelector('#sheet-close')?.addEventListener('click', closeSheet)

  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    if (!sheet.hidden) closeSheet()
    else closeMenu(menu)
  })

  window.addEventListener('pointerdown', (event) => {
    if (!menu.classList.contains('open')) return
    const target = event.target
    if (target instanceof Node && menu.contains(target)) return
    closeMenu(menu)
  })

  if (seenVersion() !== version) openSheet('Changelog', changelog)
}

export function closeMenu(menu: HTMLElement) {
  menu.classList.remove('open')
}

export function settingOn(name: string, store: Storage = localStorage): boolean {
  return read(name, store) !== 'off'
}

export function rememberSetting(name: string, on: boolean, store: Storage = localStorage) {
  write(name, on ? 'on' : 'off', store)
}

export function volumeSetting(name: string, store: Storage = localStorage): number | null {
  const stored = read(name, store)
  return stored === null ? null : Number(stored)
}

export function rememberVolume(name: string, percent: number, store: Storage = localStorage) {
  write(name, String(percent), store)
}

function read(name: string, store: Storage): string | null {
  try {
    return store.getItem(`rts.${name}`)
  } catch {
    return null
  }
}

function write(name: string, value: string, store: Storage) {
  try {
    store.setItem(`rts.${name}`, value)
  } catch {
    // Storage can be blocked. The setting still applies for this visit.
  }
}

function setPressed(toggle: HTMLElement, on: boolean) {
  toggle.setAttribute('aria-pressed', on ? 'true' : 'false')
  const mark = toggle.querySelector('.mark')
  if (mark) mark.textContent = on ? 'On' : 'Off'
}

function seenVersion(): string | null {
  try {
    return localStorage.getItem(SEEN_VERSION)
  } catch {
    return version
  }
}

function markSeen(next: string) {
  try {
    localStorage.setItem(SEEN_VERSION, next)
  } catch {
    // Storage can be blocked. Skip the write and leave the sheet as the only notice.
  }
}

function stripMatchingTitle(markdown: string, label: string): string {
  const source = markdown.trim()
  const match = /^#\s+(.+)\n+/.exec(source)
  if (!match || match[1] !== label) return source
  return source.slice(match[0].length)
}

function renderMarkdown(source: string): string {
  const lines = source.replaceAll('\r\n', '\n').split('\n')
  const out: string[] = []
  let list: string[] | null = null
  let para: string[] = []

  const flushPara = () => {
    if (para.length === 0) return
    out.push(`<p>${inline(para.join(' '))}</p>`)
    para = []
  }
  const flushList = () => {
    if (!list) return
    out.push(`<ul>${list.map((item) => `<li>${inline(item)}</li>`).join('')}</ul>`)
    list = null
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') {
      flushPara()
      flushList()
      continue
    }
    if (/^---+$/.test(trimmed)) {
      flushPara()
      flushList()
      out.push('<hr>')
      continue
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed)
    if (heading) {
      flushPara()
      flushList()
      const level = heading[1].length
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`)
      continue
    }
    const item = /^[-*]\s+(.+)$/.exec(trimmed)
    if (item) {
      flushPara()
      list ??= []
      list.push(item[1])
      continue
    }
    flushList()
    para.push(trimmed)
  }
  flushPara()
  flushList()
  return out.join('')
}

function inline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
}

function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
