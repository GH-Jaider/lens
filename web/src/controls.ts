// The camera's controls on the phone page: a strip that is always in view,
// like a camera's, with one value per setting. A phone only shows the ones its
// browser can really set: an Android phone offers shutter, ISO, focus and
// white balance; an iPhone offers far fewer.

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
  quality: string
  normal: string
  high: string
  zoom: string
  light: string
  on: string
  off: string
  exposure: string
  shutter: string
  iso: string
  brightness: string
  white: string
  temperature: string
  focus: string
  distance: string
  auto: string
  manual: string
  locked: string
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const made = document.createElement(tag)
  if (className) made.className = className
  if (text) made.textContent = text
  return made
}

/**
 * One thing about the camera that can be set. The strip shows its name and
 * value at all times; `open` puts its control (buttons or a slider) in place.
 */
export interface Param {
  label: string
  value: string
  open(into: HTMLElement, changed: () => void): void
}

/** A few options, one of them chosen. */
function choice<T>(label: string, options: [text: string, value: T][], current: T, pick: (value: T) => void): Param {
  const param: Param = {
    label,
    value: options.find(([, value]) => value === current)?.[0] ?? "",
    open(into, changed) {
      const buttons = element("div", "seg")
      for (const [text, value] of options) {
        const button = element("button", text === param.value ? "on" : "", text)
        button.onclick = () => {
          for (const other of buttons.children) other.classList.toggle("on", other === button)
          param.value = text
          pick(value)
          changed()
        }
        buttons.append(button)
      }
      into.append(buttons)
    },
  }
  return param
}

/** A value along a range. */
function slider(
  label: string,
  range: Range,
  current: number,
  show: (value: number) => string,
  move: (value: number) => void,
): Param {
  let at = current
  const param: Param = {
    label,
    value: show(current),
    open(into, changed) {
      const input = element("input")
      input.type = "range"
      input.min = String(range.min)
      input.max = String(range.max)
      input.step = String(range.step || (range.max - range.min) / 100)
      input.value = String(at)
      const output = element("output", "", param.value)
      input.oninput = () => {
        at = input.valueAsNumber
        param.value = show(at)
        output.textContent = param.value
        move(at)
        changed()
      }
      into.append(input, output)
    },
  }
  return param
}

const usable = (range: Range | undefined): range is Range => Boolean(range && range.max > range.min)

/** Exposure time comes in units of 100 microseconds; photographers read 1/250. */
function shutterSpeed(units: number): string {
  const seconds = units / 10_000
  return seconds >= 1 ? `${seconds.toFixed(1)} s` : `1/${Math.round(1 / seconds)}`
}

/**
 * Everything this camera lets its page set, in the order of the strip.
 * `resize` is called when the picture's size, rate or quality is chosen, since
 * those also concern the connection; the rest is set on the camera here.
 */
