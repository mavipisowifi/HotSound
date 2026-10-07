# Author

**Marvin Bangcailan**

- GitHub: [@mavipisowifi](https://github.com/mavipisowifi)
- Repository: [mavipisowifi/HotSound](https://github.com/mavipisowifi/HotSound)

HotSound was designed and developed by Marvin Bangcailan.

---

## Where this credit appears

The name and links are defined once, in `package.json`, and everything else is derived
from them — so the app, the installer and the built `.exe` cannot disagree about who
wrote it.

| Surface | Source field | Shows |
| --- | --- | --- |
| Windows `.exe` properties | `author.name`, `copyright` | CompanyName, LegalCopyright |
| App status bar | `author.name`, `author.url` | `dev Marvin Bangcailan \| GitHub`, the GitHub button opens the profile |
| Installer terms page | `build/installer/terms-and-privacy.txt`, section 8 | name and GitHub link, shown before installing |
| Repository metadata | `homepage`, `repository`, `bugs` | links in the package manifest |

To see it on the built program: right-click the installed `HotSound.exe`, then
**Properties -> Details** — CompanyName and LegalCopyright come straight from
`package.json`. The README's "Developer credit" section documents each field.

## Third-party components

| Component | Licence |
| --- | --- |
| Electron and Chromium | MIT / BSD-style (see `LICENSE.electron.txt` inside the installed app) |
| Google Sans, in `font/` | **not open source** — see the font licensing note in `README.md` |
| The rest of the source | MIT — see [LICENSE](LICENSE) |

Audio files are not bundled: the app plays only the samples you choose yourself.
