# three.js editor enhanced

An enhanced version of the [three.js editor](https://threejs.org/editor/) ready for static hosting — no build step required.

## Features

- **No build** — serve the `docs/` folder as-is
- **JS Shell** — interactive JavaScript REPL (like Blender's Python console), available under **View → JS Shell**

## Hosting

Point your static host root at the `docs/` folder. The editor is served at `/`.

**GitHub Pages:** set the Pages source to the `docs/` folder of the `main` branch.

**Local:**
```bash
npx serve docs
```

## JS Shell

Open with **View → JS Shell** in the menu bar.

| Key | Action |
|-----|--------|
| `Enter` | Execute |
| `Shift+Enter` | New line |
| `↑` / `↓` | Command history |
| `Backspace` | Delete (works normally) |

Available globals inside the shell:

| Name | Description |
|------|-------------|
| `editor` | The Editor instance |
| `THREE` | The three.js library |
| `scene` | The active scene |
| `camera` | The active camera |
| `renderer` | The WebGL renderer |

**Example:**
```js
scene.children.length
new THREE.BoxGeometry(1,1,1)
editor.scene.background = new THREE.Color(0xff0000)
```

## Structure

```
docs/
  index.html       ← entry point
  editor/          ← editor app (HTML, CSS, JS)
  build/           ← three.js module builds
  examples/jsm/    ← three.js addons
```
