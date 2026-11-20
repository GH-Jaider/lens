// The page the phone opens from the QR code: it sends the camera to every
// viewer (the OBS source and the preview in the app window).
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

function status(text: string, live = false) {
  $("status").textContent = text
  $("status").classList.toggle("live", live)
}

function notice(text: string, button: string) {
  $("notice").textContent = text
  $("retry").textContent = button
  document.body.classList.add("notice-on")
}

function refresh() {
  const live = [...peers.values()].some((peer) => peer.pc.connectionState === "connected")
  status(live ? t.live : events?.readyState === EventSource.OPEN ? t.connecting : t.lost, live)
}

const send = (to: number, data: Signal) =>
  fetch(`/signal?t=${token}&id=${id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to, data }),
  }).catch(() => {})

function camera(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
  })
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
    const sender = pc.addTrack(track, stream)
    // The link is the local network, so quality matters more than thrift.
    try {
      const params = sender.getParameters()
      const [encoding] = params.encodings
      if (encoding) {
        encoding.maxBitrate = 8_000_000
        await sender.setParameters(params)
      }
    } catch {
      // The browser keeps its own limit.
    }
  }
  pc.onicecandidate = (event) => {
    if (event.candidate) send(viewer, { candidate: event.candidate.toJSON() })
  }
  pc.onconnectionstatechange = refresh
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
  let queue: Promise<void> = Promise.resolve()
  const source = new EventSource(`/events?t=${token}`)
  events = source
  source.onopen = refresh
  source.onerror = () => {
    refresh()
    // The browser stops trying when the computer cannot be reached at all.
    if (source.readyState === EventSource.CLOSED) setTimeout(connect, 2000)
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
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) stayAwake()
})
document.addEventListener("pointerdown", stayAwake)

async function start() {
  document.body.classList.remove("notice-on")
  if (!navigator.mediaDevices?.getUserMedia) return notice(t.insecure, t.retry)
  status(t.starting)
  try {
    stream ??= await camera()
  } catch {
    return notice(t.denied, t.retry)
  }
  video.srcObject = stream
  stayAwake()
  connect()
}

$("retry").onclick = start

$("flip").onclick = async () => {
  if (!stream) return
  const before = facing
  facing = facing === "environment" ? "user" : "environment"
  // Some phones cannot open a second camera while the first is in use.
  for (const track of stream.getTracks()) track.stop()
  try {
    stream = await camera()
  } catch {
    facing = before
    stream = await camera().catch(() => null)
    if (!stream) return notice(t.denied, t.retry)
  }
  video.srcObject = stream
  const [track] = stream.getVideoTracks()
  if (!track) return
  for (const { pc } of peers.values()) {
    for (const sender of pc.getSenders()) await sender.replaceTrack(track).catch(() => {})
  }
}

start()
