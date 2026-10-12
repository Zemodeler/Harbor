# Releasing Harbor

## How it works
- Every push to `main` runs `.github/workflows/release.yml` on `windows-latest`: `npm ci`, packaging deps (`npm install --prefix build`), then `npm test`, `npm run typecheck`, `npm run build`. Only if all pass does it package and publish.
- Version is `0.1.<GitHub run number>`, set in the runner with `npm version --no-git-tag-version` (never committed). The release tag is `v<version>`. Assets: `Harbor-Setup-<version>.exe`, its `.blockmap`, and `latest.yml`. Release notes are generated from the commits since the previous release.
- Installed copies (`electron-updater`, `src/main/updater.ts`) check GitHub Releases 30 s after launch and every 4 hours, download in the background, then ask "Restart now / Later". The prompt never appears, and Harbor never restarts, while agents are running (it re-checks every minute). "Later" installs on the next normal quit.
- The repository must be public: update checks are unauthenticated.

## Trigger or skip
- Merge or push to `main` = release. Put `[skip release]` in the head commit message to skip (docs-only changes, etc.).
- Local packaging without publishing: `npm run dist` (`node build/dist.mjs`, publish never). CI uses `node build/dist.mjs --publish always`.

## Disable updates
- Environment variable `HARBOR_NO_UPDATE=1`.
- Settings field `autoUpdate: false` (read by `index.ts`; not yet in the typed `Settings` or the UI, see follow-ups).
- Dev (unpackaged) runs never update.

## First install on a PC
Download `Harbor-Setup-<version>.exe` from the latest release once and run it. Windows SmartScreen will warn (the installer is unsigned): More info, Run anyway. This only happens on the first install; later updates are installed by Harbor itself.

## Roll back
Users cannot be downgraded automatically. Push a commit that reverts the bad change; it becomes a newer release and installs everywhere. To stop a bad release spreading sooner, delete that GitHub release (clients then see the previous latest, which they ignore as older) and push the fix.

## Not verified
- The GitHub Actions run itself (workflow syntax, `npm ci` + `npm install --prefix build` on the runner, the release-notes step).
- A real update download and a real silent install/relaunch from a published release.
- That version `0.1.N` stays higher than any installed build (the local build is `0.1.0`, so any release supersedes it).
- Behaviour of the unauthenticated check until the repo is public.
