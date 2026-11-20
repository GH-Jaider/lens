// The page the phone opens from the QR code: it sends the camera to every
// viewer (the OBS source and the preview in the app window).
import { cameraParams, choice, type Param, sending, type Wanted } from "./controls.ts"
import { openDial } from "./dial.ts"
import { $, type PhoneMessage, pick, type Signal } from "./types.ts"

const t = pick({
  en: {
    starting: "Starting camera",
    connecting: "Connecting",
    live: "Live",
    lost: "Looking for the computer",
    denied: "Lens needs your camera. Allow it when the browser asks.",
    insecure: "This page has to be opened from the code Lens shows on the computer.",
    replaced: "Another phone took over as the camera.",
    retry: "Try again",
    again: "Use this phone",
    lens: "Lens",
    front: "Front",
    back: "Back",
    ultra: "Ultra wide",
    tele: "Tele",
    controls: {
      resolution: "Res",
      fps: "FPS",
      bitrate: "Bitrate",
      zoom: "Zoom",
      light: "Light",
      on: "On",
      off: "Off",
      ev: "EV",
      shutter: "Shutter",
      iso: "ISO",
      wb: "WB",
      focus: "Focus",
      auto: "Auto",
    },
  },
  es: {
    starting: "Iniciando la cámara",
    connecting: "Conectando",
    live: "En vivo",
    lost: "Buscando el computador",
    denied: "Lens necesita tu cámara. Permítela cuando el navegador pregunte.",
    insecure: "Esta página debe abrirse desde el código que Lens muestra en el computador.",
    replaced: "Otro celular pasó a ser la cámara.",
    retry: "Reintentar",
    again: "Usar este celular",
    lens: "Lente",
    front: "Frontal",
    back: "Trasera",
    ultra: "Ultra angular",
    tele: "Tele",
    controls: {
      resolution: "Res",
      fps: "FPS",
      bitrate: "Bitrate",
      zoom: "Zoom",
      light: "Luz",
      on: "Sí",
      off: "No",
      ev: "EV",
      shutter: "Obturador",
      iso: "ISO",
      wb: "WB",
      focus: "Foco",
      auto: "Auto",
    },
  },
})

interface Peer {
  pc: RTCPeerConnection
  /** Candidates that arrived before the viewer's answer. */
  waiting: RTCIceCandidateInit[]
}

const token = new URLSearchParams(location.search).get("t") ?? ""
const video = $<HTMLVideoElement>("video")
const peers = new Map<number, Peer>()
let stream: MediaStream | null = null
let facing: "environment" | "user" = "environment"
let id: number | null = null
let events: EventSource | null = null
// The camera is asked for what was chosen; it gives the closest it has.
const wanted: Wanted = { height: 1080, fps: 30, mbps: 8 }

// What is really being sent, beside "Live": size, rate and bitrate.
const sent = { bytes: 0, at: 0 }
let figures = ""

function notice(text: string, button: string) {
  $("notice").textContent = text
  $("retry").textContent = button
  document.body.classList.add("notice-on")
}

function refresh(starting = false) {
  const live = [...peers.values()].some((peer) => peer.pc.connectionState === "connected")
  const waiting = events?.readyState === EventSource.OPEN ? t.connecting : t.lost
  $("status").textContent = starting ? t.starting : live ? t.live : waiting
  $("status").classList.toggle("live", live)
  $("figures").textContent = live ? figures : ""
}

setInterval(async () => {
  const live = [...peers.values()].find((peer) => peer.pc.connectionState === "connected")
  figures = live ? await sending(live.pc, sent) : ""
  refresh()
}, 1000)

