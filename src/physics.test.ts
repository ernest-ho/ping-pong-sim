import { describe, expect, test } from 'bun:test'
import {
  BALL_RADIUS,
  DEFAULT_BALL_START,
  DEFAULT_PARAMS,
  DEFAULT_TABLE_POSITION,
  MATERIAL_LIMITS,
  NET_HEIGHT,
  referenceRacketRestitution,
  TABLE_LENGTH,
  TABLE_SURFACE_Y,
  TABLE_THICKNESS,
  TABLE_WIDTH,
  simulate,
  solveCircularContactParams,
  solveLinearContactParams,
  type SimParams,
} from './physics'

const NEUTRAL_PARAMS: SimParams = {
  ...DEFAULT_PARAMS,
  ballSpeed: 9,
  ballElevation: 0,
  racketSpeed: 10,
  pathElevation: 0,
  faceTilt: 0,
  spinZ: 0,
}

function contactGeometryError(params: SimParams) {
  const { ballCenter, contactPoint, normal } = simulate(params).impact
  const touch = {
    x: ballCenter.x - normal.x * BALL_RADIUS,
    y: ballCenter.y - normal.y * BALL_RADIUS,
    z: ballCenter.z - normal.z * BALL_RADIUS,
  }
  return Math.hypot(
    touch.x - contactPoint.x,
    touch.y - contactPoint.y,
    touch.z - contactPoint.z,
  )
}

