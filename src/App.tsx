import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Billboard, Grid, Line, OrbitControls, RoundedBox, Text } from '@react-three/drei'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import {
  Activity,
  ArrowLeftRight,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  CircleDashed,
  Eye,
  Gauge,
  Info,
  Layers3,
  Moon,
  MoveRight,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  SkipBack,
  Sun,
  Target,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import {
  BALL_RADIUS,
  BOOSTER_EFFECTS,
  DEFAULT_BALL_START,
  DEFAULT_PARAMS,
  DEFAULT_TABLE_POSITION,
  MATERIAL_LIMITS,
  NET_HEIGHT,
  NET_WIDTH,
  SIM_START_TIME,
  TABLE_LENGTH,
  TABLE_SURFACE_Y,
  TABLE_THICKNESS,
  TABLE_WIDTH,
  sampleTrajectory,
  simulate,
  solveCircularContactParams,
  solveLinearContactParams,
  type CircleDirection,
  type SimParams,
  type SimResult,
  type BallStart,
  type Vec3,
} from './physics'

const DEFAULT_START_TIME = SIM_START_TIME
const STEP = 1 / 120
const ANGLE_STEP = 0.1
const MAX_SPEED_MPS = 100 / 3.6
const SCENE_CENTER: Vec3 = { x: 0, y: TABLE_SURFACE_Y, z: 0 }

type CameraPreset = 'free' | 'side' | 'front' | 'top' | 'ball'
type SpeedUnit = 'm/s' | 'km/h'
type ZoomRequest = { level: number; id: number }
type CameraPov = {
  direction: [number, number, number]
  up: [number, number, number]
}

const STROKE_BENCHMARKS = [
  { stroke: 'Push', speed: [10 / 3.6, 10 / 3.6], approximate: true, spin: '~1,700', direction: 'back' },
  { stroke: 'Drive', speed: [15.8, 19.2], approximate: false, spin: '3,000–3,200', direction: 'top' },
  { stroke: 'Loop', speed: [12.3, 23.6], approximate: false, spin: '6,200–8,800', direction: 'top' },
  { stroke: 'Flick', speed: [12.02, 12.02], approximate: true, spin: '4,600–7,200', direction: 'top / side' },
] as const

const ELITE_TOPSPIN_RACKET_SPEED = [15, 20] as const
const ELITE_TOPSPIN_RACKET_ACCELERATION = [150, 180] as const

const formatBenchmarkSpeed = (
  speed: readonly [number, number],
  approximate: boolean,
  unit: SpeedUnit,
) => {
  const scale = unit === 'km/h' ? 3.6 : 1
  const decimals = unit === 'km/h' ? 0 : 1
  const low = (speed[0] * scale).toFixed(decimals)
  const high = (speed[1] * scale).toFixed(decimals)
  return `${approximate ? '~' : ''}${low === high ? low : `${low}–${high}`}`
}

const zoomLimits = (preset: CameraPreset) => preset === 'ball'
  ? { min: 0.025, max: 10 }
  : { min: 0.3, max: 40 }
const zoomLevelFromDistance = (distance: number, preset: CameraPreset) => {
  const { min, max } = zoomLimits(preset)
  const boundedDistance = Math.max(min, Math.min(max, distance))
  return 100 * Math.log(max / boundedDistance) / Math.log(max / min)
}
const distanceFromZoomLevel = (level: number, preset: CameraPreset) => {
  const { min, max } = zoomLimits(preset)
  return max * Math.pow(min / max, Math.max(0, Math.min(100, level)) / 100)
}
const defaultZoomDistance = (preset: CameraPreset) => {
  if (preset === 'ball') return 0.32
  if (preset === 'top') return 9.2
  if (preset === 'side' || preset === 'front') return 8.2
  return Math.hypot(5.8, 3.7 - TABLE_SURFACE_Y, 6.5)
}

const toArray = (v: Vec3): [number, number, number] => [v.x, v.y, v.z]
const magnitude = (v: Vec3) => Math.hypot(v.x, v.y, v.z)
const boundedKinematicState = (initialSpeed: number, acceleration: number, time: number) => {
  let travelTime = time
  if (acceleration > 0 && time < 0) {
    travelTime = Math.max(time, -initialSpeed / acceleration)
  } else if (acceleration < 0 && time > 0) {
    travelTime = Math.min(time, initialSpeed / -acceleration)
  }
  return {
    speed: Math.max(0, initialSpeed + acceleration * travelTime),
    distance: initialSpeed * travelTime + 0.5 * acceleration * travelTime * travelTime,
  }
}

function TableIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="9" width="20" height="3" rx="1" />
      <line x1="5" y1="12" x2="5" y2="20" />
      <line x1="19" y1="12" x2="19" y2="20" />
      <line x1="12" y1="4" x2="12" y2="9" />
    </svg>
  )
}

function RacketIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="10" cy="9" r="6.5" />
      <line x1="14.5" y1="13.5" x2="19" y2="19" strokeWidth={2.75} />
    </svg>
  )
}

function BouncingBallIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <line x1="2" y1="21" x2="22" y2="21" />
      <path d="M2 21 Q7 2 12 21" />
      <path d="M12 21 Q16.5 10 21 21" />
    </svg>
  )
}

// Roll/sidespin/top-backspin are meaningful only relative to the direction the ball is
// actually headed, not the fixed world axes spin is stored in. Sidespin's axis (vertical)
// doesn't change with heading, but which way reads as "left" does, and roll/top-backspin's
// axes are rebuilt from the ball's current horizontal heading so the labels stay correct
// no matter which way the ball is launched or bounces.
function resolveSpinComponents(spin: Vec3, travelDirection: Vec3) {
  const horizontalMagnitude = Math.hypot(travelDirection.x, travelDirection.z)
  const forward = horizontalMagnitude > 1e-6
    ? { x: travelDirection.x / horizontalMagnitude, z: travelDirection.z / horizontalMagnitude }
    : { x: -1, z: 0 }
  const roll = -(spin.x * forward.x + spin.z * forward.z)
  const sidespin = spin.y
  const topBack = spin.x * forward.z - spin.z * forward.x
  return { roll, sidespin, topBack }
}

function EditableValue({
  label,
  value,
  min,
  max,
  step,
  unit,
  className = 'control-value',
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  unit: string
  className?: string
  onChange: (value: number) => void
}) {
  const decimals = Number.isInteger(step) ? 0 : step < 0.1 ? 2 : 1
  const format = useCallback((nextValue: number) => nextValue.toFixed(decimals), [decimals])
  const [draft, setDraft] = useState(() => format(value))
  const [editing, setEditing] = useState(false)
  const cancelOnBlur = useRef(false)

  useEffect(() => {
    if (!editing) setDraft(format(value))
  }, [editing, format, value])

  const commit = () => {
    const parsed = Number(draft.trim().replace(',', '.'))
    if (!Number.isFinite(parsed)) {
      setDraft(format(value))
      return
    }
    const bounded = Math.max(min, Math.min(max, parsed))
    setDraft(format(bounded))
    onChange(bounded)
  }

  return (
    <span className={className}>
      <input
        type="text"
        inputMode="decimal"
        value={draft}
        aria-label={`Edit ${label}`}
        onFocus={() => setEditing(true)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (cancelOnBlur.current) cancelOnBlur.current = false
          else commit()
          setEditing(false)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
          if (event.key === 'Escape') {
            cancelOnBlur.current = true
            setDraft(format(value))
            event.currentTarget.blur()
          }
        }}
      />
      {unit && <small>{unit}</small>}
    </span>
  )
}

function useBallSeamTexture() {
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 1024
    canvas.height = 512
    const context = canvas.getContext('2d')!
    context.fillStyle = '#fbfaf4'
    context.fillRect(0, 0, canvas.width, canvas.height)

    const drawMeridian = (x: number, color: string, width: number) => {
      context.beginPath()
      context.moveTo(x, 0)
      context.lineTo(x, canvas.height)
      context.strokeStyle = color
      context.lineWidth = width
      context.stroke()
    }
    // Each great circle appears twice in an equirectangular map. Both pairs
    // converge at the sphere's poles and therefore rotate with the spin axis.
    drawMeridian(0, '#f08a24', 30)
    drawMeridian(canvas.width, '#f08a24', 30)
    drawMeridian(canvas.width / 2, '#f08a24', 30)
    drawMeridian(canvas.width / 4, '#111111', 20)
    drawMeridian(canvas.width * 3 / 4, '#111111', 20)

    const ballTexture = new THREE.CanvasTexture(canvas)
    ballTexture.colorSpace = THREE.SRGBColorSpace
    ballTexture.wrapS = THREE.RepeatWrapping
    ballTexture.needsUpdate = true
    return ballTexture
  }, [])
  useEffect(() => () => texture.dispose(), [texture])
  return texture
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  unit,
  defaultValue,
  displayScale = 1,
  effectiveValue,
  effectiveMin,
  effectiveMax,
  accent = 'mint',
  onChange,
  onEffectiveChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  unit: string
  defaultValue: number
  displayScale?: number
  effectiveValue?: number
  effectiveMin?: number
  effectiveMax?: number
  accent?: 'mint' | 'coral' | 'violet'
  onChange: (value: number) => void
  onEffectiveChange?: (value: number) => void
}) {
  const progress = ((value - min) / (max - min)) * 100
  const effectiveProgress = effectiveValue === undefined
    ? progress
    : Math.max(0, Math.min(100, (effectiveValue - min) / (max - min) * 100))
  const hasEffectiveValue = effectiveValue !== undefined && Math.abs(effectiveValue - value) > 1e-9
  const boostStart = Math.min(progress, effectiveProgress)
  const boostEnd = Math.max(progress, effectiveProgress)
  const displayedStep = step * displayScale
  const shownValue = (effectiveValue ?? value) * displayScale
  const shownMin = (effectiveMin ?? min) * displayScale
  const shownMax = (effectiveMax ?? max) * displayScale
  return (
    <div className="control-row">
      <span className="control-label">{label}</span>
      <EditableValue
        label={label}
        value={shownValue}
        min={shownMin}
        max={shownMax}
        step={displayedStep}
        unit={unit}
        className={hasEffectiveValue ? 'control-value effective-control-value' : 'control-value'}
        onChange={(displayedValue) => {
          const nextValue = displayedValue / displayScale
          if (hasEffectiveValue && onEffectiveChange) onEffectiveChange(nextValue)
          else onChange(nextValue)
        }}
      />
      <button
        type="button"
        className="slider-reset"
        aria-label={`Reset ${label}`}
        title={`Reset ${label}`}
        disabled={value === defaultValue}
        onClick={() => onChange(defaultValue)}
      >
        <RotateCcw size={12} strokeWidth={3.2} />
      </button>
      <div className="range-shell">
        <input
          className={`range range-${accent}${hasEffectiveValue ? ' range-boosted' : ''}`}
          style={{
            '--progress': `${progress}%`,
            '--boost-start': `${boostStart}%`,
            '--boost-end': `${boostEnd}%`,
          } as React.CSSProperties}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          onDoubleClick={() => onChange(defaultValue)}
        />
        {hasEffectiveValue && (
          <i className="boost-effective-marker" style={{ left: `${effectiveProgress}%` }} aria-hidden="true" />
        )}
      </div>
      <span className="range-bounds">
        <i>{Number((min * displayScale).toFixed(1))}</i>
        <i>{Number((max * displayScale).toFixed(1))}</i>
      </span>
    </div>
  )
}

function Section({
  icon,
  eyebrow,
  title,
  children,
  tone,
}: {
  icon: React.ReactNode
  eyebrow: string
  title: string
  children: React.ReactNode
  tone: 'coral' | 'mint' | 'violet'
}) {
  const [expanded, setExpanded] = useState(true)
  return (
    <section className="control-section">
      <button className="section-toggle" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
        <div className={`section-icon ${tone}`}>{icon}</div>
        <div className="section-heading">
          <h2><span>{eyebrow}</span>{title}</h2>
        </div>
        <ChevronDown size={16} className={`section-chevron ${expanded ? '' : 'collapsed'}`} />
      </button>
      {expanded && <div className="section-content">{children}</div>}
    </section>
  )
}

const cameraScreenRight = (cameraPov: CameraPov) => new THREE.Vector3(...cameraPov.direction)
  .negate()
  .cross(new THREE.Vector3(...cameraPov.up))
  .normalize()

