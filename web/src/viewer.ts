// Shared by the OBS source and the preview in the app window: receives the
// phone's video. The phone always makes the offer; a new offer replaces the
// connection before it.
import type { Signal, ViewerMessage } from "./types.ts"

/** `obs` marks the page inside OBS, which also tells Lens what it is showing. */
export function startViewer(video: HTMLVideoElement, whenLive: (live: boolean) => void, obs = false): void {
  let id: number | null = null
  let pc: RTCPeerConnection | null = null
  let waiting: RTCIceCandidateInit[] = []

  const send = (data: Signal) =>
    fetch(`/signal?id=${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data }),
    }).catch(() => {})

  function onLive(live: boolean) {
    whenLive(live)
    if (obs && id !== null) fetch(`/live?id=${id}&on=${live ? 1 : 0}`, { method: "POST" }).catch(() => {})
  }

  function reset() {
    pc?.close()
    pc = null
    waiting = []
    video.srcObject = null
    onLive(false)
  }

  async function onSignal(data: Signal) {
    if ("sdp" in data) {
      reset()
      const mine = new RTCPeerConnection()
      pc = mine
      mine.ontrack = (event) => {
        // As little buffering as the browser allows: this is a live camera.
        try {
          event.receiver.jitterBufferTarget = 0
        } catch {
          // Older browsers keep their own buffer.
        }
        video.srcObject = event.streams[0] ?? new MediaStream([event.track])
        video.play().catch(() => {})
      }
      mine.onicecandidate = (event) => {
        if (event.candidate) send({ candidate: event.candidate.toJSON() })
      }
      mine.onconnectionstatechange = () => {
        if (pc === mine && ["failed", "closed"].includes(mine.connectionState)) reset()
      }
      await mine.setRemoteDescription(data.sdp)
      await mine.setLocalDescription(await mine.createAnswer())
      if (mine.localDescription) send({ sdp: mine.localDescription.toJSON() })
      for (const candidate of waiting.splice(0)) await mine.addIceCandidate(candidate).catch(() => {})
    } else if (pc?.remoteDescription) {
      await pc.addIceCandidate(data.candidate).catch(() => {})
    } else {
      waiting.push(data.candidate)
    }
  }

  video.addEventListener("playing", () => onLive(true))

  // One message at a time, in the order they arrived.
  let queue: Promise<void> = Promise.resolve()
  function connect() {
    const events = new EventSource(obs ? "/events?obs=1" : "/events")
    events.onmessage = (event) => {
      const message = JSON.parse(event.data) as ViewerMessage
      queue = queue
        .then(async () => {
          if (message.type === "hello") {
            reset()
            id = message.id
          } else if (message.type === "phone-left") reset()
          else await onSignal(message.data)
        })
        .catch(() => {})
    }
    events.onerror = () => {
      queue = queue.then(reset)
      // A browser gives up for good when Lens is not running; this page (OBS
      // keeps it open for days) has to find Lens again when it comes back.
      if (events.readyState === EventSource.CLOSED) setTimeout(connect, 2000)
    }
  }
  connect()
}
