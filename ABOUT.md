# HotSound — what it does, and who it's for

**A soundboard that is a keyboard.** HotSound draws an ANSI tenkeyless PC keyboard on
screen — numpad left out — and every key on it holds a sound. Press the physical key, or
click the keycap, and it plays. There is no hardware to buy and no labels to stick on your
keys: the mapping is to *physical* key positions, so a slot stays on the same keycap
whatever your keyboard layout types. Built with Electron, and it runs offline — no
accounts, no server, no telemetry.

## What it does

- **Every key is a slot.** Click an empty key for a file picker, drop audio files onto the
  board, or fill the whole board from a folder in one go. The arrow cluster is on the
  board; the numeric keypad and the nav/editing block are not. The system keys Windows
  needs — Esc, the backtick key, Tab, Caps, Shift, Ctrl, Alt, Win, Menu, Backspace and
  `\` — are drawn but never captured, so they keep their normal behaviour.
- **Press to play, press again to stop.** The stop fades out over a time you set (0–2000
  ms, 150 ms by default). Turn *twice to stop* off — globally, or for one key from its
  menu — and every hit starts another copy instead, so drum rolls overlap.
- **Right-click a key for its menu:** **Replace** its sound, **Loop** it, pin **Set twice
  to stop** for that key alone, or **Delete** it.
- **You can see what is playing.** Equalizer-style faders run along the top of the board
  and follow the mix; a **playing now** panel beside it lists each sounding key with its
  name, elapsed time and a progress bar; the sample's waveform sweeps past a playhead
  below, driven by the audio clock so it stays in step with what you hear.
- **Panic, and giving the keyboard back.** **Stop all**, `Ctrl+Escape` in the app, or
  `Ctrl+Alt+X` from anywhere in Windows, fades everything out. The `keys: on` badge in the
  status bar releases the keyboard entirely when you need to type.
- **Profiles and a master volume** in the toolbar. Profiles save anywhere on disk and the
  location is remembered, so the one on your Desktop is the one that opens next time.
- **Plays what Chromium decodes:** `wav`, `mp3`, `ogg`/`oga`, `flac`, `m4a`/`aac`, `opus`,
  `webm`, `aif`/`aiff`. Sounds from different keys overlap.

## Who it's for

- **Streamers and video makers** who want stingers, alerts and sound effects on a single
  press, with the board visible on a second monitor so the keys can double as labels.
- **Drummers and musicians** who want a keyboard of samples that responds like a pad:
  retriggering overlaps, and the latency is measured rather than guessed — the app's own
  share is around a millisecond, and the Settings dialog shows what your audio device adds
  on top.
- **Tabletop GMs, podcasters and teachers** who need ambience beds and cue sounds they can
  hit without looking, and a **playing now** list that says what is still running.
- **Makers and tinkerers.** The source is MIT, it is plain HTML/CSS/JS inside Electron
  with no bundler, and the board is one data file (`renderer/layout.js`) — so remapping
  keys, changing the grid or adding labelled zones is an edit, not a rewrite. A test suite
  that boots the real app comes with it.
- **Anyone with a spare keyboard** who wants a soundboard without buying one.

It is not a DAW: no arranging, no mixing, no editing, no MIDI. It is a fast, predictable
way to make a keyboard play sounds.

## Getting it, and building it

Installer and portable builds are on the
[releases page](https://github.com/mavipisowifi/HotSound/releases). To build from source
you need Node.js 20+ and npm:

```bash
npm install
npm start          # run it
npm test           # smoke and end-to-end suites
npm run dist       # build the Windows installer into dist/
```

Windows 10 or 11, 64-bit. Full documentation is in the
[README](https://github.com/mavipisowifi/HotSound#readme).

---

Made by **Marvin Bangcailan** — [github.com/mavipisowifi](https://github.com/mavipisowifi)