export function cameraParams(track: MediaStreamTrack, wanted: Wanted, t: Texts, resize: () => void): Param[] {
  const can: Capabilities = track.getCapabilities?.() ?? {}
  const now: Settings = track.getSettings()
  // Several settings moved quickly are sent one after the other, never at once.
  let busy: Promise<void> = Promise.resolve()
  const set = (extra: Extra) => {
    busy = busy.then(() => track.applyConstraints({ advanced: [extra as MediaTrackConstraintSet] })).catch(() => {})
  }
  const params: Param[] = []

  // A phone held upright reports its long side as the height.
  const longest = Math.max(can.width?.max ?? 1920, can.height?.max ?? 1080)
  const sizes = ([720, 1080, 2160] as const).filter((height) => (height * 16) / 9 <= longest + 1)
  if (sizes.length > 1) {
    const options = sizes.map((height): [string, number] => [height === 2160 ? "4K" : `${height}p`, height])
    params.push(
      choice(t.resolution, options, wanted.height, (height) => {
        wanted.height = height
        resize()
      }),
    )
  }
  const rates = [24, 30, 60].filter((fps) => fps <= (can.frameRate?.max ?? 30) + 0.5)
  if (rates.length > 1) {
    const options = rates.map((fps): [string, number] => [String(fps), fps])
    params.push(
      choice(t.fps, options, wanted.fps, (fps) => {
        wanted.fps = fps
        resize()
      }),
    )
  }
  const qualities: [string, number][] = [
    [t.normal, 8],
    [t.high, 25],
  ]
  params.push(
    choice(t.quality, qualities, wanted.mbps, (mbps) => {
      wanted.mbps = mbps
      resize()
    }),
  )

  if (usable(can.zoom)) {
    const show = (zoom: number) => `${zoom.toFixed(1)}×`
    params.push(slider(t.zoom, can.zoom, now.zoom ?? can.zoom.min, show, (zoom) => set({ zoom })))
  }
  if (can.torch) {
    const options: [string, boolean][] = [
      [t.off, false],
      [t.on, true],
    ]
    params.push(choice(t.light, options, Boolean(now.torch), (torch) => set({ torch })))
  }
  if (usable(can.exposureCompensation)) {
    const show = (stops: number) => `${stops > 0 ? "+" : ""}${stops.toFixed(1)}`
    const range = can.exposureCompensation
    params.push(
      slider(t.brightness, range, now.exposureCompensation ?? 0, show, (exposureCompensation) =>
        set({ exposureCompensation }),
      ),
    )
  }

  // Automatic, or held still. A camera whose page can also set the value
  // itself (a shutter time, a temperature) calls the second "Manual", and
  // moving that value switches to it. One that cannot only offers to lock what
  // the camera chose, which shows as nothing changing: that is the point.
  type Mode = "exposureMode" | "whiteBalanceMode" | "focusMode"
  const mode = (label: string, key: Mode, list: string[] | undefined, settable: boolean): Param | null => {
    if (!list?.includes("manual") || !list.includes("continuous")) return null
    const options: [string, string][] = [
      [t.auto, "continuous"],
      [settable ? t.manual : t.locked, "manual"],
    ]
    const param = choice(label, options, now[key] === "manual" ? "manual" : "continuous", (value) =>
      set({ [key]: value }),
    )
    params.push(param)
    return param
  }

  const exposure = mode(t.exposure, "exposureMode", can.exposureMode, usable(can.exposureTime) || usable(can.iso))
  if (exposure && usable(can.exposureTime)) {
    const range = can.exposureTime
    params.push(
      slider(t.shutter, range, now.exposureTime ?? range.min, shutterSpeed, (exposureTime) => {
        exposure.value = t.manual
        set({ exposureMode: "manual", exposureTime })
      }),
    )
  }
  if (exposure && usable(can.iso)) {
    const show = (iso: number) => String(Math.round(iso))
    params.push(
      slider(t.iso, can.iso, now.iso ?? can.iso.min, show, (iso) => {
        exposure.value = t.manual
        set({ exposureMode: "manual", iso })
      }),
    )
  }
  const white = mode(t.white, "whiteBalanceMode", can.whiteBalanceMode, usable(can.colorTemperature))
  if (white && usable(can.colorTemperature)) {
    const range = can.colorTemperature
    const show = (kelvin: number) => `${Math.round(kelvin)} K`
    params.push(
      slider(t.temperature, range, now.colorTemperature ?? range.min, show, (colorTemperature) => {
        white.value = t.manual
        set({ whiteBalanceMode: "manual", colorTemperature })
      }),
    )
  }
  const focus = mode(t.focus, "focusMode", can.focusMode, usable(can.focusDistance))
  if (focus && usable(can.focusDistance)) {
    const range = can.focusDistance
    const show = (metres: number) => `${metres.toFixed(1)} m`
    params.push(
      slider(t.distance, range, now.focusDistance ?? range.min, show, (focusDistance) => {
        focus.value = t.manual
        set({ focusMode: "manual", focusDistance })
      }),
    )
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
    return `${sent.frameWidth}×${sent.frameHeight} · ${Math.round(sent.framesPerSecond ?? 0)} fps · ${mbps.toFixed(1)} Mbps`
  }
  return ""
}
