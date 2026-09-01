export type Vec3 = { x: number; y: number; z: number }
export type BallStart = { x: number; z: number }
export type RacketPath = 'linear' | 'circular'
export type CircleDirection = 'clockwise' | 'counterclockwise'

export type SimParams = {
  ballSpeed: number
  ballAzimuth: number
  ballElevation: number
  contactPhase: number
  racketSpeed: number
  racketAcceleration: number
  racketPath: RacketPath
  racketPathRadius: number
  circleSideTilt: number
  circleLift: number
  circleContactAngle: number
  circleContactTime: number
  circleDirection: CircleDirection
  pathAzimuth: number
  pathElevation: number
  facePathAngle: number
  faceTilt: number
  rubberGrip: number
  restitution: number
  spongeThickness: number
  spongeHardness: number
  spongeDamping: number
  bladeStiffness: number
  bladeDamping: number
  tableFriction: number
  spinX: number
  spinY: number
  spinZ: number
}

export type TrajectoryPoint = Vec3 & {
  t: number
  velocity: Vec3
  spin: Vec3
}

export type SimResult = {
  startTime: number
  incoming: TrajectoryPoint[]
  noHitProjection: TrajectoryPoint[]
  outgoing: TrajectoryPoint[]
  bounces: Array<Vec3 & { t: number; speedBefore: number; speedAfter: number }>
  termination: 'floor' | 'table-rest' | 'limit'
  impact: {
    contactPoint: Vec3
    ballCenter: Vec3
    incomingVelocity: Vec3
    outgoingVelocity: Vec3
    racketVelocity: Vec3
    incomingSpin: Vec3
    outgoingSpin: Vec3
    normalImpulse: Vec3
    frictionImpulse: Vec3
    normalForce: number
    frictionForce: number
    peakNormalForce: number
    contactTime: number
    effectiveRestitution: number
    spongeCompression: number
    spongeCompressionRatio: number
    bottomedOut: boolean
    outgoingSpeed: number
    elevation: number
    sidespinRpm: number
    totalSpinRpm: number
    normal: Vec3
    slipSpeed: number
  }
}

export const BALL_MASS = 0.0027
export const BALL_RADIUS = 0.02
const BALL_AREA = Math.PI * BALL_RADIUS * BALL_RADIUS
const BALL_INERTIA = (2 / 3) * BALL_MASS * BALL_RADIUS * BALL_RADIUS
const AIR_DENSITY = 1.225
const DRAG_COEFFICIENT = 0.47
const G = 9.81
const TABLE_REST_SPEED = 0.35
export const TABLE_SURFACE_Y = 0.76
export const TABLE_LENGTH = 2.74
export const TABLE_WIDTH = 1.525
export const TABLE_THICKNESS = 0.06
export const NET_HEIGHT = 0.1525
export const NET_WIDTH = 1.83
export const DEFAULT_TABLE_POSITION: Vec3 = { x: 0, y: 0, z: 0 }
const RACKET_HALF_MIN_X = BALL_RADIUS
const RACKET_HALF_MAX_X = TABLE_LENGTH / 2 - BALL_RADIUS
export const DEFAULT_BALL_START: BallStart = {
  x: RACKET_HALF_MAX_X - 0.8 * (RACKET_HALF_MAX_X - RACKET_HALF_MIN_X),
  z: 0,
}
export const SIM_START_TIME = 0

export const DEFAULT_PARAMS: SimParams = {
  ballSpeed: 10 / 3.6,
  ballAzimuth: 0,
  ballElevation: 45,
  contactPhase: 55,
  racketSpeed: 80 / 3.6,
  racketAcceleration: 0,
  racketPath: 'linear',
  racketPathRadius: 0.7,
  circleSideTilt: 0,
  circleLift: 0,
  circleContactAngle: 0,
  circleContactTime: 0,
  circleDirection: 'clockwise',
  pathAzimuth: 0,
  pathElevation: 60,
  facePathAngle: 0,
  faceTilt: -80,
  rubberGrip: 0.72,
  restitution: 0.82,
  spongeThickness: 2.0,
  spongeHardness: 45,
  spongeDamping: 0.28,
  bladeStiffness: 62,
  bladeDamping: 0.16,
  tableFriction: 0.24,
  spinX: 0,
  spinY: 0,
  spinZ: -1700,
}

const rad = (degrees: number) => (degrees * Math.PI) / 180
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z
const length = (v: Vec3) => Math.hypot(v.x, v.y, v.z)
const scale = (v: Vec3, s: number): Vec3 => ({ x: v.x * s, y: v.y * s, z: v.z * s })
const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z })
const subtract = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
})
const rotateAroundAxis = (vector: Vec3, axisValue: Vec3, angle: number): Vec3 => {
  const axis = normalize(axisValue)
  const cosine = Math.cos(angle)
  const sine = Math.sin(angle)
  return add(
    add(scale(vector, cosine), scale(cross(axis, vector), sine)),
    scale(axis, dot(axis, vector) * (1 - cosine)),
  )
}
const normalize = (v: Vec3): Vec3 => {
  const magnitude = length(v)
  return magnitude > 1e-9 ? scale(v, 1 / magnitude) : { x: 0, y: 0, z: 0 }
}
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))