function BallStartPicker({
  value,
  cameraPov,
  onChange,
}: {
  value: BallStart
  cameraPov: CameraPov
  onChange: (value: BallStart) => void
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const dragging = useRef(false)
  const minimumX = BALL_RADIUS
  const maximumX = TABLE_LENGTH / 2 - BALL_RADIUS
  const minimumAcross = -TABLE_WIDTH / 2 + BALL_RADIUS
  const maximumAcross = TABLE_WIDTH / 2 - BALL_RADIUS
  const xPercentage = (maximumX - value.x) / (maximumX - minimumX) * 100
  const yPercentage = (value.z - minimumAcross) / (maximumAcross - minimumAcross) * 100
  const screenRight = cameraScreenRight(cameraPov)
  const flipX = screenRight.x < 0
  const flipY = cameraPov.up[2] > 0
  const updateFromPointer = (event: React.PointerEvent<SVGSVGElement>) => {
    const bounds = svgRef.current?.getBoundingClientRect()
    if (!bounds) return
    const displayX = (event.clientX - bounds.left) / bounds.width
    const displayY = (event.clientY - bounds.top) / bounds.height
    const normalizedX = Math.max(0.025, Math.min(0.49, flipX ? 1 - displayX : displayX))
    const normalizedZ = Math.max(0.035, Math.min(0.965, flipY ? 1 - displayY : displayY))
    onChange({
      x: normalizedX * 2.74,
      z: (normalizedZ - 0.5) * 1.525,
    })
  }
  const physicalMarkerX = value.x / 2.74 * 274
  const physicalMarkerY = (value.z / 1.525 + 0.5) * 152.5
  const markerX = flipX ? 274 - physicalMarkerX : physicalMarkerX
  const markerY = flipY ? 152.5 - physicalMarkerY : physicalMarkerY
  return (
    <div className="start-picker">
      <div className="start-picker-heading">
        <div><strong>Ball start</strong><span>Racket-side half only</span></div>
        <button
          className="slider-reset card-reset"
          title="Reset ball start"
          aria-label="Reset ball start"
          disabled={value.x === DEFAULT_BALL_START.x && value.z === DEFAULT_BALL_START.z}
          onClick={() => onChange(DEFAULT_BALL_START)}
        ><RotateCcw size={12} strokeWidth={3.2} /></button>
      </div>
      <svg
        ref={svgRef}
        viewBox="0 0 274 152.5"
        role="slider"
        aria-label="Select the ball start position on the racket-side table half"
        onPointerDown={(event) => {
          dragging.current = true
          event.currentTarget.setPointerCapture(event.pointerId)
          updateFromPointer(event)
        }}
        onPointerMove={(event) => { if (dragging.current) updateFromPointer(event) }}
        onPointerUp={(event) => {
          dragging.current = false
          event.currentTarget.releasePointerCapture(event.pointerId)
        }}
      >
        <rect width="274" height="152.5" className="picker-table" />
        <rect x={flipX ? 137 : 0} width="137" height="152.5" className="picker-active-half" />
        <path d="M137 0V152.5M0 1H274V151.5H0Z" className="picker-lines" />
        <path d="M0 76.25H274" className="picker-midline" />
        <text x={flipX ? 205.5 : 68.5} y="16" className="picker-label" textAnchor="middle">RACKET SIDE</text>
        <text x={flipX ? 68.5 : 205.5} y="16" className="picker-label muted" textAnchor="middle">OPPONENT SIDE</text>
        <circle cx={markerX} cy={markerY} r="8" className="picker-marker-ring" />
        <circle cx={markerX} cy={markerY} r="4" className="picker-marker" />
      </svg>
      <div className="start-coordinate-inputs">
        <div className="start-coordinate-field">
          <span>X</span>
          <EditableValue
            className="start-coordinate-value"
            label="Ball start X coordinate"
            value={xPercentage}
            min={0}
            max={100}
            step={0.1}
            unit="%"
            onChange={(percentage) => onChange({
              ...value,
              x: maximumX - percentage / 100 * (maximumX - minimumX),
            })}
          />
        </div>
        <div className="start-coordinate-field">
          <span>Y</span>
          <EditableValue
            className="start-coordinate-value"
            label="Ball start Y coordinate"
            value={yPercentage}
            min={0}
            max={100}
            step={0.1}
            unit="%"
            onChange={(percentage) => onChange({
              ...value,
              z: minimumAcross + percentage / 100 * (maximumAcross - minimumAcross),
            })}
          />
        </div>
      </div>
    </div>
  )
}

function ContactArcControl({
  value,
  trajectory,
  noHitProjection,
  cameraPov,
  onChange,
}: {
  value: number
  trajectory: SimResult['incoming']
  noHitProjection: SimResult['noHitProjection']
  cameraPov: CameraPov
  onChange: (value: number) => void
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const dragging = useRef(false)
  const [isDragging, setIsDragging] = useState(false)
  const phase = value / 100
  const launch = trajectory[0]
  const allPoints = [...trajectory, ...noHitProjection.slice(1)]
  const horizontalSpeed = Math.hypot(launch.velocity.x, launch.velocity.z)
  const horizontalDirection = horizontalSpeed > 1e-8
    ? { x: launch.velocity.x / horizontalSpeed, z: launch.velocity.z / horizontalSpeed }
    : { x: 1, z: 0 }
  const screenRight = cameraScreenRight(cameraPov)
  const flipHorizontal = horizontalDirection.x * screenRight.x + horizontalDirection.z * screenRight.z < 0
  const forwardDistances = allPoints.map((point) => (
    (point.x - launch.x) * horizontalDirection.x + (point.z - launch.z) * horizontalDirection.z
  ))
  const referenceDistance = Math.max(0.25, horizontalSpeed * 0.6)
  const minimumDistance = Math.min(-referenceDistance * 0.06, ...forwardDistances)
  const maximumDistance = Math.max(referenceDistance, ...forwardDistances)
  const minimumY = Math.min(0, ...allPoints.map((point) => point.y - 0.08))
  const maximumY = Math.max(1.5, ...allPoints.map((point) => point.y + 0.08))
  const projectPoint = (point: SimResult['incoming'][number]) => {
    const projectedX = 14 + (
      (point.x - launch.x) * horizontalDirection.x
      + (point.z - launch.z) * horizontalDirection.z
      - minimumDistance
    ) / Math.max(1e-8, maximumDistance - minimumDistance) * 246
    return {
      x: flipHorizontal ? 274 - projectedX : projectedX,
      y: 82 - (point.y - minimumY) / Math.max(1e-8, maximumY - minimumY) * 70,
    }
  }
  const projectedIncoming = trajectory.map(projectPoint)
  const projectedNoHit = noHitProjection.map(projectPoint)
  const apexIndex = allPoints.reduce(
    (highestIndex, point, index) => point.y >= allPoints[highestIndex].y - 1e-9 ? index : highestIndex,
    0,
  )
  const apex = projectPoint(allPoints[apexIndex])
  const incomingPath = projectedIncoming.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ')
  const noHitPath = projectedNoHit.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ')
  const start = projectedIncoming[0]
  const contact = projectedIncoming[projectedIncoming.length - 1]
  const apexLabelBelow = apex.y < 16
  const contactFlightTime = -trajectory[0].t
  const absoluteTimes = [
    ...trajectory.map((point) => point.t + contactFlightTime),
    ...noHitProjection.slice(1).map((point) => point.t + contactFlightTime),
  ]
  const apexTime = absoluteTimes[apexIndex]
  const floorTime = absoluteTimes[absoluteTimes.length - 1]

  const updateFromPointer = (event: React.PointerEvent<SVGSVGElement>) => {
    const bounds = svgRef.current?.getBoundingClientRect()
    if (!bounds || allPoints.length < 2) return
    const pointer = {
      x: (event.clientX - bounds.left) / bounds.width * 274,
      y: (event.clientY - bounds.top) / bounds.height * 90,
    }
    const projectedAll = [...projectedIncoming, ...projectedNoHit.slice(1)]
    let closestTime = absoluteTimes[0]
    let closestDistanceSquared = Number.POSITIVE_INFINITY
    for (let index = 0; index < projectedAll.length - 1; index += 1) {
      const startPoint = projectedAll[index]
      const endPoint = projectedAll[index + 1]
      const dx = endPoint.x - startPoint.x
      const dy = endPoint.y - startPoint.y
      const lengthSquared = dx * dx + dy * dy
      const segmentPhase = lengthSquared > 1e-12
        ? Math.max(0, Math.min(1, ((pointer.x - startPoint.x) * dx + (pointer.y - startPoint.y) * dy) / lengthSquared))
        : 0
      const nearestX = startPoint.x + dx * segmentPhase
      const nearestY = startPoint.y + dy * segmentPhase
      const distanceSquared = (pointer.x - nearestX) ** 2 + (pointer.y - nearestY) ** 2
      if (distanceSquared < closestDistanceSquared) {
        closestDistanceSquared = distanceSquared
        closestTime = absoluteTimes[index]
          + (absoluteTimes[index + 1] - absoluteTimes[index]) * segmentPhase
      }
    }
    const nextPhase = closestTime <= apexTime
      ? (apexTime > 1e-9 ? 50 * closestTime / apexTime : 0)
      : 50 + (floorTime > apexTime + 1e-9 ? 50 * (closestTime - apexTime) / (floorTime - apexTime) : 0)
    onChange(Math.round(Math.max(0, Math.min(100, nextPhase))))
  }

  const finishDragging = (event: React.PointerEvent<SVGSVGElement>) => {
    dragging.current = false
    setIsDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  return (
    <div className="contact-arc-control">
      <div className="contact-arc-heading">
        <div><strong>Contact point in flight</strong></div>
        <EditableValue
          className="contact-arc-value"
          label="Contact point in flight"
          value={value}
          min={0}
          max={100}
          step={1}
          unit="%"
          onChange={onChange}
        />
        <button
          type="button"
          className="slider-reset card-reset"
          title="Reset contact point"
          aria-label="Reset contact point"
          disabled={value === DEFAULT_PARAMS.contactPhase}
          onClick={() => onChange(DEFAULT_PARAMS.contactPhase)}
        ><RotateCcw size={12} strokeWidth={3.2} /></button>
      </div>
      <svg
        ref={svgRef}
        viewBox="0 0 274 90"
        role="slider"
        tabIndex={0}
        aria-label="Racket contact point in flight"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        className={isDragging ? 'dragging' : ''}
        onPointerDown={(event) => {
          dragging.current = true
          setIsDragging(true)
          event.currentTarget.setPointerCapture(event.pointerId)
          updateFromPointer(event)
        }}
        onPointerMove={(event) => { if (dragging.current) updateFromPointer(event) }}
        onPointerUp={finishDragging}
        onPointerCancel={finishDragging}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
            event.preventDefault()
            onChange(Math.max(0, Math.min(100, value + (flipHorizontal && event.key === 'ArrowLeft' ? 1 : -1))))
          } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
            event.preventDefault()
            onChange(Math.max(0, Math.min(100, value + (flipHorizontal && event.key === 'ArrowRight' ? -1 : 1))))
          } else if (event.key === 'Home') {
            event.preventDefault()
            onChange(0)
          } else if (event.key === 'End') {
            event.preventDefault()
            onChange(100)
          }
        }}
      >
        <line x1={apex.x} y1={apex.y} x2={apex.x} y2="86" className="contact-arc-apex-guide" />
        <path d={noHitPath} className="contact-arc-unhit" />
        <path d={incomingPath} className="contact-arc-active" />
        <circle cx={apex.x} cy={apex.y} r="4" className="contact-arc-apex-ring" />
        <circle cx={apex.x} cy={apex.y} r="2" className="contact-arc-apex" />
        <text
          x={apex.x}
          y={apexLabelBelow ? apex.y + 13 : apex.y - 10}
          textAnchor="middle"
          className="contact-arc-apex-label"
        >APEX</text>
        <circle cx={start.x} cy={start.y} r="4" className="contact-arc-launch" />
        <circle cx={contact.x} cy={contact.y} r="7" className="contact-arc-ring" />
        <circle cx={contact.x} cy={contact.y} r="3.5" className="contact-arc-marker" />
      </svg>
      <input
        className="range range-coral"
        style={{ '--progress': `${(flipHorizontal ? 1 - phase : phase) * 100}%` } as React.CSSProperties}
        type="range"
        min={0}
        max={100}
        step={1}
        value={value}
        aria-label="Contact point in flight"
        dir={flipHorizontal ? 'rtl' : 'ltr'}
        onChange={(event) => onChange(Number(event.target.value))}
        onDoubleClick={() => onChange(DEFAULT_PARAMS.contactPhase)}
      />
      <span className="range-bounds">
        {flipHorizontal ? <><i>100% · floor</i><i>0% · launch</i></> : <><i>0% · launch</i><i>100% · floor</i></>}
      </span>
    </div>
  )
}

