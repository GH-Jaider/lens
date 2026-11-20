// The app window: the code to scan, then the picture and how OBS is doing.
import { $, pick, type UiState } from "./types.ts"
import { startViewer } from "./viewer.ts"

/** A row of the list: its title and the line under it. */
type Row = readonly [title: string, detail: string]
type Mark = "ok" | "warn" | "idle"
type ObsCase = "ready" | "live" | "off" | "disabled" | "auth" | "restart"

interface Texts {
  scan: string
  live: string
  offline: string
  offlineBody: string
  badge: string
  steps: readonly [Row, Row, Row]
  phone: Row
  obsLive: Row
  obsWait: Row
  obsOff: Row
  obsDisabled: Row
  obsAuth: Row
  obsRestart: Row
  camOn: Row
  camOff: Row
  foot: Record<ObsCase, string>
  noPreview: string
  previewOff: string
  hide: string
  show: string
  update: string
  updating: string
  copy: string
  copied: string
}

const en: Texts = {
  scan: "Scan with your phone",
  live: "Your phone is the camera",
  offline: "No network",
  offlineBody: "Join this computer to the same Wi‑Fi as your phone.",
  badge: "Live",
  steps: [
    ["Scan the code", "With the phone's camera, on the same Wi‑Fi"],
    ["Continue past the warning", "Tap Details or Advanced, then visit the site"],
    ["Allow the camera", "Nothing is installed on the phone"],
  ],
  phone: ["Phone connected", "Keep this page open and the screen on"],
  obsLive: ["OBS is showing it", "It is the source named Lens"],
  obsWait: ["OBS is getting the picture", "It should appear in a moment"],
  obsOff: ["OBS is not open", "Open it and Lens adds the phone by itself"],
  obsDisabled: ["OBS needs one setting", "Tools → WebSocket Server Settings → enable"],
  obsAuth: ["OBS refused its password", "Quit OBS and Lens, then open both again"],
  obsRestart: ["Open OBS again, just this once", "Its browser only starts when OBS opens"],
  camOn: ["Virtual camera on", "Other apps see it as OBS Virtual Camera"],
  camOff: ["Virtual camera off", "Start it in OBS to use the phone in other apps"],
  foot: {
    ready: "OBS ready",
    live: "OBS is showing the phone",
    off: "OBS is not open",
    disabled: "OBS needs one setting",
    auth: "OBS refused its password",
    restart: "Open OBS again",
  },
  noPreview: "The picture goes straight to OBS. This window cannot preview it on this system.",
  previewOff: "Preview off. OBS still gets the picture.",
  hide: "Hide the preview",
  show: "Show the preview",
  update: "Update to",
  updating: "Updating…",
  copy: "Copy OBS link",
  copied: "Copied",
}

const es: Texts = {
  scan: "Escanea con tu celular",
  live: "Tu celular es la cámara",
  offline: "Sin red",
  offlineBody: "Conecta este computador al mismo wifi que tu celular.",
  badge: "En vivo",
  steps: [
    ["Escanea el código", "Con la cámara del celular, en el mismo wifi"],
    ["Continúa tras el aviso", "Toca Detalles o Avanzado y visita el sitio"],
    ["Permite la cámara", "No se instala nada en el celular"],
  ],
  phone: ["Celular conectado", "Deja esta página abierta y la pantalla encendida"],
  obsLive: ["OBS lo está mostrando", "Es la fuente llamada Lens"],
  obsWait: ["OBS está recibiendo la imagen", "Debería aparecer en un momento"],
  obsOff: ["OBS está cerrado", "Ábrelo y Lens añade el celular por sí solo"],
  obsDisabled: ["A OBS le falta un ajuste", "Herramientas → Servidor WebSocket → activar"],
  obsAuth: ["OBS rechazó su contraseña", "Cierra OBS y Lens, y abre ambos de nuevo"],
  obsRestart: ["Abre OBS de nuevo, solo esta vez", "Su navegador arranca al abrir OBS"],
  camOn: ["Cámara virtual encendida", "Otras apps la ven como OBS Virtual Camera"],
  camOff: ["Cámara virtual apagada", "Enciéndela en OBS para usarla en otras apps"],
  foot: {
    ready: "OBS listo",
    live: "OBS muestra el celular",
    off: "OBS está cerrado",
    disabled: "A OBS le falta un ajuste",
    auth: "OBS rechazó su contraseña",
    restart: "Abre OBS de nuevo",
  },
  noPreview: "La imagen va directo a OBS. Esta ventana no puede mostrarla en este sistema.",
  previewOff: "Vista previa apagada. OBS sigue recibiendo la imagen.",
  hide: "Ocultar la vista previa",
  show: "Mostrar la vista previa",
  update: "Actualizar a",
  updating: "Actualizando…",
  copy: "Copiar enlace",
  copied: "Copiado",
}

const t = pick({ en, es })
// Some Linux systems ship a web view that cannot receive video.
const canPreview = "RTCPeerConnection" in window
$("copy").textContent = t.copy
$("badge").textContent = t.badge

