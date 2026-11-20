// Leaves a release with one plainly named download per system instead of
// everything the build produces. The Release workflow runs it after the
// builds; `node scripts/release.ts v0.1.0` does the same by hand.
//
// What stays: the four installers, the archive a Mac updates itself from, and
// latest.json, which the app reads to learn about a new version. The separate
// signature files go, because latest.json already carries each signature.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const REPO = "GH-Jaider/lens"
const NAMES: [pattern: RegExp, name: string][] = [
  [/\.dmg$/, "Lens-macOS.dmg"],
  [/-setup\.exe$/, "Lens-Windows.exe"],
  [/\.AppImage$/, "Lens-Linux.AppImage"],
  [/\.deb$/, "Lens-Linux.deb"],
  [/\.app\.tar\.gz$/, "Lens-macOS-update.tar.gz"],
]

interface Latest {
  platforms: Record<string, { signature: string; url: string }>
}

const tag = process.argv[2]
if (!tag) throw new Error("usage: node scripts/release.ts <tag>")
const gh = (...args: string[]) => execFileSync("gh", [...args, "-R", REPO], { encoding: "utf8" })
const plain = (file: string) => NAMES.find(([pattern]) => pattern.test(file))?.[1]

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lens-release-"))
gh("release", "download", tag, "--dir", dir)
const files = fs.readdirSync(dir)
const kept = new Set(["latest.json", ...NAMES.map(([, name]) => name)])

// Already tidy: nothing to rename.
const renamed = files.filter((file) => !kept.has(file) && plain(file))
for (const file of renamed) fs.renameSync(path.join(dir, file), path.join(dir, plain(file) as string))

const latestFile = path.join(dir, "latest.json")
const latest = JSON.parse(fs.readFileSync(latestFile, "utf8")) as Latest
for (const [platform, entry] of Object.entries(latest.platforms)) {
  const file = decodeURIComponent(entry.url.split("/").pop() ?? "")
  const name = kept.has(file) ? file : plain(file)
  // A build nobody is offered (an .msi, an .rpm) is not offered as an update either.
  if (!name) delete latest.platforms[platform]
  else entry.url = `https://github.com/${REPO}/releases/download/${tag}/${name}`
}
// An app that does not say how it was installed asks for the plain entry.
for (const [plainKey, exactKey] of [["windows-x86_64", "windows-x86_64-nsis"]] as const) {
  const exact = latest.platforms[exactKey]
  if (exact && !latest.platforms[plainKey]) latest.platforms[plainKey] = exact
}
fs.writeFileSync(latestFile, `${JSON.stringify(latest, null, 2)}\n`)

const upload = fs.readdirSync(dir).filter((file) => kept.has(file))
gh("release", "upload", tag, "--clobber", ...upload.map((file) => path.join(dir, file)))
for (const file of files.filter((file) => !kept.has(file))) gh("release", "delete-asset", tag, file, "--yes")

fs.rmSync(dir, { recursive: true, force: true })
console.log(`${tag}: ${upload.sort().join(", ")}`)
console.log(`updates for: ${Object.keys(latest.platforms).sort().join(", ")}`)