function CameraRig({
  preset,
  result,
  time,
  controlsRef,
}: {
  preset: CameraPreset
  result: SimResult
  time: number
  controlsRef: React.RefObject<React.ElementRef<typeof OrbitControls> | null>
}) {
  const { camera } = useThree()
  const ballCameraInitialized = useRef(false)
  useEffect(() => {
    if (preset === 'ball') return
    const positions: Record<Exclude<CameraPreset, 'ball'>, [number, number, number]> = {
      free: [5.8, 3.7, -6.5],
      side: [SCENE_CENTER.x, SCENE_CENTER.y, SCENE_CENTER.z - 8.2],
      front: [SCENE_CENTER.x + 8.2, SCENE_CENTER.y, SCENE_CENTER.z],
      top: [SCENE_CENTER.x, SCENE_CENTER.y + 9.2, SCENE_CENTER.z],
    }
    camera.position.set(...positions[preset])
    if (preset === 'top') camera.up.set(0, 0, 1)
    else camera.up.set(0, 1, 0)
    camera.lookAt(SCENE_CENTER.x, SCENE_CENTER.y, SCENE_CENTER.z)
    camera.updateProjectionMatrix()
  }, [camera, preset])
  useEffect(() => {
    ballCameraInitialized.current = false
  }, [preset])
  useFrame(() => {
    if (preset !== 'ball') return
    const controls = controlsRef.current
    if (!controls) return
    const point = time < 0
      ? sampleTrajectory(result.incoming, time)
      : sampleTrajectory(result.outgoing, time)
    const ballPosition = new THREE.Vector3(point.x, point.y, point.z)
    if (!ballCameraInitialized.current) {
      const incomingStart = result.incoming[0]
      const towardRacket = new THREE.Vector3(
        result.impact.contactPoint.x - incomingStart.x,
        0,
        result.impact.contactPoint.z - incomingStart.z,
      )
      if (towardRacket.lengthSq() < 1e-10) towardRacket.set(-1, 0, 0)
      else towardRacket.normalize()
      camera.position.copy(ballPosition).addScaledVector(towardRacket, -0.32)
      camera.up.set(0, 1, 0)
      controls.target.copy(ballPosition)
      controls.update()
      ballCameraInitialized.current = true
      return
    }

    const offset = camera.position.clone().sub(controls.target)
    offset.y = 0
    controls.target.copy(ballPosition)
    camera.position.copy(ballPosition).add(offset)
    camera.up.set(0, 1, 0)
    camera.updateMatrixWorld()
  })
  return null
}

const vectorFromAngles = (azimuthDegrees: number, elevationDegrees: number) => {
  const azimuth = azimuthDegrees * Math.PI / 180
  const elevation = elevationDegrees * Math.PI / 180
  return new THREE.Vector3(
    Math.cos(elevation) * Math.cos(azimuth),
    Math.sin(elevation),
    Math.cos(elevation) * Math.sin(azimuth),
  ).normalize()
}

const circularPathFrame = (params: SimParams) => {
  // The neutral clock lies parallel to the table: +X is 12 o'clock and +Z is 3 o'clock.
  // The contact tangent angle rotates that neutral clock first, so the chosen clock
  // position becomes the new 12 o'clock. Side tilt then rotates around that 12–6
  // diameter, and lift rotates around the newly tilted 3–9 diameter — tilt and lift
  // always act relative to the actual contact tangent, not the untouched neutral frame.
  const tangentAngle = params.circleContactAngle * Math.PI / 180
  const tangentTwelve = new THREE.Vector3(1, 0, 0).multiplyScalar(Math.cos(tangentAngle))
    .addScaledVector(new THREE.Vector3(0, 0, 1), Math.sin(tangentAngle))
    .normalize()
  const tangentThree = new THREE.Vector3(1, 0, 0).multiplyScalar(-Math.sin(tangentAngle))
    .addScaledVector(new THREE.Vector3(0, 0, 1), Math.cos(tangentAngle))
    .normalize()
  const clockThree = tangentThree.clone()
    .applyAxisAngle(tangentTwelve, params.circleSideTilt * Math.PI / 180)
    .normalize()
  const clockTwelve = tangentTwelve.clone()
    .applyAxisAngle(clockThree, params.circleLift * Math.PI / 180)
    .normalize()
  const topDownFlipped = new THREE.Vector3()
    .crossVectors(clockTwelve, clockThree)
    .y > 0
  const referenceTangent = clockTwelve.clone()
  const referenceCenterDirection = clockThree.clone()
  if (params.circleDirection === 'counterclockwise') referenceCenterDirection.negate()
  const radius = Math.max(0.05, params.racketPathRadius)
  const referenceTime = params.circleContactTime
  const referenceDistance = boundedKinematicState(
    params.racketSpeed,
    params.racketAcceleration,
    referenceTime,
  ).distance
  const contactTravelAngle = referenceDistance / radius
  const tangent = referenceTangent.clone().multiplyScalar(Math.cos(contactTravelAngle))
    .addScaledVector(referenceCenterDirection, Math.sin(contactTravelAngle))
    .normalize()
  const centerDirection = referenceCenterDirection.clone().multiplyScalar(Math.cos(contactTravelAngle))
    .addScaledVector(referenceTangent, -Math.sin(contactTravelAngle))
    .normalize()
  const circleAxis = new THREE.Vector3().crossVectors(tangent, centerDirection).normalize()
  const inPlaneNormal = tangent.clone()
    .applyAxisAngle(circleAxis, params.facePathAngle * Math.PI / 180)
    .normalize()
  const faceTiltAxis = new THREE.Vector3().crossVectors(inPlaneNormal, circleAxis).normalize()
  const normal = inPlaneNormal.clone()
    .applyAxisAngle(faceTiltAxis, params.faceTilt * Math.PI / 180)
    .normalize()
  const handleDirection = centerDirection.clone()
  return {
    tangent,
    centerDirection,
    circleAxis,
    normal,
    handleDirection,
    clockTwelve,
    clockThree,
    topDownFlipped,
    contactTravelAngle,
  }
}

const racketQuaternion = (
  normalValue: THREE.Vector3,
  handleSide: 'left' | 'right',
  desiredHandleDirection?: THREE.Vector3 | null,
) => {
  const normal = normalValue.clone().normalize()
  let right: THREE.Vector3
  if (desiredHandleDirection) {
    const projectedHandle = desiredHandleDirection.clone()
      .addScaledVector(normal, -desiredHandleDirection.dot(normal))
    if (projectedHandle.lengthSq() > 1e-10) {
      right = projectedHandle.normalize().multiplyScalar(handleSide === 'left' ? -1 : 1)
    } else {
      const reference = Math.abs(normal.z) < 0.94 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0)
      right = reference.addScaledVector(normal, -reference.dot(normal)).normalize()
    }
  } else {
    const reference = Math.abs(normal.z) < 0.94 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0)
    right = reference.addScaledVector(normal, -reference.dot(normal)).normalize()
  }
  const up = new THREE.Vector3().crossVectors(normal, right).normalize()
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, normal))
}

function racketPoseAtTime(
  time: number,
  contactPoint: Vec3,
  contactNormal: Vec3,
  impactVelocity: Vec3,
  params: SimParams,
) {
  const speed = magnitude(impactVelocity)
  // Each phase stops at zero speed instead of allowing the quadratic path to
  // reverse. Acceleration owns t < 0; independent braking owns t > 0.
  const displacement = time <= 0
    ? boundedKinematicState(speed, params.racketAcceleration, time).distance
    : boundedKinematicState(speed, -Math.max(0, params.afterContactDeceleration), time).distance
  const position = new THREE.Vector3(contactPoint.x, contactPoint.y, contactPoint.z)

  if (params.racketPath === 'circular') {
    const frame = circularPathFrame(params)
    const radius = Math.max(0.05, params.racketPathRadius)
    const circleCenter = position.clone().addScaledVector(frame.centerDirection, radius)
    const angle = displacement / radius
    position
      .addScaledVector(frame.tangent, radius * Math.sin(angle))
      .addScaledVector(frame.centerDirection, radius * (1 - Math.cos(angle)))
    const normal = frame.normal.clone()
    const handleDirection = frame.handleDirection.clone()
    const rotationAxis = frame.circleAxis
    normal.applyAxisAngle(rotationAxis, angle)
    handleDirection.applyAxisAngle(rotationAxis, angle)
    return { position, normal, handleDirection, circleCenter }
  } else {
    const direction = speed > 1e-8
      ? new THREE.Vector3(impactVelocity.x, impactVelocity.y, impactVelocity.z).normalize()
      : vectorFromAngles(params.pathAzimuth, params.pathElevation)
    const normal = new THREE.Vector3(contactNormal.x, contactNormal.y, contactNormal.z).normalize()
    position.addScaledVector(direction, displacement)
    return { position, normal, handleDirection: null, circleCenter: null }
  }
}

function RacketModel({ handleSide }: { handleSide: 'left' | 'right' }) {
  const handleSign = handleSide === 'left' ? -1 : 1
  return (
    <>
      <mesh scale={[1.2, 1, 1]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.085, 0.085, 0.014, 64]} />
        <meshStandardMaterial color="#c95248" roughness={0.73} metalness={0.02} />
      </mesh>
      <mesh position={[0, 0, 0.008]} scale={[1.2, 1, 1]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.082, 0.082, 0.004, 64]} />
        <meshStandardMaterial color="#e66559" roughness={0.9} />
      </mesh>
      <RoundedBox args={[0.105, 0.025, 0.018]} radius={0.008} smoothness={4} position={[handleSign * 0.135, 0, -0.002]}>
        <meshStandardMaterial color="#b98959" roughness={0.74} />
      </RoundedBox>
    </>
  )
}

function Racket({
  time,
  result,
  params,
  handleSide,
}: {
  time: number
  result: SimResult
  params: SimParams
  handleSide: 'left' | 'right'
}) {
  const { contactPoint, normal: contactNormal, racketVelocity } = result.impact
  const pose = racketPoseAtTime(Math.min(time, 0.22), contactPoint, contactNormal, racketVelocity, params)
  const normal = { x: pose.normal.x, y: pose.normal.y, z: pose.normal.z }
  const facePoint = {
    x: pose.position.x,
    y: pose.position.y,
    z: pose.position.z,
  }
  const quaternion = racketQuaternion(pose.normal, handleSide, pose.handleDirection)
  const center = new THREE.Vector3(facePoint.x, facePoint.y, facePoint.z)
    .addScaledVector(new THREE.Vector3(normal.x, normal.y, normal.z), -0.009)

  return (
    <group position={center} quaternion={quaternion}>
      <RacketModel handleSide={handleSide} />
    </group>
  )
}

type PathPreviewView = 'overview' | 'racket'

const formatClockPosition = (angle: number) => {
  const normalized = ((angle % 360) + 360) % 360
  const totalMinutes = Math.round(normalized / 360 * 12 * 60) % (12 * 60)
  const hour = Math.floor(totalMinutes / 60) || 12
  const minutes = totalMinutes % 60
  return `${hour}:${minutes.toString().padStart(2, '0')}`
}

function PathPreviewCamera({
  params,
  view,
  cameraPov,
}: {
  params: SimParams
  view: PathPreviewView
  cameraPov: CameraPov
}) {
  const { camera } = useThree()
  useEffect(() => {
    const target = new THREE.Vector3(0, 0, 0)
    const distance = params.racketPath === 'circular' && view === 'overview'
      ? Math.max(0.62, params.racketPathRadius * 3.15)
      : 1.22
    if (params.racketPath === 'circular' && view === 'overview') {
      const frame = circularPathFrame(params)
      target.copy(frame.centerDirection).multiplyScalar(params.racketPathRadius)
    }
    camera.position.copy(target).addScaledVector(new THREE.Vector3(...cameraPov.direction), distance)
    camera.up.set(...cameraPov.up)
    camera.lookAt(target)
    const perspectiveCamera = camera as THREE.PerspectiveCamera
    perspectiveCamera.fov = params.racketPath === 'linear' || view === 'racket' ? 36 : 42
    camera.updateProjectionMatrix()
  }, [camera, cameraPov, params, view])
  return null
}

function PreviewSpinningBall({
  position,
  spin,
}: {
  position: THREE.Vector3
  spin: Vec3
}) {
  const spinVector = useMemo(() => new THREE.Vector3(spin.x, spin.y, spin.z), [spin.x, spin.y, spin.z])
  const spinAxis = useMemo(
    () => spinVector.lengthSq() > 1e-10 ? spinVector.clone().normalize() : new THREE.Vector3(0, 0, 1),
    [spinVector],
  )
  // Static pose showing the starting spin axis, not an animation synced to playback.
  const rotation = useMemo(
    () => new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), spinAxis),
    [spinAxis],
  )
  const seamTexture = useBallSeamTexture()
  return (
    <group position={position} quaternion={rotation}>
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <sphereGeometry args={[0.055, 32, 32]} />
        <meshStandardMaterial map={seamTexture} color="#ffffff" roughness={0.66} />
      </mesh>
    </group>
  )
}

