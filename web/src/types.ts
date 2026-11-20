// What the pages and Lens say to each other. The Rust side is src/hub.rs.

/** Everything the app window shows. */
export interface UiState {
  /** What the QR code holds; empty while the computer has no network. */
  url: string
  qr: string
  view_url: string
  phone: boolean
  obs: "off" | "disabled" | "auth" | "ready"
  source: boolean
  vcam: boolean
  obs_page: boolean
  obs_live: boolean
  update: string
  updating: boolean
}

/** One step of the WebRTC handshake. */
export type Signal = { sdp: RTCSessionDescriptionInit } | { candidate: RTCIceCandidateInit }

export type ViewerMessage =
  | { type: "hello"; id: number }
  | { type: "phone-left" }
  | { type: "signal"; from: number; data: Signal }

export type PhoneMessage =
  | { type: "hello"; id: number }
  | { type: "viewer-joined"; id: number }
  | { type: "viewer-left"; id: number }
  | { type: "signal"; from: number; data: Signal }
  | { type: "replaced" }

/** An element the page is known to have. */
export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`The page has no #${id}`)
  return element as T
}

/** The language of the texts: Spanish for Spanish speakers, English otherwise. */
export function pick<T>(texts: { en: T; es: T }): T {
  const spanish = navigator.language.toLowerCase().startsWith("es")
  document.documentElement.lang = spanish ? "es" : "en"
  return spanish ? texts.es : texts.en
}
