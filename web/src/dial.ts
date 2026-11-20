// The control that opens above the strip: a scale that slides under a fixed
// needle, as on a cine camera. The value is always the one under the needle,
// so the thumb never covers what is being set.
import type { Param } from "./controls.ts"

/** How wide a scale is, in pixels, from one end of its range to the other. */
const SCALE = 720
/** The room each named option takes. */
const STOP = 88

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const made = document.createElement(tag)
  if (className) made.className = className
  if (text) made.textContent = text
  return made
}

/** Puts the control for `param` into `into`. `changed` is called on every change. */
export function openDial(into: HTMLElement, param: Param, changed: () => void, autoText: string): void {
  const dial = element("div", "dial")
  const readout = element("div", "readout", param.value)
  const wrap = element("div", "dialwrap")
  const auto = param.auto ? element("button", "auto", autoText) : null
  // Turning the scale is only the person's doing once it has been put in place.
  let placed = false

  const refresh = () => {
    readout.textContent = param.value
    auto?.classList.toggle("on", Boolean(param.auto?.on))
    changed()
  }

  if (param.kind === "scale") {
    dial.append(element("i", "pad"), element("div", "scale"), element("i", "pad"))
    dial.addEventListener("scroll", () => {
      if (!placed) return
      param.move(dial.scrollLeft / SCALE)
      refresh()
    })
    wrap.append(readout)
  } else {
    const stops = param.stops.map((text, index) => {
      const stop = element("button", "stop", text)
      stop.onclick = () => dial.scrollTo({ left: index * STOP, behavior: "smooth" })
      return stop
    })
    const mark = (index: number) => {
      for (const [other, stop] of stops.entries()) stop.classList.toggle("on", other === index)
    }
    mark(param.at)
    dial.classList.add("stops")
    dial.append(element("i", "pad"), ...stops, element("i", "pad"))
    // The option is taken once the scale comes to rest, not on the way past
    // the ones before it: each could mean opening another camera.
    let settle: ReturnType<typeof setTimeout> | undefined
    dial.addEventListener("scroll", () => {
      if (!placed) return
      const index = Math.min(stops.length - 1, Math.max(0, Math.round(dial.scrollLeft / STOP)))
      mark(index)
      clearTimeout(settle)
      settle = setTimeout(() => {
        param.pick(index)
        refresh()
      }, 220)
    })
  }

  if (auto) {
    auto.classList.toggle("on", Boolean(param.auto?.on))
    auto.onclick = () => {
      param.auto?.set(!param.auto.on)
      refresh()
    }
    into.append(auto)
  }
  wrap.append(dial, element("i", "needle"))
  into.append(wrap)

  // Timers, not animation frames: a page that is not in front gets no frames,
  // and the dial has to be ready when it comes forward.
  setTimeout(() => {
    dial.scrollLeft = param.kind === "scale" ? param.at * SCALE : param.at * STOP
    setTimeout(() => {
      placed = true
    }, 80)
  }, 0)
}