function RacketPathPreview({
  params,
  handleSide,
  view,
  darkMode,
  time,
  startTime,
  cameraPov,
  contactPoint,
}: {
  params: SimParams
  handleSide: 'left' | 'right'
  view: PathPreviewView
  darkMode: boolean
  time: number
  startTime: number
  cameraPov: CameraPov
  contactPoint: Vec3
}) {
  const direction = useMemo(
    () => vectorFromAngles(params.pathAzimuth, params.pathElevation),
    [params.pathAzimuth, params.pathElevation],
  )
  const linearNormal = useMemo(
    () => {
      // Linear paths have no swing plane of their own, so face path angle is just a
      // yaw: it turns the face left/right around vertical, independent of elevation.
      const verticalAxis = new THREE.Vector3(0, 1, 0)
      const inPlaneNormal = direction.clone()
        .applyAxisAngle(verticalAxis, params.facePathAngle * Math.PI / 180)
        .normalize()
      let tiltAxis = new THREE.Vector3().crossVectors(inPlaneNormal, verticalAxis).normalize()
      if (tiltAxis.lengthSq() < 1e-12) {
        const fallbackReference = Math.abs(inPlaneNormal.z) < 0.94
          ? new THREE.Vector3(0, 0, 1)
          : new THREE.Vector3(1, 0, 0)
        tiltAxis = new THREE.Vector3().crossVectors(inPlaneNormal, fallbackReference).normalize()
      }
      return inPlaneNormal
        .applyAxisAngle(tiltAxis, params.faceTilt * Math.PI / 180)
        .normalize()
    },
    [direction, params.facePathAngle, params.faceTilt],
  )
  const circularFrame = useMemo(() => circularPathFrame(params), [params])
  const tangent = params.racketPath === 'circular' ? circularFrame.tangent : direction
  const normal = params.racketPath === 'circular' ? circularFrame.normal : linearNormal
  const previewRadius = Math.max(0.1, params.racketPathRadius)
  const racketPosition = new THREE.Vector3(0, 0, 0)
  const circleCenter = circularFrame.centerDirection.clone().multiplyScalar(previewRadius)
  const handleDirection = params.racketPath === 'circular'
    ? circularFrame.handleDirection
    : null
  const racketRotation = racketQuaternion(normal, handleSide, handleDirection)
  const pathPoints = useMemo(() => {
    if (params.racketPath === 'linear') {
      return [
        direction.clone().multiplyScalar(-0.44).toArray() as [number, number, number],
        direction.clone().multiplyScalar(0.44).toArray() as [number, number, number],
      ]
    }
    return Array.from({ length: 129 }, (_, index) => {
      const angle = index / 128 * Math.PI * 2
      return circleCenter.clone()
        .addScaledVector(circularFrame.centerDirection, -previewRadius * Math.cos(angle))
        .addScaledVector(circularFrame.tangent, previewRadius * Math.sin(angle))
        .toArray() as [number, number, number]
    })
  }, [circleCenter, circularFrame, direction, params.racketPath])
  const displayedPathPoints = params.racketPath === 'circular' && view === 'racket'
    ? Array.from({ length: 49 }, (_, index) => {
        const extent = Math.min(Math.PI, 0.44 / previewRadius)
        const angle = -extent + index / 48 * extent * 2
        return circleCenter.clone()
          .addScaledVector(circularFrame.centerDirection, -previewRadius * Math.cos(angle))
          .addScaledVector(circularFrame.tangent, previewRadius * Math.sin(angle))
          .toArray() as [number, number, number]
      })
    : pathPoints
  const showCircularOverview = params.racketPath === 'circular' && view === 'overview'
  const clockMarkers = [
    { label: '12 · FRONT', direction: circularFrame.clockTwelve },
    { label: '3 · RIGHT', direction: circularFrame.clockThree },
    { label: '6 · BACK', direction: circularFrame.clockTwelve.clone().negate() },
    { label: '9 · LEFT', direction: circularFrame.clockThree.clone().negate() },
  ]

  return (
    <>
      <PathPreviewCamera params={params} view={view} cameraPov={cameraPov} />
      <color attach="background" args={[darkMode ? '#171717' : '#eeeeec']} />
      <hemisphereLight args={[darkMode ? '#f0f0f0' : '#ffffff', darkMode ? '#202020' : '#a9aaa7', 2.4]} />
      <directionalLight position={[3, 4, 5]} intensity={2.5} />
      {params.racketPath === 'circular' && (
        <>
          <mesh position={[0, -contactPoint.y - 0.008, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
            <planeGeometry args={[18, 18]} />
            <meshStandardMaterial
              color={darkMode ? '#252525' : '#858585'}
              transparent
              opacity={darkMode ? 0.46 : 0.34}
              roughness={0.94}
              depthWrite={false}
            />
          </mesh>
          <Grid
            position={[0, -contactPoint.y, 0]}
            args={[18, 18]}
            cellSize={0.25}
            cellThickness={0.9}
            cellColor={darkMode ? '#3f3f3f' : '#c8c8c8'}
            sectionSize={1}
            sectionThickness={1.8}
            sectionColor={darkMode ? '#505050' : '#ababab'}
            fadeDistance={10}
          />
          <Table
            x={-contactPoint.x}
            y={-contactPoint.y}
            z={-contactPoint.z}
            darkMode={darkMode}
          />
        </>
      )}
      {showCircularOverview && (
        <>
          <mesh position={circleCenter}>
            <sphereGeometry args={[previewRadius, 28, 18]} />
            <meshBasicMaterial
              color={darkMode ? '#4f5b57' : '#aeb4b1'}
              wireframe
              transparent
              opacity={0.22}
            />
          </mesh>
          <mesh position={circleCenter}>
            <sphereGeometry args={[0.035, 20, 20]} />
            <meshBasicMaterial color={darkMode ? '#8dd8ca' : '#278c7b'} />
          </mesh>
          <Billboard position={circleCenter.clone().add(new THREE.Vector3(0, 0.1, 0))}>
            <Text
              fontSize={0.06}
              color={darkMode ? '#8dd8ca' : '#216f63'}
              outlineWidth={0.006}
              outlineColor={darkMode ? '#171717' : '#eeeeec'}
              anchorX="center"
              anchorY="middle"
            >CENTER</Text>
          </Billboard>
          {clockMarkers.map(({ label, direction }) => (
            <group
              key={label}
              position={circleCenter.clone().addScaledVector(direction, previewRadius)}
            >
              <mesh>
                <sphereGeometry args={[0.025, 16, 16]} />
                <meshBasicMaterial color="#7966d8" />
              </mesh>
              <Billboard position={direction.clone().multiplyScalar(0.12)}>
                <Text
                  fontSize={0.065}
                  color={darkMode ? '#f0f0ed' : '#343a37'}
                  outlineWidth={0.006}
                  outlineColor={darkMode ? '#171717' : '#eeeeec'}
                  anchorX="center"
                  anchorY="middle"
                >{label}</Text>
              </Billboard>
            </group>
          ))}
        </>
      )}
      <Line
        points={displayedPathPoints}
        color="#7966d8"
        lineWidth={2.4}
        dashed
        dashSize={0.075}
        gapSize={0.05}
      />
      {showCircularOverview && (
        <Line
          points={[[0, 0, 0], circleCenter.toArray() as [number, number, number]]}
          color={darkMode ? '#8dd8ca' : '#278c7b'}
          lineWidth={1.5}
          dashed
          dashSize={0.06}
          gapSize={0.04}
        />
      )}
      <group position={racketPosition} quaternion={racketRotation} scale={2.2}>
        <RacketModel handleSide={handleSide} />
      </group>
      <PreviewSpinningBall
        position={racketPosition.clone().addScaledVector(normal, 0.075)}
        spin={{ x: params.spinX, y: params.spinY, z: params.spinZ }}
      />
    </>
  )
}

function RacketPathSelector({
  params,
  handleSide,
  darkMode,
  time,
  startTime,
  cameraPov,
  contactPoint,
}: {
  params: SimParams
  handleSide: 'left' | 'right'
  darkMode: boolean
  time: number
  startTime: number
  cameraPov: CameraPov
  contactPoint: Vec3
}) {
  const [view, setView] = useState<PathPreviewView>('overview')
  useEffect(() => {
    if (params.racketPath === 'linear') setView('overview')
  }, [params.racketPath])

  return (
    <div className="path-orientation-control">
      <div
        className="path-preview-canvas"
        role="img"
        aria-label={params.racketPath === 'circular' ? 'Circular racket path preview' : 'Linear racket and spinning ball impact preview'}
      >
        {params.racketPath === 'circular' && (
          <div className="path-preview-views">
            <button className={view === 'overview' ? 'active' : ''} onClick={() => setView('overview')}>Overview</button>
            <button className={view === 'racket' ? 'active' : ''} onClick={() => setView('racket')}>Racket</button>
          </div>
        )}
        <Canvas dpr={[1, 1.5]} camera={{ position: [2.4, 1.8, 2.8], fov: 42, near: 0.01, far: 20 }}>
          <RacketPathPreview
            params={params}
            handleSide={handleSide}
            view={view}
            darkMode={darkMode}
            time={time}
            startTime={startTime}
            cameraPov={cameraPov}
            contactPoint={contactPoint}
          />
        </Canvas>
      </div>
    </div>
  )
}

function Table({ x, y, z, darkMode }: { x: number; y: number; z: number; darkMode: boolean }) {
  const topY = TABLE_SURFACE_Y - TABLE_THICKNESS / 2
  const legColor = darkMode ? '#343d3a' : '#4f5955'
  const borderWidth = 0.035
  const markingY = TABLE_SURFACE_Y
  const netColor = darkMode ? '#91a9b4' : '#263f50'
  const netOverhang = (NET_WIDTH - TABLE_WIDTH) / 2
  const netGridPositions = useMemo(() => {
    const positions: number[] = []
    const rows = 10
    const columns = 120
    for (let row = 0; row <= rows; row += 1) {
      const rowY = row * NET_HEIGHT / rows
      positions.push(0, rowY, -NET_WIDTH / 2, 0, rowY, NET_WIDTH / 2)
    }
    for (let column = 0; column <= columns; column += 1) {
      const columnZ = -NET_WIDTH / 2 + column * NET_WIDTH / columns
      positions.push(0, 0, columnZ, 0, NET_HEIGHT, columnZ)
    }
    return new Float32Array(positions)
  }, [])
  return (
    <group position={[x, y, z]}>
      <mesh position={[0, topY, 0]} castShadow receiveShadow>
        <boxGeometry args={[TABLE_LENGTH, TABLE_THICKNESS, TABLE_WIDTH]} />
        <meshStandardMaterial color={darkMode ? '#11467d' : '#1769aa'} roughness={0.68} />
      </mesh>
      {([-1, 1] as const).map((side) => (
        <mesh key={`side-marking-${side}`} position={[0, markingY, side * (TABLE_WIDTH / 2 - borderWidth / 2)]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[TABLE_LENGTH, borderWidth]} />
          <meshStandardMaterial color="#ffffff" roughness={0.58} polygonOffset polygonOffsetFactor={-1} />
        </mesh>
      ))}
      {([-1, 1] as const).map((side) => (
        <mesh key={`end-marking-${side}`} position={[side * (TABLE_LENGTH / 2 - borderWidth / 2), markingY, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[borderWidth, TABLE_WIDTH - borderWidth * 2]} />
          <meshStandardMaterial color="#ffffff" roughness={0.58} polygonOffset polygonOffsetFactor={-1} />
        </mesh>
      ))}
      <mesh position={[0, markingY, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[TABLE_LENGTH - borderWidth * 2, 0.014]} />
        <meshStandardMaterial color="#ffffff" roughness={0.58} polygonOffset polygonOffsetFactor={-1} />
      </mesh>
      {([-1, 1] as const).flatMap((sideX) => ([-1, 1] as const).map((sideZ) => (
        <RoundedBox
          key={`${sideX}-${sideZ}`}
          args={[0.055, 0.72, 0.055]}
          radius={0.012}
          smoothness={2}
          position={[sideX * 1.12, 0.36, sideZ * 0.58]}
        >
          <meshStandardMaterial color={legColor} roughness={0.75} />
        </RoundedBox>
      )))}
      <group position={[0, TABLE_SURFACE_Y, 0]}>
        <mesh position={[0, NET_HEIGHT / 2, 0]} rotation={[0, Math.PI / 2, 0]}>
          <planeGeometry args={[NET_WIDTH, NET_HEIGHT]} />
          <meshStandardMaterial
            color={netColor}
            transparent
            opacity={darkMode ? 0.12 : 0.09}
            roughness={0.9}
            side={THREE.DoubleSide}
            depthWrite={false}
          />
        </mesh>
        <lineSegments>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[netGridPositions, 3]} />
          </bufferGeometry>
          <lineBasicMaterial color={netColor} transparent opacity={0.68} />
        </lineSegments>
        <mesh position={[0, NET_HEIGHT, 0]}>
          <boxGeometry args={[0.014, 0.018, NET_WIDTH + 0.018]} />
          <meshStandardMaterial color="#f4f1e8" roughness={0.72} />
        </mesh>
        {([-1, 1] as const).map((side) => (
          <mesh key={`net-binding-${side}`} position={[0, NET_HEIGHT / 2, side * NET_WIDTH / 2]}>
            <boxGeometry args={[0.012, NET_HEIGHT, 0.012]} />
            <meshStandardMaterial color="#e9e6dd" roughness={0.75} />
          </mesh>
        ))}
        {([-1, 1] as const).map((side) => (
          <group key={`net-post-${side}`} position={[0, 0, side * NET_WIDTH / 2]}>
            <mesh position={[0, NET_HEIGHT / 2 - 0.012, 0]}>
              <cylinderGeometry args={[0.011, 0.013, NET_HEIGHT + 0.085, 16]} />
              <meshStandardMaterial color={darkMode ? '#aab6b2' : '#606b67'} metalness={0.35} roughness={0.48} />
            </mesh>
            <RoundedBox
              args={[0.04, 0.032, netOverhang + 0.025]}
              radius={0.007}
              smoothness={3}
              position={[0, -0.026, -side * netOverhang / 2]}
            >
              <meshStandardMaterial color={darkMode ? '#697570' : '#424c48'} metalness={0.28} roughness={0.55} />
            </RoundedBox>
            <RoundedBox
              args={[0.052, 0.074, 0.026]}
              radius={0.005}
              smoothness={3}
              position={[0, -0.034, -side * netOverhang]}
            >
              <meshStandardMaterial color={darkMode ? '#74807b' : '#4b5651'} metalness={0.3} roughness={0.5} />
            </RoundedBox>
            <mesh position={[0, -0.078, -side * (netOverhang - 0.018)]}>
              <cylinderGeometry args={[0.004, 0.004, 0.04, 12]} />
              <meshStandardMaterial color={darkMode ? '#aeb9b5' : '#727d78'} metalness={0.55} roughness={0.35} />
            </mesh>
            <mesh position={[0, -0.102, -side * (netOverhang - 0.018)]}>
              <cylinderGeometry args={[0.019, 0.019, 0.012, 20]} />
              <meshStandardMaterial color={darkMode ? '#68736e' : '#3e4944'} metalness={0.24} roughness={0.62} />
            </mesh>
            <RoundedBox
              args={[0.058, 0.012, 0.052]}
              radius={0.005}
              smoothness={3}
              position={[0, -0.062, -side * (netOverhang - 0.018)]}
            >
              <meshStandardMaterial color={darkMode ? '#858f8b' : '#5b6661'} metalness={0.32} roughness={0.5} />
            </RoundedBox>
            <mesh position={[0, NET_HEIGHT + 0.012, 0]}>
              <sphereGeometry args={[0.014, 16, 16]} />
              <meshStandardMaterial color="#eeeae0" roughness={0.65} />
            </mesh>
          </group>
        ))}
      </group>
    </group>
  )
}

function MirroredMiniCamera({ cameraPov }: { cameraPov: CameraPov }) {
  const { camera } = useThree()
  useEffect(() => {
    camera.position.copy(new THREE.Vector3(...cameraPov.direction).multiplyScalar(3))
    camera.up.set(...cameraPov.up)
    camera.lookAt(0, 0, 0)
    camera.updateProjectionMatrix()
  }, [camera, cameraPov])
  return null
}

function SpinWidget({
  spin,
  velocity,
  darkMode,
  cameraPov,
  playbackRate,
}: {
  spin: Vec3
  velocity: Vec3
  darkMode: boolean
  cameraPov: CameraPov
  playbackRate: number
}) {
  const spinLength = magnitude(spin)
  const travelSpeed = magnitude(velocity)
  const direction = useMemo(
    () => travelSpeed > 1e-8 ? new THREE.Vector3(velocity.x, velocity.y, velocity.z).normalize() : new THREE.Vector3(1, 0, 0),
    [velocity, travelSpeed],
  )
  const spinAxis = useMemo(
    () => spinLength > 1e-8 ? new THREE.Vector3(spin.x, spin.y, spin.z).normalize() : new THREE.Vector3(0, 1, 0),
    [spin, spinLength],
  )
  const poleQuaternion = useMemo(
    () => new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), spinAxis),
    [spinAxis],
  )
  const localPoleAxis = useMemo(() => new THREE.Vector3(0, 0, 1), [])
  const rotationGroupRef = useRef<THREE.Group>(null)
  const rotationAngleRef = useRef(0)
  useFrame((_state, delta) => {
    rotationAngleRef.current += spinLength * delta * playbackRate
    rotationGroupRef.current?.quaternion.setFromAxisAngle(localPoleAxis, rotationAngleRef.current)
  })
  const arrow = useMemo(
    () => new THREE.ArrowHelper(direction, new THREE.Vector3(0, 0, 0), 1.12, '#e79b51', 0.22, 0.11),
    [direction],
  )
  const rotationAxisPoints = useMemo(() => {
    const extent = 1.08
    return [
      [-spinAxis.x * extent, -spinAxis.y * extent, -spinAxis.z * extent],
      [spinAxis.x * extent, spinAxis.y * extent, spinAxis.z * extent],
    ] as [number, number, number][]
  }, [spinAxis])
  const seamTexture = useBallSeamTexture()
  return (
    <>
      <color attach="background" args={[darkMode ? '#101010' : '#f2f2f2']} />
      <MirroredMiniCamera cameraPov={cameraPov} />
      <ambientLight intensity={2.2} />
      <directionalLight position={[3, 4, 5]} intensity={2} />
      <group quaternion={poleQuaternion}>
        <group ref={rotationGroupRef}>
          <mesh rotation={[Math.PI / 2, 0, 0]}>
            <sphereGeometry args={[0.62, 40, 40]} />
            <meshStandardMaterial map={seamTexture} color="#ffffff" roughness={0.66} />
          </mesh>
        </group>
      </group>
      {spinLength > 1e-8 && (
        <Line
          points={rotationAxisPoints}
          color={darkMode ? '#8dd8ca' : '#277d70'}
          lineWidth={2}
          transparent
          opacity={0.82}
        />
      )}
      {travelSpeed > 1e-8 ? <primitive object={arrow} /> : (
        <Text position={[0, -0.95, 0]} fontSize={0.16} color={darkMode ? '#8c9692' : '#747b78'}>STATIONARY</Text>
      )}
    </>
  )
}

function Ball({ time, result, darkMode, playbackRate }: { time: number; result: SimResult; darkMode: boolean; playbackRate: number }) {
  const point = time < 0
    ? sampleTrajectory(result.incoming, time)
    : sampleTrajectory(result.outgoing, time)
  const spin = point.spin
  const spinMagnitude = magnitude(spin)
  const poleQuaternion = useMemo(() => {
    if (spinMagnitude < 1e-7) return new THREE.Quaternion()
    const spinAxis = new THREE.Vector3(spin.x, spin.y, spin.z).normalize()
    return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), spinAxis)
  }, [spin, spinMagnitude, time])
  const rotationAxis = useMemo(() => new THREE.Vector3(0, 0, 1), [])
  const rotationGroupRef = useRef<THREE.Group>(null)
  const rotationAngleRef = useRef(0)
  useFrame((_state, delta) => {
    rotationAngleRef.current += spinMagnitude * delta * playbackRate
    rotationGroupRef.current?.quaternion.setFromAxisAngle(rotationAxis, rotationAngleRef.current)
  })
  const spinAxisExtent = BALL_RADIUS * 1.75
  const seamTexture = useBallSeamTexture()

  return (
    <group position={[point.x, point.y, point.z]} quaternion={poleQuaternion}>
      <group ref={rotationGroupRef}>
        <mesh castShadow rotation={[Math.PI / 2, 0, 0]}>
          <sphereGeometry args={[BALL_RADIUS, 40, 40]} />
          <meshStandardMaterial map={seamTexture} color="#ffffff" roughness={0.68} />
        </mesh>
      </group>
      {spinMagnitude > 1e-7 && (
        <Line
          points={[[0, 0, -spinAxisExtent], [0, 0, spinAxisExtent]]}
          color={darkMode ? '#8dd8ca' : '#277d70'}
          lineWidth={2}
          transparent
          opacity={0.82}
        />
      )}
    </group>
  )
}

