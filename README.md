# HotSound

**HotSound** is a Windows desktop soundboard whose slots are plotted on a PC keyboard
layout — numpad excluded. Every slot *is* a hotkey: the key at a given physical position
plays the sound you put there. A sound wave preview shows the sample you loaded and
sweeps a playhead across it while it plays.

Built with Electron. No native modules, no bundler, no runtime dependencies beyond
Electron itself.

**Developer:** Marvin Bangcailan — [@mavipisowifi](https://github.com/mavipisowifi)  
**Repository:** [mavipisowifi/HotSound](https://github.com/mavipisowifi/HotSound)

The board, top to bottom:

```
Esc   F1  F2  F3  F4   F5  F6  F7  F8   F9  F10 F11 F12
`  1 2 3 4 5 6 7 8 9 0 - =  Backspace
Tab  Q W E R T Y U I O P [ ] \
Caps  A S D F G H J K L ; '   Enter
Shift  Z X C V B N M , . /   Shift            Up
Ctrl Win Alt   Space   Alt Win Menu Ctrl     Lft Dn Rgt
```

Above the board is a bank of **equalizer faders**: eighteen log-spaced bands reading
the finished mix, with a fast attack and a slow release so they settle like a channel
strip rather than flickering. Beside the board is **Playing now**, which lists the keys
sounding at this moment — key, sound name, elapsed / total time, and how far through the
sound is — each row tinted with its key's own colour. Rows appear when a key sounds and
remove themselves when it stops.

Some keys are printed on the board but are not slots — see
[Muted keys](#muted-keys--on-the-board-but-not-slots).

---

## Requirements

- Windows 10 or 11, x64 (the built installer targets x64)
- [Node.js](https://nodejs.org/) 20+ and npm, to build from source
- That is all: Electron is the only dependency

## Quick start

```bash
npm install       # Electron + electron-builder
npm start         # generates the font faces, then runs the app
```

Two generators derive committed-by-source assets, and the build scripts above run the
ones they need automatically:

```bash
npm run fonts     # font/                 -> renderer/fonts.css + renderer/fonts/
npm run icons     # logo.png              -> app icon, window icon, UI logo
npm run assets    # both of the above
```

Committing, pushing and releasing is covered in [CONTRIBUTING.md](CONTRIBUTING.md).

### Build a Windows program

```bash
npm run dist             # NSIS installer + portable .exe  -> dist/
npm run dist:portable    # portable .exe only
```

The installer lets the user pick an install directory, shows the Terms of Service and
Privacy Policy for acceptance, and creates a desktop shortcut. The portable build is a
single runnable `.exe` with no install step.

### The installer's terms page

The **first page** of the installer is the Terms of Service and Privacy Policy: the full
text in a scrollable box, and a checkbox that must be ticked before Next becomes usable.
It comes before the install mode and install location pages, so nothing is chosen or
written before it is accepted. It is shown on a fresh install and when installing over an
existing one.

The wording lives in `build/installer/terms-and-privacy.txt` as plain text — edit that
file to change it, no NSIS knowledge needed. It is a starting template written from what
the software actually does, not legal advice; `build/installer/README.md` has the caveats
and the two NSIS traps to avoid if you edit the page itself.

Silent installs (`installer.exe /S`) skip every page, including this one. That is normal
for NSIS installers, but it does mean the acceptance step can be bypassed by anyone who
runs the installer silently on purpose.

---

## Using it

| Action | Result |
| --- | --- |
| **Click an empty key** | Add music to it (file picker) |
| **Click a key with music** | Play it |
| **Click a key again while it plays** | Stop it, with the configured fade |
| **Right-click a key** | Slot menu: **Replace** its sound, **Loop** it, **Delete** it, or pin **Set twice to stop** for that key |
| **Shift+click** | Toggle loop on that key |
| Drop audio files onto a key | Add music, spilling onto following keys |
| Press a key | Play its slot |
| Press the same key again | Stop that sound |

Replacing a key's music is right-click (remove) then click (add).

Each slot is keyed by `KeyboardEvent.code`, the *physical* key, so a slot stays on the
same keycap whatever the OS layout types for it (`KeyA` is the key between Caps Lock and
S whether it prints `A` or `Q`).

Supported formats: whatever Chromium decodes — `wav`, `mp3`, `ogg`/`oga`, `flac`,
`m4a`/`aac`, `opus`, `webm`, `aif`/`aiff`.

### Rows and colours

The keyboard map lives in `renderer/layout.js` — an ANSI tenkeyless board with the
numeric keypad *and* the editing/nav block removed (PrtSc, ScrLk, Pause, Ins, Home,
PgUp, Del, End, PgDn). The arrow cluster stays, with Up sitting over Down.

Slot keys are colour-zoned: function row rose/teal/indigo, number row green, top row
olive, home row rose, bottom row green, modifiers indigo, arrows teal, and the WASD
cluster accented in mint.

### Muted keys — on the board, but not slots

These keys are printed on the board and deliberately hold no music. They are never
captured by the app, so they keep their normal OS behaviour (Tab still moves focus, Esc
still closes things). They cannot be clicked to add music, cannot be drop targets, and
cannot be OS-wide hotkeys:

`Esc`  `` ` ``  `Tab`  `Caps`  `Shift` (both)  `Ctrl` (both)  `Alt` (both)
`Menu`  `Win` (both)  `Backspace`  `\`

### Sound wave preview

The panel under the board shows the sample's waveform — its peak envelope, computed once
per decoded buffer — and sweeps a playhead across it while it plays, with the played
portion drawn bright and the rest dimmed. Assigning music previews its waveform without
playing it. The readout names the key and the sample and shows elapsed / total time.

The sweep is driven by the `AudioContext` clock rather than by frame deltas, so it stays
in step with what you hear even if frames are late. Stopping a sound — pressing its key
again, or **Stop all** — stops the sweep with it and returns the playhead to the start, so
a stopped sound is not left looking like it is still playing. The sample stays on screen as
a preview.

The equalizer faders read the same signal through an `AnalyserNode` placed after the master
gain, so they follow the volume you have set; it is a pass-through node, so the
visualisation cannot alter the output. When the mix is silent and the faders have settled,
the bank stops repainting until something moves again.

### Loading a folder

**Load folder…** fills empty slots first (then wraps around) with the audio files in the
chosen folder's top level, sorted naturally, and decodes them up front. Everything else
decodes on first use and is then cached. See
[known issues](#known-issues-and-limits) about memory when loading long tracks.

### Playback

The graph is `source → slot gain → optional panner → master → analyser → output`, with a
voice per trigger, so with press-again-to-stop off every hit is polyphonic and retriggering
does not cut the tail of the previous one. Keys light up while one of their voices is
sounding, and taking music off a key or stopping it fades out over the configured time
rather than cutting.

### Keyboard capture

While the window has focus, HotSound consumes key presses for the keys that are slots,
because every slot is a bare key. Muted keys are left to the OS. Text fields still work
normally. The **keys: on** badge in the status bar toggles capture off when you want the
keyboard back without closing HotSound.

### Global hotkeys

Slots are local by default. `Ctrl+Alt+X` is always registered as a panic key that fades
out every voice. `Ctrl+Escape` does the same from inside the app, and **Stop all** does it
from the toolbar.

---

## Settings

**Settings** in the toolbar opens a small panel with two options. Both are stored in the
profile, so they survive a restart and travel with it when you save it somewhere else.

**Fade out when a sound is stopped** — how long a sound takes to fade when it is stopped,
default 150 ms, up to 2 s. It applies wherever a sound is stopped: pressing a key again,
**Stop all**, or the panic shortcuts. A fade of 0 ms cuts instantly, which can click on a
loud sample — that is the whole reason the fade exists.

**Press a key again to stop its sound** — on, every key behaves as a toggle: press once to
play, press again to stop. Off, each press starts another copy of the sample on top of the
last, so rapid hits overlap and ring together, which is what drum rolls and fast hi-hat
patterns want. It is on by default.

That setting is the default for the whole board, and **any single key can differ from it**:
right-click the key and use **Set twice to stop** in its menu. A key pinned away from the
default shows a small `2×` badge, and choosing the same option again returns it to following
the global setting. Deleting a key's music clears its pin too.

### The slot menu

Right-clicking any key opens a small menu headed with that key's name, with four actions:

| Item | What it does |
| --- | --- |
| **Replace** | Opens the same file picker as adding a sound, and puts the chosen file on that key. Cancelling changes nothing. |
| **Loop** | Makes that key's sound repeat. Turning it off while it is repeating lets the current pass finish and then stops it. Disabled when the key is empty. A looping key shows `↻` on its keycap. |
| **Set twice to stop** | Ticks or unticks the press-again-to-stop behaviour for that key alone. The note on the right says `default` while the key follows the global setting, and `just this key` once it has been pinned. |
| **Delete** | Removes the music from that key. Disabled when the key is empty. |

Escape, a click anywhere else, or choosing an item closes it. Deleting is deliberately two
clicks — a menu, then the item — rather than the single right-click it used to be, because
that threw an assignment away with no way back.

---

## Latency

Measured with `tools/measure-latency.js`, so the numbers below are not guesses. On the
machine this was built on:

| What | Time |
| --- | --- |
| App work between the key press and the audio being scheduled | **~1 ms** (median 1.1, max 1.7 over 24 hits) |
| First hit of a sample, before it is decoded | ~3 ms (was ~37 ms before the device was warmed at boot) |
| What the sound card adds: `baseLatency` + `outputLatency` | **~61 ms** |

The device figure is the one you feel on drums, and **it is not something the app can
change**. Three things were tried and measured, and none helped:

| Attempt | Device latency |
| --- | --- |
| default (`latencyHint: 'interactive'`) | 61 ms |
| `latencyHint: 'balanced'`, `0.003`, `0.01` | 71 ms (no better) |
| `latencyHint: 'playback'`, `0.02`, `0.05` | 91–152 ms |
| `--enable-exclusive-audio` | **133 ms** — worse, and it takes the device from other apps |
| `--audio-buffer-size=256` | 71 ms — worse |

So the app asks for the lowest latency Chromium offers and gets it; the rest is the driver's
shared-mode buffer. Two things do help:

- **Warming the output device at boot**, which is done: opening it costs tens of
  milliseconds, and that used to land on the first hit of the session.
- **The right output device.** Bluetooth headphones and audio through a monitor add far
  more than a sound card does. The Settings panel shows what the driver reports, so you can
  see the figure change when you switch devices.

`npm run e2e` asserts a budget on the app's own share (median under 5 ms) so a future change
cannot quietly put work back between the key press and the sound.

Re-run the measurements at any time:

```bash
npm run measure:latency
```

---

## Profiles

**Save profile…** opens the Windows save dialog, so a profile can be written anywhere you
like — Desktop, a project folder, a USB stick. The location you pick becomes the **active
profile**: it is remembered across launches, so the profile you saved to the Desktop is
the one that opens next time. **Open profile…** loads one back from anywhere on disk. The
status bar always shows the active profile's file name; click it to reveal the file in
Explorer.

Assignments and master volume are written to the active profile on **Save profile…** and
silently on window close, so nothing is lost if you forget to save.

The active location is remembered in `%APPDATA%/HotSound/hotsound-settings.json`; when no
profile has been chosen yet the working copy lives at
`%APPDATA%/HotSound/hotsound-profile.json`.

Two failure modes are handled rather than ignored:

- A slot whose audio file has since moved is flagged on the key, and reloading the
  profile marks it missing instead of failing silently.
- If the active profile is unreadable — a corrupt file, or an external drive that is no
  longer plugged in — the app falls back to the working copy and says so in the status
  bar, rather than starting empty.

Profiles written by older versions that list a now-muted key are ignored for that key
rather than resurrecting it.

---

## Typography

**Google Sans is the app's only font.** The eight faces in `font/` (Regular, Medium,
SemiBold and Bold, each with an italic) are declared in `renderer/fonts.css`, and nothing
else is named anywhere in the stylesheets, the inline styles or the canvas drawing code —
the theme token is a single family with no fallback list, so there is no second font to
fall back to:

```css
--font: "Google Sans";
```

`npm run fonts` reads the family name, weight and slope out of each file's `name` and
`OS/2` tables rather than trusting the filenames, copies the files next to the renderer
and writes `fonts.css`. That matters because font builds often register each weight as its
own family, which would leave `font-weight: 500` unmatched — this set is clean, reporting
one family with weights 400, 500, 600 and 700.

Faces use `font-display: block`, and the app waits on `document.fonts.ready` before its
first paint (with a 4s deadline, so a broken file cannot wedge startup), which keeps
canvas text and keycaps from ever rendering in a fallback face.

The smoke test enforces all of this: it checks that every `@font-face` actually loaded,
that the resolved families named by any rule or inline style are exactly `Google Sans`
(following `var()` indirection and treating `inherit` as the same family), and that the
rendered body and keycap text compute to that family.

### Font licensing

The faces in `font/` are **Google Sans**, which — unlike Roboto or Noto — is not
distributed under an open-source licence. That is fine for local builds, but check
Google's terms before publishing or redistributing a build that bundles it.

Swapping in an open-licence font is contained: replace the files in `font/`, run
`npm run fonts`, and rebuild. Nothing else refers to the font by name except the
`--font` token in `renderer/styles.css`.

## Logo and icon

`logo.png` is the official artwork — a round badge: light background, black line art (a
note over a waveform band), transparent outside the circle. `npm run icons` derives
everything from it:

| Output | Used for |
| --- | --- |
| `build/icon.png` | electron-builder converts it to the `.ico` for the app, installer, shortcuts |
| `assets/logo-square.png` | the window/taskbar icon at runtime |
| `renderer/assets/logo.png` | the logo in the top bar |

Windows application icons and the NSIS installer both require a **square** canvas, and the
generator adapts to whatever shape it is given rather than assuming one:

- **Self-contained artwork** — the opaque bounding box fills the canvas and the artwork is
  dense inside it, which covers a plain square *and* a round badge whose only transparency
  is the corners. It is centre-cropped to square and used edge to edge, keeping its own
  background and its own silhouette.
- **Transparent line art** — strokes floating in a transparent canvas. This is padded onto
  a mint plate instead: padding keeps a non-square mark undistorted, and the plate keeps
  black line art visible on a dark Windows taskbar.

The test is the bounding box plus the density inside it, deliberately not the raw alpha
ratio: measuring the alpha ratio alone misreads a round badge's transparent corners as
"transparent artwork" and would draw a coloured square behind a circle.

Masters are never upscaled — they are capped at the source resolution (minimum 256px), so
a small logo produces a small master rather than interpolated detail. After writing, the
tool reads its own output back and fails if a self-contained artwork ended up with
anything behind it, or if a square master came out non-square.

The top bar frames the logo with a drop shadow rather than a border or box shadow, so the
frame follows the artwork's silhouette instead of drawing a square behind a circle.

If you replace `logo.png`, re-run `npm run icons` and rebuild. Set `HOTSOUND_NO_PLATE=1`
to emit unplated transparent masters for transparent sources.

## Developer credit

**Marvin Bangcailan** — [@mavipisowifi](https://github.com/mavipisowifi) — see [AUTHORS.md](AUTHORS.md) for the author record and the third-party component licences.

The credit is defined once, in `package.json`, and reaches every surface from there:

| Field | Effect |
| --- | --- |
| `author.name` / `author.url` | stamped into the `.exe` (CompanyName / LegalCopyright), and shown in the app |
| `homepage` | the link the GitHub button opens |
| `copyright` | the exe's copyright field, and the credit's tooltip |

In the app it sits in the status bar as `dev Marvin Bangcailan | GitHub`, where GitHub
opens the profile in your browser. The button is a button rather than a link on purpose:
the click is routed through an IPC handler in the main process that accepts only `http(s)`
URLs, so nothing in the renderer can ask the shell to open an arbitrary scheme.

Right-click the installed `HotSound.exe` and open **Properties → Details** to see the same
name and copyright on the file itself.

## Project layout

```
main.js                Electron main: window + icon, IPC, profile dialogs and files
preload.js             contextBridge surface (the renderer's only privileges)
logo.png               Source artwork (as delivered)
font/                  Source fonts: Google Sans, 8 faces (as delivered)
package.json           Scripts, electron-builder config, author/credit metadata
LICENSE                MIT
AUTHORS.md             Author, where the credit appears, third-party licences

build/
  icon.png             Square icon master -> electron-builder makes the .ico
  installer/
    terms-page.nsh     The installer's terms page (checkbox gating)
    terms-and-privacy.txt   The text shown to the user - edit this
    README.md          Notes and caveats for both files above
assets/
  logo-square.png      Window icon used at runtime

renderer/
  index.html           Markup: top bar, board, sound wave panel, status bar
  styles.css           Dark-green theme derived from the reference art
  layout.js            The keyboard map: slot keys, muted keys, colour zones
  audio.js             Web Audio engine: decode cache, polyphony, per-voice gain
  waveform.js          Peak envelope + canvas preview with a playhead
  panels.js            Equalizer faders + the "playing now" list
  app.js               State, board DOM, hotkey capture, click/right-click, store
  fonts.css            GENERATED @font-face rules (the only font declarations)
  fonts/               GENERATED copies of the faces, so the renderer is self-contained
                       Both are gitignored - npm start, dist and test regenerate them
  assets/logo.png      UI logo

test/
  e2e.js               End-to-end checks driven through real IPC + real audio
  run.js               Test runner; requires the suite's success marker to appear

tools/                 Diagnostics and generators, not shipped in the package
  make-icons.js        logo.png -> square icon masters + UI logo
  make-font-css.js     font/    -> @font-face rules
  repro-cancel.js      drives the file picker and cancels it for real
  diagnose-memory.js   measures what loading music costs in RAM
  measure-latency.js   times the playing path and the audio device
  diagnose-exit.js     probes which native accelerators close the window
```

---

## Tests

```bash
npm test                # both suites
npm run smoke           # boots the app, asserts the rendered board matches the layout math
npm run e2e             # plays real WAVs through the real audio graph
npm run verify:cancel   # cancels the file picker for real (needs a window)
```

`smoke` checks the rendered board rather than just the code: every key is drawn, the 15
muted keys are inert non-buttons with no slot title, the nine removed nav keys are gone
from both the layout and the DOM while the four arrows remain with Up over Down, no keycap
overlaps, every keycap lands exactly where the layout model says on whole pixels, and rows
stay aligned. It also guards the things that make the window *look* wrong rather than merely
measure wrong: nothing may cover the app at rest, nothing may blur over the UI, and no
label font size may be fractional. It checks the branding and typography (logo decoded and
sized, all eight font faces loaded with `Google Sans` the only family named anywhere), the
developer credit, the profile controls, the picker configuration, that the removed Music
Spinner and Slot inspector panels are not in the DOM, that muted keys refuse assignment and
playback, that the waveform canvas has a real backing store, and that the equalizer bank
sits above the board and the playing list beside it.

`e2e` also drives the slot menu: that right-click opens it without discarding anything,
that Delete clears the key and disables itself when the key is empty, that a pinned key
stacks a second press while an unpinned one stops, that pinning the same option again
returns the key to the global default, and that Escape and a click elsewhere dismiss it.
Replace is covered too, using the real file picker: the test opens it, closes it the way
Cancel does, and checks the key still holds the sound it had and that the app is intact.
Loop is checked by playing a 300 ms sample and letting it run 700 ms: if the sound is still
sounding past its own length, it is genuinely repeating, not merely flagged.

`e2e` also checks that the output device is opened at boot rather than on the first hit,
and holds the app's own scheduling to a latency budget. It covers the playing system itself: that pressing a key again stops it, that the
configured fade is really a fade (still sounding part way through it, silent after), that
turning the toggle off restores polyphonic retriggering, that the settings survive a
profile round-trip, and that stopping a sound — by the key or by **Stop all** — also stops
the waveform sweep rather than leaving it running. It covers the playback visualisations too: that a sounding key appears in the Playing
now list with its label, sound name, elapsed / total time and progress, that the row removes
itself when the sound ends, that the list returns to idle, that the analyser reports a real
spectrum while audio plays, and that the faders are painted rather than merely fed.

`e2e` writes WAV files to a temp dir and drives the real IPC and audio graph: decode,
polyphony, natural voice release, loop sustain and stop, the missing-file error path, that
muted keys load nothing and cannot be global hotkeys, that a click on a filled key plays
it, that right-click removes the music (and is inert on an empty key), that the waveform is
actually painted and its playhead advances and settles at the end, profile round-trip
through the filesystem, that **Save As writes to a chosen path and makes it the active
profile**, that a legacy profile entry for a muted key is ignored, multi-file spill order,
folder fill that never touches a muted key, and both corrupt-profile paths: a broken
*active* profile falls back to the working copy, and when every candidate is broken the app
still loads, with no profile, without throwing. It also fails if `showOpenDialog` reappears
anywhere in the source, or if a bridge to the removed shell dialogs comes back.

Both suites are wrapped by `test/run.js`, which requires the run to actually print its
`SMOKE OK` / `E2E OK` marker. The exit code alone is not trusted: a run that quits early —
for example when another HotSound instance holds the single-instance lock — exits `0`
without having tested anything, and that must count as a failure.

---

## Known issues and limits

- **Memory grows with the music you load.** Decoded audio is kept in memory for the life
  of the session and is never evicted; taking music back off a key does not release it.
  Measured at about 22 MB per minute of stereo audio, so a board full of long tracks can
  reach gigabytes and the window may be killed by Windows. Restarting the app clears it.
  A bounded, least-recently-used cache is the fix; it is not done yet.
- **`Ctrl+W` quits the program, and `Ctrl+R` reloads it.** Electron's default application
  menu is still installed (hiding the menu bar does not remove it), and its accelerators
  are live. They are not intercepted because the app deliberately lets modifier combos
  through to the OS. Removing the menu would take them away.
- **Right-click removes music immediately**, with no undo — click to add, right-click to
  remove.
- **A slot's music is found by absolute path.** Moving the file later shows the key as
  errored, and reloading the profile flags it missing rather than failing silently.
- **Muted keys cannot be OS-wide hotkeys**, since they cannot hold music.
- **Global hotkeys**: `Ctrl+Alt+X` / `Ctrl+Escape` panic, and per-slot global hotkeys are
  opt-in per slot — an OS-wide bare key is swallowed from every other application, which
  would break typing elsewhere.
- **The first hit on a sample decodes it**, which can add a few milliseconds of latency;
  after that it plays from cache. **Load folder…** decodes up front.
- **The portable build has no terms page**, because it has no install step. The terms are
  part of the installer flow only.

---

## Why there is no shell open dialog

**Do not reintroduce `dialog.showOpenDialog`.** On this machine it segfaults the main
process the moment it is dismissed, so cancelling the file picker made the whole program
vanish instantly — no error dialog, no crash window, nothing in the log. `npm run smoke`
and `npm run e2e` fail if the call reappears in the source, because the defect cannot be
caught at runtime.

What was measured, by driving the real app and dismissing the real dialog with both
`WM_CLOSE` (the Cancel button) and a real Escape keystroke:

| Call | On cancel |
| --- | --- |
| `dialog.showOpenDialog(win, opts)` | **segfault** (exit 139, exception 0xc0000005) |
| `dialog.showOpenDialog(opts)` — no parent | **segfault** |
| `dialog.showSaveDialog(win, opts)` | fine |
| renderer `<input type="file">` | fine — fires a `cancel` event |

Windows records the crash as an access violation in `explorerframe.dll`, the shell DLL
that hosts the open dialog and its navigation pane. Parenting makes no difference and no
JS handler ever runs: it is a native fault inside Electron's dialog, reached through its
shell places-bar, not something the app can catch.

So every file *open* in this app goes through Chromium's own chooser instead — a
renderer-side `<input type="file">` — and the chosen path comes from
`webUtils.getPathForFile` in the preload (the same mechanism drag-and-drop uses). That
covers:

- **adding music** — a plain multi-select input;
- **Load folder…** — `input.webkitdirectory`, restricted to the folder's direct children;
- **Open profile…** — an input accepting `.json`, read in the renderer.

`showSaveDialog` is safe and remains for **Save profile…**, so a profile can still be
written anywhere on disk.

To re-check the cancel path by hand — it needs a real window and real keystrokes, so it is
not part of `npm test`:

```bash
npm run verify:cancel     # clicks an empty key, then cancels the picker
```

## License

MIT — see [LICENSE](LICENSE).
