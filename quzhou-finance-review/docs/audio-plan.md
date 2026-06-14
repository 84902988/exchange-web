# Audio Plan

## Male Voiceover

- Voice profile: male, calm, mature, institutional financial commentary.
- Delivery: medium pace, restrained emotion, documentary recap tone.
- Suggested pace: about 210-240 Chinese characters per minute.
- Target duration: 85-90 seconds of spoken audio, leaving 1-3 seconds of natural breathing room around the opening and ending.
- Performance notes: emphasize price nodes and transition words, but avoid promotional urgency.
- Local TTS status: no suitable Chinese male TTS voice is available on this machine. The only detected system voice is `Microsoft Zira Desktop - English (United States)`, which should not be used for this project.

## Voiceover Script Source

- Source file: `narration.zh-CN.txt`
- Subtitle file: `subtitles.srt`
- Timing target: 14 subtitle cues, ending exactly at `01:30`.
- Current script length after 12-scene alignment: about `380-430` Chinese characters.
- Estimated narration duration at steady financial pacing: about `95-115` seconds if read word-for-word.
- Practical direction: use the 12 SRT cue lines as the timed narration basis, and keep delivery concise per scene.
- Compression status: the expanded `narration.zh-CN.txt` is a complete reference script. For final TTS/recording, use `subtitles.srt` cue text or a similarly compressed voiceover to stay inside 90 seconds.
- Price data must remain unchanged:
  - `2.80元 → 5.13元`
  - `5.13元 → 1.58元`
  - `1.58元 → 6.03元 → 3.50元`
  - `5.51元 → 2.76元`

## Background Music

- Style: dark financial documentary bed.
- Texture: low drone, soft bass pulse, light percussion, restrained impact hits at scene transitions.
- Tempo: 72-88 BPM.
- Avoid: heroic trailer rises, marketing-style claps, bright synth leads, cyberpunk neon feeling.
- Local BGM status: no suitable local music素材 was found in the workspace. Do not fabricate or rename non-audio files as `bgm.cinematic.mp3`.
- Structure:
  - 00:00-00:08: low atmosphere only, title pulse.
  - 00:08-00:34: light drum pulse enters, controlled momentum.
  - 00:34-00:48: subtle lift for state-owned capital and semiconductor spike.
  - 00:48-01:16: darker tone, lower percussion, pressure feeling.
  - 01:16-01:30: reduce percussion, fade into risk提示.

## Volume Ratio

- Voiceover peak: around `-3 dB`.
- Voiceover integrated loudness target: around `-16 LUFS`.
- Background music bed under narration: `-24 LUFS` to `-28 LUFS`.
- Transition hit effects: keep below voiceover, usually `-18 dB` peak or lower.
- Suggested mix ratio in `index.html`: voice `100%`, BGM `12-18%`; current reserved value is `15%`.
- Opening music fade-in: `1` second.
- Ending music fade-out: `2` seconds.
- Ducking: lower music by another `3-5 dB` during dense subtitle lines.

## Final Audio Assets To Produce

- `assets/audio/voiceover.zh-CN.male.wav`
- `assets/audio/bgm.cinematic.mp3`
- Optional mixed preview: `assets/audio/mix-preview.wav`

These audio files are not generated yet. They should be created only after the visual preview is approved.

Manual placement paths:

```text
D:\exchange-web\quzhou-finance-review\assets\audio\voiceover.zh-CN.male.wav
D:\exchange-web\quzhou-finance-review\assets\audio\bgm.cinematic.mp3
```

## Index Audio Mounting

`index.html` now reserves optional audio tracks:

- Voiceover: `assets/audio/voiceover.zh-CN.male.wav`, `data-volume="1"`.
- BGM: `assets/audio/bgm.cinematic.mp3`, `data-volume="0.15"`.
- BGM mix metadata: `data-mix-fade-in="1"` and `data-mix-fade-out="2"`.

If these files are missing, the static visual preview remains usable. The files must exist before final MP4 render.
