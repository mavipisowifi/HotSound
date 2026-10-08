# HotSound 1.0.0

A Windows soundboard whose slots **are** the keys of a PC keyboard. The app draws an ANSI
tenkeyless layout on screen — numpad excluded — and the keys on it hold your sounds: press
a key and it plays, press it again and it stops, fading out over a time you choose.
Equalizer-style faders run along the top of the board, the keys that are sounding list
themselves beside it, and the sample's waveform sweeps past a playhead below. Built with
Electron; the app itself makes no network requests.

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
- **Getting sounds onto the board.** Click an empty key for the file picker, drop audio
  files onto a key (extra files spill onto the keys after it), or **Load folder…** to fill
  the board from a folder in one go.
- **Playing, and stopping.** Click a key that has music, or press it, and it plays. Press
  or click it again while it is playing and it stops, fading out over the time set in
  Settings — 150 ms by default. That *twice to stop* behaviour is on by default; turn it
  off in Settings and every hit starts another copy instead, so drum rolls overlap and
  nothing cuts off. A single key can be pinned either way from its menu.
- **Right-click any key for its menu:**
  - **Replace** — puts another file on the key, through the same picker that adds sounds.
    Cancelling changes nothing.
  - **Loop** — the key's sound repeats until it is stopped, and the keycap shows `↻`.
    Turning Loop off while it is repeating lets the current pass finish and then fades it
    out.
  - **Set twice to stop** — pins the press-again-to-stop behaviour for that one key
    instead of following the global setting. The note on the right says `default` while it
    follows the setting and `just this key` once it has been pinned.
  - **Delete** — takes the music off the key.

  Items that cannot apply are disabled: Loop and Delete grey out on an empty key.
- **Shift+click** (or holding Shift with a key) toggles Loop without opening the menu.
  Holding a looping key and letting go stops it, sampler-pad style, when twice-to-stop is
  off.
- **Visualisers.** Equalizer-style faders along the top of the board move with what is
  playing; the **playing now** panel beside the board lists each sounding key with its
  name, elapsed time and a progress bar, and clears itself as sounds end; the waveform
  preview under the board sweeps a playhead across the sample, driven by the audio clock
  so it stays in step with what you hear.
- **Settings** (toolbar) holds the **fade-out time**, 0–2000 ms — 0 cuts instantly, which
  can click on a loud sample — the default for press-again-to-stop, and a **measured
  latency readout**, so you can see what the output path costs on your machine.
- **Profiles** save anywhere you like through the normal Windows save dialog, and the
  location is remembered, so the profile you saved to your Desktop is the one that opens
  next time. The profile holds the board, the master volume and the settings.
- **Panic:** the **Stop all** button, or `Ctrl+Escape` anywhere in the app, fades every
  voice out at once. `Ctrl+Alt+X` does the same from anywhere in Windows, even when
  HotSound is not the focused window.
- **Giving the keyboard back to Windows:** click the `keys: on` badge in the status bar
  and the board stops capturing keys — every key types normally again — until you click it
  back on.
- **Polyphonic.** Sounds from different keys overlap; starting one never cuts off another.
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
HotSound Setup 1.0.0.exe   96.1 MB   698a31f159775002a418bb403781af31e29cb3a099ca96f08cfc11b274415a6a
HotSound 1.0.0.exe         95.8 MB   99ddd6147a8f17d680f8cc8b3a99e38c3440f0b7f2649d34e769ee58a39204c1
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
- **Delete removes music immediately**, with no undo. It is the destructive item in the
  menu, so it sits last, below a separator.
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