// Solves the two angles (a rotation around `facePlaneAxis` then around the
// perpendicular it produces) that steer `racketDirection` onto `targetNormal`,
// mirroring the facePathAngle/faceTilt construction used in simulate().
function solveFaceAngles(racketDirection: Vec3, facePlaneAxis: Vec3, targetNormal: Vec3) {
  const axis = normalize(facePlaneAxis)
  const s = normalize(racketDirection)
  const n = normalize(targetNormal)
  const alongAxis = clamp(dot(s, axis), -1, 1)
  const alpha = Math.acos(alongAxis)
  const perp = subtract(s, scale(axis, alongAxis))
  const e1 = length(perp) > 1e-6
    ? normalize(perp)
    : normalize(cross(axis, Math.abs(axis.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 0, z: 1 }))
  const e2 = normalize(cross(axis, e1))
  const beta = Math.acos(clamp(dot(n, axis), -1, 1))
  const nE1 = dot(n, e1)
  const nE2 = dot(n, e2)
  const facePathAngle = Math.sin(beta) > 1e-6 ? Math.atan2(nE2, nE1) * 180 / Math.PI : 0
  const faceTilt = (alpha - beta) * 180 / Math.PI
  return { facePathAngle, faceTilt }
}

// Given the racket direction and face normal a linear or circular setup
// currently produces at contact, solves the parameters for the *other* path
// shape that reproduce the exact same contact direction and face normal.
export function solveCircularContactParams(
  targetDirection: Vec3,
  targetNormal: Vec3,
  circleDirection: CircleDirection,
) {
  const dir = normalize(targetDirection)
  const liftRad = Math.acos(clamp(dir.x, -1, 1))
  const sideTiltRad = Math.atan2(dir.z, dir.y)
  const clockThree = normalize(rotateAroundAxis({ x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 0 }, sideTiltRad))
  const referenceCenterDirection = circleDirection === 'clockwise' ? clockThree : scale(clockThree, -1)
  const motionAxis = normalize(cross(dir, referenceCenterDirection))
  const { facePathAngle, faceTilt } = solveFaceAngles(dir, motionAxis, targetNormal)
  return {
    circleContactAngle: 0,
    circleContactTime: 0,
    circleSideTilt: sideTiltRad * 180 / Math.PI,
    circleLift: liftRad * 180 / Math.PI,
    facePathAngle,
    faceTilt,
  }
}

export function solveLinearContactParams(targetDirection: Vec3, targetNormal: Vec3) {
  const dir = normalize(targetDirection)
  const pathElevation = Math.asin(clamp(dir.y, -1, 1)) * 180 / Math.PI
  const pathAzimuth = Math.atan2(dir.z, dir.x) * 180 / Math.PI
  const { facePathAngle, faceTilt } = solveFaceAngles(dir, { x: 0, y: 1, z: 0 }, targetNormal)
  return { pathAzimuth, pathElevation, facePathAngle, faceTilt }
}

function directionFromAngles(azimuth: number, elevation: number, baseSign: 1 | -1): Vec3 {
  const a = rad(azimuth)
  const e = rad(elevation)
  return normalize({
    x: baseSign * Math.cos(e) * Math.cos(a),
    y: Math.sin(e),
    z: Math.cos(e) * Math.sin(a),
  })
}

function flightAcceleration(velocity: Vec3, spin: Vec3): Vec3 {
  const speed = length(velocity)
  const dragMagnitude = speed > 0
    ? (0.5 * AIR_DENSITY * DRAG_COEFFICIENT * BALL_AREA * speed * speed) / BALL_MASS
    : 0
  const drag = speed > 0 ? scale(velocity, -dragMagnitude / speed) : { x: 0, y: 0, z: 0 }
  const spinMagnitude = length(spin)
  const spinRatio = speed > 0 ? (spinMagnitude * BALL_RADIUS) / speed : 0
  const liftCoefficient = Math.min(0.6, 0.32 * spinRatio)
  const magnusMagnitude = (0.5 * AIR_DENSITY * liftCoefficient * BALL_AREA * speed * speed) / BALL_MASS
  const magnusDirection = normalize(cross(spin, velocity))
  return add(add(drag, scale(magnusDirection, magnusMagnitude)), { x: 0, y: -G, z: 0 })
}

function applyTableFriction(
  velocity: Vec3,
  spin: Vec3,
  normalImpulse: number,
  friction: number,
) {
  const contactArm = { x: 0, y: -BALL_RADIUS, z: 0 }
  const contactVelocity = add(velocity, cross(spin, contactArm))
  const slip = { x: contactVelocity.x, y: 0, z: contactVelocity.z }
  const inverseTangentMass = 1 / BALL_MASS + (BALL_RADIUS * BALL_RADIUS) / BALL_INERTIA
  const idealImpulse = scale(slip, -1 / inverseTangentMass)
  const frictionLimit = friction * normalImpulse
  const idealMagnitude = length(idealImpulse)
  const frictionImpulse = idealMagnitude > frictionLimit && idealMagnitude > 1e-12
    ? scale(idealImpulse, frictionLimit / idealMagnitude)
    : idealImpulse
  return {
    velocity: add(velocity, scale(frictionImpulse, 1 / BALL_MASS)),
    spin: add(spin, scale(cross(contactArm, frictionImpulse), 1 / BALL_INERTIA)),
  }
}

