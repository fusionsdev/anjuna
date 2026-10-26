# Training videos

Thai training videos for the ops team. Each video is a Playwright run through the live control panel, with Edge TTS Thai narration and burned-in Thai subtitles. The MP4 is build output: re-run the script, never commit it.

## Needs

- Python 3.11 with `playwright` 1.62, `edge-tts` 7.x and `pytest`
- Microsoft Edge (Playwright drives it through `channel="msedge"`)
- `ffmpeg` and `ffprobe` with libass, on the PATH
- The Leelawadee UI font (ships with Windows) for the subtitles

## Run

```bash
cd tools/training-video
python tv.py login                 # sign in once as an EMPLOYEE account; saves .auth/state.json (git-ignored)
python tv.py all ep01_home         # voice + record + compose -> out/ep01_home.mp4
python tv.py stills ep01_home      # one PNG per step, for review
python -m pytest -q
```

`--base=https://app.maimax.com` records from the other panel. `--headed` shows the browser while it records.

## Safety

- Recording aborts every request that is not GET, HEAD or OPTIONS (`guard` in `tv.py`). No click can deploy, save or delete.
- `record` stops unless the session is an `employee`, because ops staff see the employee screens. `--allow-owner` overrides it.
- `MASK_SELECTORS` blurs emails, names, keys, tokens, lead data and install ids before the panel paints. Add a selector there when a scene opens a new screen.
- `test_tv.py` fails if a scene clicks, types into or selects a control whose label deploys, saves, approves or deletes.

## Write a scene

Add `scenes/<id>.py` with `SCENE = {"title": ..., "steps": [{"say": "...", "do": [...]}]}`. Each step's narration plays from the step's first frame; the step lasts until its narration ends plus 0.6 s, or until its actions finish.

Actions: `("goto", path)`, `("card", kicker, title, sub)`, `("click", sel)`, `("point", sel)` (cursor plus ring, no click), `("type", sel, text)`, `("select", sel, value)`, `("scroll", sel)`, `("wait", seconds)`, `("signed_out",)` / `("signed_in",)` (show the sign-in page, then restore the session).

Selectors: `{"role": "button", "name": "ถัดไป (Next)"}`, `{"label": ...}`, `{"text": ...}` or `{"css": ...}`, plus optional `within`, `has_text`, `nth` and `exact`. Many panel buttons show Thai text but carry a "ไทย (English)" aria-label: match the aria-label.

Edge TTS returns no audio for some Thai phrases. `voice` retries 6 times, then names the step to reword.
