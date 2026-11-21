# App icon

`icon.svg` is the one source: a 1,024 px square on macOS's grid (an 824 px tile at 100 px, continuous corners, a soft shadow), the header's three-state mark in white on the brand cobalt. Its design is the "App icon" section of the canvas's `LaptopStyles` board (#435).

To regenerate the set after changing it, write the output outside the repo, then copy back the files `tauri.conf.json` bundles plus `icon.png`:

```sh
(cd desktop && npm run tauri icon src-tauri/icons/icon.svg -- -o /tmp/icmm-icons)
cp /tmp/icmm-icons/{32x32.png,128x128.png,128x128@2x.png,icon.icns,icon.ico,icon.png} desktop/src-tauri/icons/
```

The command also writes Windows Store, Android and iOS sets; ICMM ships none of them. `icon.icns` comes out with its images in a different order each run, so an unchanged source can still show it as changed.

## Installer artwork

The Windows installer's welcome and finish pages show `sidebar.bmp` (164 × 314) and the pages between show `header.bmp` (150 × 57), set in `tauri.conf.json`'s `bundle.windows.nsis`. Both are `icon.png` on the app's light colors, written by a stdlib-only script; run it again after `icon.png` changes:

```sh
uv run python scripts/dev/installer_images.py
```
