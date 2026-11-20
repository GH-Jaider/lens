// End to end, with no phone: starts Lens without its window, opens the phone
// page and the OBS page in a headless Chrome whose camera is a test pattern,
// and checks that the picture arrives. Needs Node 22+ and Chrome.
import { type ChildProcess, spawn } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const CHROME = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].find((candidate) => candidate && fs.existsSync(candidate))
if (!CHROME) throw new Error("Chrome was not found (set CHROME_PATH).")
const exe = process.platform === "win32" ? ".exe" : ""
const BINARY = process.env.LENS_BINARY ?? fileURLToPath(new URL(`../target/debug/lens${exe}`, import.meta.url))
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lens-test-"))
const children: ChildProcess[] = []
let failed = false

/** Where a headless Lens listens, as it prints it. */
interface Lens {
  local: string
  phone: string
  child: ChildProcess
}

/** One browser tab, driven over the DevTools protocol. */
interface Page {
  evaluate(expression: string): Promise<unknown>
  close(): Promise<unknown>
}

function check(name: string, ok: unknown, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`)
  if (!ok) failed = true
}

/** Asks again until the answer is truthy; resolves to the last answer. */
async function until<T>(read: () => Promise<T>, timeout = 15000): Promise<T | null> {
  const end = Date.now() + timeout
  let value: T | null = null
  while (Date.now() < end) {
    value = await read().catch(() => null)
    if (value) return value
    await delay(200)
  }
  return value
}

/** The first thing a stream of events says. */
async function firstEvent(url: string): Promise<string> {
  const reader = (await fetch(url)).body?.getReader()
  if (!reader) return ""
  const { value } = await reader.read()
  await reader.cancel()
  return new TextDecoder().decode(value)
}

async function startLens(): Promise<Lens> {
  const child = spawn(BINARY, ["--headless"], {
    env: { ...process.env, LENS_DATA: path.join(temp, "data") },
    stdio: ["ignore", "pipe", "inherit"],
  })
  children.push(child)
  let out = ""
  child.stdout?.on("data", (chunk) => {
    out += chunk
  })
  await until(async () => out.includes("\n"))
  return { ...(JSON.parse(out) as { local: string; phone: string }), child }
}

async function startChrome(chrome: string): Promise<(url: string) => Promise<Page>> {
  const profile = path.join(temp, "chrome")
  const child = spawn(
    chrome,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      // Three cameras, as a phone has.
      "--use-fake-device-for-media-stream=device-count=3",
      "--use-fake-ui-for-media-stream",
      "--ignore-certificate-errors",
      "--autoplay-policy=no-user-gesture-required",
      // A CI machine runs as root or without the kernel features the sandbox wants.
      ...(process.env.CI ? ["--no-sandbox"] : []),
      "about:blank",
    ],
    { stdio: "ignore" },
  )
  children.push(child)
  const port = await until(
    async () => Number(fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]),
    45000,
  )
  if (!port) throw new Error("Chrome did not open its DevTools port.")

  return async function open(url) {
    const created = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })
    const target = (await created.json()) as { id: string; webSocketDebuggerUrl: string }
    const socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      socket.onopen = resolve
      socket.onerror = reject
    })
    let next = 1
    const pending = new Map<number, (result: unknown) => void>()
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as { id: number; result: unknown }
      pending.get(message.id)?.(message.result)
      pending.delete(message.id)
    }
    return {
      async evaluate(expression) {
        const id = next++
        const answer = await new Promise<unknown>((resolve) => {
          pending.set(id, resolve)
          const params = { expression, returnByValue: true, awaitPromise: true }
          socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params }))
        })
        return (answer as { result?: { value?: unknown } } | undefined)?.result?.value
      },
      close: () => fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {}),
    }
  }
}

const resolution = `[...document.querySelectorAll("#chips .chip")].find((chip) => chip.textContent.startsWith("Resolution"))`
const picture = `(() => { const v = document.querySelector("video"); return v.videoWidth > 0 && v.currentTime > 0 ? v.videoWidth + "x" + v.videoHeight : "" })()`

try {
  const lens = await startLens()
  const open = await startChrome(CHROME)

  // fetch() does not let a caller choose the Host header, so this one is by hand.
  const refused = await new Promise((resolve) => {
    http
      .get(`${lens.local}/`, { headers: { host: "evil.example:47800" } }, (response) => resolve(response.statusCode))
      .on("error", () => resolve(0))
  })
  check("local pages refuse another site's name", refused === 403, String(refused))

  const state = await firstEvent(`${lens.local}/state`)
  check("the app receives its state", state.includes('"view_url"'))

  const viewer = await open(`${lens.local}/view`)
  const app = await open(`${lens.local}/`)
  await delay(500)
  const phone = await open(lens.phone)

  const size = await until(() => viewer.evaluate(picture))
  check("the OBS page shows the phone's picture", Boolean(size), String(size))
  check(
    "the OBS page reveals the video",
    await viewer.evaluate(`document.querySelector("video").classList.contains("live")`),
  )
  check("the app window previews it", Boolean(await until(() => app.evaluate(picture))))
  check(
    "the app says the phone is connected",
    await until(() => app.evaluate(`document.getElementById("m1").className === "mark dot ok"`)),
  )
  const told = await until(async () => (await firstEvent(`${lens.local}/state`)).includes('"obs_live":true'))
  check("Lens knows the OBS page is showing the picture", Boolean(told))
  check(
    "the phone says it is live",
    await until(() => phone.evaluate(`document.getElementById("status").classList.contains("live")`)),
  )

  // The camera's controls: Chrome's test camera can change size and rate.
  const chips = await until(() =>
    phone.evaluate(`[...document.querySelectorAll("#chips .chip")].map((c) => c.textContent).join(" | ")`),
  )
  check("the phone shows the camera's settings and their values", String(chips).includes("1080p"), String(chips))
  const figures = await until(() =>
    phone.evaluate(`/\\d+×\\d+ · \\d+ fps/.test(document.getElementById("status").textContent)`),
  )
  check("the phone says what it is sending", Boolean(figures))
  await phone.evaluate(`${resolution}.click()`)
  await phone.evaluate(
    `[...document.querySelectorAll("#editor .seg button")].find((b) => b.textContent === "720p").click()`,
  )
  check(
    "the strip shows the new value",
    await phone.evaluate(`${resolution}.querySelector("b").textContent === "720p"`),
  )
  // The camera takes a moment to switch, and the viewer a moment more to see it.
  const height = `document.querySelector("video").srcObject.getVideoTracks()[0].getSettings().height`
  check("choosing 720p changes what the camera gives", await until(() => phone.evaluate(`${height} === 720`)))
  const longest = `(() => { const v = document.querySelector("video"); return v.videoWidth > 0 && Math.max(v.videoWidth, v.videoHeight) <= 1280 })()`
  check("the viewer gets the smaller picture", await until(() => viewer.evaluate(longest)))
  await phone.evaluate(`${resolution}.click()`)
  check(
    "touching the setting again puts its control away",
    await phone.evaluate(`!document.body.classList.contains("editing")`),
  )

  // A phone has several cameras; the strip's first setting picks one by name.
  const cameras = `(async () => {
    const chip = document.querySelector("#chips .chip")
    if (!chip.textContent.startsWith("Camera")) return "no camera setting: " + chip.textContent
    const track = () => document.querySelector("video").srcObject.getVideoTracks()[0]
    const before = track().getSettings().deviceId
    chip.click()
    const buttons = [...document.querySelectorAll("#editor .seg button")]
    buttons.find((button) => !button.classList.contains("on")).click()
    await new Promise((done) => setTimeout(done, 2500))
    const after = track().getSettings().deviceId
    return buttons.length + " cameras, " + (after !== before && track().readyState === "live" ? "switched" : "did not switch")
  })()`
  check(
    "the phone lists its cameras and switches to the one chosen",
    (await phone.evaluate(cameras)) === "3 cameras, switched",
  )
  const still = await viewer.evaluate(`document.querySelector("video").currentTime`)
  await delay(1000)
  check(
    "the picture goes on from the other camera",
    Number(await viewer.evaluate(`document.querySelector("video").currentTime`)) > Number(still),
  )

  // Back to the first camera: Chrome's other test cameras deliver frames in
  // unusual formats, and the checks that follow are not about that.
  await phone.evaluate(`document.querySelector("#chips .chip").click()`)
  await phone.evaluate(`document.querySelector("#editor .seg button").click()`)
  await delay(2500)
  check("the phone goes back to the first camera", Boolean(await until(() => viewer.evaluate(picture))))

  // Chrome's test camera has a shutter: moving it makes exposure manual, and
  // the exposure setting has to say so when it is opened afterwards.
  const manual = `(() => {
    const chips = [...document.querySelectorAll("#chips .chip")]
    const named = (word) => chips.find((chip) => chip.textContent.startsWith(word))
    const exposure = named("Exposure")
    if (!exposure || !named("Shutter")) return "no shutter here"
    exposure.click()
    document.querySelector("#editor .seg button").click()
    named("Shutter").click()
    const slider = document.querySelector("#editor input")
    slider.value = slider.min
    slider.dispatchEvent(new Event("input"))
    exposure.click()
    return document.querySelector("#editor .seg button.on").textContent + " / " + exposure.querySelector("b").textContent
  })()`
  const exposure = String(await phone.evaluate(manual))
  check("moving the shutter makes exposure manual", ["Manual / Manual", "no shutter here"].includes(exposure), exposure)
  await phone.evaluate(`document.querySelector("#chips .chip.on")?.click()`)

  // Nothing in the strip is ever left half outside the screen.
  const inside = `(() => {
    const chips = [...document.querySelectorAll("#chips .chip")]
    const last = chips.at(-1)
    last.click()
    return new Promise((done) => setTimeout(() => {
      const box = last.getBoundingClientRect()
      const cut = chips.some((chip) => [...chip.children].some((part) => part.scrollWidth > part.clientWidth))
      last.click()
      done(box.left >= 0 && box.right <= innerWidth && !cut)
    }, 800))
  })()`
  check("a setting at the end of the strip comes fully into view", await phone.evaluate(inside))

  // The preview can be switched off without OBS losing the picture.
  await app.evaluate(`document.getElementById("eye").click()`)
  check(
    "hiding the preview stops it",
    await until(() => app.evaluate(`!document.getElementById("stage").classList.contains("live")`)),
  )
  await delay(1000)
  check("OBS keeps the picture meanwhile", Boolean(await viewer.evaluate(picture)))
  await app.evaluate(`document.getElementById("eye").click()`)
  check("showing the preview brings it back", Boolean(await until(() => app.evaluate(picture))))

  await phone.evaluate(`document.getElementById("flip").click()`)
  await delay(1500)
  const clock = async () => Number(await viewer.evaluate(`document.querySelector("video").currentTime`))
  const before = await clock()
  await delay(1000)
  check("the picture keeps moving after switching camera", (await clock()) > before)

  // A page that opens late (OBS started after the phone) still gets the picture.
  const late = await open(`${lens.local}/view`)
  check("a viewer that joins later gets the picture", Boolean(await until(() => late.evaluate(picture))))

  const wrong = await open(lens.phone.replace(/t=.*/, "t=wrong"))
  await delay(1500)
  check("a wrong code does not take over", (await viewer.evaluate(picture)) !== "")
  await wrong.close()

  // A second phone with the right code takes over, and the first is told.
  const second = await open(lens.phone)
  check(
    "the first phone is told it was replaced",
    await until(() => phone.evaluate(`document.body.classList.contains("notice-on")`)),
  )
  check(
    "the second phone goes live",
    await until(() => second.evaluate(`document.getElementById("status").classList.contains("live")`)),
  )
  check("the viewer shows the second phone", Boolean(await until(() => viewer.evaluate(picture))))

  await second.close()
  check(
    "the viewer clears when the phone leaves",
    await until(() => viewer.evaluate(`!document.querySelector("video").classList.contains("live")`), 20000),
  )
  check(
    "the app goes back to waiting",
    await until(() => app.evaluate(`document.getElementById("m1").className === "mark"`)),
  )

  // Lens is closed and opened again while OBS stays open with its page loaded.
  lens.child.kill()
  await delay(6000)
  const reborn = await startLens()
  check("Lens comes back on the same address", reborn.local === lens.local, reborn.local)
  const third = await open(reborn.phone)
  check("the page OBS kept open finds Lens again", Boolean(await until(() => viewer.evaluate(picture), 20000)))
  await third.close()
} catch (error) {
  check("the test ran", false, String(error))
} finally {
  for (const child of children) child.kill()
  await delay(300)
  // Windows keeps Chrome's files locked for a moment after it closes.
  try {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  } catch {
    /* the system clears it */
  }
}
process.exit(failed ? 1 : 0)
