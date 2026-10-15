import { bayFacing, bayTile, CLIMB_RATE, cruiseAltitude, Flight, onRunway, orbitLoop, planeInFlight, RUNWAY_LENGTH, taxiRoute } from './flight.ts'
import { tileCenter, type TileCoord } from './tiles.ts'
import { Locomotion, type UnitType } from './unit-types.ts'

const ARRIVE = 0.38
const HULL_AIM_RATE = 2.5
const HULL_CLOSE = 1.25
const RETREAT_TICKS = 10
const RETREAT_SCALE = 0.95
const BEHIND = (Math.PI * 2) / 3

export const SIM_STEP = 1 / 30
export const MOTION_HEARTBEAT = 60
export const SNAPSHOT_GAP = 60
export const SNAPSHOT_COOLDOWN = 30
export const KEEPALIVE_TICKS = 150

export const enum MotionResult {
  Moved = 0,
  Waiting = 1,
  Denied = 2,
}

export type MotionState = {
  x: number
  z: number
  facing: number
  speed: number
  tileX: number
  tileY: number
  path: TileCoord[]
  homeX?: number
  homeY?: number
  returning?: boolean
  flight?: Flight
  altitude?: number
  orbitX?: number
  orbitY?: number
  loiter?: boolean
  bay?: number
}

/** A unit at rest takes an order at once on its client; one on the move keeps its course until the server answers. */
export function atRest(unit: { readonly path: readonly TileCoord[]; readonly speed: number }): boolean {
  return unit.path.length === 0 && unit.speed === 0
}

/**
 * A unit within weapon range of the point it attacks, a plane only while airborne, holds: its path clears and, without
 * a turret, its hull turns toward the point. Returns whether it holds.
 */
export function holdInRange(state: MotionState, type: UnitType, aim: { readonly x: number; readonly z: number }, dt: number): boolean {
  if (type.locomotion === Locomotion.Plane && !planeInFlight(state.flight ?? Flight.Ground, state.altitude ?? 0)) return false
  if (Math.hypot(aim.x - state.x, aim.z - state.z) > type.weapon.range) return false
  state.path = []
  if (type.weapon.turretRate <= 0) state.facing = turnToward(state.facing, Math.atan2(aim.x - state.x, aim.z - state.z), HULL_AIM_RATE, dt)
  return true
}

export function wrapAngle(angle: number): number {
  const turn = Math.PI * 2
  let wrapped = angle % turn
  if (wrapped > Math.PI) wrapped -= turn
  if (wrapped < -Math.PI) wrapped += turn
  return wrapped
}

export function approach(current: number, target: number, maxDelta: number): number {
  const delta = target - current
  if (Math.abs(delta) <= maxDelta) return target
  return current + Math.sign(delta) * maxDelta
}