function Scene({
  result,
  params,
  time,
  playbackRate,
  cameraPreset,
  tablePosition,
  darkMode,
  handleSide,
  zoomRequest,
  onZoomChange,
  onCameraPovChange,
}: {
  result: SimResult
  params: SimParams
  time: number
  playbackRate: number
  cameraPreset: CameraPreset
  tablePosition: Vec3
  darkMode: boolean
  handleSide: 'left' | 'right'
  zoomRequest: ZoomRequest | null
  onZoomChange: (level: number) => void
  onCameraPovChange: (pov: CameraPov) => void
}) {
  const camera = useThree((state) => state.camera)
  const incomingPoints = useMemo(
    () => result.incoming.map((point) => [point.x, point.y, point.z] as [number, number, number]),
    [result],
  )
  const outgoingPoints = useMemo(
    () => result.outgoing.map((point) => [point.x, point.y, point.z] as [number, number, number]),
    [result],
  )
  const racketPath = useMemo(() => {
    const pointCount = 96
    const pathEndTime = 0.22
    return Array.from({ length: pointCount }, (_, index) => {
      const pathTime = result.startTime + (pathEndTime - result.startTime) * index / (pointCount - 1)
      const pose = racketPoseAtTime(
        pathTime,
        result.impact.contactPoint,
        result.impact.normal,
        result.impact.racketVelocity,
        params,
      )
      return [pose.position.x, pose.position.y, pose.position.z] as [number, number, number]
    })
  }, [params, result])
  const orbitControlsRef = useRef<React.ElementRef<typeof OrbitControls>>(null)
  const lastCameraPovRef = useRef<CameraPov | null>(null)
  const orbitTarget = useMemo(
    () => new THREE.Vector3(SCENE_CENTER.x, SCENE_CENTER.y, SCENE_CENTER.z),
    [cameraPreset],
  )
  const planarCamera = cameraPreset === 'side' || cameraPreset === 'front' || cameraPreset === 'top'
  const limits = zoomLimits(cameraPreset)
  const reportZoom = useCallback(() => {
    const controls = orbitControlsRef.current
    if (!controls) return
    onZoomChange(zoomLevelFromDistance(camera.position.distanceTo(controls.target), cameraPreset))
  }, [camera, cameraPreset, onZoomChange])

  useFrame(() => {
    const controls = orbitControlsRef.current
    if (!controls) return
    const direction = camera.position.clone().sub(controls.target)
    if (direction.lengthSq() < 1e-12) return
    direction.normalize()
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion).normalize()
    const next: CameraPov = {
      direction: [direction.x, direction.y, direction.z],
      up: [up.x, up.y, up.z],
    }
    const previous = lastCameraPovRef.current
    const changed = !previous
      || next.direction.some((value, index) => Math.abs(value - previous.direction[index]) > 1e-4)
      || next.up.some((value, index) => Math.abs(value - previous.up[index]) > 1e-4)
    if (!changed) return
    lastCameraPovRef.current = next
    onCameraPovChange(next)
  })

  useEffect(() => {
    if (!zoomRequest) return
    const controls = orbitControlsRef.current
    if (!controls) return
    const direction = camera.position.clone().sub(controls.target)
    if (direction.lengthSq() < 1e-12) direction.set(1, 0, 0)
    direction.normalize()
    camera.position.copy(controls.target).addScaledVector(
      direction,
      distanceFromZoomLevel(zoomRequest.level, cameraPreset),
    )
    camera.updateMatrixWorld()
    controls.update()
  }, [camera, cameraPreset, zoomRequest])

  return (
    <>
      <CameraRig preset={cameraPreset} result={result} time={time} controlsRef={orbitControlsRef} />
      <color attach="background" args={[darkMode ? '#0b0b0b' : '#e8e8e8']} />
      <hemisphereLight args={[darkMode ? '#e2e2e2' : '#ffffff', darkMode ? '#1e1e1e' : '#bdbdbd', 2.4]} />
      <ambientLight intensity={2.5} />
      <directionalLight position={[3, 16, 5]} intensity={3.4} />
      <directionalLight position={[-6, 9, -5]} intensity={1.5} color="#c9e8ff" />

      <mesh position={[0, -0.006, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[120, 120]} />
        <meshStandardMaterial
          color={darkMode ? '#252525' : '#858585'}
          transparent
          opacity={darkMode ? 0.46 : 0.34}
          roughness={0.94}
          depthWrite={false}
        />
      </mesh>
      <Grid
        position={[0, 0, 0]}
        args={[120, 120]}
        cellSize={0.25}
        cellThickness={0.9}
        cellColor={darkMode ? '#3f3f3f' : '#c8c8c8'}
        sectionSize={1}
        sectionThickness={1.8}
        sectionColor={darkMode ? '#505050' : '#ababab'}
        fadeDistance={52}
      />
      <Table x={tablePosition.x} y={tablePosition.y} z={tablePosition.z} darkMode={darkMode} />
      <Line points={incomingPoints} color="#e76d60" lineWidth={2.2} dashed dashScale={12} dashSize={0.09} gapSize={0.055} />
      <Line points={outgoingPoints} color="#39bfa8" lineWidth={3.2} />
      <Line points={racketPath} color="#7966d8" lineWidth={1.4} dashed dashScale={9} dashSize={0.08} gapSize={0.08} transparent opacity={0.62} />
      {result.bounces.map((bounce, index) => (
        <mesh key={`${bounce.t}-${index}`} position={[bounce.x, bounce.y + 0.003, bounce.z]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.045, 0.005, 10, 40]} />
          <meshBasicMaterial color="#fff3a8" />
        </mesh>
      ))}

      <Racket time={time} result={result} params={params} handleSide={handleSide} />
      <Ball time={time} result={result} darkMode={darkMode} playbackRate={playbackRate} />

      <OrbitControls
        ref={orbitControlsRef}
        key={cameraPreset}
        makeDefault
        target={orbitTarget}
        enableDamping
        dampingFactor={0.08}
        enableRotate={cameraPreset === 'free' || cameraPreset === 'ball'}
        enablePan={cameraPreset === 'free' || planarCamera}
        enableZoom
        screenSpacePanning
        minDistance={limits.min}
        maxDistance={limits.max}
        minPolarAngle={cameraPreset === 'ball' ? Math.PI / 2 : 0}
        maxPolarAngle={cameraPreset === 'ball' ? Math.PI / 2 : Math.PI}
        onChange={reportZoom}
      />
    </>
  )
}

