// The page OBS loads as a browser source: the phone's picture and nothing else.
import { $ } from "./types.ts"
import { startViewer } from "./viewer.ts"

const video = $<HTMLVideoElement>("video")
startViewer(video, (live) => video.classList.toggle("live", live), true)
