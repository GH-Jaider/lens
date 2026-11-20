// The camera's controls on the phone page. A phone only shows the ones its
// browser can really set: an Android phone offers shutter, ISO, focus and
// white balance; an iPhone offers far fewer. Nothing is shown that would do
// nothing.

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
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const made = document.createElement(tag)
  if (className) made.className = className
  if (text) made.textContent = text
  return made
}

/** A row of buttons where one is chosen. */
function choice<T>(label: string, options: [text: string, value: T][], current: T, pick: (value: T) => void) {
  const row = element("div", "row wide")
  const buttons = element("div", "seg")
  for (const [text, value] of options) {
    const button = element("button", value === current ? "on" : "", text)
    button.onclick = () => {
      for (const other of buttons.children) other.classList.toggle("on", other === button)
      pick(value)
    }
    buttons.append(button)
  }
  row.append(element("span", "", label), buttons)
  return row
}

/** A slider with its value beside it. */
function slider(
  label: string,
  range: Range,
  current: number,
  show: (value: number) => string,
  move: (value: number) => void,
) {
  const row = element("div", "row")
  const input = element("input")
  input.type = "range"
  input.min = String(range.min)
  input.max = String(range.max)
  input.step = String(range.step || (range.max - range.min) / 100)
  input.value = String(current)
  const value = element("output", "", show(current))
  input.oninput = () => {
    value.textContent = show(input.valueAsNumber)
    move(input.valueAsNumber)
  }
  row.append(element("span", "", label), input, value)
  return row
}

const usable = (range: Range | undefined): range is Range => Boolean(range && range.max > range.min)

/** Exposure time comes in units of 100 microseconds; photographers read 1/250. */
function shutterSpeed(units: number): string {
  const seconds = units / 10_000
  return seconds >= 1 ? `${seconds.toFixed(1)} s` : `1/${Math.round(1 / seconds)}`
}

/**
 * Fills `into` with the controls this camera has. `resize` is called when the
 * picture's size, rate or bitrate is chosen, since those also concern the
 * connection; everything else is set on the camera here.
 */
export function showControls(into: HTMLElement, track: MediaStreamTrack, wanted: Wanted, t: Texts, resize: () => void) {
  const can: Capabilities = track.getCapabilities?.() ?? {}
  const now: Settings = track.getSettings()
  // Several settings moved quickly are sent one after the other, never at once.
  let busy: Promise<void> = Promise.resolve()
  const set = (extra: Extra) => {
    busy = busy.then(() => track.applyConstraints({ advanced: [extra as MediaTrackConstraintSet] })).catch(() => {})
  }
  into.replaceChildren()

  // A phone held upright reports its long side as the height.
  const longest = Math.max(can.width?.max ?? 1920, can.height?.max ?? 1080)
  const sizes = ([720, 1080, 2160] as const).filter((height) => (height * 16) / 9 <= longest + 1)
  if (sizes.length > 1) {
    const options = sizes.map((height): [string, number] => [height === 2160 ? "4K" : `${height}p`, height])
    into.append(
      choice(t.resolution, options, wanted.height, (height) => {
        wanted.height = height
        resize()
      }),
    )
  }
  const rates = [24, 30, 60].filter((fps) => fps <= (can.frameRate?.max ?? 30) + 0.5)
  if (rates.length > 1) {
    const options = rates.map((fps): [string, number] => [String(fps), fps])
    into.append(
      choice(t.fps, options, wanted.fps, (fps) => {
        wanted.fps = fps
        resize()
      }),
    )
  }
  into.append(
    choice(
      t.quality,
      [
        [t.normal, 8],
        [t.high, 25],
      ],
      wanted.mbps,
      (mbps) => {
        wanted.mbps = mbps
        resize()
      },
    ),
  )

  if (usable(can.zoom)) {
    into.append(
      slider(
        t.zoom,
        can.zoom,
        now.zoom ?? can.zoom.min,
        (zoom) => `${zoom.toFixed(1)}×`,
        (zoom) => set({ zoom }),
      ),
    )
  }
  if (can.torch) {
    into.append(
      choice(
        t.light,
        [
          [t.off, false],
          [t.on, true],
        ],
        Boolean(now.torch),
        (torch) => set({ torch }),
      ),
    )
  }
  if (usable(can.exposureCompensation)) {
    const show = (stops: number) => `${stops > 0 ? "+" : ""}${stops.toFixed(1)}`
    into.append(
      slider(t.brightness, can.exposureCompensation, now.exposureCompensation ?? 0, show, (exposureCompensation) =>
        set({ exposureCompensation }),
      ),
    )
  }

  // Moving a manual setting switches its mode to manual, as a camera does.
  const modes = (label: string, key: "exposureMode" | "whiteBalanceMode" | "focusMode", list: string[] | undefined) => {
    if (!list?.includes("manual") || !list.includes("continuous")) return null
    const row = choice(
      label,
      [
        [t.auto, "continuous"],
        [t.manual, "manual"],
      ],
      now[key] === "manual" ? "manual" : "continuous",
      (mode) => set({ [key]: mode }),
    )
    into.append(row)
    return () => {
      const [auto, manual] = row.querySelectorAll("button")
      auto?.classList.remove("on")
      manual?.classList.add("on")
    }
  }

  const exposure = modes(t.exposure, "exposureMode", can.exposureMode)
  if (exposure && usable(can.exposureTime)) {
    into.append(
      slider(t.shutter, can.exposureTime, now.exposureTime ?? can.exposureTime.min, shutterSpeed, (exposureTime) => {
        exposure()
        set({ exposureMode: "manual", exposureTime })
      }),
    )
  }
  if (exposure && usable(can.iso)) {
    into.append(
      slider(
        t.iso,
        can.iso,
        now.iso ?? can.iso.min,
        (iso) => String(Math.round(iso)),
        (iso) => {
          exposure()
          set({ exposureMode: "manual", iso })
        },
      ),
    )
  }
  const white = modes(t.white, "whiteBalanceMode", can.whiteBalanceMode)
  if (white && usable(can.colorTemperature)) {
    const show = (kelvin: number) => `${Math.round(kelvin)} K`
    into.append(
      slider(
        t.temperature,
        can.colorTemperature,
        now.colorTemperature ?? can.colorTemperature.min,
        show,
        (colorTemperature) => {
          white()
          set({ whiteBalanceMode: "manual", colorTemperature })
        },
      ),
    )
  }
  const focus = modes(t.focus, "focusMode", can.focusMode)
  if (focus && usable(can.focusDistance)) {
    const show = (metres: number) => `${metres.toFixed(2)} m`
    into.append(
      slider(t.distance, can.focusDistance, now.focusDistance ?? can.focusDistance.min, show, (focusDistance) => {
        focus()
        set({ focusMode: "manual", focusDistance })
      }),
    )
  }
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
