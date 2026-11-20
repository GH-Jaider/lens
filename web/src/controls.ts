// What the phone's camera lets its page set, as the settings of the strip.
// A phone only gets the ones its browser can really set: an Android phone
// offers shutter, ISO, focus and white balance; an iPhone offers far fewer.
// A setting whose value the page cannot choose is left out altogether.

/** The settings beyond the standard ones, as browsers that have them report them. */
interface Range {
  min: number
  max: number
  step?: number
}
interface Capabilities extends MediaTrackCapabilities {
  zoom?: Range
  torch?: boolean
  exposureMode?: string[]
  exposureTime?: Range
  iso?: Range
  exposureCompensation?: Range
  whiteBalanceMode?: string[]
  colorTemperature?: Range
  focusMode?: string[]
  focusDistance?: Range
}
type Extra = Partial<{
  zoom: number
  torch: boolean
  exposureMode: string
  exposureTime: number
  iso: number
  exposureCompensation: number
  whiteBalanceMode: string
  colorTemperature: number
  focusMode: string
  focusDistance: number
}>
type Settings = MediaTrackSettings & Extra

/** What the person chose; kept when the camera is switched. */
export interface Wanted {
  height: number
  fps: number
  /** Megabits per second the phone may send to each viewer. */
  mbps: number
}

export interface Texts {
  resolution: string
  fps: string
  bitrate: string
  zoom: string
  light: string
  on: string
  off: string
  ev: string
  shutter: string
  iso: string
  wb: string
  /** Tungsten, fluorescent, daylight, cloudy, shade: in that order. */
  whites: string[]
  focus: string
  auto: string
}

/** A setting the camera can also look after by itself. */
export interface Auto {
  on: boolean
  set(on: boolean): void
}

interface Base {
  label: string
  /** As the strip shows it. */
  readonly value: string
  auto?: Auto
}
/** One of a few named options. */
export interface Choice extends Base {
  kind: "choice"
  stops: string[]
  at: number
  pick(index: number): void
}
/** Anywhere along a range; `at` runs from 0 to 1. */
export interface Scale extends Base {
  kind: "scale"
  at: number
  move(at: number): void
}
export type Param = Choice | Scale

/** `brief` gives the strip a shorter name than the dial has room for. */
export function choice<T>(
  label: string,
  options: [text: string, value: T][],
  current: T,
  pick: (value: T) => void,
  brief: (text: string) => string = (text) => text,
): Choice {
  const param: Choice = {
    kind: "choice",
    label,
    stops: options.map(([text]) => text),
    at: Math.max(
      0,
      options.findIndex(([, value]) => value === current),
    ),
    get value() {
      return brief(param.stops[param.at] ?? "")
    },
    pick(index) {
      const option = options[index]
      if (!option || index === param.at) return
      param.at = index
      pick(option[1])
    },
  }
  return param
}

const usable = (range: Range | undefined): range is Range => Boolean(range && range.max > range.min)

/** Exposure time comes in units of 100 microseconds; photographers read 1/250. */
function shutterSpeed(units: number): string {
  const seconds = units / 10_000
  return seconds >= 1 ? `${seconds.toFixed(1)}s` : `1/${Math.round(1 / seconds)}`
}

/**
 * Everything this camera lets its page set, in the order of the strip.
 * `basic` is the size and rate asked of the camera, which every change sends
 * along: a browser takes each request as the whole of what is wanted, so one
 * that left them out would let the camera fall back to its own size.
 * `rate` is called when the bitrate is chosen, which concerns the connection.
 * `report` gets what was asked of the camera and what came of it.
 */