describe('3D compliant impact model', () => {
  test('uses the requested launch and racket defaults', () => {
    expect(DEFAULT_PARAMS.ballSpeed * 3.6).toBeCloseTo(10, 12)
    expect(DEFAULT_PARAMS.ballElevation).toBe(45)
    expect(DEFAULT_PARAMS.spinZ).toBe(-1700)
    expect(DEFAULT_PARAMS.contactPhase).toBe(55)
    expect(DEFAULT_PARAMS.racketSpeed * 3.6).toBeCloseTo(80, 12)
    expect(DEFAULT_PARAMS.racketAcceleration).toBe(0)
    expect(DEFAULT_PARAMS.afterContactDeceleration).toBe(0)
    expect(DEFAULT_PARAMS.racketPath).toBe('linear')
    expect(DEFAULT_PARAMS.racketPathRadius).toBeCloseTo(0.7, 12)
    expect(DEFAULT_PARAMS.circleSideTilt).toBe(0)
    expect(DEFAULT_PARAMS.circleLift).toBe(0)
    expect(DEFAULT_PARAMS.circleContactAngle).toBe(0)
    expect(DEFAULT_PARAMS.circleContactTime).toBe(0)
    expect(DEFAULT_PARAMS.circleDirection).toBe('clockwise')
    expect(DEFAULT_PARAMS.pathElevation).toBe(60)
    expect(DEFAULT_PARAMS.facePathAngle).toBe(0)
    expect(DEFAULT_PARAMS.faceTilt).toBe(-80)
    expect(DEFAULT_PARAMS.topsheetTension).toBe(1)
    expect(DEFAULT_PARAMS.boosterLevel).toBe(0)
    const minimumX = BALL_RADIUS
    const maximumX = TABLE_LENGTH / 2 - BALL_RADIUS
    expect((maximumX - DEFAULT_BALL_START.x) / (maximumX - minimumX) * 100).toBeCloseTo(80, 12)
  })

  test('uses practical material control limits around the neutral defaults', () => {
    for (const key of Object.keys(MATERIAL_LIMITS) as Array<keyof typeof MATERIAL_LIMITS>) {
      const limits = MATERIAL_LIMITS[key]
      const value = DEFAULT_PARAMS[key]
      expect(typeof value).toBe('number')
      expect(value as number).toBeGreaterThanOrEqual(limits.min)
      expect(value as number).toBeLessThanOrEqual(limits.max)
    }
    expect(MATERIAL_LIMITS.topsheetDamping).toEqual({ min: 0.05, max: 0.35, step: 0.01 })
    expect(MATERIAL_LIMITS.topsheetTension).toEqual({ min: 0, max: 6, step: 0.1 })
    expect(MATERIAL_LIMITS.spongeDamping).toEqual({ min: 0.1, max: 0.45, step: 0.01 })
    expect(MATERIAL_LIMITS.bladeStiffness).toEqual({ min: 1, max: 6, step: 0.1 })
    expect(MATERIAL_LIMITS.racketMass).toEqual({ min: 130, max: 210, step: 1 })
    expect(MATERIAL_LIMITS.bladeDamping).toEqual({ min: 0.005, max: 0.1, step: 0.005 })
  })

  test('keeps the calculated contact point on the racket face for angled setups', () => {
    expect(contactGeometryError(DEFAULT_PARAMS)).toBeLessThan(1e-12)
    expect(contactGeometryError({
      ...DEFAULT_PARAMS,
      ballAzimuth: 31,
      ballElevation: 18,
      pathAzimuth: -28,
      pathElevation: 36,
      faceTilt: -30,
    })).toBeLessThan(1e-12)
  })

  test('starts the default ball one physical radius above the table', () => {
    const result = simulate(DEFAULT_PARAMS)
    const start = result.incoming[0]
    expect(start.t).toBe(result.startTime)
    expect(start.y - TABLE_SURFACE_Y).toBeCloseTo(BALL_RADIUS, 8)
    expect(start.x).toBeCloseTo(DEFAULT_BALL_START.x - TABLE_LENGTH / 2, 8)
    expect(start.z).toBeCloseTo(DEFAULT_BALL_START.z, 8)
  })

  test('starts angled arcs directly on the selected table surface point', () => {
    const params = {
      ...DEFAULT_PARAMS,
      ballAzimuth: 27,
      ballElevation: 19,
      faceTilt: -22,
    }
    const selected = { x: 0.34, z: -0.41 }
    const start = simulate(params, DEFAULT_TABLE_POSITION, selected).incoming[0]
    expect(start.x).toBeCloseTo(selected.x - TABLE_LENGTH / 2, 8)
    expect(start.y).toBeCloseTo(TABLE_SURFACE_Y + BALL_RADIUS, 8)
    expect(start.z).toBeCloseTo(selected.z, 8)
  })

  test('interprets ball angles as the initial launch direction', () => {
    const params = { ...DEFAULT_PARAMS, ballAzimuth: 30, ballElevation: 20 }
    const launch = simulate(params).incoming[0].velocity
    const elevation = 20 * Math.PI / 180
    const azimuth = 30 * Math.PI / 180
    expect(launch.x).toBeCloseTo(-params.ballSpeed * Math.cos(elevation) * Math.cos(azimuth), 10)
    expect(launch.y).toBeCloseTo(params.ballSpeed * Math.sin(elevation), 10)
    expect(launch.z).toBeCloseTo(params.ballSpeed * Math.cos(elevation) * Math.sin(azimuth), 10)
  })

  test('keeps a zero-degree launch rolling on the table until the edge', () => {
    const result = simulate({ ...NEUTRAL_PARAMS, contactPhase: 100 })
    const fullArc = [...result.incoming, ...result.noHitProjection.slice(1)]
    const supported = fullArc.filter((point) => (
      point.x >= -TABLE_LENGTH / 2
      && point.x <= TABLE_LENGTH / 2
      && point.z >= -TABLE_WIDTH / 2
      && point.z <= TABLE_WIDTH / 2
    ))

    expect(supported.length).toBeGreaterThan(2)
    expect(supported.every((point) => point.y >= TABLE_SURFACE_Y + BALL_RADIUS - 1e-12)).toBe(true)
    expect(supported.slice(0, -1).every((point) => Math.abs(point.velocity.y) < 1e-12)).toBe(true)
  })

  test('bounces an incoming launch off the table instead of clipping through it', () => {
    const result = simulate({
      ...DEFAULT_PARAMS,
      ballSpeed: 2,
      ballElevation: 10,
      contactPhase: 100,
    })
    const incoming = result.incoming
    const onTable = incoming.filter((point) => (
      point.x >= -TABLE_LENGTH / 2
      && point.x <= TABLE_LENGTH / 2
      && point.z >= -TABLE_WIDTH / 2
      && point.z <= TABLE_WIDTH / 2
    ))
    const bounced = incoming.some((point, index) => (
      index > 0
      && incoming[index - 1].velocity.y < 0
      && point.velocity.y > 0
      && Math.abs(point.y - (TABLE_SURFACE_Y + BALL_RADIUS)) < 1e-9
    ))

    expect(bounced).toBe(true)
    expect(onTable.every((point) => point.y >= TABLE_SURFACE_Y + BALL_RADIUS - 1e-12)).toBe(true)
  })

  test('maps contact phase from launch through apex to the floor', () => {
    const params = { ...DEFAULT_PARAMS, ballElevation: 35 }
    const launch = simulate({ ...params, contactPhase: 0 })
    const apex = simulate({ ...params, contactPhase: 50 })
    const floor = simulate({ ...params, contactPhase: 100 })
    const fullUnhitArc = [...apex.incoming, ...apex.noHitProjection.slice(1)]

    expect(launch.startTime).toBeCloseTo(0, 12)
    expect(apex.impact.ballCenter.y).toBeCloseTo(
      Math.max(...fullUnhitArc.map((point) => point.y)),
      8,
    )
    expect(floor.impact.ballCenter.y).toBeCloseTo(BALL_RADIUS, 12)
    expect(Math.abs(apex.startTime)).toBeGreaterThan(Math.abs(launch.startTime))
    expect(Math.abs(floor.startTime)).toBeGreaterThan(Math.abs(apex.startTime))
  })

  test('projects the remaining incoming flight when no racket hit occurs', () => {
    const result = simulate({ ...DEFAULT_PARAMS, ballElevation: 35, contactPhase: 50 })
    const projectedStart = result.noHitProjection[0]
    const projectedEnd = result.noHitProjection[result.noHitProjection.length - 1]
    expect(projectedStart.x).toBeCloseTo(result.impact.ballCenter.x, 12)
    expect(projectedStart.y).toBeCloseTo(result.impact.ballCenter.y, 12)
    expect(projectedStart.z).toBeCloseTo(result.impact.ballCenter.z, 12)
    expect(projectedEnd.y).toBeCloseTo(BALL_RADIUS, 12)
    expect(projectedEnd.t).toBeGreaterThan(0)
    expect(result.noHitProjection.length).toBeGreaterThan(1)
  })

  test('top and backspin deform the incoming arc in opposite directions', () => {
    const top = simulate({ ...DEFAULT_PARAMS, ballElevation: 20, spinZ: 5000 })
    const back = simulate({ ...DEFAULT_PARAMS, ballElevation: 20, spinZ: -5000 })
    expect(top.impact.contactPoint.y).toBeLessThan(back.impact.contactPoint.y)
  })

  test('moves the calculated contact with the selected start while the table stays centered', () => {
    const launchContact = { ...DEFAULT_PARAMS, contactPhase: 0 }
    const first = simulate(launchContact, DEFAULT_TABLE_POSITION, { x: 0.2, z: -0.5 })
    const second = simulate(launchContact, DEFAULT_TABLE_POSITION, { x: 1.1, z: 0.45 })
    expect(second.impact.contactPoint.x - first.impact.contactPoint.x).toBeCloseTo(0.9, 12)
    expect(second.impact.contactPoint.z - first.impact.contactPoint.z).toBeCloseTo(0.95, 12)
    expect(DEFAULT_TABLE_POSITION).toEqual({ x: 0, y: 0, z: 0 })
  })

  test('keeps the centered table on the floor at regulation height', () => {
    expect(DEFAULT_TABLE_POSITION.y).toBe(0)
    expect(DEFAULT_TABLE_POSITION.y + TABLE_SURFACE_Y).toBeCloseTo(0.76, 12)
  })

  test('clamps requested starts to the physical racket-side half', () => {
    const start = simulate(DEFAULT_PARAMS, DEFAULT_TABLE_POSITION, { x: 99, z: 99 }).incoming[0]
    expect(start.x).toBeCloseTo(-BALL_RADIUS, 8)
    expect(start.z).toBeCloseTo(TABLE_WIDTH / 2 - BALL_RADIUS, 8)
  })

  test('thicker sponge provides more dwell and shear travel', () => {
    const thin = simulate({ ...NEUTRAL_PARAMS, spongeThickness: 1, spongeHardness: 35, pathElevation: 30 })
    const thick = simulate({ ...NEUTRAL_PARAMS, spongeThickness: 2.3, spongeHardness: 35, pathElevation: 30 })
    expect(thick.impact.contactTime).toBeGreaterThan(thin.impact.contactTime)
    expect(thick.impact.spongeCompression).toBeGreaterThan(thin.impact.spongeCompression)
    expect(thick.impact.totalSpinRpm).toBeGreaterThan(thin.impact.totalSpinRpm)
  })

  test('a softer blade deflects further and returns less ball speed', () => {
    const soft = simulate({ ...DEFAULT_PARAMS, bladeStiffness: MATERIAL_LIMITS.bladeStiffness.min })
    const hard = simulate({ ...DEFAULT_PARAMS, bladeStiffness: MATERIAL_LIMITS.bladeStiffness.max })
    expect(soft.impact.bladeDeflection).toBeGreaterThan(hard.impact.bladeDeflection)
    expect(soft.impact.outgoingSpeed).toBeLessThan(hard.impact.outgoingSpeed)
  })

  test('derives the loaded blade mode from flexural rigidity and assembled mass', () => {
    const flexible = simulate({ ...DEFAULT_PARAMS, bladeStiffness: 1 })
    const stiff = simulate({ ...DEFAULT_PARAMS, bladeStiffness: 6 })
    const light = simulate({ ...DEFAULT_PARAMS, racketMass: 130 })
    const heavy = simulate({ ...DEFAULT_PARAMS, racketMass: 210 })
    expect(stiff.impact.bladeNaturalFrequency).toBeGreaterThan(flexible.impact.bladeNaturalFrequency)
    expect(stiff.impact.bladeDeflection).toBeLessThan(flexible.impact.bladeDeflection)
    expect(light.impact.bladeNaturalFrequency).toBeGreaterThan(heavy.impact.bladeNaturalFrequency)
  })

  test('modal blade damping dissipates vibration energy and limits deflection', () => {
    const lively = simulate({ ...DEFAULT_PARAMS, bladeDamping: MATERIAL_LIMITS.bladeDamping.min })
    const damped = simulate({ ...DEFAULT_PARAMS, bladeDamping: MATERIAL_LIMITS.bladeDamping.max })
    expect(damped.impact.bladeDissipatedEnergy).toBeGreaterThan(lively.impact.bladeDissipatedEnergy)
    expect(damped.impact.bladeDeflection).toBeLessThan(lively.impact.bladeDeflection)
  })

  test('sponge hardness changes deformation and contact rate without acting as a loss control', () => {
    const soft = simulate({ ...DEFAULT_PARAMS, spongeHardness: 25 })
    const hard = simulate({ ...DEFAULT_PARAMS, spongeHardness: 60 })
    expect(hard.impact.contactTime).toBeLessThan(soft.impact.contactTime)
    expect(hard.impact.spongeCompression).toBeLessThan(soft.impact.spongeCompression)
    expect(hard.impact.effectiveRestitution).toBeGreaterThan(soft.impact.effectiveRestitution)
    expect(hard.impact.outgoingSpeed).toBeGreaterThan(soft.impact.outgoingSpeed)
    expect(hard.impact.peakNormalForce).not.toBeCloseTo(soft.impact.peakNormalForce, 1)
  })

  test('sponge loss visibly dissipates rebound and spin energy', () => {
    const lively = simulate({ ...DEFAULT_PARAMS, spongeDamping: MATERIAL_LIMITS.spongeDamping.min })
    const lossy = simulate({ ...DEFAULT_PARAMS, spongeDamping: MATERIAL_LIMITS.spongeDamping.max })
    expect(lossy.impact.effectiveRestitution).toBeLessThan(lively.impact.effectiveRestitution)
    expect(lossy.impact.outgoingSpeed).toBeLessThan(lively.impact.outgoingSpeed)
    expect(lossy.impact.totalSpinRpm).toBeLessThan(lively.impact.totalSpinRpm)
  })

  test('topsheet loss lowers rebound without prescribing whole-racket restitution', () => {
    const lively = simulate({ ...DEFAULT_PARAMS, topsheetDamping: MATERIAL_LIMITS.topsheetDamping.min })
    const lossy = simulate({ ...DEFAULT_PARAMS, topsheetDamping: MATERIAL_LIMITS.topsheetDamping.max })
    expect(lossy.impact.effectiveRestitution).toBeLessThan(lively.impact.effectiveRestitution)
    expect(lossy.impact.outgoingSpeed).toBeLessThan(lively.impact.outgoingSpeed)
  })

  test('topsheet pre-tension stiffens indentation and changes tangential shear', () => {
    const setup = { ...NEUTRAL_PARAMS, pathElevation: 35, rubberGrip: 1.3 }
    const loose = simulate({ ...setup, topsheetTension: 0 })
    const tensioned = simulate({ ...setup, topsheetTension: MATERIAL_LIMITS.topsheetTension.max })
    expect(tensioned.impact.contactTime).toBeLessThan(loose.impact.contactTime)
    expect(tensioned.impact.spongeCompression).toBeLessThan(loose.impact.spongeCompression)
    expect(tensioned.impact.effectiveRestitution).toBeGreaterThan(loose.impact.effectiveRestitution)
    expect(tensioned.impact.outgoingSpeed).toBeGreaterThan(loose.impact.outgoingSpeed)
    expect(Math.abs(tensioned.impact.totalSpinRpm - loose.impact.totalSpinRpm)).toBeGreaterThan(5)
  })

  test('booster expands and softens the sponge while tensioning the topsheet', () => {
    const untreated = simulate({ ...NEUTRAL_PARAMS, boosterLevel: 0 })
    const boosted = simulate({ ...NEUTRAL_PARAMS, boosterLevel: 100 })
    expect(boosted.impact.effectiveSpongeThickness).toBeGreaterThan(untreated.impact.effectiveSpongeThickness)
    expect(boosted.impact.effectiveSpongeHardness).toBeLessThan(untreated.impact.effectiveSpongeHardness)
    expect(boosted.impact.effectiveTopsheetTension).toBeGreaterThan(untreated.impact.effectiveTopsheetTension)
    expect(boosted.impact.effectiveRestitution).toBeGreaterThan(untreated.impact.effectiveRestitution)
    expect(boosted.impact.outgoingSpeed).toBeGreaterThan(untreated.impact.outgoingSpeed)
  })

  test('viscoelastic restitution falls as normal impact speed rises', () => {
    const setup = {
      ...DEFAULT_PARAMS,
      ballElevation: 0,
      racketSpeed: 0,
      pathElevation: 0,
      faceTilt: 0,
      spinZ: 0,
      contactPhase: 0,
    }
    const slow = simulate({ ...setup, ballSpeed: 2 })
    const fast = simulate({ ...setup, ballSpeed: 15 })
    expect(fast.impact.effectiveRestitution).toBeLessThan(slow.impact.effectiveRestitution)
  })

  test('normal rebound follows the experimental speed and flexural-rigidity calibration', () => {
    const setup = {
      ...DEFAULT_PARAMS,
      ballElevation: 0,
      racketSpeed: 0,
      pathElevation: 0,
      faceTilt: 0,
      spinZ: 0,
      contactPhase: 0,
    }
    const speeds = [2, 5, 10, 20, 30]
    const restitution = speeds.map((ballSpeed) => (
      simulate({ ...setup, ballSpeed }).impact.effectiveRestitution
    ))
    for (let index = 0; index < speeds.length; index += 1) {
      expect(restitution[index]).toBeCloseTo(
        referenceRacketRestitution(speeds[index], DEFAULT_PARAMS.bladeStiffness),
        1,
      )
      if (index > 0) expect(restitution[index]).toBeLessThan(restitution[index - 1])
    }
    expect(referenceRacketRestitution(10, 6)).toBeGreaterThan(
      referenceRacketRestitution(10, 1),
    )
  })

  test('rubber-covered default contact has millisecond-scale dwell', () => {
    const dwellMilliseconds = simulate(DEFAULT_PARAMS).impact.contactTime * 1000
    expect(dwellMilliseconds).toBeGreaterThan(1)
    expect(dwellMilliseconds).toBeLessThan(1.8)
  })

  test('pre-contact acceleration changes circular speed at a timed contact point', () => {
    const setup = {
      ...DEFAULT_PARAMS,
      racketPath: 'circular' as const,
      circleContactTime: 0.05,
    }
    const decelerating = simulate({ ...setup, racketAcceleration: -100 })
    const accelerating = simulate({ ...setup, racketAcceleration: 100 })
    expect(accelerating.impact.outgoingSpeed).toBeGreaterThan(decelerating.impact.outgoingSpeed)
    expect(accelerating.impact.normalForce).toBeGreaterThan(decelerating.impact.normalForce)
  })

  test('after-contact deceleration slows the racket through dwell', () => {
    const continuing = simulate({ ...DEFAULT_PARAMS, afterContactDeceleration: 0 })
    const braking = simulate({ ...DEFAULT_PARAMS, afterContactDeceleration: 250 })
    expect(braking.impact.outgoingSpeed).toBeLessThan(continuing.impact.outgoingSpeed)
    expect(braking.impact.normalForce).toBeLessThan(continuing.impact.normalForce)
  })

  test('circular racket radius changes the contact tangent during dwell', () => {
    const tightArc = simulate({ ...DEFAULT_PARAMS, racketPath: 'circular', racketPathRadius: 0.1 })
    const broadArc = simulate({ ...DEFAULT_PARAMS, racketPath: 'circular', racketPathRadius: 2 })
    expect(Math.hypot(
      tightArc.impact.outgoingVelocity.x - broadArc.impact.outgoingVelocity.x,
      tightArc.impact.outgoingVelocity.y - broadArc.impact.outgoingVelocity.y,
      tightArc.impact.outgoingVelocity.z - broadArc.impact.outgoingVelocity.z,
    )).toBeGreaterThan(0.1)
  })

  test('circular contact angle moves the solved path tangent', () => {
    const start = simulate({ ...DEFAULT_PARAMS, racketPath: 'circular', circleContactAngle: 0 })
    const quarterCircle = simulate({ ...DEFAULT_PARAMS, racketPath: 'circular', circleContactAngle: 90 })
    expect(quarterCircle.impact.racketVelocity.x).not.toBeCloseTo(start.impact.racketVelocity.x, 4)
  })

  test('uses zero face path angle and tilt as a flat hit aligned with the path tangent', () => {
    for (const params of [
      { ...DEFAULT_PARAMS, racketPath: 'linear' as const, facePathAngle: 0, faceTilt: 0 },
      { ...DEFAULT_PARAMS, racketPath: 'circular' as const, facePathAngle: 0, faceTilt: 0, circleContactAngle: 74 },
    ]) {
      const impact = simulate(params).impact
      const racketSpeed = Math.hypot(
        impact.racketVelocity.x,
        impact.racketVelocity.y,
        impact.racketVelocity.z,
      )
      expect(impact.normal.x).toBeCloseTo(impact.racketVelocity.x / racketSpeed, 10)
      expect(impact.normal.y).toBeCloseTo(impact.racketVelocity.y / racketSpeed, 10)
      expect(impact.normal.z).toBeCloseTo(impact.racketVelocity.z / racketSpeed, 10)
    }
  })

  test('keeps circle side tilt continuous through 90 degrees', () => {
    const before = simulate({ ...DEFAULT_PARAMS, racketPath: 'circular', circleSideTilt: 89 }).impact.normal
    const after = simulate({ ...DEFAULT_PARAMS, racketPath: 'circular', circleSideTilt: 91 }).impact.normal
    expect(Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z)).toBeLessThan(0.05)
  })

  test('maps the neutral contact tangent from 12 through 3 to 6 o clock', () => {
    const far = simulate({ ...DEFAULT_PARAMS, racketPath: 'circular', circleContactAngle: 0 }).impact.racketVelocity
    const right = simulate({ ...DEFAULT_PARAMS, racketPath: 'circular', circleContactAngle: 90 }).impact.racketVelocity
    const back = simulate({ ...DEFAULT_PARAMS, racketPath: 'circular', circleContactAngle: 180 }).impact.racketVelocity
    expect(far.x).toBeGreaterThan(0)
    expect(far.z).toBeCloseTo(0, 10)
    expect(right.x).toBeCloseTo(0, 10)
    expect(right.z).toBeGreaterThan(0)
    expect(back.x).toBeLessThan(0)
    expect(back.z).toBeCloseTo(0, 10)
  })

  test('moves the circle center to reverse turning side while preserving the selected tangent', () => {
    const clockwise = simulate({
      ...DEFAULT_PARAMS,
      racketPath: 'circular',
      circleContactAngle: 63,
      circleDirection: 'clockwise',
    }).impact.racketVelocity
    const counterclockwise = simulate({
      ...DEFAULT_PARAMS,
      racketPath: 'circular',
      circleContactAngle: 63,
      circleDirection: 'counterclockwise',
    }).impact.racketVelocity
    expect(counterclockwise.x).toBeCloseTo(clockwise.x, 10)
    expect(counterclockwise.y).toBeCloseTo(clockwise.y, 10)
    expect(counterclockwise.z).toBeCloseTo(clockwise.z, 10)
  })

  test('advances the circular contact point from its reference tangent using elapsed time', () => {
    const quarterTurnTime = Math.PI * DEFAULT_PARAMS.racketPathRadius
      / (2 * DEFAULT_PARAMS.racketSpeed)
    const reference = simulate({
      ...DEFAULT_PARAMS,
      racketPath: 'circular',
      circleContactAngle: 0,
      circleContactTime: 0,
    }).impact.racketVelocity
    const quarterTurn = simulate({
      ...DEFAULT_PARAMS,
      racketPath: 'circular',
      circleContactAngle: 0,
      circleContactTime: quarterTurnTime,
    }).impact.racketVelocity
    expect(reference.x).toBeGreaterThan(0)
    expect(reference.z).toBeCloseTo(0, 10)
    expect(quarterTurn.x).toBeCloseTo(0, 10)
    expect(quarterTurn.z).toBeGreaterThan(0)
  })

  test('keeps linear and circular orientation controls independent', () => {
    const linear = simulate(DEFAULT_PARAMS)
    const linearWithCircleEdits = simulate({
      ...DEFAULT_PARAMS,
      circleSideTilt: 145,
      circleLift: -73,
      circleContactAngle: 210,
      circleContactTime: 0.17,
      circleDirection: 'counterclockwise',
    })
    expect(linearWithCircleEdits.impact.racketVelocity).toEqual(linear.impact.racketVelocity)
    expect(linearWithCircleEdits.impact.outgoingVelocity).toEqual(linear.impact.outgoingVelocity)

    const circular = simulate({ ...DEFAULT_PARAMS, racketPath: 'circular' })
    const circularWithLinearEdits = simulate({
      ...DEFAULT_PARAMS,
      racketPath: 'circular',
      pathAzimuth: -120,
      pathElevation: -35,
    })
    expect(circularWithLinearEdits.impact.racketVelocity).toEqual(circular.impact.racketVelocity)
    expect(circularWithLinearEdits.impact.normal).toEqual(circular.impact.normal)
  })

  test('detects sponge bottom-out under an extreme thin, soft collision', () => {
    const result = simulate({
      ...NEUTRAL_PARAMS,
      ballSpeed: 22,
      racketSpeed: 22,
      spongeThickness: 1,
      spongeHardness: 25,
    })
    expect(result.impact.bottomedOut).toBe(true)
    expect(result.impact.spongeCompressionRatio).toBeGreaterThanOrEqual(1)
  })

  test('uses practical foam travel without flagging an ordinary contact', () => {
    const ordinary = simulate(DEFAULT_PARAMS)
    const hardThin = simulate({
      ...NEUTRAL_PARAMS,
      ballSpeed: 15,
      racketSpeed: 20,
      spongeThickness: 1,
      spongeHardness: 25,
    })
    expect(ordinary.impact.bottomedOut).toBe(false)
    expect(ordinary.impact.spongeCompressionRatio).toBeLessThan(1)
    expect(hardThin.impact.bottomedOut).toBe(true)
    expect(hardThin.impact.spongeCompressionRatio).toBeGreaterThan(ordinary.impact.spongeCompressionRatio)
  })

  test('can bottom out within the visible controls at the default face orientation', () => {
    const result = simulate({
      ...DEFAULT_PARAMS,
      ballSpeed: 100 / 3.6,
      racketSpeed: 100 / 3.6,
      spongeThickness: MATERIAL_LIMITS.spongeThickness.min,
      spongeHardness: MATERIAL_LIMITS.spongeHardness.min,
    })
    expect(result.impact.bottomedOut).toBe(true)
    expect(result.impact.spongeCompressionRatio).toBe(1)
  })

  test('bounces only when the outgoing arc intersects the table bounds', () => {
    const downwardHit = {
      ...NEUTRAL_PARAMS,
      ballElevation: 5,
      faceTilt: -10,
      contactPhase: 30,
    }
    const onTable = simulate(downwardHit)
    expect(onTable.bounces.length).toBeGreaterThan(0)
    expect(onTable.bounces[0].y).toBeCloseTo(TABLE_SURFACE_Y + BALL_RADIUS, 8)
    expect(onTable.outgoing.find((point) => point.t > onTable.bounces[0].t)?.velocity.y).toBeGreaterThan(0)
    expect(simulate({ ...NEUTRAL_PARAMS, pathElevation: 30 }).bounces).toHaveLength(0)
  })

  test('table friction transfers horizontal slip into spin', () => {
    const bounceSetup = { ...NEUTRAL_PARAMS, ballElevation: 5, faceTilt: -10, contactPhase: 30 }
    const slippery = simulate({ ...bounceSetup, tableFriction: 0 })
    const grippy = simulate({ ...bounceSetup, tableFriction: 0.6 })
    const slipperyAfterBounce = slippery.outgoing.find((point) => point.t >= slippery.bounces[0].t)!
    const grippyAfterBounce = grippy.outgoing.find((point) => point.t >= grippy.bounces[0].t)!
    expect(Math.abs(grippyAfterBounce.spin.z)).toBeGreaterThan(Math.abs(slipperyAfterBounce.spin.z))
    expect(grippy.bounces[0].speedAfter).toBeLessThan(slippery.bounces[0].speedAfter)
  })

  test('blocks low shots with the regulation-height net', () => {
    const result = simulate(
      {
        ...NEUTRAL_PARAMS,
        contactPhase: 0,
        pathElevation: 0,
        spinZ: 3000,
      },
      DEFAULT_TABLE_POSITION,
      { x: TABLE_LENGTH / 4, z: 0 },
    )
    const hitIndex = result.outgoing.findIndex((point, index) => (
      index > 0
      && result.outgoing[index - 1].velocity.x > 0
      && point.velocity.x < 0
      && Math.abs(point.x) <= BALL_RADIUS + 0.001
    ))

    expect(hitIndex).toBeGreaterThan(0)
    const before = result.outgoing[hitIndex - 1]
    const after = result.outgoing[hitIndex]
    const speedBefore = Math.hypot(before.velocity.x, before.velocity.y, before.velocity.z)
    const speedAfter = Math.hypot(after.velocity.x, after.velocity.y, after.velocity.z)
    const spinBefore = Math.hypot(before.spin.x, before.spin.y, before.spin.z)
    const spinAfter = Math.hypot(after.spin.x, after.spin.y, after.spin.z)
    expect(after.y - BALL_RADIUS).toBeLessThanOrEqual(TABLE_SURFACE_Y + NET_HEIGHT + 1e-9)
    expect(speedAfter).toBeLessThan(speedBefore * 0.12)
    expect(spinAfter).toBeLessThan(spinBefore * 0.08)
  })

  test('keeps the ball outside the solid sides and underside of the tabletop', () => {
    const shots = [
      simulate({ ...DEFAULT_PARAMS, contactPhase: 50, pathElevation: -30, faceTilt: -60 }),
      simulate({ ...DEFAULT_PARAMS, contactPhase: 90, pathElevation: 90, faceTilt: -20 }),
      simulate({ ...DEFAULT_PARAMS, contactPhase: 0, pathElevation: -60, faceTilt: 60 }),
    ]
    const clampToBox = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))

    for (const result of shots) {
      for (const point of result.outgoing) {
        const nearestX = clampToBox(point.x, -TABLE_LENGTH / 2, TABLE_LENGTH / 2)
        const nearestY = clampToBox(point.y, TABLE_SURFACE_Y - TABLE_THICKNESS, TABLE_SURFACE_Y)
        const nearestZ = clampToBox(point.z, -TABLE_WIDTH / 2, TABLE_WIDTH / 2)
        const distance = Math.hypot(
          point.x - nearestX,
          point.y - nearestY,
          point.z - nearestZ,
        )
        expect(distance).toBeGreaterThanOrEqual(BALL_RADIUS - 0.0001)
      }
    }
  })

  test('terminates the calculated flight exactly when the ball reaches the floor', () => {
    const shots = [
      simulate(DEFAULT_PARAMS),
      simulate({ ...DEFAULT_PARAMS, racketSpeed: 22, pathElevation: 90 }),
    ]
    for (const result of shots) {
      expect(result.termination).toBe('floor')
      const final = result.outgoing[result.outgoing.length - 1]
      expect(final.y).toBeCloseTo(BALL_RADIUS, 12)
      expect(final.velocity.y).toBeLessThan(0)
      expect(result.outgoing.every((point) => point.y >= BALL_RADIUS - 1e-12)).toBe(true)
    }
  })

  test('settles and stops a low-velocity ball on the table', () => {
    const params = {
      ...DEFAULT_PARAMS,
      ballSpeed: 0.1,
      racketSpeed: 0,
      topsheetDamping: MATERIAL_LIMITS.topsheetDamping.max,
      spongeDamping: MATERIAL_LIMITS.spongeDamping.max,
      bladeDamping: MATERIAL_LIMITS.bladeDamping.max,
      contactPhase: 0,
    }
    const result = simulate(params)
    const final = result.outgoing[result.outgoing.length - 1]
    expect(result.termination).toBe('table-rest')
    expect(final.y).toBeCloseTo(TABLE_SURFACE_Y + BALL_RADIUS, 12)
    expect(Math.hypot(final.velocity.x, final.velocity.y, final.velocity.z)).toBe(0)
    expect(Math.hypot(final.spin.x, final.spin.y, final.spin.z)).toBe(0)
  })

  function unitVector(v: { x: number; y: number; z: number }) {
    const magnitude = Math.hypot(v.x, v.y, v.z)
    return { x: v.x / magnitude, y: v.y / magnitude, z: v.z / magnitude }
  }

  function expectClose(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, precision = 8) {
    expect(a.x).toBeCloseTo(b.x, precision)
    expect(a.y).toBeCloseTo(b.y, precision)
    expect(a.z).toBeCloseTo(b.z, precision)
  }

  test('solving circular params from a linear setup reproduces the same contact direction and face normal', () => {
    const linearSetups = [
      { pathAzimuth: 0, pathElevation: 60, facePathAngle: 0, faceTilt: -30 },
      { pathAzimuth: -28, pathElevation: 36, facePathAngle: 40, faceTilt: 15 },
      { pathAzimuth: 120, pathElevation: -20, facePathAngle: -70, faceTilt: 55 },
    ]
    for (const setup of linearSetups) {
      const before = simulate({ ...DEFAULT_PARAMS, racketPath: 'linear', ...setup })
      const solved = solveCircularContactParams(before.impact.racketVelocity, before.impact.normal, DEFAULT_PARAMS.circleDirection)
      const after = simulate({ ...DEFAULT_PARAMS, racketPath: 'circular', ...solved })
      expectClose(unitVector(before.impact.racketVelocity), unitVector(after.impact.racketVelocity))
      expectClose(before.impact.normal, after.impact.normal)
    }
  })

  test('solving linear params from a circular setup reproduces the same contact direction and face normal', () => {
    const circularSetups = [
      { circleSideTilt: 0, circleLift: 0, circleContactAngle: 0, circleContactTime: 0 },
      { circleSideTilt: 40, circleLift: -25, circleContactAngle: 63, circleContactTime: 0.02 },
      { circleSideTilt: 145, circleLift: -73, circleContactAngle: 210, circleContactTime: 0.05, circleDirection: 'counterclockwise' as const, facePathAngle: 33, faceTilt: -12 },
    ]
    for (const setup of circularSetups) {
      const before = simulate({ ...DEFAULT_PARAMS, racketPath: 'circular', ...setup })
      const solved = solveLinearContactParams(before.impact.racketVelocity, before.impact.normal)
      const after = simulate({ ...DEFAULT_PARAMS, racketPath: 'linear', ...solved })
      expectClose(unitVector(before.impact.racketVelocity), unitVector(after.impact.racketVelocity))
      expectClose(before.impact.normal, after.impact.normal)
    }
  })
})
