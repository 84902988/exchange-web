# Draft Render Preparation

This guide prepares the project for draft render only. Do not render the final MP4 until the final checklist is complete.

## Current Audio Status

Real audio files are not generated yet.

Required files before a complete audiovisual draft:

- `assets/audio/voiceover.zh-CN.male.wav`
- `assets/audio/bgm.cinematic.mp3`

The current machine only exposes `Microsoft Zira Desktop - English (United States)`, a female English system voice. It is not suitable for the required Chinese male financial narration. No local BGM素材 was found in the workspace.

## Voiceover Duration Check

Source: `narration.zh-CN.txt`

- Chinese character count: about `249`
- Estimated duration at `210` CJK chars/min: about `71` seconds
- Estimated duration at `225` CJK chars/min: about `66` seconds
- Estimated duration at `240` CJK chars/min: about `62` seconds

Conclusion: the existing narration is not too long for a 90-second video. It leaves room for scene transitions, title pauses, and the risk提示 ending. No compressed rewrite is required at this stage.

## Manual Audio Placement

Generate or obtain audio externally, then place files exactly at:

```text
D:\exchange-web\quzhou-finance-review\assets\audio\voiceover.zh-CN.male.wav
D:\exchange-web\quzhou-finance-review\assets\audio\bgm.cinematic.mp3
```

Recommended voice settings:

- Male Chinese voice
- Calm and steady
- Medium-slow financial commentary
- Avoid dramatic sales pitch tone

Recommended BGM settings:

- Cinematic financial documentary bed
- Low bass pulse
- Light percussion
- No intense trailer rise
- No bright cyberpunk synth

## Draft Render Commands

Only after HyperFrames CLI is available locally:

```powershell
cd D:\exchange-web\quzhou-finance-review
$env:npm_config_cache='D:\exchange-web\.npm-cache'
npx.cmd -y hyperframes lint
npx.cmd -y hyperframes inspect --samples 16
npx.cmd -y hyperframes render --quality draft --output renders\draft.mp4
```

If `npx` needs to fetch HyperFrames and hangs, stop and install/prepare the package manually outside this sandboxed session. Do not repeatedly retry the same hanging command.

## Final Render Hold

Do not run high-quality final MP4 render yet. The draft render should be reviewed first for:

- subtitle readability
- audio levels
- price node accuracy
- scene pacing
- text overflow
- no unintended missing audio warnings

## Final Render Command After Draft Approval

Run only after the draft is approved and all final checklist items pass:

```powershell
cd D:\exchange-web\quzhou-finance-review
$env:npm_config_cache='D:\exchange-web\.npm-cache'
npx.cmd -y hyperframes render --fps 30 --quality high --output renders\quzhou-finance-review.final.mp4
```