let state: UiState | null = null
let live = false
let stuckSince = 0

// The preview can be switched off: the window then receives no video at all,
// and the choice is remembered. A web view may refuse to remember; that is fine.
const remembered = (() => {
  try {
    return localStorage.getItem("preview") !== "off"
  } catch {
    return true
  }
})()
let preview = remembered
let stopPreview: (() => void) | null = null

function watch() {
  stopPreview?.()
  stopPreview = null
  live = false
  if (preview && canPreview) {
    stopPreview = startViewer($<HTMLVideoElement>("video"), (now) => {
      live = now
      render()
    })
  }
  render()
}

function row(n: 1 | 2 | 3, [title, detail]: Row, mark?: Mark) {
  $(`a${n}`).textContent = title
  $(`b${n}`).textContent = detail
  $(`m${n}`).textContent = mark ? "" : String(n)
  $(`m${n}`).className = mark ? `mark dot ${mark}` : "mark"
}

/** How OBS is doing: which case, the row that explains it, and its colour. */
function obsNow(state: UiState, restart: boolean): [ObsCase, Row, Mark] {
  if (restart) return ["restart", t.obsRestart, "warn"]
  if (state.obs === "ready") return state.obs_live ? ["live", t.obsLive, "ok"] : ["ready", t.obsWait, "idle"]
  if (state.obs === "disabled") return ["disabled", t.obsDisabled, "warn"]
  if (state.obs === "auth") return ["auth", t.obsAuth, "warn"]
  return ["off", t.obsOff, "idle"]
}

function render() {
  if (!state) return
  const qr = $("qr")
  if (qr.dataset.url !== state.url) {
    qr.dataset.url = state.url
    qr.innerHTML = state.qr
  }
  // Without a preview the phone still reaches OBS, so say that instead of
  // leaving the code on screen.
  const blind = state.phone && (!canPreview || !preview)
  $("offline").textContent = !blind ? t.offlineBody : canPreview ? t.previewOff : t.noPreview
  $("eye").classList.toggle("on", state.phone && canPreview)
  $("eye").classList.toggle("off", !preview)
  $("eye").title = preview ? t.hide : t.show
  $("stage").classList.toggle("offline", blind || (!state.url && !live))
  $("stage").classList.toggle("live", live)
  $("title").textContent = state.phone ? t.live : state.url ? t.scan : t.offline
  $("update").textContent = state.updating ? t.updating : `${t.update} ${state.update}`
  $("update").classList.toggle("on", Boolean(state.update))
  // The version sits where the update button appears, and gives way to it.
  $("version").textContent = state.update ? "" : state.version

  // OBS has the source but its page never opened: on a Mac, a browser source
  // added while OBS runs stays blank until OBS is opened again.
  const stuck = state.obs === "ready" && state.source && state.phone && !state.obs_page
  if (!stuck) stuckSince = 0
  else if (!stuckSince) {
    stuckSince = Date.now()
    setTimeout(render, 20100)
  }
  const [which, explained, mark] = obsNow(state, stuck && Date.now() - stuckSince > 20000)

  if (state.phone) {
    row(1, t.phone, "ok")
    row(2, explained, mark)
    row(3, state.vcam ? t.camOn : t.camOff, state.vcam ? "ok" : "idle")
  } else {
    row(1, t.steps[0])
    row(2, t.steps[1])
    row(3, t.steps[2])
  }
  // With a phone connected the rows above already say it.
  $("foot").textContent = t.foot[which]
  $("foot").className = `${which === "ready" ? "ok" : mark}${state.phone ? " said" : ""}`
}

// Tells Lens the room this page really got, so it can size the window to it.
const fit = () => fetch(`/fit?w=${innerWidth}&h=${innerHeight}`, { method: "POST" }).catch(() => {})
addEventListener("resize", fit)
fit()

function follow() {
  const events = new EventSource("/state")
  events.onmessage = (event) => {
    state = JSON.parse(event.data) as UiState
    render()
  }
  events.onerror = () => {
    if (events.readyState === EventSource.CLOSED) setTimeout(follow, 2000)
  }
}
follow()

watch()

$("eye").onclick = () => {
  preview = !preview
  try {
    localStorage.setItem("preview", preview ? "on" : "off")
  } catch {
    // Not remembered; it still works until the window closes.
  }
  watch()
}

$("update").onclick = () => fetch("/update", { method: "POST" }).catch(() => {})

$("copy").onclick = async () => {
  if (!state) return
  const link = state.view_url
  await navigator.clipboard.writeText(link).catch(() => {
    // Web views that keep the clipboard to themselves still allow the old way.
    const field = Object.assign(document.createElement("textarea"), { value: link })
    document.body.append(field)
    field.select()
    document.execCommand("copy")
    field.remove()
  })
  $("copy").textContent = t.copied
  setTimeout(() => {
    $("copy").textContent = t.copy
  }, 1400)
}
