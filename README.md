# three.js editor — Sovereign AI-Native

A fork of the [three.js editor](https://threejs.org/editor/) with an in-browser local LLM that builds and edits 3D scenes via natural language, executes its output through the editor's existing JS shell (command pattern → undo stack), and versions scenes through git.

**No server. No API keys. No data leaves the device.**

---

## Quick start

```bash
npx serve docs       # local dev — or point GitHub Pages at docs/
```

Requires **Chrome 113+** (WebGPU). Verify at [webgpureport.org](https://webgpureport.org).

---

## Features

| | |
|---|---|
| **Sovereign AI** | 100 % on-device inference via WebGPU (WebLLM / MLC). Prompts and scenes never leave the browser. |
| **No build step** | Serve `docs/` as-is. Plain ES modules, importmap, no bundler. |
| **JS Shell** | Interactive REPL under **View → JS Shell**. Same scope as the AI. |
| **One execution surface** | AI-generated code and human-typed code run through the same `execute()` binding — same undo stack, same error handling, no second path. |
| **Scene Q&A** | Ask the AI questions about the scene in plain English (prefix with `?`). No code is generated or run. |
| **Modeling ops** | Boolean CSG, mirror, array duplicate, midpoint subdivision — all undoable, all AI-callable. |
| **Git integration** | Load / commit scenes from a GitHub repo via the **Git** menu. AI generates commit messages that describe what changed. |
| **Error-feedback retry** | If generated code throws, the error is fed back to the model for one auto-correction pass. |
| **Token streaming** | AI output streams live into the shell as it is generated. |

---

## AI models

Select a model from the shell header and click **Load AI**. Weights are downloaded once and cached in browser storage automatically.

| Label | Model ID | Size | Notes |
|-------|----------|------|-------|
| **Default** | `Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC` | ~1 GB | Recommended |
| **Power** | `Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC` | ~4.5 GB | Best quality, needs ≥8 GB VRAM |
| **Lite** | `Llama-3.2-1B-Instruct-q4f32_1-MLC` | ~900 MB | Weak / integrated GPUs only |

---

## JS Shell

Open with **View → JS Shell**. Type JavaScript directly or use the AI input row.

| Key / Input | Action |
|-------------|--------|
| `Enter` | Execute |
| `Shift+Enter` | New line |
| `↑` / `↓` | Command history |
| AI input + `Enter` | Generate and run code |
| AI input `? question` | Ask about the scene — plain-text answer, no code |

### Scene assembly globals

```js
editor                // Editor instance
THREE                 // three.js library
scene                 // live THREE.Scene
camera                // active camera
renderer              // WebGLRenderer

// Commands (all go through the undo stack)
AddObjectCommand      RemoveObjectCommand
SetPositionCommand    SetRotationCommand    SetScaleCommand
SetMaterialColorCommand                     SetValueCommand

// Primitives (no THREE. prefix needed)
BoxGeometry  SphereGeometry  CylinderGeometry  ConeGeometry  PlaneGeometry
TorusGeometry  TorusKnotGeometry  CircleGeometry
MeshStandardMaterial  MeshBasicMaterial  MeshPhongMaterial  MeshLambertMaterial
Mesh  Group  Line  Points
DirectionalLight  PointLight  AmbientLight  SpotLight
Color  Vector3  Euler
```

### Scene lookup globals

```js
findObject('human')          // first object whose name contains 'human' (case-insensitive)
findAll('box')               // array of all matching objects
findOfType('Mesh')           // first object of a given three.js type
findNear(mesh, radius)       // array of objects within radius world-units of mesh
```

### Spatial helpers

These use `THREE.Box3` for accuracy — they account for scale, rotation, and child objects.

```js
getSize(obj)                 // → {x, y, z}  world-space bounding box dimensions
getTopY(obj)                 // → number      world Y of the top face
getCenter(obj)               // → Vector3     world-space bounding box centre
placeOnTop(child, target)    // sets child.position.y so it rests on top of target
```

### Codegen / round-trip globals

```js
showJS(obj?)                 // print executable JS for obj (or selected, or full scene)
objectToJS(obj)              // → { code, lossy, lossyReasons }
sceneToJS()                  // → { code, lossy, lossyReasons }  for the whole scene
sceneEqual(jsonA, jsonB)     // semantic equality check (float-tolerant, UUID-agnostic)
summarize()                  // compact scene snapshot object
```

### Modeling ops

All ops are undoable and AI-callable.

```js
// Boolean CSG (three-bvh-csg)
booleanUnion(meshA, meshB, keepInputs=false)
booleanSubtract(meshA, meshB, keepInputs=false)
booleanIntersect(meshA, meshB, keepInputs=false)

// Geometry ops
mirrorMesh(mesh, axis='x')                      // create mirrored copy ('x'|'y'|'z')
arrayDuplicate(mesh, count, dx=0, dy=0, dz=0)  // N copies offset by (dx,dy,dz) each
subdivide(mesh, iterations=1)                   // midpoint subdivision (4× tris/iter)

listOps()                                       // print registered op schema
```

### Scene Q&A

```js
askScene('what objects are in the scene?')
askScene('which object is tallest?')
askScene('is anything red?')
// Or: prefix the AI input row with ? and press Enter
```

---

## Scene representation

The editor maintains a **two-form** scene representation:

```
EXECUTABLE JS                    THREE.JS JSON
─────────────                    ─────────────
Loops, procedural geometry       Serialized state snapshot
Easy for AI to write             Git-diffable, lossless storage
Human readable                   Round-trip safe
```

| # | Direction | Implementation |
|---|-----------|----------------|
| 1 | JS → Scene | Shell `execute()` |
| 2 | Scene → JSON | `scene.toJSON()` |
| 3 | JSON → Scene | `ObjectLoader.parse()` |
| 4 | Scene → JS | `codegen.js` — `objectToJS()` / `sceneToJS()` |

**Lossy boundary:** custom `BufferGeometry`, `ExtrudeGeometry`, and similar types cannot be reconstructed from constructor args. The codegen emits a clearly-flagged JSON-load fallback and sets `result.lossy = true`. Never silently wrong.

**Round-trip test (in-shell):**
```js
var snap = editor.scene.toJSON();
var js = sceneToJS();
// paste js.code and run, then:
sceneEqual(snap, editor.scene.toJSON())  // { equal: true, differences: [] }
```

---

## AI scene context

Every AI request receives a compact JS-comment scene description — the format a code model reads most naturally:

```
// [selected] "Human" Mesh BoxGeometry(0.6,1.8,0.5) size(0.6,1.8,0.5) color:#ffcc99 at(0,0.9,0)
// "Ground"   Mesh PlaneGeometry(10,10) size(10,0,10) color:#888888 at(0,0,0) rot(-1.57,0,0rad)
// "Tree"     Group(2 children) at(3,0,-2)
//   "Trunk"  Mesh CylinderGeometry(0.2,0.3,2) size(0.4,2,0.4) color:#8b4513 at(0,1,0) [in:Tree]
//   "Canopy" Mesh ConeGeometry(1,2,8) size(2,2,2) color:#228b22 at(0,3,0) [in:Tree]
// Camera at(0,5,10) looking at(0,0,0)
```

Each line includes:
- **Object name** and **type**
- **Geometry type + key params** (only shape-determining params, not segment counts)
- **`size(w,h,d)`** — actual world-space bounding box (geometry × scale, computed via `Box3`)
- **Material** — color, opacity, metalness, roughness, emissive
- **Transform** — position always; scale and rotation only when non-default
- **Hierarchy** — `[in:ParentName]` for nested objects
- **Selection** — `[selected]` marker

For very large scenes (>1 800 chars) the context falls back to compact JSON capped at 15 objects.

---

## Git integration

Open the **Git** menu to configure a GitHub repository and sync scenes.

### Settings

| Field | Description |
|-------|-------------|
| Repository | Full GitHub URL, e.g. `https://github.com/user/repo` |
| Branch | Target branch (default: `main`) |
| Scene file | Path in repo for the scene JSON (default: `scene.json`) |
| Access token | GitHub PAT with `repo` scope — stored in `localStorage` |

### Load scene

Fetches the scene JSON from the configured repo path, clears the current scene, and loads it. Also sets the diff baseline so the next commit correctly describes what changed.

### Commit scene

1. **AI generates a commit message** based on the diff since the last commit:
   - Added objects, removed objects, modified transforms/materials
   - Falls back to a scene description on the first commit
2. **Message is editable** — pre-filled in the input, user can change anything before committing
3. Commits `editor.toJSON()` (pretty-printed JSON) to the configured path and branch

All GitHub API calls use `fetch()` directly — no Octokit dependency.

> **Token storage & scope**
> The access token is saved in `localStorage` under the key `git-settings`. It persists across browser sessions and is readable by any JavaScript running on the same origin — treat it like a password and never use a token with broader permissions than necessary.
>
> **Prefer a fine-grained, repo-specific PAT** over a classic token with full `repo` scope:
> 1. On GitHub go to **Settings → Developer settings → Personal access tokens → Fine-grained tokens**
> 2. Set **Repository access** to the single repo you are syncing scenes to
> 3. Grant only **Contents: Read and write** — nothing else is needed
>
> A repo-scoped token limits blast radius if the value is ever read from `localStorage` by a browser extension or injected script. Classic `repo`-scope tokens grant write access to every repository in your account and should be avoided here.

---

## Architecture

```
docs/editor/js/
  AIEngine.js         — WebLLM wrapper: init(), stream(), complete()
  AIPrompt.js         — SYSTEM_PROMPT, SCENE_QA_PROMPT, model registry, few-shot examples
  AIUtils.js          — extractCode(), buildMessages(), buildQAMessages(), sceneContextString()
  Shell.js            — REPL UI + single execute() / streamRaw() surface
  Menubar.Git.js      — Git menu: settings, load, commit + diff-aware message generation
  scene/
    summarize.js      — sceneContextString() (JS-comment format), summarizeScene() (JSON),
                        getSize() / getTopY() / getWorldCenter() spatial helpers
    serialize.js      — sceneToJSON(), jsonToObject(), cloneViaJSON()
    codegen.js        — Scene/JSON → executable JS
    geometryParams.js — per-geometry constructor-arg tables
    materialProps.js  — material prop emit maps
    sceneEqual.js     — semantic equality for round-trip tests
  mesh/
    ops/
      index.js        — registerOp(), serializeForAI() (op registry)
      boolean.js      — booleanUnion / booleanSubtract / booleanIntersect (three-bvh-csg)
      mirror.js       — mirrorMesh()
      array.js        — arrayDuplicate()
      subdivide.js    — midpoint subdivision
```

### Design principles

- **One execution surface.** AI and human code run through the same `execute()` binding. No second path.
- **Sovereignty is the product.** Inference is 100 % on-device. This claim must stay ironclad.
- **No build step.** Plain ES modules. No bundler, no transpiler.
- **Everything reversible.** All mutations go through `editor.execute(new Command(…))` — undo stack. No direct `scene.add()`.
- **Open system prompt.** The prompt is public and readable in the client. The moat is integration, not secrecy.

---

## Roadmap

```
✅  Editor fork, static hosting, no build
✅  JS Shell (human REPL + AI bridge, single execution surface)
✅  WebLLM on-device streaming (weights cached in browser)
✅  Qwen2.5-Coder default model + constrained few-shot prompt
✅  Scene summariser — JS-comment format injected into every AI request
✅  World-space bounding box (size) in context — AI can reason about dimensions
✅  Error-feedback retry loop (one auto-correction pass)
✅  Bidirectional scene representation: codegen + round-trip tests
✅  View → Show JS for Selection
✅  SetMaterialColorCommand / SetValueCommand in shell scope
✅  findObject / findAll / findOfType / findNear — name & type lookup
✅  Spatial helpers: getSize / getTopY / getCenter / placeOnTop
✅  Scene Q&A — ? prefix + askScene() for plain-text scene interrogation
✅  Modeling layer M1: boolean CSG (three-bvh-csg) — union / subtract / intersect
✅  Modeling layer M2: mirror, array duplicate, midpoint subdivision
✅  Git menu: Settings / Load scene / Commit scene
✅  AI-generated commit messages with scene diff (added / removed / modified)
⬜  Half-edge EditableMesh + edit mode (M3)
⬜  Vertex / edge / face selection + three-mesh-bvh raycast (M4)
⬜  Core mesh ops: extrude, inset, bevel, loop cut, delete, weld (M5)
⬜  AI selectByCriteria + natural-language mesh editing (M6)
⬜  glTF / OBJ import into editable pipeline (M7)
⬜  UV unwrapping — planar / box projection (M8)
⬜  Merge-conflict viewport (dual-render conflicting object states)
⬜  PWA / WebXR / Electron packaging
```

---

## File structure

```
docs/
  index.html              ← entry point (importmap: three, three-mesh-bvh, three-bvh-csg)
  editor/
    css/main.css
    js/
      AIEngine.js
      AIPrompt.js
      AIUtils.js
      Shell.js
      Menubar.js
      Menubar.Git.js
      Menubar.View.js
      Menubar.File.js
      Menubar.Edit.js
      Menubar.Add.js
      Menubar.Status.js
      scene/
        summarize.js
        serialize.js
        codegen.js
        geometryParams.js
        materialProps.js
        sceneEqual.js
      mesh/
        ops/
          index.js
          boolean.js
          mirror.js
          array.js
          subdivide.js
      commands/           ← standard three.js editor command classes
      libs/               ← ui.js, signals, codemirror, tern
  build/                  ← three.js module builds
  examples/jsm/           ← three.js addons
```