function resolveNetCollision(
  previousPosition: Vec3,
  nextPosition: Vec3,
  velocity: Vec3,
  spin: Vec3,
  tablePosition: Vec3,
) {
  const travelX = nextPosition.x - previousPosition.x
  if (Math.abs(travelX) < 1e-12) return { velocity, spin, hit: false }

  const direction = Math.sign(travelX)
  const netFaceX = tablePosition.x - direction * BALL_RADIUS
  const crossedFace = direction > 0
    ? previousPosition.x <= netFaceX && nextPosition.x >= netFaceX
    : previousPosition.x >= netFaceX && nextPosition.x <= netFaceX
  if (!crossedFace) return { velocity, spin, hit: false }

  const fraction = clamp((netFaceX - previousPosition.x) / travelX, 0, 1)
  const contactY = previousPosition.y + (nextPosition.y - previousPosition.y) * fraction
  const contactZ = previousPosition.z + (nextPosition.z - previousPosition.z) * fraction
  const netBottom = tablePosition.y + TABLE_SURFACE_Y
  const netTop = netBottom + NET_HEIGHT
  if (
    contactY + BALL_RADIUS < netBottom
    || contactY - BALL_RADIUS > netTop
    || Math.abs(contactZ - tablePosition.z) > NET_WIDTH / 2 + BALL_RADIUS
  ) return { velocity, spin, hit: false }

  nextPosition.x = netFaceX - direction * 0.0001
  nextPosition.y = contactY
  nextPosition.z = contactZ
  return {
    velocity: {
      x: -velocity.x * 0.06,
      y: velocity.y * 0.1,
      z: velocity.z * 0.08,
    },
    spin: scale(spin, 0.06),
    hit: true,
  }
}

function resolveTableBodyCollision(
  previousPosition: Vec3,
  nextPosition: Vec3,
  velocity: Vec3,
  spin: Vec3,
  tablePosition: Vec3,
) {
  const tableTop = tablePosition.y + TABLE_SURFACE_Y
  const tableBottom = tableTop - TABLE_THICKNESS
  const minX = tablePosition.x - TABLE_LENGTH / 2 - BALL_RADIUS
  const maxX = tablePosition.x + TABLE_LENGTH / 2 + BALL_RADIUS
  const minY = tableBottom - BALL_RADIUS
  const maxY = tableTop + BALL_RADIUS
  const minZ = tablePosition.z - TABLE_WIDTH / 2 - BALL_RADIUS
  const maxZ = tablePosition.z + TABLE_WIDTH / 2 + BALL_RADIUS
  const travel = subtract(nextPosition, previousPosition)
  const candidates: Array<{ fraction: number; normal: Vec3 }> = []
  const between = (value: number, low: number, high: number) => value >= low && value <= high

  const addSideCandidate = (fraction: number, normal: Vec3) => {
    if (fraction < 0 || fraction > 1) return
    const point = add(previousPosition, scale(travel, fraction))
    if (normal.x !== 0) {
      if (!between(point.z, minZ, maxZ) || !between(point.y, minY, maxY - 1e-6)) return
    } else if (normal.z !== 0) {
      if (!between(point.x, minX, maxX) || !between(point.y, minY, maxY - 1e-6)) return
    } else if (!between(point.x, minX, maxX) || !between(point.z, minZ, maxZ)) return
    candidates.push({ fraction, normal })
  }

  if (travel.x > 1e-12 && previousPosition.x < minX && nextPosition.x >= minX) {
    addSideCandidate((minX - previousPosition.x) / travel.x, { x: -1, y: 0, z: 0 })
  }
  if (travel.x < -1e-12 && previousPosition.x > maxX && nextPosition.x <= maxX) {
    addSideCandidate((maxX - previousPosition.x) / travel.x, { x: 1, y: 0, z: 0 })
  }
  if (travel.z > 1e-12 && previousPosition.z < minZ && nextPosition.z >= minZ) {
    addSideCandidate((minZ - previousPosition.z) / travel.z, { x: 0, y: 0, z: -1 })
  }
  if (travel.z < -1e-12 && previousPosition.z > maxZ && nextPosition.z <= maxZ) {
    addSideCandidate((maxZ - previousPosition.z) / travel.z, { x: 0, y: 0, z: 1 })
  }
  if (travel.y > 1e-12 && previousPosition.y < minY && nextPosition.y >= minY) {
    addSideCandidate((minY - previousPosition.y) / travel.y, { x: 0, y: -1, z: 0 })
  }
  // Catch the rounded top edge when the ball descends just outside the flat
  // playing surface but still overlaps the side of the tabletop slab.
  if (travel.y < -1e-12 && previousPosition.y > maxY && nextPosition.y <= maxY) {
    const fraction = (maxY - previousPosition.y) / travel.y
    const point = add(previousPosition, scale(travel, fraction))
    const outsideFlatTop = point.x < tablePosition.x - TABLE_LENGTH / 2
      || point.x > tablePosition.x + TABLE_LENGTH / 2
      || point.z < tablePosition.z - TABLE_WIDTH / 2
      || point.z > tablePosition.z + TABLE_WIDTH / 2
    if (outsideFlatTop) addSideCandidate(fraction, { x: 0, y: 1, z: 0 })
  }

  if (!candidates.length) return { velocity, spin, hit: false }
  const collision = candidates.reduce((first, candidate) => (
    candidate.fraction < first.fraction ? candidate : first
  ))
  const contactPosition = add(previousPosition, scale(travel, collision.fraction))
  nextPosition.x = contactPosition.x + collision.normal.x * 0.0001
  nextPosition.y = contactPosition.y + collision.normal.y * 0.0001
  nextPosition.z = contactPosition.z + collision.normal.z * 0.0001
  const normalVelocity = scale(collision.normal, dot(velocity, collision.normal))
  const tangentialVelocity = subtract(velocity, normalVelocity)
  return {
    velocity: add(scale(normalVelocity, -0.42), scale(tangentialVelocity, 0.86)),
    spin: scale(spin, 0.82),
    hit: true,
  }
}

