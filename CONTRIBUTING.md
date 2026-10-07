# Working on this repository

A practical guide to committing changes here, written for the machine this project
was set up on (Windows, Git Bash). Everything below has been run and verified on it.

---

## Where things stand right now

The project is **already committed and pushed**:

| | |
| --- | --- |
| Repository | https://github.com/mml1-glitch/HotSound |
| Visibility | private |
| Branch | `main`, tracking `origin/main`, working tree clean |
| Author on commits | `mml1-glitch <mml1@pisdavao.com>` |

So there is nothing to do for a "first commit" — the steps below are for every commit
after it. Check the state at any time:

```bash
cd /d/MyFiles/myProjects/HotSound

git log --oneline          # what has been committed
git status -sb             # staged / modified, and whether you are ahead of the remote
gh repo view --web         # open the repository in the browser
```

`git status -sb` reading `## main...origin/main` with nothing else means everything is
committed and pushed.

---

## One-time setup

Already done on this machine; documented so it can be reproduced elsewhere.

### 1. Who commits are authored as

```bash
git config --global user.name     # mml1-glitch
git config --global user.email    # mml1@pisdavao.com
```

If either is empty, set it:

```bash
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
```

This is the name on the commit, not the account used to push. Keeping them the same
avoids confusion later.

### 2. The account that owns the repository

```bash
gh auth status
```

Expected: `Logged in to github.com account mml1-glitch`. If it is not logged in:

```bash
gh auth login          # GitHub.com -> HTTPS -> login with a browser
```

### 3. Which account git pushes as

```bash
gh auth setup-git
```

This points git at the GitHub CLI's token for github.com. It matters here because the
repository is owned by **mml1-glitch**, while Windows' own stored credential for
github.com belongs to a different account (**mavipisowifi**). Pushing a *private* repo
with an account that cannot see it does not return a permission error — GitHub answers

```
remote: Repository not found.
fatal: repository 'https://github.com/mml1-glitch/HotSound.git/' not found
```

which reads like the repo is gone when the real problem is the credentials. After
`gh auth setup-git`, `~/.gitconfig` contains:

```ini
[credential "https://github.com"]
	helper =
	helper = !'C:\Program Files\GitHub CLI\gh.exe' auth git-credential
```

To hand github.com back to the Windows credential manager instead — which would push
as `mavipisowifi`, and only works if that account has access to the repo — delete those
two `helper` lines from `~/.gitconfig`.

---

## The everyday workflow

```bash
cd /d/MyFiles/myProjects/HotSound

git status -sb                  # 1. what changed?
git diff                        #    read it (--staged shows what is staged)
git add -A                      # 2. stage everything
git commit -m "what changed and why"
git push                        # 3. send it to GitHub
```

Then confirm with `git log --oneline -1` and `git status -sb` (no `ahead` marker).

Stage selectively when a change is unrelated to the rest:

```bash
git add renderer/app.js renderer/styles.css
git commit -m "Board: ..."
```

Before committing code changes, `npm test` is the cheap check — it boots the app and
asserts the rendered board, the typography and the audio/profile behaviour.

### A commit message that helps future you

First line under about 70 characters saying what changed; a blank line; then why, if it
is not obvious. Reference the file or feature rather than saying "fixes".

```
Picker: use Chromium's chooser instead of the shell open dialog

Dismissing dialog.showOpenDialog segfaults the main process, so cancelling
the file picker killed the app. Files now come from a renderer-side input.
```

---

## What is committed, and what is not

Committed: all source, the reference image and logo, `font/`, the icon masters, the
installer files, tests, `README.md`, `LICENSE`, `CONTRIBUTING.md`, `package.json` and
`package-lock.json`.

Deliberately ignored (see `.gitignore`):

| Path | Why |
| --- | --- |
| `node_modules/` | recreated by `npm install` |
| `dist/` | build output, roughly 100 MB of installers |
| `renderer/fonts/`, `renderer/fonts.css` | generated from `font/` by `npm run fonts` |

The generated font files are the ones worth knowing about: `npm start`, `npm test`,
`npm run smoke`, `npm run e2e` and `npm run dist` each run `npm run fonts` first, so
they regenerate themselves and never need committing. That keeps ~16 MB of duplicated
font files out of the repository. The generated **icons** are committed instead, because
regenerating those needs Electron.

So a fresh clone needs exactly: `npm install`, then `npm start`. Nothing else.

---

## Windows note: the LF/CRLF warnings

`git add` prints lines like:

```
warning: in the working copy of 'README.md', LF will be replaced by CRLF the next time Git touches it
```

That is `core.autocrlf=true` working as intended: the repository stores LF line endings,
the working copy gets CRLF. Nothing to fix and nothing to configure.

---

## Verifying what reached GitHub

```bash
gh repo view --json url,visibility,pushedAt
gh api repos/mml1-glitch/HotSound/commits \
  --jq '.[] | .sha[0:7] + "  " + (.commit.message | split("\n") | .[0])'
git ls-tree -r --name-only origin/main | wc -l     # files on the remote branch
```

Or open https://github.com/mml1-glitch/HotSound (or `gh repo view --web`).

---

## When something goes wrong

**`remote: Repository not found` when pushing**
Credentials, not a missing repo. Check `gh auth status`, then run `gh auth setup-git`,
then push again. Confirm the owner and name: `gh repo view`.

**`! [rejected] main -> main (fetch first)`**
The remote has commits you do not have locally (for example, edited on github.com):

```bash
git pull --rebase
git push
```

**`nothing to commit, working tree clean`**
Nothing was staged, or the changes are in ignored paths. `git status --ignored --short`
lists what is being skipped.

**A file was committed that should be ignored**

```bash
git rm --cached path/to/file         # untrack it, keep it on disk
echo "path/to/file" >> .gitignore
git commit -m "Stop tracking path/to/file"
```

It remains in the history. If it was a credential, rotate it — and treat it as exposed
if the repository is public.

**Undo the last commit but keep the changes**

```bash
git reset --soft HEAD~1
```

**Pushed a commit that should not be there** (only safe if nobody else has pulled)

```bash
git revert <commit>        # preferred: adds a commit that undoes it
```

---

## Cutting a release

`dist/` is not committed, so built installers travel as release assets:

```bash
npm run dist
git tag -a v1.0.0 -m "HotSound 1.0.0"
git push origin v1.0.0
gh release create v1.0.0 \
  "dist/HotSound Setup 1.0.0.exe" \
  "dist/HotSound 1.0.0.exe" \
  --title "HotSound 1.0.0" \
  --notes "Describe what changed in this release"
```

Bump the version in `package.json` first if the release is more than a rebuild.
