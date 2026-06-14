# Preview Status

## Current Preview Options

1. Static local preview:
   - `D:\exchange-web\quzhou-finance-review\preview-static.html`
   - Works without HyperFrames CLI.
   - Shows 12-scene preview, 12-scene timeline, locked prices, and file entry points.

2. HyperFrames animated preview:
   - Requires `hyperframes` CLI.
   - Current machine does not have `node_modules\hyperframes` installed in either the workspace root or this project directory.
   - Previous `npx hyperframes` attempt timed out while fetching the package.

## Resource Path Check

- `assets/scene-preview.svg`: exists.
- `assets/timeline-preview.svg`: exists.
- `assets/audio/`: exists.
- `assets/audio/voiceover.zh-CN.male.wav`: missing, required before final render.
- `assets/audio/bgm.cinematic.mp3`: missing, required before final render.
- `subtitles.srt`: exists.
- `narration.zh-CN.txt`: exists.
- `docs/timeline.md`: exists.
- `index.html`: exists.

## Storyboard Alignment

- Scene count: `12`.
- Total duration: `90` seconds.
- Title: `衢州发展（原新湖中宝）七年阴跌史（2019-2026）`.
- Separate scenes are reserved for the historical low, state-owned capital entry, semiconductor spike, risk page, interaction page, and ending page.

## Optional Audio Mounts

`index.html` includes optional audio tracks:

- Male voiceover path: `assets/audio/voiceover.zh-CN.male.wav`, volume `100%`.
- Background music path: `assets/audio/bgm.cinematic.mp3`, volume `15%`.
- Mix metadata: 1-second BGM fade-in and 2-second BGM fade-out.

The files are intentionally not fabricated. Missing audio files should not block static visual preview, but they must be supplied or generated before final MP4 rendering.

## External Dependency

`index.html` currently references GSAP from:

`https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js`

This is acceptable for HyperFrames preview/render when network access is available. The static preview page does not depend on it.

## Known Environment Limits

- Windows sandbox blocked automatic browser launch.
- `npx hyperframes` package fetch timed out.
- No suitable local Chinese male TTS voice was detected.
- No suitable local BGM素材 was found in the workspace.
- Final MP4 has not been rendered.

## Draft Render Preparation

Draft render documentation is available at:

`docs/draft-render-guide.md`

Suggested draft output path:

`renders\draft.mp4`