export function simulate(
  params: SimParams,
  tablePosition: Vec3 = DEFAULT_TABLE_POSITION,
  requestedStart: BallStart = DEFAULT_BALL_START,
): SimResult {
  const launchDirection = directionFromAngles(params.ballAzimuth, params.ballElevation, -1)
  const linearRacketDirection = directionFromAngles(params.pathAzimuth, params.pathElevation, 1)
  let racketDirection = linearRacketDirection
  // Linear paths have no swing plane of their own, so face path angle is just a yaw:
  // it turns the face left/right around vertical, independent of the path's elevation.
  let facePlaneAxis: Vec3 = { x: 0, y: 1, z: 0 }
  let inPlaneNormal = normalize(rotateAroundAxis(
    racketDirection,
    facePlaneAxis,
    rad(params.facePathAngle),
  ))
  let faceTiltAxis = normalize(cross(inPlaneNormal, facePlaneAxis))
  if (length(faceTiltAxis) < 1e-6) {
    // A straight-up/down path leaves yaw with no effect and no natural tilt axis; fall
    // back to a fixed horizontal reference so face tilt still has something to pivot on.
    const fallbackReference: Vec3 = Math.abs(inPlaneNormal.z) < 0.94
      ? { x: 0, y: 0, z: 1 }
      : { x: 1, y: 0, z: 0 }
    faceTiltAxis = normalize(cross(inPlaneNormal, fallbackReference))
  }
  let normal = normalize(rotateAroundAxis(inPlaneNormal, faceTiltAxis, rad(params.faceTilt)))
  let circularCenterDirection: Vec3 = { x: 0, y: 1, z: 0 }
  if (params.racketPath === 'circular') {
    // The neutral clock lies parallel to the table: +X is 12 o'clock and +Z is 3 o'clock.
    // The contact tangent angle rotates that neutral clock first, so the chosen clock
    // position becomes the new 12 o'clock. Side tilt then rotates around that 12–6
    // diameter, and lift rotates around the newly tilted 3–9 diameter — tilt and lift
    // always act relative to the actual contact tangent, not the untouched neutral frame.
    const tangentAngle = rad(params.circleContactAngle)
    const tangentTwelve = normalize(add(
      scale({ x: 1, y: 0, z: 0 }, Math.cos(tangentAngle)),
      scale({ x: 0, y: 0, z: 1 }, Math.sin(tangentAngle)),
    ))
    const tangentThree = normalize(add(
      scale({ x: 1, y: 0, z: 0 }, -Math.sin(tangentAngle)),
      scale({ x: 0, y: 0, z: 1 }, Math.cos(tangentAngle)),
    ))
    const clockThree = normalize(rotateAroundAxis(
      tangentThree,
      tangentTwelve,
      rad(params.circleSideTilt),
    ))
    const clockTwelve = normalize(rotateAroundAxis(
      tangentTwelve,
      clockThree,
      rad(params.circleLift),
    ))
    const referenceTangent = clockTwelve
    const clockwiseCenterDirection = clockThree
    const referenceCenterDirection = params.circleDirection === 'clockwise'
      ? clockwiseCenterDirection
      : scale(clockwiseCenterDirection, -1)
    const radius = Math.max(0.05, params.racketPathRadius)
    const referenceTime = params.circleContactTime
    const referenceDistance = params.racketSpeed * referenceTime
      + 0.5 * params.racketAcceleration * referenceTime * referenceTime
    const contactTravelAngle = referenceDistance / radius
    racketDirection = normalize(add(
      scale(referenceTangent, Math.cos(contactTravelAngle)),
      scale(referenceCenterDirection, Math.sin(contactTravelAngle)),
    ))
    circularCenterDirection = normalize(add(
      scale(referenceCenterDirection, Math.cos(contactTravelAngle)),
      scale(referenceTangent, -Math.sin(contactTravelAngle)),
    ))
    const motionAxis = normalize(cross(racketDirection, circularCenterDirection))
    facePlaneAxis = motionAxis
    inPlaneNormal = normalize(rotateAroundAxis(
      racketDirection,
      facePlaneAxis,
      rad(params.facePathAngle),
    ))
    faceTiltAxis = normalize(cross(inPlaneNormal, facePlaneAxis))
    normal = normalize(rotateAroundAxis(inPlaneNormal, faceTiltAxis, rad(params.faceTilt)))
  }
  const launchVelocity = scale(launchDirection, params.ballSpeed)
  const localStart = {
    x: clamp(requestedStart.x, BALL_RADIUS, TABLE_LENGTH / 2 - BALL_RADIUS),
    z: clamp(requestedStart.z, -TABLE_WIDTH / 2 + BALL_RADIUS, TABLE_WIDTH / 2 - BALL_RADIUS),
  }
  const startPosition = {
    x: tablePosition.x + localStart.x - TABLE_LENGTH / 2,
    y: tablePosition.y + TABLE_SURFACE_Y + BALL_RADIUS,
    z: tablePosition.z + localStart.z,
  }
  const contactRacketSpeed = params.racketPath === 'circular'
    ? Math.max(0, params.racketSpeed + params.racketAcceleration * params.circleContactTime)
    : params.racketSpeed
  const racketVelocityAtTime = (elapsed: number) => {
    const speed = Math.max(0, contactRacketSpeed + params.racketAcceleration * elapsed)
    if (params.racketPath !== 'circular') return scale(racketDirection, speed)
    const radius = Math.max(0.05, params.racketPathRadius)
    const distance = contactRacketSpeed * elapsed
      + 0.5 * params.racketAcceleration * elapsed * elapsed
    const angle = distance / radius
    const tangent = add(
      scale(racketDirection, Math.cos(angle)),
      scale(circularCenterDirection, Math.sin(angle)),
    )
    return scale(tangent, speed)
  }
  const racketVelocity = racketVelocityAtTime(0)
  const rpmToRadians = (2 * Math.PI) / 60
  const launchSpin = scale({ x: params.spinX, y: params.spinY, z: params.spinZ }, rpmToRadians)

  const freeFlight: TrajectoryPoint[] = [{
    t: 0,
    ...startPosition,
    velocity: launchVelocity,
    spin: launchSpin,
  }]
  let freeState = freeFlight[0]
  const ballOnTableY = tablePosition.y + TABLE_SURFACE_Y + BALL_RADIUS
  for (let elapsed = 0.005; elapsed <= 14; elapsed += 0.005) {
    const step = 0.005
    const acceleration = flightAcceleration(freeState.velocity, freeState.spin)
    let velocity = add(freeState.velocity, scale(acceleration, step))
    let spin = scale(freeState.spin, Math.exp(-0.025 * step))
    const nextPosition = {
      x: freeState.x + velocity.x * step,
      y: freeState.y + velocity.y * step,
      z: freeState.z + velocity.z * step,
    }
    const netCollision = resolveNetCollision(
      freeState,
      nextPosition,
      velocity,
      spin,
      tablePosition,
    )
    velocity = netCollision.velocity
    spin = netCollision.spin
    const tableBodyCollision = resolveTableBodyCollision(
      freeState,
      nextPosition,
      velocity,
      spin,
      tablePosition,
    )
    velocity = tableBodyCollision.velocity
    spin = tableBodyCollision.spin
    const withinTable = nextPosition.x >= tablePosition.x - TABLE_LENGTH / 2
      && nextPosition.x <= tablePosition.x + TABLE_LENGTH / 2
      && nextPosition.z >= tablePosition.z - TABLE_WIDTH / 2
      && nextPosition.z <= tablePosition.z + TABLE_WIDTH / 2
    const tableCrossFraction = clamp(
      (freeState.y - ballOnTableY) / Math.max(1e-9, freeState.y - nextPosition.y),
      0,
      1,
    )
    const crossesFlatTable = freeState.x + (nextPosition.x - freeState.x) * tableCrossFraction >= tablePosition.x - TABLE_LENGTH / 2
      && freeState.x + (nextPosition.x - freeState.x) * tableCrossFraction <= tablePosition.x + TABLE_LENGTH / 2
      && freeState.z + (nextPosition.z - freeState.z) * tableCrossFraction >= tablePosition.z - TABLE_WIDTH / 2
      && freeState.z + (nextPosition.z - freeState.z) * tableCrossFraction <= tablePosition.z + TABLE_WIDTH / 2

    if (
      crossesFlatTable
      && freeState.y >= ballOnTableY - 1e-9
      && nextPosition.y <= ballOnTableY
      && velocity.y < 0
    ) {
      const supported = freeState.y <= ballOnTableY + 0.0025
        && Math.abs(freeState.velocity.y) < 0.25
      if (supported) {
        velocity.y = 0
        const frictionResult = applyTableFriction(
          velocity,
          spin,
          BALL_MASS * G * step,
          params.tableFriction,
        )
        velocity = frictionResult.velocity
        spin = frictionResult.spin
        nextPosition.y = ballOnTableY
      } else {
        const normalImpulse = -(1 + 0.88) * velocity.y * BALL_MASS
        velocity.y *= -0.88
        const frictionResult = applyTableFriction(
          velocity,
          spin,
          normalImpulse,
          params.tableFriction,
        )
        velocity = frictionResult.velocity
        spin = frictionResult.spin
        nextPosition.y = ballOnTableY
      }
    }

    const supportedSpeed = Math.hypot(velocity.x, velocity.z)
    if (withinTable && nextPosition.y === ballOnTableY && supportedSpeed < 1e-4) {
      freeState = {
        t: elapsed,
        ...nextPosition,
        velocity: { x: 0, y: 0, z: 0 },
        spin: { x: 0, y: 0, z: 0 },
      }
      freeFlight.push(freeState)
      break
    }
    if (freeState.y >= BALL_RADIUS && nextPosition.y <= BALL_RADIUS && velocity.y < 0) {
      const travelFraction = clamp(
        (freeState.y - BALL_RADIUS) / Math.max(1e-9, freeState.y - nextPosition.y),
        0,
        1,
      )
      freeState = {
        t: freeState.t + step * travelFraction,
        x: freeState.x + (nextPosition.x - freeState.x) * travelFraction,
        y: BALL_RADIUS,
        z: freeState.z + (nextPosition.z - freeState.z) * travelFraction,
        velocity,
        spin,
      }
      freeFlight.push(freeState)
      break
    }
    freeState = {
      t: elapsed,
      ...nextPosition,
      velocity,
      spin,
    }
    freeFlight.push(freeState)
  }

  // Flat launches can remain at maximum height while rolling across the table;
  // in that case the end of the supported segment is the useful 50% landmark.
  const apex = freeFlight.reduce(
    (highest, point) => point.y >= highest.y - 1e-9 ? point : highest,
    freeFlight[0],
  )
  const floorTime = freeFlight[freeFlight.length - 1].t
  const phase = clamp(params.contactPhase, 0, 100)
  const contactFlightTime = phase <= 50
    ? apex.t * phase / 50
    : apex.t + (floorTime - apex.t) * (phase - 50) / 50
  const contactState = sampleTrajectory(freeFlight, contactFlightTime)
  const startTime = -contactFlightTime
  const incoming: TrajectoryPoint[] = freeFlight
    .filter((point) => point.t < contactFlightTime - 1e-9)
    .map((point) => ({ ...point, t: point.t - contactFlightTime }))
  incoming.push({ ...contactState, t: 0 })

  const ballCenter = { x: contactState.x, y: contactState.y, z: contactState.z }
  const incomingVelocity = contactState.velocity
  const incomingSpin = contactState.spin
  const contactPoint = subtract(ballCenter, scale(normal, BALL_RADIUS))

  const noHitProjection: TrajectoryPoint[] = [{ ...contactState, t: 0 }]
  noHitProjection.push(...freeFlight
    .filter((point) => point.t > contactFlightTime + 1e-9)
    .map((point) => ({ ...point, t: point.t - contactFlightTime })))

  const contactArm = scale(normal, -BALL_RADIUS)
  const initialSurfaceVelocity = add(incomingVelocity, cross(incomingSpin, contactArm))
  const initialRelativeVelocity = subtract(initialSurfaceVelocity, racketVelocity)
  const approachSpeed = Math.max(0, -dot(initialRelativeVelocity, normal))
  const initialNormalComponent = scale(normal, dot(initialRelativeVelocity, normal))
  const initialSlipVelocity = subtract(initialRelativeVelocity, initialNormalComponent)
  const slipSpeed = length(initialSlipVelocity)

  // The ball, sponge and flexing blade act as springs in series. The sponge
  // hardens sharply near bottom-out, while damping converts some stored energy
  // into heat and blade vibration.
  const spongeThicknessMetres = params.spongeThickness / 1000
  const ballStiffness = 165_000
  const spongeStiffnessBase = 285_000
    * Math.pow(params.spongeHardness / 45, 1.55)
    * (0.002 / spongeThicknessMetres)
  const bladeStiffness = 240_000 * Math.pow(params.bladeStiffness / 62, 1.7)
  const seriesStiffness = (spongeStiffness: number) => 1 / (
    1 / ballStiffness + 1 / spongeStiffness + 1 / bladeStiffness
  )
  const baseSeriesStiffness = seriesStiffness(spongeStiffnessBase)
  const tangentialStiffness = 82_000
    * Math.pow(params.spongeHardness / 45, 1.25)
    * (0.002 / spongeThicknessMetres)
  const tangentialEffectiveMass = 1 / (
    1 / BALL_MASS + (BALL_RADIUS * BALL_RADIUS) / BALL_INERTIA
  )
  const tangentialDamping = 2
    * params.spongeDamping
    * Math.sqrt(tangentialEffectiveMass * tangentialStiffness)
  const restitutionLog = Math.log(clamp(params.restitution, 0.05, 0.99))
  const restitutionDampingRatio = -restitutionLog / Math.sqrt(Math.PI * Math.PI + restitutionLog * restitutionLog)
  const normalDampingRatio = clamp(
    restitutionDampingRatio
      + params.spongeDamping * 0.085 * (params.spongeThickness / 2)
      + params.bladeDamping * 0.045 * (62 / params.bladeStiffness),
    0.015,
    0.42,
  )

  let outgoingVelocity = { ...incomingVelocity }
  let outgoingSpin = { ...incomingSpin }
  let compression = 0
  let shearDisplacement: Vec3 = { x: 0, y: 0, z: 0 }
  let normalImpulseMagnitude = 0
  let frictionImpulse: Vec3 = { x: 0, y: 0, z: 0 }
  let peakNormalForce = 0
  let maximumSpongeCompression = 0
  let maximumCompressionRatio = 0
  let contactTime = 0
  const contactDt = 0.000002

  if (approachSpeed > 0) {
    for (let stepIndex = 0; stepIndex < 10_000; stepIndex += 1) {
      const surfaceVelocity = add(outgoingVelocity, cross(outgoingSpin, contactArm))
      const currentRacketVelocity = racketVelocityAtTime(contactTime)
      const relativeVelocity = subtract(surfaceVelocity, currentRacketVelocity)
      const relativeNormalVelocity = dot(relativeVelocity, normal)
      const compressionRate = -relativeNormalVelocity
      compression = Math.max(0, compression + compressionRate * contactDt)

      // Estimate how much of the total approach deformation sits in the sponge.
      const baseSpongeShare = baseSeriesStiffness / spongeStiffnessBase
      const projectedSpongeCompression = compression * baseSpongeShare
      const bottomOutStart = spongeThicknessMetres * 0.68
      const bottomOutProgress = Math.max(
        0,
        (projectedSpongeCompression - bottomOutStart) / Math.max(1e-7, spongeThicknessMetres - bottomOutStart),
      )
      const hardeningFactor = 1 + 24 * Math.pow(bottomOutProgress, 3)
      const currentSpongeStiffness = spongeStiffnessBase * hardeningFactor
      const currentStiffness = seriesStiffness(currentSpongeStiffness)
      const normalDamping = 2 * normalDampingRatio * Math.sqrt(BALL_MASS * currentStiffness)
      const normalForceMagnitude = Math.max(
        0,
        currentStiffness * compression + normalDamping * compressionRate,
      )

      const normalPart = scale(normal, relativeNormalVelocity)
      const slipVelocity = subtract(relativeVelocity, normalPart)
      shearDisplacement = add(shearDisplacement, scale(slipVelocity, contactDt))
      const desiredTangentialForce = add(
        scale(shearDisplacement, -tangentialStiffness),
        scale(slipVelocity, -tangentialDamping),
      )
      const frictionLimit = params.rubberGrip * normalForceMagnitude
      const desiredTangentialMagnitude = length(desiredTangentialForce)
      const tangentialForce = desiredTangentialMagnitude > frictionLimit && desiredTangentialMagnitude > 1e-9
        ? scale(desiredTangentialForce, frictionLimit / desiredTangentialMagnitude)
        : desiredTangentialForce

      // When the contact patch slides, discard shear that cannot be stored by
      // the rubber. This allows it to grip again if relative motion reverses.
      if (desiredTangentialMagnitude > frictionLimit && tangentialStiffness > 0) {
        shearDisplacement = scale(
          add(tangentialForce, scale(slipVelocity, tangentialDamping)),
          -1 / tangentialStiffness,
        )
      }

      const normalForce = scale(normal, normalForceMagnitude)
      const totalForce = add(normalForce, tangentialForce)
      const frameImpulse = scale(totalForce, contactDt)
      outgoingVelocity = add(outgoingVelocity, scale(frameImpulse, 1 / BALL_MASS))
      outgoingSpin = add(
        outgoingSpin,
        scale(cross(contactArm, scale(tangentialForce, contactDt)), 1 / BALL_INERTIA),
      )
      normalImpulseMagnitude += normalForceMagnitude * contactDt
      frictionImpulse = add(frictionImpulse, scale(tangentialForce, contactDt))
      peakNormalForce = Math.max(peakNormalForce, normalForceMagnitude)
      const estimatedSpongeCompression = Math.min(
        spongeThicknessMetres,
        normalForceMagnitude / Math.max(1, currentSpongeStiffness),
      )
      maximumSpongeCompression = Math.max(maximumSpongeCompression, estimatedSpongeCompression)
      maximumCompressionRatio = Math.max(
        maximumCompressionRatio,
        projectedSpongeCompression / spongeThicknessMetres,
      )
      contactTime += contactDt

      if (stepIndex > 3 && compression <= 1e-9 && relativeNormalVelocity > 0) break
    }
  }

  const normalImpulse = scale(normal, normalImpulseMagnitude)
  const frictionMagnitude = length(frictionImpulse)
  const finalRacketVelocity = racketVelocityAtTime(contactTime)
  const outgoingRelativeNormalSpeed = dot(subtract(outgoingVelocity, finalRacketVelocity), normal)
  const effectiveRestitution = approachSpeed > 1e-9
    ? Math.max(0, outgoingRelativeNormalSpeed / approachSpeed)
    : 0

  const outgoing: TrajectoryPoint[] = [{
    t: 0,
    ...ballCenter,
    velocity: outgoingVelocity,
    spin: outgoingSpin,
  }]
  const dt = 0.004
  let state = outgoing[0]
  const bounces: SimResult['bounces'] = []
  let termination: SimResult['termination'] = 'limit'
  for (let t = dt; t <= 14; t += dt) {
    const acceleration = flightAcceleration(state.velocity, state.spin)
    let velocity = add(state.velocity, scale(acceleration, dt))
    let spin = scale(state.spin, Math.exp(-0.025 * dt))
    const nextPosition = {
      x: state.x + velocity.x * dt,
      y: state.y + velocity.y * dt,
      z: state.z + velocity.z * dt,
    }
    const netCollision = resolveNetCollision(
      state,
      nextPosition,
      velocity,
      spin,
      tablePosition,
    )
    velocity = netCollision.velocity
    spin = netCollision.spin
    const tableBodyCollision = resolveTableBodyCollision(
      state,
      nextPosition,
      velocity,
      spin,
      tablePosition,
    )
    velocity = tableBodyCollision.velocity
    spin = tableBodyCollision.spin
    const ballOnTableY = tablePosition.y + TABLE_SURFACE_Y + BALL_RADIUS
    const withinTable = nextPosition.x >= tablePosition.x - TABLE_LENGTH / 2
      && nextPosition.x <= tablePosition.x + TABLE_LENGTH / 2
      && nextPosition.z >= tablePosition.z - TABLE_WIDTH / 2
      && nextPosition.z <= tablePosition.z + TABLE_WIDTH / 2
    const tableCrossFraction = clamp(
      (state.y - ballOnTableY) / Math.max(1e-9, state.y - nextPosition.y),
      0,
      1,
    )
    const crossesFlatTable = state.x + (nextPosition.x - state.x) * tableCrossFraction >= tablePosition.x - TABLE_LENGTH / 2
      && state.x + (nextPosition.x - state.x) * tableCrossFraction <= tablePosition.x + TABLE_LENGTH / 2
      && state.z + (nextPosition.z - state.z) * tableCrossFraction >= tablePosition.z - TABLE_WIDTH / 2
      && state.z + (nextPosition.z - state.z) * tableCrossFraction <= tablePosition.z + TABLE_WIDTH / 2

    let bouncedOnTable = false
    let supportedOnTable = false
    if (
      ballOnTableY >= BALL_RADIUS
      && state.y >= ballOnTableY
      && nextPosition.y <= ballOnTableY
      && velocity.y < 0
      && crossesFlatTable
    ) {
      const supported = state.y <= ballOnTableY + 0.0025
        && Math.abs(state.velocity.y) < 0.25
      const speedBefore = length(velocity)
      const tableNormalImpulse = supported
        ? BALL_MASS * G * dt
        : -(1 + 0.88) * velocity.y * BALL_MASS
      velocity.y = supported ? 0 : velocity.y + tableNormalImpulse / BALL_MASS
      const frictionResult = applyTableFriction(
        velocity,
        spin,
        tableNormalImpulse,
        params.tableFriction,
      )
      velocity = frictionResult.velocity
      spin = frictionResult.spin
      nextPosition.y = ballOnTableY
      supportedOnTable = supported
      if (!supported) {
        bouncedOnTable = true
        bounces.push({
          t,
          ...nextPosition,
          speedBefore,
          speedAfter: length(velocity),
        })
      }
    }

    if ((bouncedOnTable || supportedOnTable) && length(velocity) <= TABLE_REST_SPEED) {
      state = {
        t,
        ...nextPosition,
        velocity: { x: 0, y: 0, z: 0 },
        spin: { x: 0, y: 0, z: 0 },
      }
      outgoing.push(state)
      termination = 'table-rest'
      break
    }

    if (state.y >= BALL_RADIUS && nextPosition.y <= BALL_RADIUS && velocity.y < 0) {
      const travelFraction = clamp(
        (state.y - BALL_RADIUS) / Math.max(1e-9, state.y - nextPosition.y),
        0,
        1,
      )
      state = {
        t: state.t + dt * travelFraction,
        x: state.x + (nextPosition.x - state.x) * travelFraction,
        y: BALL_RADIUS,
        z: state.z + (nextPosition.z - state.z) * travelFraction,
        velocity,
        spin,
      }
      outgoing.push(state)
      termination = 'floor'
      break
    }

    state = {
      t,
      ...nextPosition,
      velocity,
      spin,
    }
    outgoing.push(state)
  }

  const horizontalSpeed = Math.hypot(outgoingVelocity.x, outgoingVelocity.z)
  const spinRpmFactor = 60 / (2 * Math.PI)
  return {
    startTime,
    incoming,
    noHitProjection,
    outgoing,
    bounces,
    termination,
    impact: {
      contactPoint,
      ballCenter,
      incomingVelocity,
      outgoingVelocity,
      racketVelocity,
      incomingSpin,
      outgoingSpin,
      normalImpulse,
      frictionImpulse,
      normalForce: contactTime > 0 ? normalImpulseMagnitude / contactTime : 0,
      frictionForce: contactTime > 0 ? frictionMagnitude / contactTime : 0,
      peakNormalForce,
      contactTime,
      effectiveRestitution,
      spongeCompression: maximumSpongeCompression * 1000,
      spongeCompressionRatio: maximumCompressionRatio,
      bottomedOut: maximumCompressionRatio >= 0.92,
      outgoingSpeed: length(outgoingVelocity),
      elevation: Math.atan2(outgoingVelocity.y, horizontalSpeed) * 180 / Math.PI,
      sidespinRpm: outgoingSpin.y * spinRpmFactor,
      totalSpinRpm: length(outgoingSpin) * spinRpmFactor,
      normal,
      slipSpeed,
    },
  }
}

export function sampleTrajectory(points: TrajectoryPoint[], time: number): TrajectoryPoint {
  if (time <= points[0].t) return points[0]
  if (time >= points[points.length - 1].t) return points[points.length - 1]
  let low = 0
  let high = points.length - 1
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    if (points[middle].t < time) low = middle + 1
    else high = middle - 1
  }
  const next = points[low]
  const previous = points[Math.max(0, low - 1)]
  const mix = (time - previous.t) / Math.max(1e-9, next.t - previous.t)
  const lerp = (a: number, b: number) => a + (b - a) * mix
  return {
    t: time,
    x: lerp(previous.x, next.x),
    y: lerp(previous.y, next.y),
    z: lerp(previous.z, next.z),
    velocity: {
      x: lerp(previous.velocity.x, next.velocity.x),
      y: lerp(previous.velocity.y, next.velocity.y),
      z: lerp(previous.velocity.z, next.velocity.z),
    },
    spin: {
      x: lerp(previous.spin.x, next.spin.x),
      y: lerp(previous.spin.y, next.spin.y),
      z: lerp(previous.spin.z, next.spin.z),
    },
  }
}
