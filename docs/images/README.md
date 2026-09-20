# Images for the README

The README is the first thing a player sees, and most of them will decide whether to
bother from the pictures alone. This is the shot list. The pictures themselves are
uploaded to GitHub's asset host (drag them into the README editor; they become
`user-attachments` URLs) rather than committed, so clones stay small; anything committed
here instead must be referenced by `README.md`, and a test fails if a referenced file is
missing.

Capture at **1920x1080** and keep each file under the size given. PNG for stills, GIF for
motion -- GitHub does not play a committed `.mp4` inline, it renders it as a download
link, so anything that needs to move has to be a GIF.

## The shots

| file | max | what is in it |
|---|---|---|
| `hero.png` | 600 KB | The game while driving, app drawer open on the right, two or three apps on screen. This is the whole pitch in one picture: it has to look like the game, not like a web page. Daylight track, clean HUD, no dev console. |
| `drawer.gif` | 3 MB | Mouse moves to the right edge, the drawer slides in, one app is switched on and appears. About 5 seconds. This answers "how do I use it" better than any paragraph. |
| `mods-folder.png` | 250 KB | Explorer at `Saved Games\ACE\mods` with `ACEUIAppLoader.kspkg` in it, address bar visible so the path can be read. Crop to the window. |
| `apps-pedalgraph.png` | 300 KB | The pedal graph widget on the HUD, mid-corner so the traces are interesting. |
| `apps-doom.png` | 400 KB | DOOM running on the HUD. The showpiece -- pick a frame with an enemy in it. |
| `settings.png` | 300 KB | An app's settings page, showing that apps are configurable without editing files. |

> **The two app shots sit side by side in one row**, each half the page wide.
> Crop both to the **same aspect ratio and the same pixel size** -- 16:9 at
> 640x360 works -- or the row comes out ragged and the whole page looks careless.
> They are the most-looked-at images here: they are what a passer-by judges the
> project on.

## Optional, if you want one

`banner.png` -- a wordmark for the top of the README, about 900x180, transparent
background. Only worth it if it looks deliberate; a plain heading beats a bad logo. If one
is added with a light and a dark version, the README needs a `<picture>` element and
`ReadmeTests` needs to learn to read `srcset`, which it currently does not.

## Capturing

- **Stills**: the game's own screenshot key, or Win+Shift+S. Crop tight; no desktop, no
  taskbar, no other windows.
- **GIF**: record with ShareX or ScreenToGif at 1920x1080, then scale to **960 wide** and
  10-12 fps before saving. A 5-second clip at that size lands around 2-3 MB; at full size
  it will be 20 MB and nobody on a phone will wait for it.
- Turn the dev console and profiler off first. They are developer apps and default to
  hidden, so a player's first screen will not have them -- the pictures should match what
  they will actually see.

## Later, for the wiki

The wiki can hold what the README should not: a longer video walkthrough, per-app pages,
troubleshooting with screenshots of each failure. A wiki cannot be created until the
repository is public, so none of that blocks a first release -- but the README should stay
short even once the wiki exists. It is a front door, not a manual.

Longer video belongs on YouTube or as a release asset, linked from the README with a
thumbnail, rather than committed here: repositories are cloned, and a 50 MB demo video is
paid for by everyone who clones for the code.
