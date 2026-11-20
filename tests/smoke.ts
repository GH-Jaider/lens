// Starts the real app (window, tray and all) and checks that it comes up and
// serves its page. On Linux CI this runs under xvfb.
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const exe = process.platform === "win32" ? ".exe" : ""
const binary = process.env.LENS_BINARY ?? fileURLToPath(new URL(`../target/debug/lens${exe}`, import.meta.url))
// The app is told to leave OBS alone: this machine's scenes are not the test's.
const child = spawn(binary, [], { env: { ...process.env, LENS_NO_OBS: "1" }, stdio: "inherit" })
let exited: number | null = null
child.on("exit", (code) => {
  exited = code
})

let page = ""
let state = ""
for (let i = 0; i < 120 && exited === null && !state; i++) {
  await new Promise((resolve) => setTimeout(resolve, 500))
  for (const port of [47800, 47801, 47802]) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`)
      if (!response.ok) continue
      page = await response.text()
      const reader = (await fetch(`http://127.0.0.1:${port}/state`)).body?.getReader()
      state = new TextDecoder().decode((await reader?.read())?.value)
      await reader?.cancel()
      break
    } catch {
      /* not up yet */
    }
  }
}
// Give the window a moment: a crash while it is being created shows here.
await new Promise((resolve) => setTimeout(resolve, 4000))
if (exited === 0) {
  // Lens runs once per computer: a second copy hands over to the first and leaves.
  console.log("skip the app is already open on this computer; close it to run this test")
  process.exit(0)
}
const ok = page.includes("<title>Lens</title>") && state.includes('"view_url"') && exited === null
console.log(
  ok
    ? "ok   the app starts, opens its window and serves its page"
    : `FAIL the app did not come up (exit code ${exited})`,
)
child.kill()
process.exit(ok ? 0 : 1)