const send = (to: number, data: Signal) =>
  fetch(`/signal?t=${token}&id=${id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to, data }),
  }).catch(() => {})

/** The size and rate chosen, as the camera is asked for them. */
function shape(): MediaTrackConstraints {
  const width = Math.round((wanted.height * 16) / 9)
  return { width: { ideal: width }, height: { ideal: wanted.height }, frameRate: { ideal: wanted.fps } }
}

/** How much the phone may send: the link is the local network, so quality
    matters more than thrift. */
async function limit(sender: RTCRtpSender) {
  try {
    const params = sender.getParameters()
    const [encoding] = params.encodings
    if (!encoding) return
    encoding.maxBitrate = wanted.mbps * 1_000_000
    await sender.setParameters(params)
  } catch {
    // The browser keeps its own limit.
  }
}

async function limitAll() {
  for (const { pc } of peers.values()) for (const sender of pc.getSenders()) await limit(sender)
}

// A phone has several cameras. The round button turns it around; the strip's
// first setting picks one of them by name.
interface Lens {
  id: string
  name: string
  brief: string
}
let lenses: Lens[] = []
let chosen: string | null = null

function camera(): Promise<MediaStream> {
  const which = chosen ? { deviceId: { exact: chosen } } : { facingMode: { ideal: facing } }
  return navigator.mediaDevices.getUserMedia({ audio: false, video: { ...which, ...shape() } })
}

/**
 * The cameras worth offering, by plain names. Phones list more than a person
 * would count: an iPhone adds "Dual" and "Triple" cameras, which are its real
 * lenses taking turns behind one name, and those are left out when the real
 * ones are there. Android names none of them ("camera2 2, facing back"), so
 * there they are numbered. Their names only come once the camera has been
 * allowed, so this is asked after the first picture.
 */
async function findLenses() {
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [])
  const found = devices
    .filter((device) => device.kind === "videoinput" && device.deviceId)
    .map((device) => {
      const label = device.label.toLowerCase()
      const front = /front|frontal|delantera|user/.test(label)
      const merged = /dual|triple|quad|multi|logical|desk/.test(label)
      const kind = front ? "front" : /ultra/.test(label) ? "ultra" : /tele/.test(label) ? "tele" : "back"
      return { id: device.deviceId, kind, merged } as const
    })
  const real = found.filter((device) => !device.merged)
  // A phone that only lists merged back cameras keeps them: better than none.
  const kept = real.some((device) => device.kind !== "front") ? real : found
  const order = ["back", "ultra", "tele", "front"] as const
  const names = { back: t.back, ultra: t.ultra, tele: t.tele, front: t.front }
  lenses = order.flatMap((kind) =>
    kept
      .filter((device) => device.kind === kind)
      .map((device, index) => {
        const number = index ? ` ${index + 1}` : ""
        const short = kind === "ultra" ? "Ultra" : names[kind]
        return { id: device.id, name: `${names[kind]}${number}`, brief: `${short}${number}` }
      }),
  )
}

/** Opens the camera now asked for in place of the one in use. `undo` puts the
    request back as it was if the phone refuses. */
async function swap(undo: () => void) {
  if (!stream) return
  // Some phones cannot open a second camera while the first is in use.
  for (const track of stream.getTracks()) track.stop()
  try {
    stream = await camera()
  } catch {
    undo()
    stream = await camera().catch(() => null)
    if (!stream) return notice(t.denied, t.retry)
  }
  video.srcObject = stream
  controls()
  const [track] = stream.getVideoTracks()
  if (!track) return
  for (const { pc } of peers.values()) {
    for (const sender of pc.getSenders()) await sender.replaceTrack(track).catch(() => {})
  }
}

/** The strip's first setting, when the phone has more than one camera. */
function lensParam(track: MediaStreamTrack): Param[] {
  if (lenses.length < 2) return []
  const options = lenses.map((lens): [string, string] => [lens.name, lens.id])
  const current = track.getSettings().deviceId ?? ""
  const take = (deviceId: string) => {
    const before = chosen
    chosen = deviceId
    swap(() => {
      chosen = before
    })
  }
  const brief = (name: string) => lenses.find((lens) => lens.name === name)?.brief ?? name
  return [choice(t.lens, options, current, take, brief)]
}

// The strip: every setting with its value, always in view. Touching one opens
// its dial just above; touching it again puts the dial away.
let params: Param[] = []
let editing = -1

function paint() {
  const chips = $("chips").children
  params.forEach((param, index) => {
    const chip = chips[index]
    if (!chip) return
    chip.classList.toggle("on", index === editing)
    const value = chip.querySelector("b")
    if (value) value.textContent = param.value
  })
  document.body.classList.toggle("editing", editing >= 0)
}

function edit(index: number) {
  editing = index === editing ? -1 : index
  $("editor").replaceChildren()
  const param = params[editing]
  if (param) openDial($("editor"), param, paint, t.controls.auto)
  paint()
  // A setting half off the edge comes fully into view when it is chosen.
  $("chips").children[editing]?.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" })
}

/** Gives every setting the same width, chosen so a whole number of them fit. */
function layout() {
  const strip = $("chips")
  const fit = Math.max(1, Math.floor(strip.clientWidth / 64))
  const width = strip.clientWidth / Math.min(fit, params.length || 1)
  for (const chip of strip.children) (chip as HTMLElement).style.width = `${width}px`
  more()
}

/** Marks the side of the strip where settings are out of view. */
function more() {
  const strip = $("chips")
  $("strip").classList.toggle("more-left", strip.scrollLeft > 2)
  $("strip").classList.toggle("more-right", strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 2)
}
addEventListener("resize", layout)
$("chips").addEventListener("scroll", more)

function controls() {
  const [track] = stream?.getVideoTracks() ?? []
  if (!track) return
  params = [...lensParam(track), ...cameraParams(track, wanted, t.controls, shape, limitAll)]
  editing = -1
  $("editor").replaceChildren()
  $("chips").replaceChildren(
    ...params.map((param, index) => {
      const chip = document.createElement("button")
      chip.className = "chip"
      chip.append(Object.assign(document.createElement("span"), { textContent: param.label }))
      chip.append(Object.assign(document.createElement("b"), { textContent: param.value }))
      chip.onclick = () => edit(index)
      return chip
    }),
  )
  layout()
  paint()
}

function drop(viewer: number) {
  peers.get(viewer)?.pc.close()
  peers.delete(viewer)
}

function dropAll() {
  for (const viewer of [...peers.keys()]) drop(viewer)
}

async function offer(viewer: number) {
  if (!stream) return
  drop(viewer)
  const pc = new RTCPeerConnection()
  peers.set(viewer, { pc, waiting: [] })
  for (const track of stream.getTracks()) {
    await limit(pc.addTrack(track, stream))
  }
  pc.onicecandidate = (event) => {
    if (event.candidate) send(viewer, { candidate: event.candidate.toJSON() })
  }
  pc.onconnectionstatechange = () => refresh()
  await pc.setLocalDescription(await pc.createOffer())
  if (pc.localDescription) send(viewer, { sdp: pc.localDescription.toJSON() })
}

async function onSignal(from: number, data: Signal) {
  const peer = peers.get(from)
  if (!peer) return
  if ("sdp" in data) {
    await peer.pc.setRemoteDescription(data.sdp)
    for (const candidate of peer.waiting.splice(0)) await peer.pc.addIceCandidate(candidate).catch(() => {})
  } else if (peer.pc.remoteDescription) {
    await peer.pc.addIceCandidate(data.candidate).catch(() => {})
  } else {
    peer.waiting.push(data.candidate)
  }
}

async function onMessage(message: PhoneMessage, source: EventSource) {
  if (message.type === "hello") {
    dropAll()
    id = message.id
  } else if (message.type === "viewer-joined") await offer(message.id)
  else if (message.type === "viewer-left") drop(message.id)
  else if (message.type === "signal") await onSignal(message.from, message.data)
  else {
    // Another phone scanned the code.
    source.onerror = null
    source.close()
    dropAll()
    notice(t.replaced, t.again)
  }
  refresh()
}

function connect() {
  // Only ever one line to the computer: the one before is let go first.
  if (events) {
    events.onerror = null
    events.onmessage = null
    events.close()
  }
  let queue: Promise<void> = Promise.resolve()
  const source = new EventSource(`/events?t=${token}`)
  events = source
  source.onopen = () => refresh()
  source.onerror = () => {
    refresh()
    // The browser stops trying when the computer cannot be reached at all.
    if (source.readyState === EventSource.CLOSED) setTimeout(() => events === source && connect(), 2000)
  }
  // One message at a time, in the order they arrived.
  source.onmessage = (event) => {
    const message = JSON.parse(event.data) as PhoneMessage
    queue = queue.then(() => onMessage(message, source)).catch(() => {})
  }
}

// Lens lets go of a phone it has not heard from, so a sleeping one does not
// go on looking connected.
setInterval(() => {
  if (id !== null) fetch(`/ping?t=${token}&id=${id}`, { method: "POST" }).catch(() => {})
}, 5000)

// A phone that dims its screen stops sending video.
async function stayAwake() {
  try {
    await navigator.wakeLock?.request("screen")
  } catch {
    // Not allowed right now; the next touch tries again.
  }
}
document.addEventListener("pointerdown", stayAwake)

async function start() {
  document.body.classList.remove("notice-on")
  if (!navigator.mediaDevices?.getUserMedia) return notice(t.insecure, t.retry)
  refresh(true)
  try {
    stream ??= await camera()
  } catch {
    return notice(t.denied, t.retry)
  }
  video.srcObject = stream
  await findLenses()
  controls()
  stayAwake()
  connect()
}

// Leaving the page (another app, the lock screen) takes the camera away and
// lets the line to the computer die, and the phone does not always give them
// back. Coming back, the page takes up where it left off by itself.
let leftAt = 0
async function comeBack() {
  if (!stream || document.body.classList.contains("notice-on")) return
  const away = Date.now() - leftAt
  const [track] = stream.getVideoTracks()
  if (!track || track.readyState === "ended") {
    stream = await camera().catch(() => null)
    if (!stream) return notice(t.denied, t.retry)
    video.srcObject = stream
    controls()
  }
  video.play().catch(() => {})
  stayAwake()
  // Lens gives up on a phone after a quarter of a minute; well before that,
  // the old line is no longer to be trusted.
  if (away > 3000 || events?.readyState !== EventSource.OPEN) connect()
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) leftAt = Date.now()
  else comeBack()
})
// A page brought back whole from the browser's memory was never told it left.
addEventListener("pageshow", (event) => {
  if (event.persisted) comeBack()
})

$("retry").onclick = start

$("flip").onclick = () => {
  const before = { facing, chosen }
  facing = facing === "environment" ? "user" : "environment"
  chosen = null
  swap(() => {
    facing = before.facing
    chosen = before.chosen
  })
}

start()
