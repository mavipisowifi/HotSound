# Installer files

Two files drive the Terms of Service and Privacy Policy page in the installer:

| File | Role |
| --- | --- |
| `terms-and-privacy.txt` | **The text shown to the user.** Edit this to change the terms. |
| `terms-page.nsh` | The NSIS page: layout, the acceptance checkbox, and the gating. |

`package.json` points at the page script with `build.nsis.include`
(`installer/terms-page.nsh`, resolved relative to `build/`).

The page is hooked in with `customWelcomePage`, which the installer template inserts
ahead of every other page, so it is the **first thing shown** - before the install mode
and install location pages. Switching it back to `customPageAfterChangeDir` would move
it to just before the install step instead.

## About the terms text

**It is a starting template, not legal advice.** It was written from what the
software actually does — verified for this build:

- no network requests from the app (the GitHub link opens in the user's browser);
- reads only the audio files the user selects;
- writes only a profile and a settings file under the app-data folder, or a
  profile at a location the user picks with "Save profile".

If any of that changes, the privacy section becomes inaccurate and must be
updated with it. Have the wording reviewed before distributing the installer
widely, and adjust the "Last updated" date whenever the text changes.

## Two NSIS traps this page already fell into

Both produced a *silent* failure — the installer simply vanished when the page was
shown — so they are worth knowing before editing `terms-page.nsh`.

**1. `SendMessage` needs `STR:` for messages that take text.** `EM_REPLACESEL` and
`WM_SETTEXT` expect a *pointer* to a string. Without the prefix NSIS passes the string
itself as that pointer, the edit control dereferences it, and the installer dies with
exit code `0xC000041D` (`STATUS_FATAL_USER_CALLBACK_EXCEPTION`) — no message, no log.
It looks like this:

```
SendMessage $TermsBody ${EM_REPLACESEL} 0 "STR:$TermsChunk"   ; correct
SendMessage $TermsBody ${EM_REPLACESEL} 0 "$TermsChunk"       ; crashes the installer
```

**2. `FileRead` returns whole lines, and one read is capped** by the NSIS string limit
(1024 characters). The whole document therefore has to be appended in a loop until a
read comes back empty. The current text loads in 93 chunks; if that loop is ever
"simplified" into a single read, the page will show only the first line or two.

Also required, and easy to lose when editing: the `!ifndef BUILD_UNINSTALLER` guard
around the whole file. Without it the page functions are unreferenced while building
the uninstaller, NSIS warns, and the build fails because warnings are errors here.

## Verifying changes

Testing this by hand is fine, but automating it needs two precautions, because
blocking cross-process calls deadlock the harness while the wizard is inside the
page's modal loop:

- use `PostMessage` (asynchronous) and `IsWindowEnabled` / `IsWindowVisible` (no IPC)
  rather than `SendMessage` and `GetWindowText`;
- use **real mouse input** (`SetCursorPos` + `mouse_event`) to click the checkbox and
  Next — `PostMessage(BM_CLICK)` does not dispatch a page transition, so it cannot
  prove the page can actually be completed.

What was checked on the current build:

| Check | Result |
| --- | --- |
| First page shown, with **no clicks sent** | terms box (450x164 rich edit) + checkbox |
| Terms document loaded into the box | 93 chunks read |
| Next on arrival, box unticked | disabled |
| **Real click** on Next while unticked | does not advance |
| Real click on the checkbox | Next becomes enabled |
| Real click on Next when ticked | advances to the install mode page |
| Partial install from the test | removed; nothing left installed |

## Editing notes

- The text is plain ASCII and hard-wrapped at about 76 columns, because the page
  renders it in a rich edit box that scrolls horizontally rather than wrapping.
- Do not use the `$` character in the text: NSIS treats it as a variable marker
  on the way into the control.
- The page appears on every install, including over an existing installation. To
  skip it on updates instead, add `!insertmacro skipPageIfUpdated` to the start
  of the `customWelcomePage` macro body.
- Silent installs (`installer.exe /S`) skip every page, including this one. That
  is normal for NSIS installers, but it does mean the acceptance step can be
  bypassed by anyone who runs the installer silently on purpose.

## Verifying it still works

`npm run dist`, then open the installer and check that:

1. the page appears after the install-location page;
2. **Next is disabled** until the box is ticked;
3. from a clean start, pressing Next without ticking (if it is enabled at all)
   shows the warning and refuses to continue.