export function cameraParams(
  track: MediaStreamTrack,
  wanted: Wanted,
  t: Texts,
  basic: () => MediaTrackConstraints,
  rate: () => void,
  report: (entry: object) => void,
): Param[] {
  const can: Capabilities = track.getCapabilities?.() ?? {}
  const now: Settings = track.getSettings()
  const params: Param[] = []

  // What has been set by hand, by group (zoom, exposure, white balance…).
  // They always go to the camera together, as ONE set: browsers have long
  // only honoured the first set of a request, and take each request as the
  // whole of what is wanted, so a setting left out could be let go.
  const extras = new Map<string, Extra>()
  let running = false
  let again = false
  let resize = false
  async function apply(withSize = false) {
    resize ||= withSize
    if (running) {
      again = true
      return
    }
    running = true
    do {
      again = false
      const merged: Extra = Object.assign({}, ...extras.values())
      const advanced = Object.keys(merged).length ? [merged as MediaTrackConstraintSet] : []
      // The size and rate only go along when they are what changed: asking for
      // them again makes some phones set the whole camera up afresh.
      const asked: MediaTrackConstraints = resize ? { ...basic(), advanced } : { advanced }
      resize = false
      const started = performance.now()
      // A phone that never answers must not leave every later change waiting.
      const slow = new Promise<never>((_, fail) => setTimeout(() => fail(new Error("no answer in 3 s")), 3000))
      const outcome = await Promise.race([track.applyConstraints(asked), slow]).then(
        () => "ok",
        (error) => String(error),
      )
      report({ event: "apply", asked, outcome, ms: Math.round(performance.now() - started), now: track.getSettings() })
    } while (again)
    running = false
  }
  const set = (group: string, extra: Extra) => {
    extras.set(group, extra)
    apply()
  }

  /** A value along a range, on a straight or (for values that span decades) a logarithmic scale. */
  const scale = (
    label: string,
    range: Range,
    current: number,
    show: (value: number) => string,
    move: (value: number) => void,
    options: { log?: boolean; auto?: Auto } = {},
  ): Scale => {
    const log = Boolean(options.log) && range.min > 0
    const span = log ? Math.log(range.max / range.min) : range.max - range.min
    const toAt = (value: number) => (log ? Math.log(value / range.min) : value - range.min) / span
    const fromAt = (at: number) => {
      const value = log ? range.min * Math.exp(at * span) : range.min + at * span
      const stepped = range.step ? Math.round(value / range.step) * range.step : value
      return Math.min(range.max, Math.max(range.min, stepped))
    }
    let value = Math.min(range.max, Math.max(range.min, current))
    const param: Scale = {
      kind: "scale",
      label,
      auto: options.auto,
      at: toAt(value),
      get value() {
        return options.auto?.on ? t.auto : show(value)
      },
      move(at) {
        param.at = Math.min(1, Math.max(0, at))
        value = fromAt(param.at)
        move(value)
      },
    }
    return param
  }

  // A phone held upright reports its long side as the height.
  const longest = Math.max(can.width?.max ?? 1920, can.height?.max ?? 1080)
  const sizes = ([720, 1080, 2160] as const).filter((height) => (height * 16) / 9 <= longest + 1)
  if (sizes.length > 1) {
    const options = sizes.map((height): [string, number] => [height === 2160 ? "4K" : `${height}p`, height])
    params.push(
      choice(t.resolution, options, wanted.height, (height) => {
        wanted.height = height
        apply(true)
      }),
    )
  }
  const rates = [24, 30, 60].filter((fps) => fps <= (can.frameRate?.max ?? 30) + 0.5)
  if (rates.length > 1) {
    const options = rates.map((fps): [string, number] => [String(fps), fps])
    params.push(
      choice(t.fps, options, wanted.fps, (fps) => {
        wanted.fps = fps
        apply(true)
      }),
    )
  }
  const bitrates = [4, 8, 16, 25].map((mbps): [string, number] => [`${mbps} Mb`, mbps])
  params.push(
    choice(t.bitrate, bitrates, wanted.mbps, (mbps) => {
      wanted.mbps = mbps
      rate()
    }),
  )

  if (usable(can.zoom)) {
    const show = (zoom: number) => `${zoom.toFixed(1)}×`
    params.push(scale(t.zoom, can.zoom, now.zoom ?? can.zoom.min, show, (zoom) => set("zoom", { zoom })))
  }
  if (usable(can.exposureCompensation)) {
    const show = (stops: number) => `${stops > 0 ? "+" : ""}${stops.toFixed(1)}`
    const range = can.exposureCompensation
    params.push(
      scale(t.ev, range, now.exposureCompensation ?? 0, show, (exposureCompensation) =>
        set("ev", { exposureCompensation }),
      ),
    )
  }

  // Automatic or by hand. Only for cameras where the page can choose the value
  // itself: moving it switches to "by hand", and Auto hands it back.
  type Mode = "exposureMode" | "whiteBalanceMode" | "focusMode"
  const mode = (group: string, key: Mode, list: string[] | undefined, chosen: Extra): Auto | undefined => {
    if (!list?.includes("manual") || !list.includes("continuous")) return undefined
    const auto: Auto = {
      on: now[key] !== "manual",
      set(on) {
        auto.on = on
        set(group, on ? { [key]: "continuous" } : { [key]: "manual", ...chosen })
      },
    }
    return auto
  }

  // Shutter and ISO are one decision: either the camera exposes, or both are set.
  const exposed: Extra = {}
  const exposure = mode("exposure", "exposureMode", can.exposureMode, exposed)
  if (exposure && usable(can.exposureTime)) {
    const range = can.exposureTime
    params.push(
      scale(
        t.shutter,
        range,
        now.exposureTime ?? range.min,
        shutterSpeed,
        (exposureTime) => {
          exposed.exposureTime = exposureTime
          exposure.set(false)
        },
        { log: true, auto: exposure },
      ),
    )
  }
  if (exposure && usable(can.iso)) {
    const show = (iso: number) => String(Math.round(iso))
    params.push(
      scale(
        t.iso,
        can.iso,
        now.iso ?? can.iso.min,
        show,
        (iso) => {
          exposed.iso = iso
          exposure.set(false)
        },
        { log: true, auto: exposure },
      ),
    )
  }
  // White balance by name, not by degree: phones only have a handful of
  // settings for it and take the nearest to whatever temperature is asked, so
  // a fine scale would move with nothing to show for it most of the way.
  if (can.whiteBalanceMode?.includes("manual") && usable(can.colorTemperature)) {
    const range = can.colorTemperature
    const presets = ([2850, 4250, 5000, 6000, 7000] as const)
      .map((kelvin, index): [string, number] => [t.whites[index] ?? `${kelvin}K`, kelvin])
      .filter(([, kelvin]) => kelvin >= range.min && kelvin <= range.max)
    if (presets.length) {
      const options: [string, number][] = [[t.auto, 0], ...presets]
      const byHand = now.whiteBalanceMode === "manual" && now.colorTemperature
      const nearest = presets.reduce((best, preset) =>
        Math.abs(preset[1] - (now.colorTemperature ?? 0)) < Math.abs(best[1] - (now.colorTemperature ?? 0))
          ? preset
          : best,
      )
      params.push(
        choice(t.wb, options, byHand ? nearest[1] : 0, (kelvin) =>
          set(
            "white",
            kelvin ? { whiteBalanceMode: "manual", colorTemperature: kelvin } : { whiteBalanceMode: "continuous" },
          ),
        ),
      )
    }
  }
  const depth: Extra = {}
  const focus = mode("focus", "focusMode", can.focusMode, depth)
  if (focus && usable(can.focusDistance)) {
    const range = can.focusDistance
    const show = (metres: number) => (metres >= 10 ? `${Math.round(metres)}m` : `${metres.toFixed(2)}m`)
    params.push(
      scale(
        t.focus,
        range,
        now.focusDistance ?? range.min,
        show,
        (focusDistance) => {
          depth.focusDistance = focusDistance
          focus.set(false)
        },
        { log: true, auto: focus },
      ),
    )
  }
  if (can.torch) {
    const options: [string, boolean][] = [
      [t.off, false],
      [t.on, true],
    ]
    params.push(choice(t.light, options, Boolean(now.torch), (torch) => set("torch", { torch })))
  }
  return params
}

/** What one connection is really sending: size, rate and bitrate. */
export async function sending(pc: RTCPeerConnection, before: { bytes: number; at: number }): Promise<string> {
  for (const report of (await pc.getStats()).values()) {
    if (report.type !== "outbound-rtp" || report.kind !== "video") continue
    const sent = report as RTCOutboundRtpStreamStats & {
      frameWidth?: number
      frameHeight?: number
      framesPerSecond?: number
    }
    const bytes = sent.bytesSent ?? 0
    const seconds = (sent.timestamp - before.at) / 1000
    const mbps = before.at && seconds > 0 ? ((bytes - before.bytes) * 8) / seconds / 1_000_000 : 0
    before.bytes = bytes
    before.at = sent.timestamp
    if (!sent.frameWidth || !sent.frameHeight) return ""
    const fps = Math.round(sent.framesPerSecond ?? 0)
    return `${sent.frameWidth}×${sent.frameHeight} · ${fps} fps · ${mbps.toFixed(1)} Mbps`
  }
  return ""
}
