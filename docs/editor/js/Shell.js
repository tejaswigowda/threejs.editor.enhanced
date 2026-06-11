import { UIPanel } from './libs/ui.js';
import { AddObjectCommand } from './commands/AddObjectCommand.js';
import { RemoveObjectCommand } from './commands/RemoveObjectCommand.js';
import { SetPositionCommand } from './commands/SetPositionCommand.js';
import { SetRotationCommand } from './commands/SetRotationCommand.js';
import { SetScaleCommand } from './commands/SetScaleCommand.js';
import { SetMaterialColorCommand } from './commands/SetMaterialColorCommand.js';
import { SetMaterialCommand } from './commands/SetMaterialCommand.js';
import { SetValueCommand } from './commands/SetValueCommand.js';
import { AI_MODELS, SYSTEM_PROMPT, SCENE_QA_PROMPT, buildSystemPrompt } from './AIPrompt.js';
import { extractCode, buildMessages, buildQAMessages, sceneContextString } from './AIUtils.js';
import { AIEngine, getModelList } from './AIEngine.js';
import { objectToJS, sceneToJS } from './scene/codegen.js';
import { sceneEqual } from './scene/sceneEqual.js';
import { summarizeScene as summarizeSceneFull, getSize, getTopY, getWorldCenter, searchableLabel } from './scene/summarize.js';
import { booleanUnion, booleanSubtract, booleanIntersect } from './mesh/ops/boolean.js';
import { mirrorMesh } from './mesh/ops/mirror.js';
import { arrayDuplicate } from './mesh/ops/array.js';
import { subdivide } from './mesh/ops/subdivide.js';
import { serializeForAI as opsSchema } from './mesh/ops/index.js';
import { EditModeController } from './mesh/EditModeController.js';
import { extrude }     from './mesh/ops/extrude.js';
import { inset }       from './mesh/ops/inset.js';
import { bevel }       from './mesh/ops/bevel.js';
import { deleteFaces } from './mesh/ops/delete.js';
import { weld }        from './mesh/ops/weld.js';
import { planarUV, boxUV } from './mesh/ops/uv.js';
import { SceneIntelligence, findByDescription, describeObject, listCandidates, resolvePartAI } from './intelligence/sceneIndex.js';
import { findParts } from './intelligence/sceneIndex.js';
import { diagnoseImport, diagnosticMessages } from './import/diagnostics.js';
import { labelImportedAsset } from './import/labelPass.js';
import { colorToName } from './intelligence/colorName.js';
import { whatsVisible, whatsAt } from './intelligence/gpuPick.js';
import { snapshotScene, sceneDiff, confirmChange, diffSummary, inspectScene } from './intelligence/observe.js';
import { buildIndex, retrieveForPrompt, findAPI } from './ai/apiIndex.js';
import { validateCode } from './ai/validate.js';
import { runAgentic } from './ai/agentLoop.js';
import { EVAL_PROMPTS, runEval, formatTable, shouldSuggestPower } from './ai/eval.js';

// Map common shape words to the substring found in geometry.type, so findObject
// can resolve "red sphere" even when the object's name carries neither word.
const TYPE_WORDS = {
	sphere: 'sphere', ball: 'sphere',
	box: 'box', cube: 'box',
	cylinder: 'cylinder', tube: 'cylinder',
	cone: 'cone',
	plane: 'plane',
	torus: 'torus', donut: 'torus', ring: 'ring',
	capsule: 'capsule', circle: 'circle',
};