function Metric({ label, value, unit, tone = 'dark' }: { label: string; value: string; unit: string; tone?: string }) {
  return (
    <div className={`metric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{unit}</small>
    </div>
  )
}

function App() {
  const [params, setParams] = useState<SimParams>(DEFAULT_PARAMS)
  const [time, setTime] = useState(DEFAULT_START_TIME)
  const [playing, setPlaying] = useState(false)
  const [cameraPreset, setCameraPreset] = useState<CameraPreset>('free')
  const [playbackRate, setPlaybackRate] = useState(0.25)
  const [liveSolutionExpanded, setLiveSolutionExpanded] = useState(true)
  const [atImpactExpanded, setAtImpactExpanded] = useState(true)
  const [ballStart, setBallStart] = useState<BallStart>(DEFAULT_BALL_START)
  const [darkMode, setDarkMode] = useState(false)
  const [speedUnit, setSpeedUnit] = useState<SpeedUnit>('km/h')
  const [handleSide, setHandleSide] = useState<'left' | 'right'>('left')
  const [convertCircleDirection, setConvertCircleDirection] = useState(true)
  const [cameraPov, setCameraPov] = useState<CameraPov>(() => {
    const direction = new THREE.Vector3(5.8, 3.7, -6.5)
      .sub(new THREE.Vector3(SCENE_CENTER.x, SCENE_CENTER.y, SCENE_CENTER.z))
      .normalize()
    return { direction: direction.toArray(), up: [0, 1, 0] }
  })
  const [zoomLevel, setZoomLevel] = useState(35)
  const [zoomRequest, setZoomRequest] = useState<ZoomRequest | null>(null)
  const animationRef = useRef<number | null>(null)
  const lastFrameRef = useRef<number | null>(null)
  const tablePosition = DEFAULT_TABLE_POSITION
  const result = useMemo(() => simulate(params, tablePosition, ballStart), [params, ballStart, tablePosition])
  const boosterFraction = Math.max(0, Math.min(100, params.boosterLevel)) / 100
  const boostedThicknessScale = 1 + BOOSTER_EFFECTS.thicknessExpansion * boosterFraction
  const boostedHardnessScale = 1 - BOOSTER_EFFECTS.hardnessReduction * boosterFraction
  const boostedTensionIncrease = BOOSTER_EFFECTS.tensionIncrease * boosterFraction
  const startTime = result.startTime
  const endTime = result.outgoing[result.outgoing.length - 1].t
  const circleFrame = useMemo(() => circularPathFrame(params), [params])
  const topDownCircleDirection = circleFrame.topDownFlipped
    ? params.circleDirection === 'clockwise' ? 'counterclockwise' : 'clockwise'
    : params.circleDirection
  const contactTimingBaseline = topDownCircleDirection === 'clockwise' ? 270 : 180
  const contactTimingClockAngle = contactTimingBaseline + circleFrame.contactTravelAngle * 180 / Math.PI
    * (topDownCircleDirection === 'clockwise' ? 1 : -1)
  const circleContactTimeBound = Math.max(
    Math.abs(params.circleContactTime),
    // A half lap (180°) reaches the antipodal point on the circle in either direction;
    // going further would just retrace back toward the same position as the center (0).
    Math.min(10, Math.PI * Math.max(0.05, params.racketPathRadius) / Math.max(0.05, params.racketSpeed)),
  )

  const updateParam = useCallback(<K extends keyof SimParams>(key: K, value: SimParams[K]) => {
    setParams((current) => ({ ...current, [key]: value }))
    setPlaying(false)
  }, [])
  const changeRacketPath = useCallback((path: SimParams['racketPath']) => {
    setParams((current) => {
      if (current.racketPath === path) return current
      const { racketVelocity, normal } = result.impact
      const solved = path === 'circular'
        ? solveCircularContactParams(racketVelocity, normal, current.circleDirection)
        : solveLinearContactParams(racketVelocity, normal)
      return { ...current, racketPath: path, ...solved }
    })
    setPlaying(false)
  }, [result])
  const selectCircleDirection = useCallback((topDownDirection: CircleDirection) => {
    const requestedDirection = circleFrame.topDownFlipped
      ? topDownDirection === 'clockwise' ? 'counterclockwise' : 'clockwise'
      : topDownDirection
    setParams((current) => {
      if (current.circleDirection === requestedDirection) return current
      if (!convertCircleDirection) {
        return { ...current, circleDirection: requestedDirection }
      }
      const { racketVelocity, normal } = result.impact
      const solved = solveCircularContactParams(racketVelocity, normal, requestedDirection)
      return { ...current, circleDirection: requestedDirection, ...solved }
    })
    setPlaying(false)
  }, [circleFrame.topDownFlipped, convertCircleDirection, result])
  const reportZoom = useCallback((level: number) => {
    setZoomLevel((current) => Math.abs(current - level) > 0.1 ? level : current)
  }, [])
  const requestZoom = useCallback((level: number) => {
    setZoomLevel(level)
    setZoomRequest((current) => ({ level, id: (current?.id ?? 0) + 1 }))
  }, [])

  useLayoutEffect(() => {
    setPlaying(false)
    setTime(startTime)
  }, [result, startTime])

  useEffect(() => {
    if (!playing) {
      lastFrameRef.current = null
      if (animationRef.current) cancelAnimationFrame(animationRef.current)
      return
    }
    const tick = (now: number) => {
      if (lastFrameRef.current === null) lastFrameRef.current = now
      const delta = Math.min(0.04, (now - lastFrameRef.current) / 1000)
      lastFrameRef.current = now
      setTime((current) => {
        const next = current + delta * playbackRate
        if (next >= endTime) {
          setPlaying(false)
          return startTime
        }
        return next
      })
      animationRef.current = requestAnimationFrame(tick)
    }
    animationRef.current = requestAnimationFrame(tick)
    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current)
    }
  }, [playing, playbackRate, endTime])

  useEffect(() => {
    const stepWithKeyboard = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.matches('input, button, select, textarea')) return
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault()
      setPlaying(false)
      setTime((current) => Math.max(
        startTime,
        Math.min(endTime, current + (event.key === 'ArrowRight' ? STEP : -STEP)),
      ))
    }
    window.addEventListener('keydown', stepWithKeyboard)
    return () => window.removeEventListener('keydown', stepWithKeyboard)
  }, [endTime, startTime])

  const phase = time >= endTime - 1e-5
    ? result.termination === 'table-rest' ? 'At rest' : result.termination === 'floor' ? 'Floor' : 'End'
    : time < -0.025 ? 'Approach' : time <= 0.025 ? 'Impact' : 'Flight'
  const timelineProgress = ((time - startTime) / (endTime - startTime)) * 100
  const forceRatio = result.impact.normalForce > 0
    ? Math.min(100, (result.impact.frictionForce / result.impact.normalForce) * 100)
    : 0
  const livePoint = time < 0
    ? sampleTrajectory(result.incoming, time)
    : sampleTrajectory(result.outgoing, time)
  const liveSpeed = magnitude(livePoint.velocity)
  const liveSpinRpm = magnitude(livePoint.spin) * 60 / (2 * Math.PI)
  const liveSpinComponents = resolveSpinComponents(livePoint.spin, livePoint.velocity)
  const liveRollRpm = liveSpinComponents.roll * 60 / (2 * Math.PI)
  const liveSidespinRpm = liveSpinComponents.sidespin * 60 / (2 * Math.PI)
  const liveTopBackspinRpm = liveSpinComponents.topBack * 60 / (2 * Math.PI)
  const liveRollDirection = liveRollRpm > 0 ? 'CW' : liveRollRpm < 0 ? 'CCW' : 'none'
  const liveSidespinHeader = liveSidespinRpm > 0 ? 'RIGHT SIDESPIN' : liveSidespinRpm < 0 ? 'LEFT SIDESPIN' : 'SIDESPIN'
  const liveTopBackspinHeader = liveTopBackspinRpm > 0 ? 'TOPSPIN' : liveTopBackspinRpm < 0 ? 'BACKSPIN' : 'TOP/BACKSPIN'
  const impactSpinComponents = resolveSpinComponents(result.impact.outgoingSpin, result.impact.outgoingVelocity)
  const impactRollRpm = impactSpinComponents.roll * 60 / (2 * Math.PI)
  const impactTopBackspinRpm = impactSpinComponents.topBack * 60 / (2 * Math.PI)
  const impactRollDirection = impactRollRpm > 0 ? 'CW' : impactRollRpm < 0 ? 'CCW' : 'none'
  const impactTopBackspinLabel = impactTopBackspinRpm > 0 ? 'TOPSPIN' : impactTopBackspinRpm < 0 ? 'BACKSPIN' : 'TOP/BACKSPIN'
  const impactSidespinHeader = result.impact.sidespinRpm > 0 ? 'RIGHT SIDESPIN' : result.impact.sidespinRpm < 0 ? 'LEFT SIDESPIN' : 'SIDESPIN'
  const speedScale = speedUnit === 'km/h' ? 3.6 : 1
  const ballLaunchDirection = vectorFromAngles(params.ballAzimuth, params.ballElevation).clone().negate()
  const launchSpinComponents = resolveSpinComponents(
    { x: params.spinX, y: params.spinY, z: params.spinZ },
    ballLaunchDirection,
  )
  const rollLabel = launchSpinComponents.roll > 0
    ? 'X · clockwise'
    : launchSpinComponents.roll < 0 ? 'X · counterclockwise' : 'X · no roll'
  const sidespinLabel = launchSpinComponents.sidespin > 0
    ? 'Y · right sidespin'
    : launchSpinComponents.sidespin < 0 ? 'Y · left sidespin' : 'Y · no sidespin'
  const topBackspinLabel = launchSpinComponents.topBack > 0
    ? 'Z · topspin'
    : launchSpinComponents.topBack < 0 ? 'Z · backspin' : 'Z · no spin'

  return (
    <main className={`app-shell ${darkMode ? 'dark' : ''}`}>
      <div className="workspace">
        <div className="workspace-brand">
          <div className="brand-mark"><BouncingBallIcon size={28} /></div>
          <div className="brand-copy">
            <strong>Arc Lab</strong>
            <span>Table tennis collision simulator</span>
          </div>
        </div>
        <aside className="controls-panel">
          <div className="panel-intro">
            <div className="panel-actions panel-actions-top">
              <button className="reset-button" onClick={() => { setParams(DEFAULT_PARAMS); setBallStart(DEFAULT_BALL_START); setHandleSide('left'); setTime(DEFAULT_START_TIME); setPlaying(false) }}>
                <RotateCcw size={14} strokeWidth={3} /> Reset parameters
              </button>
              <div className="unit-toggle" aria-label="Speed units">
                {(['m/s', 'km/h'] as SpeedUnit[]).map((unit) => (
                  <button key={unit} className={speedUnit === unit ? 'active' : ''} onClick={() => setSpeedUnit(unit)}>{unit}</button>
                ))}
              </div>
            </div>
          </div>

          <Section icon={<Circle size={18} />} eyebrow="01" title="Ball" tone="coral">
            <BallStartPicker value={ballStart} cameraPov={cameraPov} onChange={(value) => { setBallStart(value); setPlaying(false); setTime(startTime) }} />
            <Slider label="Speed" value={params.ballSpeed} defaultValue={DEFAULT_PARAMS.ballSpeed} displayScale={speedScale} min={0} max={MAX_SPEED_MPS} step={speedUnit === 'km/h' ? 0.1 / 3.6 : 0.1} unit={speedUnit} accent="coral" onChange={(v) => updateParam('ballSpeed', v)} />
            <Slider label="Initial side angle" value={params.ballAzimuth} defaultValue={DEFAULT_PARAMS.ballAzimuth} min={-90} max={90} step={ANGLE_STEP} unit="°" accent="coral" onChange={(v) => updateParam('ballAzimuth', v)} />
            <Slider label="Initial vertical angle" value={params.ballElevation} defaultValue={DEFAULT_PARAMS.ballElevation} min={0} max={180} step={ANGLE_STEP} unit="°" accent="coral" onChange={(v) => updateParam('ballElevation', v)} />
            <div className="sub-label">INITIAL SPIN</div>
            <Slider label={rollLabel} value={params.spinX} defaultValue={DEFAULT_PARAMS.spinX} min={-5000} max={5000} step={100} unit="rpm" accent="coral" onChange={(v) => updateParam('spinX', v)} />
            <Slider label={sidespinLabel} value={params.spinY} defaultValue={DEFAULT_PARAMS.spinY} min={-5000} max={5000} step={100} unit="rpm" accent="coral" onChange={(v) => updateParam('spinY', v)} />
            <Slider label={topBackspinLabel} value={params.spinZ} defaultValue={DEFAULT_PARAMS.spinZ} min={-5000} max={5000} step={100} unit="rpm" accent="coral" onChange={(v) => updateParam('spinZ', v)} />
            <ContactArcControl
              value={params.contactPhase}
              trajectory={result.incoming}
              noHitProjection={result.noHitProjection}
              cameraPov={cameraPov}
              onChange={(value) => updateParam('contactPhase', value)}
            />
          </Section>

          <Section icon={<RacketIcon size={18} />} eyebrow="02" title="Racket" tone="violet">
            <Slider label="Speed" value={params.racketSpeed} defaultValue={DEFAULT_PARAMS.racketSpeed} displayScale={speedScale} min={0} max={MAX_SPEED_MPS} step={speedUnit === 'km/h' ? 0.1 / 3.6 : 0.1} unit={speedUnit} accent="violet" onChange={(v) => updateParam('racketSpeed', v)} />
            <Slider label="Acceleration" value={params.racketAcceleration} defaultValue={DEFAULT_PARAMS.racketAcceleration} min={-250} max={250} step={0.5} unit="m/s²" accent="violet" onChange={(v) => updateParam('racketAcceleration', v)} />
            <Slider label="After-contact deceleration" value={params.afterContactDeceleration} defaultValue={DEFAULT_PARAMS.afterContactDeceleration} min={0} max={1000} step={1} unit="m/s²" accent="violet" onChange={(v) => updateParam('afterContactDeceleration', v)} />
            <div className="binary-control">
              <span>Path shape</span>
              <div>
                <button className={params.racketPath === 'linear' ? 'active' : ''} onClick={() => changeRacketPath('linear')}>
                  <MoveRight size={13} /> Linear
                </button>
                <button className={params.racketPath === 'circular' ? 'active' : ''} onClick={() => changeRacketPath('circular')}>
                  <CircleDashed size={13} /> Circular
                </button>
              </div>
            </div>
            <RacketPathSelector
              params={params}
              handleSide={handleSide}
              darkMode={darkMode}
              time={time}
              startTime={startTime}
              cameraPov={cameraPov}
              contactPoint={result.impact.contactPoint}
            />
            {params.racketPath === 'linear' ? (
              <>
                <Slider label="Path side" value={params.pathAzimuth} defaultValue={DEFAULT_PARAMS.pathAzimuth} min={-180} max={180} step={ANGLE_STEP} unit="°" accent="violet" onChange={(v) => updateParam('pathAzimuth', v)} />
                <Slider label="Path lift" value={params.pathElevation} defaultValue={DEFAULT_PARAMS.pathElevation} min={-90} max={180} step={ANGLE_STEP} unit="°" accent="violet" onChange={(v) => updateParam('pathElevation', v)} />
              </>
            ) : (
              <>
                <Slider label="Circle radius" value={params.racketPathRadius} defaultValue={DEFAULT_PARAMS.racketPathRadius} min={0.1} max={2} step={0.05} unit="m" accent="violet" onChange={(v) => updateParam('racketPathRadius', v)} />
                <div className="binary-control">
                  <span>Path direction</span>
                  <div>
                    <button
                      className={topDownCircleDirection === 'clockwise' ? 'active' : ''}
                      aria-label="Clockwise from top view"
                      title="Clockwise from top view"
                      onClick={() => selectCircleDirection('clockwise')}
                    >
                      <RotateCw size={13} /> CW
                    </button>
                    <button
                      className={`convert-direction ${convertCircleDirection ? 'active' : ''}`}
                      aria-label="Preserve contact geometry when changing clockwise or counterclockwise direction"
                      aria-pressed={convertCircleDirection}
                      title={convertCircleDirection
                        ? 'Direction conversion on · preserve contact geometry'
                        : 'Direction conversion off · change raw winding only'}
                      onClick={() => setConvertCircleDirection((enabled) => !enabled)}
                    >
                      <ArrowLeftRight size={13} />
                    </button>
                    <button
                      className={topDownCircleDirection === 'counterclockwise' ? 'active' : ''}
                      aria-label="Counterclockwise from top view"
                      title="Counterclockwise from top view"
                      onClick={() => selectCircleDirection('counterclockwise')}
                    >
                      <RotateCcw size={13} /> CCW
                    </button>
                  </div>
                </div>
                <Slider label={`Contact tangent · ${formatClockPosition(params.circleContactAngle)}`} value={params.circleContactAngle} defaultValue={DEFAULT_PARAMS.circleContactAngle} min={-180} max={180} step={ANGLE_STEP} unit="°" accent="violet" onChange={(v) => updateParam('circleContactAngle', v)} />
                <Slider
                  label={`Contact point after tangent · ${formatClockPosition(contactTimingClockAngle)}`}
                  value={params.circleContactTime}
                  defaultValue={DEFAULT_PARAMS.circleContactTime}
                  displayScale={1000}
                  min={-circleContactTimeBound}
                  max={circleContactTimeBound}
                  step={0.001}
                  unit="ms"
                  accent="violet"
                  onChange={(v) => updateParam('circleContactTime', v)}
                />
                <Slider label="Left / right tilt · 12–6 axis" value={params.circleSideTilt} defaultValue={DEFAULT_PARAMS.circleSideTilt} min={-180} max={180} step={ANGLE_STEP} unit="°" accent="violet" onChange={(v) => updateParam('circleSideTilt', v)} />
                <Slider label="Lift · 3–9 axis" value={params.circleLift} defaultValue={DEFAULT_PARAMS.circleLift} min={-180} max={180} step={ANGLE_STEP} unit="°" accent="violet" onChange={(v) => updateParam('circleLift', v)} />
              </>
            )}
            <div className="sub-label">FACE RELATIVE TO PATH</div>
            <Slider label={params.racketPath === 'circular' ? 'Hook' : 'Face yaw'} value={params.facePathAngle} defaultValue={DEFAULT_PARAMS.facePathAngle} min={-180} max={180} step={ANGLE_STEP} unit="°" accent="violet" onChange={(v) => updateParam('facePathAngle', v)} />
            <Slider label="Face tilt" value={params.faceTilt} defaultValue={DEFAULT_PARAMS.faceTilt} min={-180} max={180} step={ANGLE_STEP} unit="°" accent="violet" onChange={(v) => updateParam('faceTilt', v)} />
            <div className="binary-control">
              <span>Handle side</span>
              <div>
                {(['left', 'right'] as const).map((side) => (
                  <button key={side} className={handleSide === side ? 'active' : ''} onClick={() => setHandleSide(side)}>{side}</button>
                ))}
              </div>
            </div>
          </Section>

          <Section icon={<Layers3 size={18} />} eyebrow="MATERIAL" title="Rubber & Sponge" tone="mint">
            <Slider label="Effective grip · μ" value={params.rubberGrip} defaultValue={DEFAULT_PARAMS.rubberGrip} {...MATERIAL_LIMITS.rubberGrip} unit="" accent="mint" onChange={(v) => updateParam('rubberGrip', v)} />
            <Slider label="Topsheet loss factor" value={params.topsheetDamping} defaultValue={DEFAULT_PARAMS.topsheetDamping} {...MATERIAL_LIMITS.topsheetDamping} unit="tan δ" accent="mint" onChange={(v) => updateParam('topsheetDamping', v)} />
            <Slider
              label="Estimated topsheet pre-strain"
              value={params.topsheetTension}
              effectiveValue={result.impact.effectiveTopsheetTension}
              effectiveMin={boostedTensionIncrease}
              effectiveMax={MATERIAL_LIMITS.topsheetTension.max + boostedTensionIncrease}
              defaultValue={DEFAULT_PARAMS.topsheetTension}
              {...MATERIAL_LIMITS.topsheetTension}
              unit="%"
              accent="mint"
              onChange={(v) => updateParam('topsheetTension', v)}
              onEffectiveChange={(v) => updateParam(
                'topsheetTension',
                Math.max(0, Math.min(MATERIAL_LIMITS.topsheetTension.max, v - boostedTensionIncrease)),
              )}
            />
            <Slider label="Booster treatment · empirical" value={params.boosterLevel} defaultValue={DEFAULT_PARAMS.boosterLevel} {...MATERIAL_LIMITS.boosterLevel} unit="%" accent="mint" onChange={(v) => updateParam('boosterLevel', v)} />
            <div className="sub-label">SPONGE</div>
            <Slider
              label="Sponge thickness"
              value={params.spongeThickness}
              effectiveValue={result.impact.effectiveSpongeThickness}
              effectiveMin={MATERIAL_LIMITS.spongeThickness.min * boostedThicknessScale}
              effectiveMax={MATERIAL_LIMITS.spongeThickness.max * boostedThicknessScale}
              defaultValue={DEFAULT_PARAMS.spongeThickness}
              {...MATERIAL_LIMITS.spongeThickness}
              unit="mm"
              accent="mint"
              onChange={(v) => updateParam('spongeThickness', v)}
              onEffectiveChange={(v) => updateParam('spongeThickness', v / boostedThicknessScale)}
            />
            <Slider
              label="Nominal sponge hardness"
              value={params.spongeHardness}
              effectiveValue={result.impact.effectiveSpongeHardness}
              effectiveMin={MATERIAL_LIMITS.spongeHardness.min * boostedHardnessScale}
              effectiveMax={MATERIAL_LIMITS.spongeHardness.max * boostedHardnessScale}
              defaultValue={DEFAULT_PARAMS.spongeHardness}
              {...MATERIAL_LIMITS.spongeHardness}
              unit="°"
              accent="mint"
              onChange={(v) => updateParam('spongeHardness', v)}
              onEffectiveChange={(v) => updateParam('spongeHardness', v / boostedHardnessScale)}
            />
            <Slider label="Sponge loss factor" value={params.spongeDamping} defaultValue={DEFAULT_PARAMS.spongeDamping} {...MATERIAL_LIMITS.spongeDamping} unit="tan δ" accent="mint" onChange={(v) => updateParam('spongeDamping', v)} />
          </Section>

          <Section icon={<Layers3 size={18} />} eyebrow="MATERIAL" title="Blade" tone="violet">
            <Slider label={`Flexural rigidity · ~${result.impact.bladeNaturalFrequency.toFixed(0)} Hz loaded`} value={params.bladeStiffness} defaultValue={DEFAULT_PARAMS.bladeStiffness} {...MATERIAL_LIMITS.bladeStiffness} unit="N·m²" accent="violet" onChange={(v) => updateParam('bladeStiffness', v)} />
            <Slider label="Assembled racket mass" value={params.racketMass} defaultValue={DEFAULT_PARAMS.racketMass} {...MATERIAL_LIMITS.racketMass} unit="g" accent="violet" onChange={(v) => updateParam('racketMass', v)} />
            <Slider label="Modal damping" value={params.bladeDamping} defaultValue={DEFAULT_PARAMS.bladeDamping} {...MATERIAL_LIMITS.bladeDamping} displayScale={100} unit="% critical" accent="violet" onChange={(v) => updateParam('bladeDamping', v)} />
          </Section>

          <Section icon={<TableIcon size={18} />} eyebrow="MATERIAL" title="Table" tone="mint">
            <Slider label="Surface friction · μ" value={params.tableFriction} defaultValue={DEFAULT_PARAMS.tableFriction} min={0} max={0.6} step={0.01} unit="" accent="mint" onChange={(value) => updateParam('tableFriction', value)} />
          </Section>

        </aside>

        <section className="stage-panel">
          <div className="stage-toolbar">
            <div className="toolbar-brand">
              <div className="brand-mark"><BouncingBallIcon size={20} /></div>
              <strong>Arc Lab</strong>
            </div>
            <div className="phase-indicator"><span>{phase}</span><i>{time.toFixed(3)} s</i></div>
            <div className="camera-controls">
              <Eye size={15} />
              {([
                ['free', 'Free'],
                ['side', 'Side'],
                ['front', 'Front'],
                ['top', 'Top'],
                ['ball', 'Ball'],
              ] as Array<[CameraPreset, string]>).map(([preset, label]) => (
                <button key={preset} data-preset={preset} className={cameraPreset === preset ? 'active' : ''} onClick={() => { setCameraPreset(preset); setZoomRequest(null) }}>{label}</button>
              ))}
            </div>
            <button className="theme-toggle" aria-label={darkMode ? 'Use light mode' : 'Use dark mode'} onClick={() => setDarkMode((value) => !value)}>
              {darkMode ? <Sun size={15} /> : <Moon size={15} />}
            </button>
          </div>

          <div className="canvas-wrap">
            <Canvas dpr={[1, 2]} camera={{ position: [5.8, 3.7, -6.5], fov: 42, near: 0.01, far: 60 }}>
              <Scene
                result={result}
                params={params}
                time={time}
                playbackRate={playbackRate}
                cameraPreset={cameraPreset}
                tablePosition={tablePosition}
                darkMode={darkMode}
                handleSide={handleSide}
                zoomRequest={zoomRequest}
                onZoomChange={reportZoom}
                onCameraPovChange={setCameraPov}
              />
            </Canvas>
            <div className="zoom-hud" aria-label="Camera zoom">
              <ZoomIn size={13} />
              <input
                type="range"
                min={0}
                max={100}
                step={0.1}
                value={zoomLevel}
                style={{ '--zoom-level': `${zoomLevel}%` } as React.CSSProperties}
                aria-label="Camera zoom level"
                onInput={(event) => requestZoom(Number((event.target as HTMLInputElement).value))}
                onDoubleClick={() => requestZoom(zoomLevelFromDistance(defaultZoomDistance(cameraPreset), cameraPreset))}
              />
              <span>{Math.round(zoomLevel)}</span>
              <ZoomOut size={13} />
            </div>
            <div className="scene-legend">
              <span><i className="line incoming" /> Incoming arc</span>
              <span><i className="line outgoing" /> Predicted arc</span>
              <span><i className="line racket" /> Racket path</span>
            </div>
          </div>

          <div className="transport">
            <div className="phase-indicator timeline-phase"><span>{phase}</span><i>{time.toFixed(3)} s</i></div>
            <div className="speed-controls" aria-label="Playback speed">
              {[0.05, 0.1, 0.25, 0.5, 1].map((rate) => (
                <button key={rate} className={playbackRate === rate ? 'active' : ''} onClick={() => setPlaybackRate(rate)}>{rate}×</button>
              ))}
            </div>
            <div className="timeline-wrap">
              <div className="timeline-labels"><span>Approach</span><span>Impact · 0.000 s</span><span>Flight</span></div>
              <input
                className="timeline"
                style={{ '--timeline-progress': `${timelineProgress}%`, '--impact-position': `${((-startTime) / (endTime - startTime)) * 100}%` } as React.CSSProperties}
                type="range"
                min={startTime}
                max={endTime}
                step="any"
                value={time}
                onPointerDown={() => setPlaying(false)}
                onInput={(event) => setTime(Number((event.target as HTMLInputElement).value))}
                onDoubleClick={() => { setPlaying(false); setTime(startTime) }}
              />
            </div>
            <div className="playback-row">
              <div className="transport-buttons">
                <button aria-label="Back to beginning" title="Back to beginning" onClick={() => { setPlaying(false); setTime(startTime) }}><SkipBack size={16} fill="currentColor" /></button>
                <button aria-label="Previous frame" onClick={() => { setPlaying(false); setTime((t) => Math.max(startTime, t - STEP)) }}><ChevronLeft size={18} /></button>
                <button className="play-button" aria-label={playing ? 'Pause' : 'Play'} onClick={() => { if (time >= endTime) setTime(startTime); setPlaying((value) => !value) }}>
                  {playing ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" />}
                </button>
                <button aria-label="Next frame" onClick={() => { setPlaying(false); setTime((t) => Math.min(endTime, t + STEP)) }}><ChevronRight size={18} /></button>
              </div>
              <button className="jump-impact" onClick={() => { setPlaying(false); setTime(0) }}><Target size={15} /> Jump to impact</button>
            </div>
          </div>
        </section>

        <aside className="results-panel">
          <div className="results-heading">
            <button className="results-heading-toggle" onClick={() => setLiveSolutionExpanded((value) => !value)} aria-expanded={liveSolutionExpanded}>
              <span className="kicker"><Activity size={11} /> LIVE SOLUTION</span>
              <ChevronDown size={14} className={`section-chevron ${liveSolutionExpanded ? '' : 'collapsed'}`} />
            </button>
          </div>

          {liveSolutionExpanded && (
          <>
          <div className="live-card">
            <div className="card-title"><Activity size={17} /><span>Live ball</span><i>{phase} · {time.toFixed(3)} s</i></div>
            <div className="spin-canvas">
              <Canvas dpr={[1, 1.5]} camera={{ position: [0, 0, 3], fov: 43 }}>
                <SpinWidget
                  spin={livePoint.spin}
                  velocity={livePoint.velocity}
                  darkMode={darkMode}
                  cameraPov={cameraPov}
                  playbackRate={playbackRate}
                />
              </Canvas>
            </div>
            <div className="live-primary">
              <div><span>SPEED</span><strong>{(liveSpeed * speedScale).toFixed(2)}</strong><small>{speedUnit}</small></div>
              <div><span>TOTAL SPIN</span><strong>{Math.round(liveSpinRpm).toLocaleString()}</strong><small>rpm</small></div>
            </div>
            <div className="spin-readout">
              <div><span>ROLL</span><strong>{Math.round(Math.abs(liveRollRpm)).toLocaleString()}</strong><small>rpm · {liveRollDirection}</small></div>
              <div><span>{liveSidespinHeader}</span><strong>{Math.round(Math.abs(liveSidespinRpm)).toLocaleString()}</strong><small>rpm</small></div>
              <div><span>{liveTopBackspinHeader}</span><strong>{Math.round(Math.abs(liveTopBackspinRpm)).toLocaleString()}</strong><small>rpm</small></div>
            </div>
          </div>

          <div className={`bounce-card ${result.bounces.length ? 'active' : ''}`}>
            <BouncingBallIcon size={17} />
            <div>
              <strong>{result.bounces.length ? `${result.bounces.length} table bounce${result.bounces.length > 1 ? 's' : ''}` : 'No table bounces'}</strong>
              {result.bounces.length > 0 && (
                <span>{`First contact at ${result.bounces[0].t.toFixed(3)} s · X ${result.bounces[0].x.toFixed(2)} · Z ${result.bounces[0].z.toFixed(2)}`}</span>
              )}
            </div>
          </div>
          </>
          )}

          <div className="results-subhead">
            <button className="results-subhead-toggle" onClick={() => setAtImpactExpanded((value) => !value)} aria-expanded={atImpactExpanded}>
              <span><Target size={11} /> AT IMPACT</span>
              <ChevronDown size={14} className={`section-chevron ${atImpactExpanded ? '' : 'collapsed'}`} />
            </button>
          </div>

          {atImpactExpanded && (
          <>
          <div className="metric-grid">
            <Metric label="EXIT SPEED" value={(result.impact.outgoingSpeed * speedScale).toFixed(1)} unit={speedUnit} tone="mint" />
            <Metric label="LAUNCH" value={`${result.impact.elevation >= 0 ? '+' : ''}${result.impact.elevation.toFixed(1)}°`} unit="elevation" tone="coral" />
          </div>

          <div className="impact-card">
            <div className="card-title spin-card-title">
              <span>TOTAL SPIN</span>
              <div className="total-spin-value">
                <strong>{Math.round(result.impact.totalSpinRpm).toLocaleString()}</strong>
                <small>rpm</small>
              </div>
            </div>
            <div className="spin-readout">
              <div><span>ROLL</span><strong>{Math.round(Math.abs(impactRollRpm)).toLocaleString()}</strong><small>rpm · {impactRollDirection}</small></div>
              <div><span>{impactSidespinHeader}</span><strong>{Math.round(Math.abs(result.impact.sidespinRpm)).toLocaleString()}</strong><small>rpm</small></div>
              <div><span>{impactTopBackspinLabel}</span><strong>{Math.round(Math.abs(impactTopBackspinRpm)).toLocaleString()}</strong><small>rpm</small></div>
            </div>
          </div>

          <div className="force-card">
            <div className="card-title"><Gauge size={17} /><span>Impact forces</span><i>{(result.impact.contactTime * 1000).toFixed(2)} ms dwell</i></div>
            <div className="force-readout">
              <div><span>Peak normal</span><strong>{result.impact.peakNormalForce.toFixed(1)} N</strong></div>
              <div><span>Mean friction</span><strong>{result.impact.frictionForce.toFixed(1)} N</strong></div>
            </div>
            <div className="force-track"><i style={{ width: `${forceRatio}%` }} /></div>
          </div>

          <div className={`material-card ${result.impact.bottomedOut ? 'bottomed' : ''}`}>
            <div className="card-title"><Layers3 size={17} /><span>Material response</span><i>e = {result.impact.effectiveRestitution.toFixed(2)}</i></div>
            <div className="compression-label">
              <span>Sponge compression</span>
              <strong>{result.impact.spongeCompression.toFixed(2)} / {result.impact.spongeUsableTravel.toFixed(2)} mm usable</strong>
            </div>
            <div className="compression-track"><i style={{ width: `${Math.min(100, result.impact.spongeCompressionRatio * 100)}%` }} /></div>
            <div className="material-state">
              <span>{result.impact.bottomedOut ? 'Bottom-out engaged' : 'Within elastic travel'}</span>
              <strong>{Math.round(result.impact.spongeCompressionRatio * 100)}%</strong>
            </div>
            <div className="material-state blade-state">
              <span>Loaded blade mode</span>
              <strong>{result.impact.bladeNaturalFrequency.toFixed(0)} Hz · {result.impact.bladeDeflection.toFixed(2)} mm</strong>
            </div>
          </div>

          <div className="exit-benchmarks">
            <span className="kicker">ELITE STROKE REFERENCE</span>
            <div className="benchmark-subhead">RACKET AT IMPACT</div>
            <div className="elite-swing-reference">
              <div>
                <span>Speed</span>
                <strong>{formatBenchmarkSpeed(ELITE_TOPSPIN_RACKET_SPEED, false, speedUnit)}</strong>
                <small>{speedUnit} · at impact</small>
              </div>
              <div>
                <span>Acceleration</span>
                <strong>{ELITE_TOPSPIN_RACKET_ACCELERATION[0]}–{ELITE_TOPSPIN_RACKET_ACCELERATION[1]}</strong>
                <small>m/s² · at impact</small>
              </div>
            </div>
            <p className="benchmark-note">Representative measured elite topspin values for resultant racket motion.</p>
            <div className="benchmark-subhead ball-benchmark-subhead">BALL AFTER IMPACT</div>
            <div className="stroke-benchmarks" aria-label="Representative elite table tennis stroke speed and spin benchmarks">
              <div className="stroke-benchmark-head" aria-hidden="true">
                <span>Stroke</span>
                <span>Speed</span>
                <span>Spin</span>
              </div>
              {STROKE_BENCHMARKS.map((benchmark) => (
                <div className="stroke-benchmark" key={benchmark.stroke}>
                  <strong>{benchmark.stroke}</strong>
                  <span>{formatBenchmarkSpeed(benchmark.speed, benchmark.approximate, speedUnit)} <small>{speedUnit}</small></span>
                  <span>{benchmark.spin} <small>rpm · {benchmark.direction}</small></span>
                </div>
              ))}
            </div>
            <p className="benchmark-note">Representative post-contact measurements, not limits. Push uses a practical short-push reference.</p>
          </div>

          <div className="contact-card">
            <Target size={19} />
            <div><strong>Calculated impact location</strong><span>X {result.impact.contactPoint.x.toFixed(2)} · Y {result.impact.contactPoint.y.toFixed(2)} · Z {result.impact.contactPoint.z.toFixed(2)} m</span></div>
          </div>

          <div className="model-note">
            <Info size={16} />
            <p><strong>Model note</strong> The 2.7 g ball shell and rubber contact patch use measured speed-dependent rebound behavior. A progressively hardening sponge acts in parallel with a pre-strained topsheet, while the blade responds as a damped first bending mode derived from flexural rigidity and assembled-racket mass. Booster changes are product-specific estimates, and post-factory treatment is not competition-legal. Tangential shear stores and returns energy during grip, with sliding capped by effective friction.</p>
          </div>
          </>
          )}
        </aside>
      </div>
    </main>
  )
}

export default App
