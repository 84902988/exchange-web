# Final MP4 Render Checklist

Do not render the final MP4 until every item below is checked.

## Project Checks

- [ ] `index.html` opens through HyperFrames preview.
- [ ] HyperFrames lint passes.
- [ ] HyperFrames inspect reports no clipped text or off-canvas critical elements.
- [ ] Composition is `1920 x 1080`.
- [ ] Composition duration is `90` seconds.
- [ ] Final expected runtime stays within `85-95` seconds.
- [ ] Scene count is exactly `12`.
- [ ] Scene timings match `00:00-00:05`, `00:05-00:15`, `00:15-00:25`, `00:25-00:31`, `00:31-00:40`, `00:40-00:50`, `00:50-01:00`, `01:00-01:10`, `01:10-01:20`, `01:20-01:25`, `01:25-01:28`, `01:28-01:30`.

## Locked Data Checks

- [ ] `2019-2021` shows `2.80元 → 5.13元`.
- [ ] `2021-2024` shows `5.13元 → 1.58元`.
- [ ] Historical low scene shows `1.58元`.
- [ ] Historical low note shows `1.55元（2024/7/8）`.
- [ ] `2024-2025` shows `1.58元 → 6.03元 → 3.50元`.
- [ ] `2026至今` shows `5.51元 → 2.76元`.
- [ ] Summary axis keeps the same price values.

## Visual Checks

- [ ] No real K-line screenshots.
- [ ] No real market data source or quote feed.
- [ ] Visual style remains dark financial documentary.
- [ ] Upward segments use green.
- [ ] Downward segments use red.
- [ ] Main palette stays deep navy, deep gray, and muted gold.
- [ ] No cyberpunk, cartoon, flashy tech, or marketing-hype style.

## Subtitle And Narration Checks

- [ ] `subtitles.srt` has no overlapping cues.
- [ ] Last subtitle ends at `01:30`.
- [ ] Captions appear bottom center.
- [ ] Voiceover uses a calm male financial commentary style.
- [ ] Narration text matches the approved storyboard.
- [ ] `assets/audio/voiceover.zh-CN.male.wav` exists before final render.

## Audio Mix Checks

- [ ] `assets/audio/bgm.cinematic.mp3` exists before final render.
- [ ] Voiceover track is mounted at `data-volume="1"`.
- [ ] BGM track is mounted at `data-volume="0.15"` or another approved value within `0.12-0.18`.
- [ ] BGM has a 1-second opening fade-in in the final mix.
- [ ] BGM has a 2-second ending fade-out in the final mix.
- [ ] Music is low documentary ambience with light percussion.
- [ ] Music does not overpower narration.
- [ ] Voice remains clear through all price nodes.
- [ ] Ending risk提示 is audible and visually readable.

## Render Command

Use draft render first, inspect the result, then render high quality MP4.

Draft render command after HyperFrames CLI is available:

```powershell
cd D:\exchange-web\quzhou-finance-review
$env:npm_config_cache='D:\exchange-web\.npm-cache'
npx.cmd -y hyperframes render --quality draft --output renders\draft.mp4
```

Final render command after draft approval:

```powershell
cd D:\exchange-web\quzhou-finance-review
$env:npm_config_cache='D:\exchange-web\.npm-cache'
npx.cmd -y hyperframes render --fps 30 --quality high --output renders\quzhou-finance-review.final.mp4
```
