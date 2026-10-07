# HotSound 1.0.0

First release.

A Windows soundboard whose slots **are** the keys of a PC keyboard. The app draws an ANSI
tenkeyless layout on screen — numpad excluded — and every key on it holds a sound: press
that key, or click it, and it plays. A sound wave preview sweeps a playhead across the
sample while it plays. Built with Electron; the app itself makes no network requests.

---

## Downloads

| File | What it is |
| --- | --- |
| **`HotSound Setup 1.0.0.exe`** | The installer. Choose where it goes, get a desktop shortcut and an uninstaller. Shows the Terms of Service and Privacy Policy for acceptance before anything is written to disk. |
| **`HotSound 1.0.0.exe`** | Portable. Runs straight from wherever you put it — no install, no uninstaller, and no terms page, since there is no install step to put it in front of. |

Windows 10 or 11, 64-bit.

## Installing

1. Windows will warn you: the build is **not code-signed**, so SmartScreen reports
   *"Windows protected your PC"*. Choose **More info → Run anyway**. Nothing about the
   app changes if you sign builds yourself — the warning is purely about the missing
   certificate.
2. The **first page is the Terms of Service and Privacy Policy**. Read it, tick
   *"I have read and accept the Terms of Service and Privacy Policy"*, and Next unlocks —
   it stays disabled until you do.
3. Pick an install location, finish, and launch it from the desktop shortcut or the Start
   menu.

To remove it later, use **Apps & features** / the Start menu uninstaller. Your profile —
which keys hold which sounds — is deliberately left behind so reinstalling does not lose
your setup; it lives in `%APPDATA%\HotSound`.

## What it does

- **Every key is a slot.** Slots are bound to *physical* key positions, so they follow the
  keycap and not what your keyboard layout types.
- **Click an empty key** to add music, **click a key with music** to play it,
  **right-click** to take the music back off. Drop files onto keys, or **Load folder…**
  to fill the board from a folder in one go.
- **Sound wave preview** — the sample's waveform with a playhead sweeping it as it plays,
  driven by the audio clock so it stays in step with what you hear.
- **Polyphonic** — retriggering a key does not cut off the previous hit. Per-slot volume,
  pitch, pan and loop.
- **Profiles** save anywhere you like through the normal Windows save dialog, and the
  location is remembered, so the profile you saved to your Desktop is the one that opens
  next time.
- **Toggles worth knowing:** Shift+click (or Shift+key) toggles looping; hold a looping
  key to sustain it and release to stop; **Stop all**, `Ctrl+Escape` or `Ctrl+Alt+X`
  fade everything out.
- **Loads what Chromium can decode:** `wav`, `mp3`, `ogg`/`oga`, `flac`, `m4a`/`aac`,
  `opus`, `webm`, `aif`/`aiff`.

### Some keys are not slots

These are printed on the board as usual but deliberately hold nothing, and the app never
captures them, so they keep their normal Windows behaviour (Tab still moves focus, Esc
still closes things):

`Esc`  `` ` ``  `Tab`  `Caps`  `Shift` (both)  `Ctrl` (both)  `Alt` (both)
`Menu`  `Win` (both)  `Backspace`  `\`

The numeric keypad and the editing/nav block (PrtSc, ScrLk, Pause, Ins, Home, PgUp, Del,
End, PgDn) are not on the board at all. The arrow cluster stays.

## Privacy

HotSound runs entirely on your computer. There are no accounts, no sign-in, no server, no
telemetry and no update check. The app reads only the audio files you select, and writes
only its own profile and settings into `%APPDATA%\HotSound` — or wherever you point
**Save profile…**. The one link in the app is the developer's GitHub page, which opens in
your browser when you click it and is then subject to GitHub's own terms. The full text is
shown by the installer and is in
[`build/installer/terms-and-privacy.txt`](https://github.com/mavipisowifi/HotSound/blob/main/build/installer/terms-and-privacy.txt).

## Verify your download

```
HotSound Setup 1.0.0.exe   96.1 MB   754ac4eb1a1449d87d1d0b80d2dc8eb5d9067bb01a5d82a28dcc4b3f4c562aee
HotSound 1.0.0.exe         95.8 MB   e36d1e380da938542cf03db4b43f18015a6bf084c549c25fa66d846163448462
```

```powershell
Get-FileHash "HotSound Setup 1.0.0.exe" -Algorithm SHA256
```

## Known limitations in this release

- **Memory grows with the music you load.** Decoded audio is held for the session and is
  not released when you take music off a key — measured at roughly 22 MB per minute of
  stereo audio, so a board full of long tracks can reach gigabytes. Restarting the app
  clears it. A bounded cache is the fix and is not in this build.
- **`Ctrl+W` quits the program** and `Ctrl+R` reloads it. Electron's default application
  menu owns those shortcuts and they are not intercepted, because the app deliberately
  lets modifier combinations through to Windows.
- **Right-click removes music immediately**, with no undo.
- **Slots remember an absolute path.** Move the file afterwards and the key is flagged as
  errored rather than silently playing nothing.
- **The first press on a sample decodes it**, which can add a few milliseconds; after that
  it plays from cache. **Load folder…** decodes up front.
- **Silent installs skip the terms page.** `HotSound Setup 1.0.0.exe /S` installs without
  showing any page, which is normal for installers, but it does mean the acceptance step
  can be bypassed on purpose.

## Licence

The source is MIT — see [LICENSE](https://github.com/mavipisowifi/HotSound/blob/main/LICENSE).

One thing to be aware of if you redistribute or repackage this build: the bundled typeface,
Google Sans, is **not** an open-source font like Roboto or Noto. Google's own terms apply
to those files. Everything else in the build is MIT or BSD-style, including Electron and
Chromium.

## Feedback

Bug reports and feature requests:
**https://github.com/mavipisowifi/HotSound/issues**

Full documentation, including how to build it yourself, is in the
[README](https://github.com/mavipisowifi/HotSound#readme).
