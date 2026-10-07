# Working on this repository

A practical guide to committing changes here, written for the machine this project was
set up on (Windows, Git Bash). Everything below has been run and verified on it.

---

## Where things stand right now

| | |
| --- | --- |
| Repository | https://github.com/mavipisowifi/HotSound |
| Visibility | public |
| Branch | `main`, tracking `origin/main`, working tree clean |
| Remote | `origin` -> `https://github.com/mavipisowifi/HotSound.git` |
| Commits authored as | `mml1-glitch <mml1@pisdavao.com>` (the git identity on this machine) |

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

This is the name on the commit, not the account used to push.

**These are currently a different account from the one that owns the repository**, so
commits appear in `mavipisowifi/HotSound` attributed to `mml1-glitch`. To re-author them
(a history rewrite, safe while nobody else has cloned the repository):

```bash
git config --global user.name  mavipisowifi
git config --global user.email mavipisowifi@users.noreply.github.com

# re-author every commit on this branch
git rebase --root --exec 'git commit --amend --no-edit --reset-author'
git push --force-with-lease
```

Using the `@users.noreply.github.com` address is the reliable way to have GitHub link
commits to that account without publishing a real email address.

### 2. Which account git pushes as

Pushing uses the **Windows credential manager** entry for github.com, which belongs to
**mavipisowifi** — the owner of this repository. That is why `git push` works here; it
needs no setup beyond having signed in to GitHub on this machine at some point.

```bash
git config --get-regexp "^credential"      # expect: credential.helper manager
```

**Do not run `gh auth setup-git` on this machine as things stand.** It points github.com
at the GitHub CLI's token instead, and the CLI is logged in as a *different* account
(`mml1-glitch`) with no access to this repository. Pushing a repository the active
account cannot see does not report a permission problem — GitHub says the repository does
not exist:

```
remote: Repository not found.
fatal: repository 'https://github.com/mavipisowifi/HotSound.git/' not found
```

which reads like the repository is gone when the real problem is the credentials.

### 3. The GitHub CLI account

```bash
gh auth status      # currently: Logged in to github.com account mml1-glitch
```

The CLI is separate from git's push credentials, and it is logged in as the wrong account
for this repository. What that means in practice:

| `gh` command | Works today? |
| --- | --- |
| `gh repo view`, `gh api` (reads) | yes — the repository is public |
| `gh release create`, `gh repo edit`, `gh issue create` (writes) | **no** — they would act as `mml1-glitch` |

To switch it to the owning account:

```bash
gh auth login           # GitHub.com -> HTTPS -> browser, sign in as mavipisowifi
gh auth switch          # later, to move between accounts
```

Until then, publish releases from the repository's web page rather than with
`gh release create` (see [Cutting a release](#cutting-a-release)).

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
`npm run smoke`, `npm run e2e` and `npm run dist` each run `npm run fonts` first, so they
regenerate themselves and never need committing. That keeps ~16 MB of duplicated font
files out of the repository. The generated **icons** are committed instead, because
regenerating those needs Electron.

So a fresh clone needs exactly: `npm install`, then `npm start`. Nothing else.

---

## Windows note: the LF/CRLF warnings

`git add` prints lines like:

```
warning: in the working copy of 'README.md', LF will be replaced by CRLF the next time Git touches it
```

That is `core.autocrlf=true` working as intended: the repository stores LF line endings,
the working copy gets CRLF. Nothing to fix.

---

## Verifying what reached GitHub

```bash
gh repo view --json url,visibility,pushedAt
gh api repos/mavipisowifi/HotSound/commits \
  --jq '.[] | .sha[0:7] + "  " + (.commit.message | split("\n") | .[0])'
git ls-tree -r --name-only origin/main | wc -l     # files on the remote branch
git ls-remote origin                                # the commit the remote points at
```

Or open https://github.com/mavipisowifi/HotSound (or `gh repo view --web`).

---

## When something goes wrong

**`remote: Repository not found` when pushing**
Almost always credentials, not a missing repository. The account git is pushing as cannot
see the repository. Check what git will use (`git config --get-regexp "^credential"`) and
which account the CLI is on (`gh auth status`). If `gh auth setup-git` has been run, the
CLI's account is being used for github.com — undo it by deleting the
`[credential "https://github.com"]` section from `~/.gitconfig` so the Windows credential
manager is used again.

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

It remains in the history. If it was a credential, rotate it — and treat it as exposed if
the repository is public.

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

The notes for the current release are in `RELEASE_NOTES.md` — paste them into the release
form (or pass them with `--notes-file RELEASE_NOTES.md`). For later versions, either rewrite
that file or turn it into one section per version, newest first.

```bash
npm run dist
git tag -a v1.0.0 -m "HotSound 1.0.0"
git push origin v1.0.0
```

The tag push uses the same credentials as a normal push, so it works today. Publishing
the release itself needs a `gh` account with write access, which the CLI does not have
yet — so either sign in as the owner first (see setup 3), or use the web page:
**Releases -> Draft a new release**, choose the tag, and attach the two `.exe` files.

Once `gh` is on the owning account:

```bash
gh release create v1.0.0 \
  "dist/HotSound Setup 1.0.0.exe" \
  "dist/HotSound 1.0.0.exe" \
  --title "HotSound 1.0.0" \
  --notes "Describe what changed in this release"
```

Bump the version in `package.json` first if the release is more than a rebuild.

---

## A second, duplicate repository

An earlier push went to `mml1-glitch/HotSound` (private). It was created by mistake: the
GitHub CLI was logged in as that account when the repository was set up. It holds the same
three commits and is no longer the remote for this project.

Delete it from the account that owns it:

```bash
gh auth login                                    # sign in as mml1-glitch if needed
gh repo delete mml1-glitch/HotSound --yes
```

Or from the web: that repository's Settings -> General -> Danger Zone -> Delete this
repository. Nothing here depends on it.