function Shell( editor ) {

	const signals = editor.signals;

	const container = new UIPanel();
	container.setId( 'shell' );
	container.setDisplay( '' );

	// ── Header bar ────────────────────────────────────────────────────────────

	const header = document.createElement( 'div' );
	header.id = 'shell-header';

	const headerTitle = document.createElement( 'span' );
	headerTitle.id = 'shell-header-title';
	headerTitle.textContent = 'JS Shell';

	const modelSelect = document.createElement( 'select' );
	modelSelect.id = 'shell-model-select';

	// Populate from WebLLM's full built-in model registry (same pattern as webllm-eg).
	// Each option shows: model_id -- X.X GB  (or MB for small models)
	function fmtVram( mb ) {

		if ( mb == null ) return '';
		if ( mb >= 1024 ) return '  \u2014  ' + ( mb / 1024 ).toFixed( 1 ) + ' GB';
		return '  \u2014  ' + Math.round( mb ) + ' MB';

	}

	// Keywords that identify code-generation models
	const CODE_KEYWORDS = [ 'coder', 'code', 'deepseek', 'starcoder', 'codellama', 'codestral' ];

	getModelList()
		.filter( m => CODE_KEYWORDS.some( kw => m.model_id.toLowerCase().includes( kw ) ) )
		.forEach( m => {

			const opt = document.createElement( 'option' );
			opt.value = m.model_id;
			opt.textContent = m.model_id + fmtVram( m.vram_required_MB );
			modelSelect.appendChild( opt );

		} );

	// Load external API models (Ollama, OpenAI, Claude) if available
	( async () => {

		try {

			const res = await fetch( '/api/models' );
			const data = await res.json();

			if ( data.models && data.models.length > 0 ) {

				// Add separator for external models
				const webllmCount = modelSelect.options.length;
				if ( webllmCount > 0 ) {

					const sep = document.createElement( 'option' );
					sep.disabled = true;
					sep.textContent = '─── External APIs ───';
					modelSelect.appendChild( sep );

				}

				// Add each external model
				data.models.forEach( m => {

					// Skip WebLLM models (already in dropdown)
					if ( m.source === 'webllm' ) return;

					const opt = document.createElement( 'option' );
					opt.value = m.id;
					opt.dataset.source = m.source;  // Store the source for later
					opt.textContent = m.label;
					modelSelect.appendChild( opt );

				} );

			}

		} catch ( e ) {

			// External API check failed, silently continue with WebLLM only
			console.debug( 'External models not available', e.message );

		}

	} )();

	// Default to a preferred coder model if present in the list
	const PREFERRED = [
		'Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC',
		'Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC',
		'Llama-3.2-1B-Instruct-q4f32_1-MLC',
		'Llama-3.2-1B-Instruct-q4f16_1-MLC',
	];
	for ( const p of PREFERRED ) {

		const found = [ ...modelSelect.options ].find( o => o.value === p );
		if ( found ) { modelSelect.value = p; break; }

	}

	// Restore previously used model (weights already cached in browser)
	const _savedModel = localStorage.getItem( 'shell-ai-model' );
	if ( _savedModel ) modelSelect.value = _savedModel;

	const loadBtn = document.createElement( 'button' );
	loadBtn.id = 'shell-load-btn';
	loadBtn.textContent = 'Load AI';

	const stopBtn = document.createElement( 'button' );
	stopBtn.id = 'shell-stop-btn';
	stopBtn.textContent = '■ Stop AI';
	stopBtn.title = 'Stop the current AI generation';
	stopBtn.style.display = 'none';

	const aiStatus = document.createElement( 'span' );
	aiStatus.id = 'shell-ai-status';

	header.appendChild( headerTitle );
	header.appendChild( modelSelect );
	header.appendChild( loadBtn );
	header.appendChild( stopBtn );
	header.appendChild( aiStatus );
	container.dom.appendChild( header );

	// ── Progress bar (shown during model load) ────────────────────────────────

	const progressWrap = document.createElement( 'div' );
	progressWrap.id = 'shell-progress-wrap';
	progressWrap.style.display = 'none';

	const progressBar = document.createElement( 'div' );
	progressBar.id = 'shell-progress-bar';
	progressWrap.appendChild( progressBar );
	container.dom.appendChild( progressWrap );

	// ── Output area ───────────────────────────────────────────────────────────

	const output = document.createElement( 'div' );
	output.id = 'shell-output';
	container.dom.appendChild( output );

	// ── AI input row ──────────────────────────────────────────────────────────

	const aiRow = document.createElement( 'div' );
	aiRow.id = 'shell-ai-row';

	const aiPromptLabel = document.createElement( 'span' );
	aiPromptLabel.className = 'shell-prompt shell-ai-label';
	aiPromptLabel.textContent = 'AI';

	const aiInput = document.createElement( 'input' );
	aiInput.id = 'shell-ai-input';
	aiInput.type = 'text';
	aiInput.spellcheck = false;
	aiInput.autocomplete = 'off';
	aiInput.placeholder = 'Describe what to do… (Enter) — load AI model first';
	aiInput.disabled = true;

	aiRow.appendChild( aiPromptLabel );
	aiRow.appendChild( aiInput );
	container.dom.appendChild( aiRow );

	// ── JS input row ──────────────────────────────────────────────────────────

	const inputRow = document.createElement( 'div' );
	inputRow.id = 'shell-input-row';

	const prompt = document.createElement( 'span' );
	prompt.className = 'shell-prompt';
	prompt.textContent = '> ';

	const input = document.createElement( 'textarea' );
	input.id = 'shell-input';
	input.spellcheck = false;
	input.autocomplete = 'off';
	input.rows = 1;
	input.placeholder = 'Enter JS — Shift+Enter for newline, ↑↓ for history';

	inputRow.appendChild( prompt );
	inputRow.appendChild( input );
	container.dom.appendChild( inputRow );

	// ── State ─────────────────────────────────────────────────────────────────

	const history = [];
	let historyIndex = - 1;
	let savedInput = '';

	// Set true when the user clicks "Stop AI"; checked by the agentic loop so it
	// halts after the current (interrupted) generation rather than retrying.
	let aiAborted = false;

	const aiEngine = new AIEngine();

	// Expose on editor so other modules (e.g. Menubar.Git) can use the loaded engine
	editor.aiEngine = aiEngine;

	// Edit Mode controller — shared across toolbar, shell, and AI
	editor.editModeController = new EditModeController( editor );

	// Scene intelligence — derives descriptors on import, resolves NL part queries
	editor.sceneIntelligence = new SceneIntelligence( editor );

	// Route asset-import pipeline messages (normalize / diagnose / label) to the shell.
	editor.importLog = ( msg ) => appendOutput( msg, 'info' );

	// Build the local API index (Technique 2 RAG) so generation references real signatures
	buildIndex();

	// ── Helpers ───────────────────────────────────────────────────────────────

	function appendOutput( text, type ) {

		const line = document.createElement( 'div' );
		line.className = 'shell-line shell-' + type;
		line.innerHTML = String( text )
			.replace( /&/g, '&amp;' )
			.replace( /</g, '&lt;' )
			.replace( />/g, '&gt;' )
			.replace( /\n/g, '<br>' );

		// Click copies the raw text to clipboard
		line.addEventListener( 'click', function () {

			navigator.clipboard.writeText( text ).then( function () {

				line.classList.add( 'shell-copied' );
				setTimeout( () => line.classList.remove( 'shell-copied' ), 600 );

			} );

		} );

		output.appendChild( line );
		output.scrollTop = output.scrollHeight;

	}

	function formatValue( val ) {

		if ( val === null ) return 'null';
		if ( val === undefined ) return 'undefined';
		if ( typeof val === 'function' ) return val.toString().split( '\n' )[ 0 ] + ' … }';
		if ( typeof val === 'object' ) {

			try { return JSON.stringify( val, null, 2 ); } catch { return String( val ); }

		}
		return String( val );

	}

	// ── Single execution surface ──────────────────────────────────────────────
	// Both human keystrokes and AI output call this function.
	// Binding: new Function('__s__','__c__','with(__s__){return eval(__c__)}')(scope, code)

	function execute( code ) {

		code = code.trim();
		if ( ! code ) return;

		history.unshift( code );
		if ( history.length > 500 ) history.pop();
		historyIndex = - 1;
		savedInput = '';

		appendOutput( '> ' + code, 'cmd' );

		try {

			// Scope vars become named parameters of a new Function; direct eval()
			// inside that function reliably sees all parameters as local variables.
			const scope = {
				editor,
				THREE:   window.THREE,
				get scene()    { return editor.scene; },
				get camera()   { return editor.camera; },
				get renderer() { return editor.renderer; },
				AddObjectCommand,
				RemoveObjectCommand,
				SetPositionCommand,
				SetRotationCommand,
				SetScaleCommand,
				SetMaterialColorCommand,
				SetMaterialCommand,
				SetValueCommand,
				// three.js primitives — available without THREE. prefix
				BoxGeometry:          window.THREE.BoxGeometry,
				SphereGeometry:       window.THREE.SphereGeometry,
				CylinderGeometry:     window.THREE.CylinderGeometry,
				ConeGeometry:         window.THREE.ConeGeometry,
				PlaneGeometry:        window.THREE.PlaneGeometry,
				TorusGeometry:        window.THREE.TorusGeometry,
				TorusKnotGeometry:    window.THREE.TorusKnotGeometry,
				CircleGeometry:       window.THREE.CircleGeometry,
				MeshStandardMaterial: window.THREE.MeshStandardMaterial,
				MeshBasicMaterial:    window.THREE.MeshBasicMaterial,
				MeshPhongMaterial:    window.THREE.MeshPhongMaterial,
				MeshLambertMaterial:  window.THREE.MeshLambertMaterial,
				LineBasicMaterial:    window.THREE.LineBasicMaterial,
				Mesh:                 window.THREE.Mesh,
				Group:                window.THREE.Group,
				Line:                 window.THREE.Line,
				Points:               window.THREE.Points,
				DirectionalLight:     window.THREE.DirectionalLight,
				PointLight:           window.THREE.PointLight,
				AmbientLight:         window.THREE.AmbientLight,
				SpotLight:            window.THREE.SpotLight,
				Color:                window.THREE.Color,
				Vector3:              window.THREE.Vector3,
				Vector2:              window.THREE.Vector2,
				Euler:                window.THREE.Euler,

				// ── Extended geometry ──────────────────────────────────────────────────
				LatheGeometry:        window.THREE.LatheGeometry,
				TubeGeometry:         window.THREE.TubeGeometry,
				CapsuleGeometry:      window.THREE.CapsuleGeometry,
				ExtrudeGeometry:      window.THREE.ExtrudeGeometry,
				ShapeGeometry:        window.THREE.ShapeGeometry,
				Shape:                window.THREE.Shape,
				Path:                 window.THREE.Path,
				CatmullRomCurve3:     window.THREE.CatmullRomCurve3,
				QuadraticBezierCurve3: window.THREE.QuadraticBezierCurve3,
				CubicBezierCurve3:    window.THREE.CubicBezierCurve3,

				// ── PBR materials ──────────────────────────────────────────────────────
				MeshPhysicalMaterial: window.THREE.MeshPhysicalMaterial,

				// ── Procedural texture helpers ─────────────────────────────────────────
				// makeTexture(fn, size) — fn(ctx, size) draws on a 2D canvas; returns CanvasTexture
				makeTexture: ( fn, size = 256 ) => {

					const c = document.createElement( 'canvas' );
					c.width = c.height = size;
					fn( c.getContext( '2d' ), size );
					const tex = new window.THREE.CanvasTexture( c );
					tex.wrapS = tex.wrapT = window.THREE.RepeatWrapping;
					return tex;

				},

				// makeCheckerTex(size, dark, light, tiles) — checker board texture
				// color args accept 0xRRGGBB numbers or CSS strings
				makeCheckerTex: ( size = 256, dark = 0x111111, light = 0xeeeeee, tiles = 8 ) => {

					const toCSS = v => typeof v === 'number' ? '#' + v.toString( 16 ).padStart( 6, '0' ) : v;
					const c = document.createElement( 'canvas' );
					c.width = c.height = size;
					const ctx = c.getContext( '2d' );
					const s = size / tiles;

					for ( let y = 0; y < tiles; y ++ ) {

						for ( let x = 0; x < tiles; x ++ ) {

							ctx.fillStyle = ( x + y ) % 2 === 0 ? toCSS( dark ) : toCSS( light );
							ctx.fillRect( x * s, y * s, s, s );

						}

					}

					const tex = new window.THREE.CanvasTexture( c );
					tex.wrapS = tex.wrapT = window.THREE.RepeatWrapping;
					return tex;

				},

				// makeGridTex(size, lineColor, divisions, bgColor) — grid lines texture
				makeGridTex: ( size = 256, lineColor = 0xffffff, divisions = 8, bgColor = 0x111111 ) => {

					const toCSS = v => typeof v === 'number' ? '#' + v.toString( 16 ).padStart( 6, '0' ) : v;
					const c = document.createElement( 'canvas' );
					c.width = c.height = size;
					const ctx = c.getContext( '2d' );
					ctx.fillStyle = toCSS( bgColor );
					ctx.fillRect( 0, 0, size, size );
					ctx.strokeStyle = toCSS( lineColor );
					ctx.lineWidth = 1;
					const step = size / divisions;

					for ( let i = 0; i <= divisions; i ++ ) {

						ctx.beginPath(); ctx.moveTo( i * step, 0 );      ctx.lineTo( i * step, size ); ctx.stroke();
						ctx.beginPath(); ctx.moveTo( 0,         i * step ); ctx.lineTo( size,    i * step ); ctx.stroke();

					}

					const tex = new window.THREE.CanvasTexture( c );
					tex.wrapS = tex.wrapT = window.THREE.RepeatWrapping;
					return tex;

				},

				// ── Codegen / round-trip helpers ───────────────────────────────────────
				// showJS()  — generate + print JS for the selected object (or full scene)
				showJS: function ( target ) {

					const obj = target ?? editor.selected;

					if ( ! obj ) {

						const result = sceneToJS( editor );
						appendOutput( result.code, 'result' );
						if ( result.lossy ) appendOutput( '⚠ Lossy fallback used: ' + result.lossyReasons.join( '; ' ), 'error' );
						return result;

					}

					const result = objectToJS( obj );
					appendOutput( result.code, 'result' );
					if ( result.lossy ) appendOutput( '⚠ Lossy fallback used: ' + result.lossyReasons.join( '; ' ), 'error' );
					return result;

				},
				objectToJS,
				sceneToJS:  () => sceneToJS( editor ),
				sceneEqual,
				summarize:  () => summarizeSceneFull( editor ),

				// ── Scene object lookup ────────────────────────────────────────────────
				// findObject(query) — best-matching object, scored across NAME, material
				// COLOR, and geometry TYPE in one pass. So "green cube" picks the right
				// cube AND "red sphere" resolves even when the name carries neither word
				// (color is on the material, shape is in geometry.type).
				// Weights: exact name ≫ whole-phrase name > geometry type > color > name word.
				findObject: function ( query ) {

					if ( ! query ) return editor.selected;
					const q = String( query ).toLowerCase().trim();
					const words = q.split( /\s+/ ).filter( Boolean );

					let exact = null;
					let best = null, bestScore = 0;

					editor.scene.traverse( function ( obj ) {

						// Decoded node name + material name(s) — matches GLB parts whose
						// only meaningful label is the material ("Tail Light" on "Object_12").
						const name = searchableLabel( obj );
						let score = 0;

						if ( name ) {

							if ( ! exact && name === q ) exact = obj;
							if ( name.includes( q ) ) score += 100 + q.length;   // whole phrase
							else for ( const w of words ) if ( name.includes( w ) ) score += 8;

						}

						if ( obj.isMesh ) {

							// Geometry type ("sphere" → SphereGeometry)
							const gtype = ( obj.geometry && obj.geometry.type || '' ).toLowerCase();
							for ( const w of words ) {

								const hint = TYPE_WORDS[ w ];
								if ( hint && gtype.includes( hint ) ) score += 12;

							}

							// Material color name ("red" → red material)
							const mat = Array.isArray( obj.material ) ? obj.material[ 0 ] : obj.material;
							if ( mat && mat.color ) {

								const base = colorToName( mat.color ).base;
								for ( const w of words ) {

									if ( w === base || ( w === 'grey' && base === 'gray' ) ) score += 6;

								}

							}

						}

						if ( score > bestScore ) { bestScore = score; best = obj; }

					} );

					return exact || ( bestScore > 0 ? best : null );

				},

				// findAll(query) — every object whose name contains query
				findAll: function ( query ) {

					const q   = String( query ).toLowerCase().trim();
					const out = [];

					editor.scene.traverse( function ( obj ) {

						if ( ( obj.name || '' ).toLowerCase().includes( q ) ) out.push( obj );

					} );

					return out;

				},

				// findOfType(type) — first object of a given three.js type string
				// e.g. findOfType('Mesh'), findOfType('DirectionalLight'), findOfType('Group')
				findOfType: function ( type ) {

					const t = String( type ).toLowerCase();
					let found = null;

					editor.scene.traverse( function ( obj ) {

						if ( ! found && obj.type.toLowerCase() === t ) found = obj;

					} );

					return found;

				},

				// findNear(mesh, radius) — all scene objects within radius of mesh's world position
				findNear: function ( mesh, radius ) {

					if ( ! mesh || ! mesh.position ) throw new Error( 'findNear: first arg must be an Object3D' );
					const r2 = radius * radius;
					const out = [];

					editor.scene.traverse( function ( obj ) {

						if ( obj === mesh ) return;
						if ( obj.position.distanceToSquared( mesh.position ) <= r2 ) out.push( obj );

					} );

					return out;

				},

				// ── Scene intelligence — natural-language part resolution ─────────────
				// Deterministic geometry+color+symmetry descriptors; ambiguous cases
				// can be disambiguated by the loaded LLM via resolvePartAI (async).

				// findByDescription(text) — best node for a NL part reference (sync, free).
				// Returns the node directly when confident, else logs candidates and
				// returns the top node (check .userData for confidence via describeObject).
				findByDescription: function ( text ) {

					const r = findByDescription( editor, text );

					if ( r.labeling ) { appendOutput( '🏷 No part labels yet — labeling this asset now. Re-run your command in a few seconds.', 'info' ); return null; }
					if ( r.method === 'merged' ) { appendOutput( 'ℹ ' + r.message, 'info' ); return null; }
					if ( r.method === 'none' )   { appendOutput( 'ℹ No node matched: "' + text + '"', 'info' ); return null; }

					if ( r.method === 'ambiguous' ) {

						appendOutput( '⚠ Ambiguous — candidates: ' + r.candidates.map( c => ( c.node.name || c.node.uuid.slice( 0, 6 ) ) + ' (' + c.reasons.join( '+' ) + ')' ).join( ', ' ), 'info' );

					}

					return r.node;

				},

				// describeObject(node) — derived descriptor bundle (region/shape/color/pair)
				describeObject: ( node ) => describeObject( editor, node ?? editor.selected ),

				// listCandidates(text) — ranked candidates [{node, score, reasons}]
				listCandidates: ( text ) => listCandidates( editor, text ),

				// resolvePartAI(text) — async Path A + LLM disambiguation → {node, confidence, method}
				resolvePartAI: ( text ) => resolvePartAI( editor, text ),

				// findParts(text) — PLURAL part resolution → ARRAY of meshes for a
				// subset of an imported asset ("the wheels"). Use this to edit only the
				// named parts instead of traversing/recoloring the whole object.
				findParts: function ( text ) {

					const r = findParts( editor, text );
					if ( r.labeling ) { appendOutput( '🏷 No part labels yet — labeling this asset now. Re-run your command in a few seconds.', 'info' ); return []; }
					if ( r.method === 'merged' ) { appendOutput( 'ℹ ' + r.message, 'info' ); return []; }
					if ( r.nodes.length === 0 ) { appendOutput( 'ℹ No parts matched: "' + text + '"', 'info' ); return []; }
					if ( r.method === 'descriptors' && r.ambiguous ) { appendOutput( '⚠ No labels for this asset — best-guessing one part for "' + text + '".', 'info' ); }
					return r.nodes;

				},

				// diagnoseImport(obj) — structural facts about an imported asset
				// (merged-mesh? opaque names? textured?), with safe user-facing notes.
				diagnoseImport: function ( obj ) {

					const root = obj ?? editor.selected;
					if ( ! root ) { appendOutput( 'ℹ Select or pass an imported object.', 'info' ); return null; }
					const d = diagnoseImport( root );
					for ( const m of diagnosticMessages( d, root.name || 'asset' ) ) appendOutput( 'ℹ ' + m, 'info' );
					return d;

				},

				// relabelAsset(obj) — re-run the LLM labeling pass (Stage 4) on demand.
				relabelAsset: ( obj ) => labelImportedAsset( editor, obj ?? editor.selected, { force: true } ),

				// ── Agentic grounding tools (no vision model) ─────────────────────────
				// findAPI(text) — retrieve REAL API signatures (anti-hallucination)
				findAPI: ( text ) => findAPI( text ).map( h => h.sig ).join( '\n' ),
				// whatsVisible() — GPU color-pick: on-screen objects by coverage
				whatsVisible: () => whatsVisible( editor ),
				// whatsAt(x,y) — GPU color-pick: object under a viewport pixel
				whatsAt: ( x, y ) => whatsAt( editor, x, y ),

				// ── Modeling ops (M1/M2) — same surface for UI and AI ─────────────────
				// Closures capture `editor` so the AI can call them without it.

				booleanUnion:     ( meshA, meshB, keepInputs )            => booleanUnion( editor, meshA, meshB, keepInputs ),
				booleanSubtract:  ( meshA, meshB, keepInputs )            => booleanSubtract( editor, meshA, meshB, keepInputs ),
				booleanIntersect: ( meshA, meshB, keepInputs )            => booleanIntersect( editor, meshA, meshB, keepInputs ),
				mirrorMesh:       ( mesh, axis )                          => mirrorMesh( editor, mesh, axis ),
				arrayDuplicate:   ( mesh, count, ox, oy, oz )             => arrayDuplicate( editor, mesh, count, ox, oy, oz ),
				subdivide:        ( mesh, iterations )                    => subdivide( editor, mesh, iterations ),

				// Diagnostic: print the registered op schema
				listOps: () => opsSchema(),

				// ── Edit Mode ops ────────────────────────────────────────────────────
				// Enter Edit Mode: Tab key, or enterEditMode(). Exit: Tab or exitEditMode().
				// Keys: 1=vertex 2=edge 3=face  A=select all/none

				enterEditMode: ( mesh ) => editor.editModeController.enter( mesh ?? editor.selected ),
				exitEditMode:  ()       => editor.editModeController.exit(),

				extrude:     ( distance = 1 )    => editor.editModeController.runOp( ( em, sel ) => extrude( em, sel, { distance } ),    'extrude',     { distance } ),
				inset:       ( amount = 0.2 )    => editor.editModeController.runOp( ( em, sel ) => inset( em, sel, { amount } ),       'inset',       { amount } ),
				bevel:       ( amount = 0.1 )    => editor.editModeController.runOp( ( em, sel ) => bevel( em, sel, { amount } ),       'bevel',       { amount } ),
				deleteFaces: ()                  => editor.editModeController.runOp( ( em, sel ) => deleteFaces( em, sel ),              'deleteFaces', {} ),
				weld:        ( threshold = 0.01 )=> editor.editModeController.runOp( ( em, sel ) => weld( em, sel, { threshold } ),     'weld',        { threshold } ),
				planarUV:    ( axis = 'y' )      => editor.editModeController.runOp( ( em, sel ) => planarUV( em, sel, axis ),          'planarUV',    { axis } ),
				boxUV:       ()                  => editor.editModeController.runOp( ( em, sel ) => boxUV( em, sel ),                   'boxUV',       {} ),

				// ── Selection helpers (used directly and in recipe-replayed code) ────────
				selectFaces:    ( ...ids ) => { const emc = editor.editModeController; if ( emc.active ) { emc.selection.setMode( 'face' ); ids.forEach( id => emc.selection.add( id ) ); emc.updateOverlay(); } },
				selectVertices: ( ...ids ) => { const emc = editor.editModeController; if ( emc.active ) { emc.selection.setMode( 'vertex' ); ids.forEach( id => emc.selection.add( id ) ); emc.updateOverlay(); } },
				selectEdges:    ( ...ids ) => { const emc = editor.editModeController; if ( emc.active ) { emc.selection.setMode( 'edge' ); ids.forEach( id => emc.selection.add( id ) ); emc.updateOverlay(); } },
				clearSelection: ()         => { const emc = editor.editModeController; if ( emc.active ) { emc.selection.clear(); emc.updateOverlay(); } },

				// ── Selection criteria (M6) ──────────────────────────────────────────────
				// Programmatic selection for AI-driven modeling
				selectTopFaces: ( count = 1 ) => {
					const emc = editor.editModeController;
					if ( ! emc.active ) return;
					emc.selection.setMode( 'face' );
					emc.selection.clear();
					const em = emc.em;
					const faces = em.faces.filter( f => f ).map( f => ( {
						id: f.id,
						centerY: em.faceCenter( f.id ).y,
					} ) ).sort( ( a, b ) => b.centerY - a.centerY ).slice( 0, count );
					faces.forEach( f => emc.selection.add( f.id ) );
					emc.updateOverlay();
				},
				selectFacingUp: ( threshold = 0.1 ) => {
					const emc = editor.editModeController;
					if ( ! emc.active ) return;
					emc.selection.setMode( 'face' );
					emc.selection.clear();
					const em = emc.em;
					em.faces.forEach( f => {
						if ( f ) {
							const n = em.faceNormal( f.id );
							if ( n.y >= threshold ) emc.selection.add( f.id );
						}
					} );
					emc.updateOverlay();
				},
				selectBoundaryEdges: () => {
					const emc = editor.editModeController;
					if ( ! emc.active ) return;
					emc.selection.setMode( 'edge' );
					emc.selection.clear();
					const em = emc.em;
					em.halfEdges.forEach( he => {
						if ( he.twin === - 1 ) emc.selection.add( Math.min( he.id, he.id ) );
					} );
					emc.updateOverlay();
				},

				// ── Spatial helpers ───────────────────────────────────────────────────
				// These are the correct way to reason about world-space dimensions;
				// reading raw geometry params ignores scale transforms.

				// {x,y,z} world-space bounding box size of any Object3D
				getSize: ( obj ) => getSize( obj ),

				// Y coordinate of the top face in world space — use for "place on top of"
				getTopY: ( obj ) => getTopY( obj ),

				// World-space center point of an Object3D's bounding box
				getCenter: ( obj ) => getWorldCenter( obj ),

				// Move `child` so it rests on top of `target` (no overlap)
				placeOnTop: function ( child, target ) {

					if ( ! child || ! target ) throw new Error( 'placeOnTop: two Object3D args required' );
					const halfH   = getSize( child ).y / 2;
					const topY    = getTopY( target );
					child.position.y = topY + halfH;

				},

				// lineFromPoints(points, color) → a Line through the given points.
				// Hides the BufferGeometry/LineBasicMaterial plumbing (neither is a
				// shell global) so nets / wires / paths have one blessed, working path.
				// points: array of Vector3 or [x,y,z] triples. Returns the Line (unadded).
				lineFromPoints: function ( points, color = 0xffffff ) {

					const T = window.THREE;
					const pts = ( points || [] ).map( p => p && p.isVector3 ? p : new T.Vector3( p[ 0 ], p[ 1 ], p[ 2 ] ) );
					if ( pts.length < 2 ) throw new Error( 'lineFromPoints: need at least 2 points' );
					const geom = new T.BufferGeometry().setFromPoints( pts );
					return new T.Line( geom, new T.LineBasicMaterial( { color } ) );

				},

				// makeTable(opts) → a complete, legged table Group (top + 4 corner legs),
				// correctly proportioned. Returns the Group (unadded) — add it with
				// AddObjectCommand. Hand-building furniture keeps dropping the legs; this
				// is the blessed path. opts: { position:[x,y,z]|Vector3, width=3, depth=2,
				// height=0.75, topColor, legColor, name }.
				makeTable: function ( opts = {} ) {

					const T = window.THREE;
					const w = opts.width ?? 3, d = opts.depth ?? 2, h = opts.height ?? 0.75;
					const topT = 0.1, legW = 0.1;
					const group = new T.Group();
					group.name = opts.name ?? 'Table';

					const topMat = new T.MeshStandardMaterial( { color: opts.topColor ?? 0x654321, roughness: 0.7, metalness: 0 } );
					const legMat = new T.MeshStandardMaterial( { color: opts.legColor ?? 0x3d2817, roughness: 0.8, metalness: 0 } );

					const top = new T.Mesh( new T.BoxGeometry( w, topT, d ), topMat );
					top.position.set( 0, h - topT / 2, 0 );
					top.name = 'Top';
					group.add( top );

					const legH = h - topT, lx = w / 2 - legW, lz = d / 2 - legW;
					[ [ - lx, - lz ], [ lx, - lz ], [ - lx, lz ], [ lx, lz ] ].forEach( ( c, i ) => {

						const leg = new T.Mesh( new T.BoxGeometry( legW, legH, legW ), legMat );
						leg.position.set( c[ 0 ], legH / 2, c[ 1 ] );
						leg.name = 'Leg ' + ( i + 1 );
						group.add( leg );

					} );

					if ( opts.position ) {

						if ( opts.position.isVector3 ) group.position.copy( opts.position );
						else group.position.set( opts.position[ 0 ], opts.position[ 1 ] ?? 0, opts.position[ 2 ] );

					}
					return group;

				},

				// makeChair(opts) → a COMPLETE chair Group (seat + 4 legs + backrest),
				// correctly proportioned and ORIENTED. Building chairs by hand repeatedly
				// drops the legs and faces the backrest the wrong way for half the seats;
				// this is the blessed, correct-by-construction path. Returns the Group
				// (unadded). opts: { position:[x,y,z]|Vector3, faceToward:[x,z]|Vector3,
				// rotationY, seatColor, legColor, scale, name }.
				// The chair faces +Z by convention (backrest at -Z, behind the occupant).
				// Pass faceToward the TABLE CENTER and it auto-rotates to face it, putting
				// the backrest on the far side — so chairs on opposite sides both face in.
				makeChair: function ( opts = {} ) {

					const T = window.THREE;
					const s = opts.scale ?? 1;
					const group = new T.Group();
					group.name = opts.name ?? 'Chair';

					const seatMat = new T.MeshStandardMaterial( { color: opts.seatColor ?? 0x8B4513, roughness: 0.7, metalness: 0 } );
					const legMat  = new T.MeshStandardMaterial( { color: opts.legColor ?? 0x654321, roughness: 0.8, metalness: 0 } );

					const seatW = 0.5 * s, seatD = 0.5 * s, seatT = 0.08 * s;
					const legH = 0.45 * s, legW = 0.06 * s;
					const backH = 0.5 * s, backT = 0.06 * s;

					const seat = new T.Mesh( new T.BoxGeometry( seatW, seatT, seatD ), seatMat );
					seat.position.set( 0, legH + seatT / 2, 0 );
					seat.name = 'Seat';
					group.add( seat );

					const lx = seatW / 2 - legW / 2, lz = seatD / 2 - legW / 2;
					[ [ - lx, - lz ], [ lx, - lz ], [ - lx, lz ], [ lx, lz ] ].forEach( ( c, i ) => {

						const leg = new T.Mesh( new T.BoxGeometry( legW, legH, legW ), legMat );
						leg.position.set( c[ 0 ], legH / 2, c[ 1 ] );
						leg.name = 'Leg ' + ( i + 1 );
						group.add( leg );

					} );

					// Backrest behind the occupant (at -Z), rising above the seat.
					const back = new T.Mesh( new T.BoxGeometry( seatW, backH, backT ), seatMat );
					back.position.set( 0, legH + seatT + backH / 2, - seatD / 2 + backT / 2 );
					back.name = 'Backrest';
					group.add( back );

					if ( opts.position ) {

						if ( opts.position.isVector3 ) group.position.copy( opts.position );
						else group.position.set( opts.position[ 0 ], opts.position[ 1 ] ?? 0, opts.position[ 2 ] );

					}

					// Orientation: face a target (backrest away from it) or an explicit angle.
					if ( opts.faceToward ) {

						const ft = opts.faceToward;
						const tx = ft.isVector3 ? ft.x : ft[ 0 ];
						const tz = ft.isVector3 ? ft.z : ft[ ft.length === 2 ? 1 : 2 ];
						// local +Z → (sin ry, 0, cos ry); aim it from the chair toward the target.
						group.rotation.y = Math.atan2( tx - group.position.x, tz - group.position.z );

					} else if ( opts.rotationY !== undefined ) {

						group.rotation.y = opts.rotationY;

					}
					return group;

				},

				// ── Third-party API ───────────────────────────────────────────────────
				// fetchAPI(url, options?) — call any HTTP API from the console and get
				// the parsed body back (JSON → object, else text). A plain-object body
				// is auto-JSON-encoded. `await` it:
				//   const d = await fetchAPI('https://api.example.com/items');
				//   await fetchAPI(url, { method:'POST', headers:{Authorization:'Bearer …'}, body:{x:1} });
				// NOTE: this reaches the network — data leaves the device, and the target
				// must allow CORS. (The editor is otherwise fully on-device.)
				fetchAPI: async function ( url, options = {} ) {

					const opts = { ...options };
					if ( opts.body && typeof opts.body === 'object' && ! ( opts.body instanceof FormData ) ) {

						opts.headers = { 'Content-Type': 'application/json', ...( opts.headers || {} ) };
						opts.body = JSON.stringify( opts.body );

					}
					const res = await fetch( url, opts );
					if ( ! res.ok ) throw new Error( `fetchAPI: ${ res.status } ${ res.statusText } — ${ url }` );
					const ct = res.headers.get( 'content-type' ) || '';
					return ct.includes( 'json' ) ? res.json() : res.text();

				},

				// ── Scene Q&A ─────────────────────────────────────────────────────────
				// askScene(question) — ask the AI a natural-language question about the
				// scene. Answer streams into the shell as text; nothing is executed.
				askScene: function ( question ) {

				if ( ! aiEngine.ready ) {

					appendOutput( 'AI not loaded — click "Load AI" first.', 'error' );
					return;

				}

				const messages = buildQAMessages( SCENE_QA_PROMPT, editor, String( question ) );
				appendOutput( '? ' + question, 'ai-prompt' );

				const streamDiv = document.createElement( 'div' );
				streamDiv.className = 'shell-line shell-ai-stream';
				output.appendChild( streamDiv );

				aiEngine.stream( messages, {
					maxTokens: 300,
					temperature: 0.2,
					onToken: ( _delta, full ) => {

						streamDiv.textContent = full + ' ▌';
						output.scrollTop = output.scrollHeight;

					},
				} ).then( answer => {

					streamDiv.remove();
					appendOutput( answer, 'result' );

				} ).catch( err => {

					streamDiv.remove();
					appendOutput( 'Q&A error: ' + err.message, 'error' );

				} );

				},

				// ── Get available models ──────────────────────────────────────────────
				// getAvailableModels() — fetch list of available models (WebLLM + APIs)
				getAvailableModels: async function () {

					try {

						const res = await fetch( '/api/models' );
						const data = await res.json();
						console.table( data.models.map( m => ( {
							id: m.id,
							label: m.label,
							source: m.source,
							vram: m.vram_required_MB ? `${ m.vram_required_MB }MB` : 'N/A'
						} ) ) );
						return data;

					} catch ( e ) {

						appendOutput( 'Error fetching models: ' + e.message, 'error' );
						return null;

					}

				},

				// ── Ask external model ────────────────────────────────────────────────
				// askExternal(model, question) — ask an external API (Ollama, OpenAI, Claude)
				askExternal: async function ( model, question ) {

					try {

						const messages = [ { role: 'user', content: question } ];
						const res = await fetch( '/api/chat', {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify( { model, messages, temperature: 0.7, max_tokens: 2000 } )
						} );
						const data = await res.json();

						// Handle both Ollama and OpenAI response formats
						const answer = data.message?.content || data.choices?.[ 0 ]?.message?.content || data.error;
						appendOutput( answer || 'No response', answer ? 'output' : 'error' );
						return answer;

					} catch ( e ) {

						appendOutput( 'Error querying model: ' + e.message, 'error' );
						return null;

					}

				},

				// ── Check API health ──────────────────────────────────────────────────
				// checkApiHealth() — verify external services are running
				checkApiHealth: async function () {

					try {

						const res = await fetch( '/api/health' );
						const health = await res.json();
						console.log( '🔍 API Health:', health );
						return health;

					} catch ( e ) {

						appendOutput( 'API health check failed: ' + e.message, 'error' );
						return null;

					}

				},

				// ── Eval harness ──────────────────────────────────────────────────────
				// evalAI([prompts]) — run the standing eval set through the agentic
				// loop and print a 3-axis (structure/spatial/semantic) pass/fail table.
				evalAI: function ( prompts ) { return evalAI( prompts ); },

			};

			// Build a named-parameter function so every scope var is a local;
			// eval() inside such a function reliably sees those locals.
			// eslint-disable-next-line no-new-func
			const __keys = Object.keys( scope );
			const __vals = __keys.map( k => scope[ k ] );
			const __fn   = new Function( ...__keys, '__shell_src__', 'return eval(__shell_src__)' );
			const result = __fn.call( null, ...__vals, code );

			if ( result !== undefined ) {

				appendOutput( formatValue( result ), 'result' );

			}

		} catch ( err ) {

			appendOutput( err.toString(), 'error' );
			return { ok: false, error: err.toString() };

		}

		return { ok: true };

	}

	// ── AI execution — calls execute() directly (identical binding) ───────────

	// Stream AI tokens into a live output div. Returns raw full text.
	async function streamRaw( messages ) {

		const streamDiv = document.createElement( 'div' );
		streamDiv.className = 'shell-line shell-ai-stream';
		output.appendChild( streamDiv );

		const fullText = await aiEngine.stream( messages, {
			onToken: ( _delta, full ) => {
				streamDiv.textContent = full + ' ▌';
				output.scrollTop = output.scrollHeight;
			},
		} );

		streamDiv.remove();
		return fullText;

	}

	// Stream and extract code block (for code-gen path).
	async function streamToOutput( messages ) {

		return extractCode( await streamRaw( messages ) );

	}

	async function runAI( userPrompt ) {

		// REPL helpers accidentally typed into the AI box → route to the JS surface
		// rather than asking the model to "build" the literal text (e.g. evalAI()).
		if ( /^\s*evalAI\s*\(/.test( userPrompt ) ) { evalAI(); return; }

		if ( ! aiEngine.ready ) {

			appendOutput( 'AI not loaded — click "Load AI" first.', 'error' );
			return;

		}

		const isQA = userPrompt.startsWith( '?' );
		const question = isQA ? userPrompt.slice( 1 ).trim() : userPrompt;

		appendOutput( ( isQA ? '? ' : '(AI) ' ) + question, 'ai-prompt' );
		aiStatus.textContent = 'thinking…';
		aiInput.disabled = true;
		aiAborted = false;
		stopBtn.disabled = false;
		stopBtn.style.display = '';

		try {

			if ( isQA ) {

				// Q&A mode — stream plain-text answer, do not execute
				const messages = buildQAMessages( SCENE_QA_PROMPT, editor, question );
				const answer   = await streamRaw( messages );
				appendOutput( answer, 'result' );
				if ( aiAborted ) appendOutput( '■ Stopped by user.', 'info' );

			} else {

				// Code-gen mode — bounded agentic loop:
				// generate → validate (real API index) → execute → observe → fix.
				const apiHints = retrieveForPrompt( question );
				const systemPrompt = buildSystemPrompt( opsSchema() );
				const messages = buildMessages( systemPrompt, editor, question, apiHints );

				const beforeMeshes = new Set();
				editor.scene.traverse( o => { if ( o.isMesh ) beforeMeshes.add( o.uuid ); } );

				const res = await runAgentic( {
					editor,
					messages,
					intent: question,
					maxRetries: 3,
					shouldAbort:   () => aiAborted,
					tokenBudget:   aiTokenBudget(),
					deps: {
						streamCode:    streamToOutput,
						execute,
						appendOutput,
						validateCode,
						snapshotScene,
						sceneDiff,
						confirmChange,
						diffSummary,
						inspectScene,
						historyLen: () => editor.history.undos.length,
						rollbackTo: ( len ) => { while ( editor.history.undos.length > len ) editor.history.undo(); },
					},
				} );

				// D1 — compositional ceiling: a complex real-world object that came
				// back as a single primitive likely needs the Power tier's world
				// knowledge. Surface a hint (don't force-escalate). This is a
				// GENERATION under-decomposition heuristic ONLY: suppress it on EDITS
				// (nothing was BUILT — e.g. recoloring the dumptruck's parts adds 0
				// meshes), where "only one shape was built" is nonsense and the real
				// issue is part RESOLUTION, not decomposition.
				if ( res && res.ok && ! aiAborted ) {

					let addedMeshes = 0;
					editor.scene.traverse( o => { if ( o.isMesh && ! beforeMeshes.has( o.uuid ) ) addedMeshes ++; } );
					if ( addedMeshes >= 1 && shouldSuggestPower( question, addedMeshes, isPowerModel() ) ) {

						appendOutput( '💡 This looks like a multi-part object but only one shape was built. Try the "Power" model (7B) for richer decomposition.', 'info' );

					}

				}

			}

		} catch ( err ) {

			appendOutput( 'AI error: ' + err.message, 'error' );

		} finally {

			aiStatus.textContent = aiAborted ? 'stopped' : 'ready';
			stopBtn.style.display = 'none';
			aiInput.disabled = false;
			aiInput.focus();

		}

	}

	// True when a Power-class (≥7B) model is loaded — used by the D1 routing hint.
	function isPowerModel() {

		return /\b\d{2,}B\b|7B|13B|34B|70B/i.test( aiEngine.modelId || '' );

	}

	// Input-token budget for the agentic loop, derived from the loaded model's
	// actual context window (reserve ~650 for the model's output). Returns
	// undefined before a window is known, so the loop falls back to its default.
	function aiTokenBudget() {

		const w = aiEngine.contextWindow;
		return w ? Math.max( 2000, w - 650 ) : undefined;

	}

	// ── Eval harness (Change Set E) ────────────────────────────────────────────
	// Runs the standing eval set through the real agentic loop and prints a 3-axis
	// pass/fail table. REPL: evalAI()  or  evalAI(EVAL_PROMPTS.slice(0,3)).
	async function evalAI( prompts = EVAL_PROMPTS ) {

		if ( ! aiEngine.ready ) { appendOutput( 'AI not loaded — click "Load AI" first.', 'error' ); return; }

		appendOutput( `Running eval set (${ prompts.length } prompts) on ${ aiEngine.modelId }…`, 'info' );

		// One prompt → structured per-axis inputs. Drives the SAME loop as runAI so
		// the eval measures real behaviour, not a separate path.
		async function generate( prompt ) {

			const before = new Set();
			editor.scene.traverse( o => { if ( o.isMesh ) before.add( o.uuid ); } );

			const apiHints = retrieveForPrompt( prompt );
			const systemPrompt = buildSystemPrompt( opsSchema() );
			const messages = buildMessages( systemPrompt, editor, prompt, apiHints );

			// Capture the final generated code (for the not-overfit axis).
			let lastCode = '';
			const streamCode = async ( msgs ) => { lastCode = await streamToOutput( msgs ); return lastCode; };

			const res = await runAgentic( {
				editor, messages, intent: prompt, maxRetries: 3, tokenBudget: aiTokenBudget(),
				deps: { streamCode, execute, appendOutput,
					validateCode, snapshotScene, sceneDiff, confirmChange, diffSummary, inspectScene,
					historyLen: () => editor.history.undos.length,
					rollbackTo: ( len ) => { while ( editor.history.undos.length > len ) editor.history.undo(); } },
			} );

			const execOk = !! ( res && res.ok );
			const objects = [];
			let partCount = 0;
			editor.scene.traverse( o => {

				if ( o.isMesh && ! before.has( o.uuid ) ) {

					partCount ++;
					const s = getSize( o );
					const c = getWorldCenter( o );
					objects.push( { size: [ s.x, s.y, s.z ], pos: [ c.x, c.y, c.z ] } );

				}

			} );

			// Distinct material colours across ALL scene meshes (for the recolor /
			// shared-material axis — both paddles green ⇒ count 1 ⇒ fail).
			const colors = new Set();
			editor.scene.traverse( o => {

				if ( o.isMesh && o.material && o.material.color ) colors.add( o.material.color.getHex() );

			} );

			// hadCode reflects whether code was actually extracted (so a thrown but
			// extracted snippet reads "threw on execute", not "no code extracted");
			// validate/exec collapse to the loop's ok result (it only succeeds when
			// validation + execution both passed).
			return { hadCode: lastCode.length > 0, validateOk: execOk, execOk, objects, partCount,
				code: lastCode, distinctColorCount: colors.size };

		}

		const results = await runEval( {
			prompts,
			deps: {
				generate,
				clearScene: () => { editor.clear(); },
				seed: ( code ) => { execute( code ); },
				log: ( line ) => appendOutput( line, 'info' ),
			},
		} );

		appendOutput( formatTable( results ), 'result' );
		return results;

	}

	// ── Stop AI button ─────────────────────────────────────────────────────────

	stopBtn.addEventListener( 'click', function () {

		if ( ! aiEngine.ready ) return;
		aiAborted = true;
		aiEngine.interrupt();
		stopBtn.disabled = true;
		aiStatus.textContent = 'stopping…';

	} );

	// ── Load AI button ────────────────────────────────────────────────────────

	loadBtn.addEventListener( 'click', async function () {

		if ( aiEngine.ready || aiEngine.loading ) return;

		const selectedModel = modelSelect.value;
		const isExternal = [ 'ollama:', 'gpt-', 'claude-' ].some( prefix => selectedModel.startsWith( prefix ) );

		loadBtn.disabled = true;
		modelSelect.disabled = true;
		aiStatus.textContent = isExternal ? 'checking…' : 'loading…';
		progressWrap.style.display = isExternal ? 'none' : 'block';
		progressBar.style.width = '0%';

		try {

			if ( isExternal ) {

				// External API: verify health and set up via aiEngine
				const healthRes = await fetch( '/api/health' );
				const health = await healthRes.json();

				// Check if the selected API source is available
				const source = selectedModel.startsWith( 'ollama:' ) ? 'ollama' : selectedModel.startsWith( 'gpt-' ) ? 'openai' : 'claude';
				if ( health.services[ source ] !== 'running' && health.services[ source ] !== 'configured' ) {

					throw new Error( `${source} API not configured or not running` );

				}

				// Set up external API with unified interface. When the caller supplies
				// an onToken handler we ask the server to STREAM (Server-Sent Events) so
				// cloud replies arrive token-by-token, exactly like the local WebLLM
				// path; complete() (no onToken) keeps the simpler one-shot JSON request.
				const streamFn = async ( messages, opts = {} ) => {

					const wantStream = typeof opts.onToken === 'function';

					// Retry on 429 (rate limit) with backoff so a transient limit never
					// returns empty (which the agentic loop would mistake for "no code
					// block" and waste a retry). The server also retries upstream; this
					// is the client-side safety net for sustained eval throughput.
					const maxRateRetries = 6;
					for ( let attempt = 0; ; attempt ++ ) {

						const res = await fetch( '/api/chat', {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify( {
								model: selectedModel,
								messages,
								temperature: opts.temperature ?? 0.7,
								stream: wantStream,
								// Cloud models bill by actual output tokens and stop at
								// end_turn, so a generous cap costs nothing for short replies
								// but prevents mid-code-block truncation (an unterminated
								// fence makes the extractor correctly reject the output).
								// The 600-token default is tuned for memory-bound WebLLM;
								// it's far too low for verbose cloud models.
								max_tokens: Math.max( opts.maxTokens ?? 0, 4096 )
							} )
						} );

						// Rate limited — wait and retry (don't surface as a code failure).
						// Checked before reading the body so the stream isn't consumed.
						if ( res.status === 429 && attempt < maxRateRetries ) {

							const retryAfter = parseFloat( res.headers.get( 'retry-after' ) );
							const waitMs = Number.isFinite( retryAfter )
								? Math.ceil( retryAfter * 1000 )
								: Math.min( 2000 * Math.pow( 2, attempt ), 30000 );
							opts.onToken?.( '', `⏳ rate limited — waiting ${ Math.round( waitMs / 1000 ) }s…` );
							await new Promise( r => setTimeout( r, waitMs ) );
							continue;

						}

						const contentType = res.headers.get( 'content-type' ) || '';

						// ── Streaming path (Server-Sent Events) ─────────────────────────
						if ( wantStream && res.ok && contentType.includes( 'text/event-stream' ) ) {

							const reader = res.body.getReader();
							const decoder = new TextDecoder();
							let buf = '', full = '';

							for ( ;; ) {

								const { value, done } = await reader.read();
								if ( done ) break;
								buf += decoder.decode( value, { stream: true } );

								// SSE events are separated by a blank line.
								let sep;
								while ( ( sep = buf.indexOf( '\n\n' ) ) >= 0 ) {

									const evt = buf.slice( 0, sep );
									buf = buf.slice( sep + 2 );

									for ( const rawLine of evt.split( '\n' ) ) {

										const line = rawLine.trim();
										if ( ! line.startsWith( 'data:' ) ) continue;
										const payload = line.slice( 5 ).trim();
										if ( ! payload || payload === '[DONE]' ) continue;

										let o;
										try { o = JSON.parse( payload ); } catch { continue; }
										if ( o.error ) throw new Error( o.error );
										if ( o.delta ) { full += o.delta; opts.onToken( o.delta, full ); }

									}

								}

							}

							return full;

						}

						// ── One-shot JSON path (complete(), or non-streaming server) ────
						const data = await res.json().catch( () => ( {} ) );

						// Surface API/transport errors as exceptions so the loop reports
						// them instead of mistaking an error string for "no code".
						if ( ! res.ok || data.error ) {

							const msg = data.error || `HTTP ${ res.status }`;
							const err = new Error( msg );
							err.status = res.status;
							throw err;

						}

						// Handle both Ollama and OpenAI response formats
						const answer = data.message?.content || data.choices?.[ 0 ]?.message?.content || '';

						// Deliver the full answer to a streaming UI in one chunk when the
						// server didn't stream (keeps the live output div populated).
						if ( opts.onToken ) opts.onToken( '', answer );

						return answer;

					}

				};

				const interruptFn = () => {}; // No-op for external APIs

				aiEngine.setExternalAPI( selectedModel, streamFn, interruptFn );

				aiStatus.textContent = 'ready';
				loadBtn.textContent = '✓ AI';
				aiInput.disabled = false;
				aiInput.focus();
				localStorage.setItem( 'shell-ai-model', selectedModel );
				appendOutput( 'AI ready — model: ' + selectedModel + '  (external API)', 'info' );

			} else {

				// WebLLM: standard loading. On-device inference needs working WebGPU
				// compute — software-emulated GPUs (llvmpipe / SwiftShader on Linux)
				// expose navigator.gpu but fail to compile compute shaders. Check up
				// front so we can point the user at the cloud models instead of a
				// cryptic "Invalid ShaderModule … compute stage" failure mid-load.
				if ( ! navigator.gpu ) {

					throw new Error( 'WebGPU is not available in this browser, so on-device models can\'t run. ' +
						'Pick a cloud model (gpt-… / claude-… / ollama:…) instead, or enable WebGPU (chrome://gpu).' );

				}

				progressWrap.style.display = 'block';

				await aiEngine.init( selectedModel, ( p ) => {

					const pct = Math.round( ( p.progress || 0 ) * 100 );
					progressBar.style.width = pct + '%';
					aiStatus.textContent = p.text ?? ( pct + '%' );

				} );

				progressBar.style.width = '100%';
				setTimeout( () => { progressWrap.style.display = 'none'; }, 600 );
				aiStatus.textContent = 'ready';
				loadBtn.textContent = '✓ AI';
				aiInput.disabled = false;
				aiInput.focus();
				localStorage.setItem( 'shell-ai-model', selectedModel );
				appendOutput( 'AI ready — model: ' + selectedModel +
					'  (context window: ' + ( aiEngine.contextWindow || 'default' ) + ' tokens)', 'info' );

			}

		} catch ( err ) {

			progressWrap.style.display = 'none';
			aiStatus.textContent = 'failed';
			loadBtn.disabled = false;
			modelSelect.disabled = false;

			// A failed compute-shader compile (e.g. "Invalid ShaderModule … compute
			// stage … index_kernel") means WebGPU can't run on this GPU — almost
			// always a software/emulated driver. Steer the user to the cloud models.
			const msg = String( err && err.message || err );
			const isWebGPUFailure = ! isExternal && /shadermodule|compute stage|index_kernel|webgpu|gpu device|createcomputepipeline/i.test( msg );

			if ( isWebGPUFailure ) {

				appendOutput( 'AI load error: on-device model failed to start — this browser/GPU can\'t run WebGPU compute ' +
					'(common with software rendering such as llvmpipe/SwiftShader on Linux). ' +
					'Use a cloud model (gpt-…, claude-…, or ollama:…) instead, or enable a hardware GPU at chrome://gpu.\n\n' +
					'Details: ' + msg, 'error' );

			} else {

				appendOutput( 'AI load error: ' + msg, 'error' );

			}

		}

	} );

	// ── AI input keydown ──────────────────────────────────────────────────────

	aiInput.addEventListener( 'keydown', function ( event ) {

		event.stopPropagation();

		if ( event.key === 'Enter' ) {

			event.preventDefault();
			const val = aiInput.value.trim();
			if ( val ) {

				aiInput.value = '';
				runAI( val );

			}

		}

	} );

	// ── JS input keydown ──────────────────────────────────────────────────────

	input.addEventListener( 'keydown', function ( event ) {

		event.stopPropagation(); // prevent global shortcut handler from eating Backspace/Delete

		if ( event.key === 'Enter' && ! event.shiftKey ) {

			event.preventDefault();
			execute( input.value );
			input.value = '';
			input.style.height = 'auto';
			return;

		}

		if ( event.key === 'ArrowUp' ) {

			if ( input.value.indexOf( '\n' ) === - 1 ) {

				event.preventDefault();
				if ( historyIndex === - 1 ) savedInput = input.value;
				if ( historyIndex < history.length - 1 ) {

					historyIndex ++;
					input.value = history[ historyIndex ];

				}

			}

		}

		if ( event.key === 'ArrowDown' ) {

			if ( input.value.indexOf( '\n' ) === - 1 ) {

				event.preventDefault();
				if ( historyIndex > 0 ) {

					historyIndex --;
					input.value = history[ historyIndex ];

				} else if ( historyIndex === 0 ) {

					historyIndex = - 1;
					input.value = savedInput;

				}

			}

		}

		// Auto-grow textarea height
		setTimeout( function () {

			input.style.height = 'auto';
			input.style.height = Math.min( input.scrollHeight, 120 ) + 'px';

		}, 0 );

	} );

	// ── Toggle signal ─────────────────────────────────────────────────────────
	// Tab visibility is owned by the Sidebar; here we just focus the input when
	// the shell tab is (re)opened.

	signals.toggleShell.add( function () {

		setTimeout( () => input.focus(), 50 );

	} );

	// ── Show JS for selection signal ──────────────────────────────────────────
	// Triggered from View → Show JS for Selection.
	// The Sidebar selects the shell tab; here we print JS for the selected object.

	signals.showJSForSelection.add( function () {

		const obj = editor.selected;

		if ( ! obj ) {

			appendOutput( '// No object selected — generating JS for entire scene:', 'info' );
			const result = sceneToJS( editor );
			appendOutput( result.code, 'result' );
			if ( result.lossy ) appendOutput( '⚠ Lossy fallback used: ' + result.lossyReasons.join( '; ' ), 'error' );
			return;

		}

		appendOutput( `// Generated JS for: "${obj.name || obj.type}"  uuid: ${obj.uuid.slice( 0, 8 )}`, 'info' );
		const result = objectToJS( obj );
		appendOutput( result.code, 'result' );
		if ( result.lossy ) appendOutput( '⚠ Lossy fallback used: ' + result.lossyReasons.join( '; ' ), 'error' );

		output.scrollTop = output.scrollHeight;

	} );

	// ── Welcome message ───────────────────────────────────────────────────────

	appendOutput( 'three.js editor shell  —  globals: editor  THREE  scene  camera  renderer  AddObjectCommand  RemoveObjectCommand  SetPositionCommand  SetRotationCommand  SetScaleCommand  SetMaterialColorCommand  SetValueCommand', 'info' );
	appendOutput( 'scene lookup: findObject(name)  findAll(name)  findOfType(type)  findNear(mesh,radius)  summarize()', 'info' );
	appendOutput( 'scene intelligence: findByDescription("right arm of the red person")  describeObject(o)  listCandidates(text)  resolvePartAI(text)', 'info' );
	appendOutput( 'agentic tools: findAPI(text)  whatsVisible()  whatsAt(x,y)  — AI requests run a bounded generate→validate→execute→observe→fix loop', 'info' );
	appendOutput( 'spatial: getSize(obj)  getTopY(obj)  getCenter(obj)  placeOnTop(child,target)', 'info' );
	appendOutput( '3rd-party API: const d = await fetchAPI(url[, {method,headers,body}])  — JSON→object (network/CORS apply)', 'info' );
	appendOutput( 'dev API (--dev mode): External models (Ollama, OpenAI, Claude) appear in model dropdown when available  — select and click "Load AI"', 'info' );
	appendOutput( 'AI Q&A: prefix AI input with ? to ask questions  —  or call askScene("question") in REPL', 'info' );
	appendOutput( 'AI eval: evalAI() runs the standing eval set (pong/chess/hoop…) and prints a structure/spatial/semantic table', 'info' );
	appendOutput( 'codegen: showJS()  objectToJS(obj)  sceneToJS()  sceneEqual(a,b)', 'info' );
	appendOutput( 'modeling ops: booleanUnion(a,b)  booleanSubtract(a,b)  booleanIntersect(a,b)  mirrorMesh(m,axis)  arrayDuplicate(m,n,dx,dy,dz)  subdivide(m,iters)', 'info' );
	appendOutput( 'organic geometry: LatheGeometry(pts,segs)  TubeGeometry(curve,…)  ExtrudeGeometry(shape,{})  CatmullRomCurve3(pts)', 'info' );
	appendOutput( 'PBR textures: makeTexture(fn,size)  makeCheckerTex(sz,dark,light,tiles)  makeGridTex(sz,color,divs,bg)  + MeshPhysicalMaterial', 'info' );
	appendOutput( 'edit mode: enterEditMode()  exitEditMode()  extrude(d)  inset(t)  bevel(t)  deleteFaces()  weld(eps)  planarUV(axis)  boxUV()  — Tab to toggle', 'info' );
	appendOutput( 'selection criteria (M6): selectTopFaces(count)  selectFacingUp(threshold)  selectBoundaryEdges()  selectFaces(…ids)  selectVertices(…ids)  selectEdges(…ids)  clearSelection()', 'info' );

	return container;

}

export { Shell };