export function turnToward(current: number, desired: number, rate: number, dt: number): number {
  return wrapAngle(current + clamp(wrapAngle(desired - current), -rate * dt, rate * dt))
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Clock speed that closes the gap to the server: gently within RETREAT_TICKS ahead of it, steeply beyond. */
export function timeScale(localTick: number, serverTick: number): number {
  const gap = serverTick - localTick
  if (gap < -RETREAT_TICKS) return Math.max(0, RETREAT_SCALE + (gap + RETREAT_TICKS) * 0.05)
  return Math.min(2, Math.max(RETREAT_SCALE, 1 + gap * 0.05))
}

export function stepMotion(
  state: MotionState,
  type: UnitType,
  dt: number,
  occupied?: (x: number, y: number) => boolean,
): MotionResult {
  if (type.topSpeed <= 0) return MotionResult.Moved
  const air = type.locomotion === Locomotion.Plane || type.locomotion === Locomotion.Rotor
  if (air) beginFlight(state, type)
  if (air && state.path.length === 0) settleFlight(state, type)
  if (state.path.length > 0 && occupied?.(state.path[0].x, state.path[0].y)) {
    state.speed = approach(state.speed, 0, type.acceleration * dt)
    return MotionResult.Waiting
  }
  if (state.path.length === 0) state.speed = approach(state.speed, 0, type.acceleration * dt)
  else driveMotion(state, type, dt)
  const next = integrateMotion(state, dt)
  const enteredX = Math.floor(next.x)
  const enteredY = Math.floor(next.z)
  const changing = enteredX !== state.tileX || enteredY !== state.tileY
  if (changing && occupied?.(enteredX, enteredY)) {
    state.speed = 0
    return MotionResult.Denied
  }
  state.x = next.x
  state.z = next.z
  state.tileX = enteredX
  state.tileY = enteredY
  const coasting = type.locomotion === Locomotion.Plane && state.flight !== Flight.Landing && state.flight !== Flight.Taxi
  if (state.path.length > 0) consumePath(state, coasting)
  if (type.locomotion === Locomotion.Hull) stopHullOvershoot(state, dt)
  if (air) settleFlight(state, type)
  if (air) stepAltitude(state, type, dt)
  if (air) settleTaxi(state, type, dt)
  return MotionResult.Moved
}

export function driveMotion(state: MotionState, type: UnitType, dt: number): void {
  if (type.topSpeed <= 0 || state.path.length === 0) return
  if (type.locomotion === Locomotion.Plane) {
    if (state.flight === Flight.Taxi) steerTaxi(state, type, dt)
    else steerPlane(state, type, dt)
  }
  else if (type.locomotion === Locomotion.Rotor) steerRotor(state, type, dt)
  else if (type.locomotion === Locomotion.Hull) steerHull(state, type, dt)
  else if (type.locomotion === Locomotion.Wheels) steerWheels(state, type, dt)
  else steerTracks(state, type, dt)
}

export function integrateMotion(state: MotionState, dt: number): { x: number; z: number } {
  const dist = state.speed * dt
  if (Math.abs(dist) < 1e-8) return { x: state.x, z: state.z }
  return {
    x: state.x + Math.sin(state.facing) * dist,
    z: state.z + Math.cos(state.facing) * dist,
  }
}

export function consumePath(state: MotionState, flyThrough = false): void {
  const dir = state.speed < -0.02 ? -1 : 1
  const hx = Math.sin(state.facing) * dir
  const hz = Math.cos(state.facing) * dir
  while (state.path.length > 0) {
    const center = tileCenter(state.path[0])
    const dx = center.x - state.x
    const dz = center.z - state.z
    const dist = Math.hypot(dx, dz)
    const ahead = dx * hx + dz * hz
    if (state.path.length === 1) {
      if (flyThrough && (dist < 2.2 || (dist < 6 && ahead < 0))) state.path.shift()
      else if (dist < ARRIVE && Math.abs(state.speed) < 0.85) state.path.shift()
      break
    }
    const onTile = Math.floor(state.x) === state.path[0].x && Math.floor(state.z) === state.path[0].y
    if (flyThrough && (ahead < 0 || dist < 1.6)) {
      state.path.shift()
      continue
    }
    if (dist < 0.4 || (onTile && ahead < 0.15) || (ahead < -0.05 && dist < 0.85)) {
      state.path.shift()
      continue
    }
    break
  }
}

export function flightLine(from: TileCoord, to: TileCoord): TileCoord[] {
  const path: TileCoord[] = []
  let x0 = from.x
  let y0 = from.y
  const dx = Math.abs(to.x - x0)
  const dy = Math.abs(to.y - y0)
  const sx = x0 < to.x ? 1 : -1
  const sy = y0 < to.y ? 1 : -1
  let err = dx - dy
  while (x0 !== to.x || y0 !== to.y) {
    const doubled = err * 2
    if (doubled > -dy) {
      err -= dy
      x0 += sx
    }
    if (doubled < dx) {
      err += dx
      y0 += sy
    }
    path.push({ x: x0, y: y0 })
  }
  return path
}

function steerTracks(state: MotionState, type: UnitType, dt: number): void {
  steerAligned(state, type, dt, Math.abs(state.speed) > 0.15 ? 0.75 : 0.35)
}

function beginFlight(state: MotionState, type: UnitType): void {
  if (state.flight === Flight.Taxi) {
    if (!state.returning && readyForTakeoff(state)) state.flight = Flight.Takeoff
    return
  }
  if ((state.flight === undefined || state.flight === Flight.Ground) && state.path.length > 0) {
    const homeX = state.homeX
    const homeY = state.homeY
    const slot = type.locomotion === Locomotion.Plane && homeX !== undefined && homeY !== undefined && (state.bay ?? -1) >= 0
    const onStrip = slot && homeX !== undefined && homeY !== undefined && onRunway(state.tileX, state.tileY, homeX, homeY)
    state.flight = slot && !onStrip ? Flight.Taxi : Flight.Takeoff
  }
  if (state.flight === Flight.Taxi || state.flight === Flight.Ground) return
  if (!state.returning || state.homeX === undefined || state.homeY === undefined) return
  const padX = state.homeX + (type.locomotion === Locomotion.Plane ? 1.5 : 0.5)
  const padZ = state.homeY + (type.locomotion === Locomotion.Plane ? 1.5 : 0.5)
  const dist = Math.hypot(state.x - padX, state.z - padZ)
  const reach = type.locomotion === Locomotion.Plane ? 8 : 1.6
  if (dist < reach) state.flight = Flight.Landing
}

function settleFlight(state: MotionState, type: UnitType): void {
  if (state.loiter === false) return
  if (type.locomotion !== Locomotion.Plane || state.returning) return
  if (state.path.length > 0 || state.orbitX === undefined || state.orbitY === undefined) return
  const loop = orbitLoop({ x: state.orbitX, y: state.orbitY }, state)
  if (loop.length === 0) return
  state.flight = Flight.Orbit
  state.path = loop
}

function stepAltitude(state: MotionState, type: UnitType, dt: number): void {
  const cruise = cruiseAltitude(type.locomotion)
  const flight = state.flight ?? Flight.Ground
  let target = 0
  if (flight === Flight.Cruise || flight === Flight.Orbit) target = cruise
  else if (flight === Flight.Takeoff) {
    const rolling = type.locomotion === Locomotion.Plane && state.speed < type.topSpeed * 0.5
    target = rolling ? 0 : cruise
  } else if (flight === Flight.Landing && type.locomotion === Locomotion.Plane && runwayDistance(state) > 4.5) {
    target = cruise * 0.85
  }
  state.altitude = approach(state.altitude ?? 0, target, CLIMB_RATE * dt)
  if (flight === Flight.Takeoff && target > 0 && state.altitude > target * 0.65) state.flight = Flight.Cruise
  const onPad = type.locomotion !== Locomotion.Plane || parkedOnRunway(state)
  if (flight === Flight.Landing && onPad && state.altitude < 0.08 && Math.abs(state.speed) < 0.4) {
    const bay = state.bay ?? -1
    if (type.locomotion === Locomotion.Plane && bay >= 0 && state.homeX !== undefined && state.homeY !== undefined) {
      state.flight = Flight.Taxi
      state.altitude = 0
      state.speed = 0
      state.returning = true
      state.orbitX = undefined
      state.orbitY = undefined
      state.path = taxiRoute({ x: state.tileX, y: state.tileY }, { x: state.homeX, y: state.homeY }, bay)
      return
    }
    state.flight = Flight.Ground
    state.speed = 0
    state.altitude = 0
    state.path = []
    state.returning = false
    state.orbitX = undefined
    state.orbitY = undefined
  }
}

function runwayDistance(state: MotionState): number {
  if (state.homeX === undefined || state.homeY === undefined) return 0
  return Math.hypot(state.x - (state.homeX + 1.5), state.z - (state.homeY + RUNWAY_LENGTH - 0.5))
}

const TAXI_SPEED = 2.2

function readyForTakeoff(state: MotionState): boolean {
  if (state.homeX === undefined || state.homeY === undefined) return false
  if (!onRunway(state.tileX, state.tileY, state.homeX, state.homeY)) return false
  const next = nextLeg(state)
  if (!next || next.x !== state.homeX + 1 || next.y <= state.tileY) return false
  return Math.abs(wrapAngle(state.facing)) < 0.7
}

function nextLeg(state: MotionState): TileCoord | undefined {
  for (const tile of state.path) {
    if (tile.x === state.tileX && tile.y === state.tileY) continue
    return tile
  }
  return undefined
}

function steerTaxi(state: MotionState, type: UnitType, dt: number): void {
  const aim = aimPoint(state)
  if (!aim) return
  const err = headingError(state, aim)
  state.facing = wrapAngle(state.facing + clamp(err, -type.turnRate * dt, type.turnRate * dt))
  let target = Math.abs(err) < 0.45 ? TAXI_SPEED : 0
  if (state.path.length === 1) {
    const center = tileCenter(state.path[0])
    const dist = Math.hypot(center.x - state.x, center.z - state.z)
    if (dist < 1) target = Math.min(target, Math.max(0.35, dist))
  }
  state.speed = approach(state.speed, target, type.acceleration * dt)
}

function settleTaxi(state: MotionState, type: UnitType, dt: number): void {
  if (state.flight !== Flight.Taxi || !state.returning) return
  if (state.homeX === undefined || state.homeY === undefined || (state.bay ?? -1) < 0) return
  const bay = state.bay ?? 0
  const spot = bayTile({ x: state.homeX, y: state.homeY }, bay)
  const center = tileCenter(spot)
  const dist = Math.hypot(state.x - center.x, state.z - center.z)
  if (dist > 0.42 || Math.abs(state.speed) > 0.85) {
    if (state.path.length === 0) state.path = taxiRoute({ x: state.tileX, y: state.tileY }, { x: state.homeX, y: state.homeY }, bay)
    return
  }
  const err = wrapAngle(bayFacing(bay) - state.facing)
  if (Math.abs(err) > 0.12) {
    state.speed = 0
    state.path = []
    state.x = center.x
    state.z = center.z
    state.tileX = spot.x
    state.tileY = spot.y
    state.facing = wrapAngle(state.facing + clamp(err, -type.turnRate * dt, type.turnRate * dt))
    return
  }
  state.x = center.x
  state.z = center.z
  state.tileX = spot.x
  state.tileY = spot.y
  state.facing = bayFacing(bay)
  state.speed = 0
  state.altitude = 0
  state.flight = Flight.Ground
  state.returning = false
  state.path = []
  state.orbitX = undefined
  state.orbitY = undefined
}

function steerPlane(state: MotionState, type: UnitType, dt: number): void {
  const goal = planeAim(state)
  if (!goal) return
  const err = headingError(state, tileCenter(goal))
  state.facing = wrapAngle(state.facing + clamp(err, -type.turnRate * dt, type.turnRate * dt))
  state.speed = approach(state.speed, planeSpeed(state, type), type.acceleration * dt)
}

function steerRotor(state: MotionState, type: UnitType, dt: number): void {
  const climbing = state.flight === Flight.Takeoff && (state.altitude ?? 0) < 0.85
  const landing = state.flight === Flight.Landing
  if (!climbing && !landing) {
    steerTracks(state, type, dt)
    return
  }
  const aim = aimPoint(state)
  if (aim) {
    const err = headingError(state, aim)
    state.facing = wrapAngle(state.facing + clamp(err, -type.turnRate * dt, type.turnRate * dt))
  }
  state.speed = approach(state.speed, 0, type.acceleration * dt)
}

function planeAim(state: MotionState): TileCoord | undefined {
  const flight = state.flight ?? Flight.Ground
  if ((flight === Flight.Takeoff || flight === Flight.Landing) && state.homeX !== undefined && state.homeY !== undefined) {
    const end = { x: state.homeX + 1, y: state.homeY + RUNWAY_LENGTH - 1 }
    if (flight === Flight.Landing || state.tileY < end.y) return end
  }
  if (state.path.length === 0) return undefined
  if (flight === Flight.Orbit) return state.path[Math.min(3, state.path.length - 1)]
  return state.path[state.path.length - 1]
}

function planeSpeed(state: MotionState, type: UnitType): number {
  if (state.flight !== Flight.Landing) return type.topSpeed
  if (parkedOnRunway(state) && (state.altitude ?? 0) < 0.45) return 0
  const dist = runwayDistance(state)
  if ((state.altitude ?? 0) < 0.35 && dist < 3) return Math.min(type.topSpeed, 2.4)
  return Math.min(type.topSpeed * 0.55, Math.max(2.4, dist * 0.85))
}

function parkedOnRunway(state: MotionState): boolean {
  if (state.homeX === undefined || state.homeY === undefined) return false
  return onRunway(state.tileX, state.tileY, state.homeX, state.homeY)
}

function steerHull(state: MotionState, type: UnitType, dt: number): void {
  const aim = aimPoint(state)
  if (!aim) return
  const err = headingError(state, aim)
  state.facing = wrapAngle(state.facing + clamp(err, -type.turnRate * dt, type.turnRate * dt))
  const target = Math.abs(err) <= 0.12 ? hullSpeed(state, type) : 0
  state.speed = approach(state.speed, target, type.acceleration * dt)
}

function hullSpeed(state: MotionState, type: UnitType): number {
  const remain = Math.max(0, pathRemaining(state) - 0.25)
  return Math.min(type.topSpeed, Math.sqrt(2 * type.acceleration * remain))
}

function pathRemaining(state: MotionState): number {
  let dist = 0
  let x = state.x
  let z = state.z
  for (const tile of state.path) {
    const center = tileCenter(tile)
    dist += Math.hypot(center.x - x, center.z - z)
    x = center.x
    z = center.z
  }
  return dist
}

function stopHullOvershoot(state: MotionState, dt: number): void {
  if (state.path.length !== 1) return
  const center = tileCenter(state.path[0])
  const dx = center.x - state.x
  const dz = center.z - state.z
  if (Math.hypot(dx, dz) > HULL_CLOSE) return
  const dir = state.speed < -0.02 ? -1 : 1
  const ahead = dx * Math.sin(state.facing) * dir + dz * Math.cos(state.facing) * dir
  if (ahead >= 0) return
  if (ahead + Math.abs(state.speed) * dt < 0) return
  state.path.length = 0
  state.speed = 0
}

function steerAligned(state: MotionState, type: UnitType, dt: number, limit: number): void {
  const aim = aimPoint(state)
  if (!aim) return
  const err = headingError(state, aim)
  const step = clamp(err, -type.turnRate * dt, type.turnRate * dt)
  state.facing = wrapAngle(state.facing + step)
  const target = Math.abs(err) <= limit ? cruiseSpeed(state, type, 1) : 0
  state.speed = approach(state.speed, target, type.acceleration * dt)
}

function steerWheels(state: MotionState, type: UnitType, dt: number): void {
  const aim = aimPoint(state)
  if (!aim) return
  const desired = Math.atan2(aim.x - state.x, aim.z - state.z)
  const noseErr = wrapAngle(desired - state.facing)
  const reverse = Math.abs(noseErr) > BEHIND
  const moveHeading = state.speed < -0.02 ? wrapAngle(state.facing + Math.PI) : state.facing
  const err = wrapAngle(desired - moveHeading)
  const steerSign = state.speed < 0 ? -1 : 1
  const steer = clamp(err * steerSign, -type.maxSteer, type.maxSteer)
  if (Math.abs(state.speed) > 0.02) {
    const yaw = (state.speed / type.wheelbase) * Math.tan(steer)
    state.facing = wrapAngle(state.facing + yaw * dt)
  }
  state.speed = approach(state.speed, cruiseSpeed(state, type, reverse ? -1 : 1), type.acceleration * dt)
}

function aimPoint(state: MotionState): { x: number; z: number } | null {
  if (state.path.length === 0) return null
  let index = 0
  while (index < state.path.length - 1) {
    const prev = index === 0 ? { x: state.tileX, y: state.tileY } : state.path[index - 1]
    const curr = state.path[index]
    const next = state.path[index + 1]
    const same = curr.x - prev.x === next.x - curr.x && curr.y - prev.y === next.y - curr.y
    if (!same) break
    index++
  }
  return tileCenter(state.path[index])
}

function headingError(state: MotionState, aim: { x: number; z: number }): number {
  const desired = Math.atan2(aim.x - state.x, aim.z - state.z)
  return wrapAngle(desired - state.facing)
}

function cruiseSpeed(state: MotionState, type: UnitType, direction: number): number {
  const goal = state.path[state.path.length - 1]
  if (!goal) return 0
  const center = tileCenter(goal)
  const dist = Math.hypot(center.x - state.x, center.z - state.z)
  let mag = type.topSpeed
  const stopping = (state.speed * state.speed) / (2 * type.acceleration)
  if (dist < stopping + 0.2) mag = Math.min(mag, Math.max(0.45, dist * 1.6))
  return mag * direction
}
