// ── apiIndex.js ───────────────────────────────────────────────────────────────
// RAG over OUR OWN API (Technique 2). Local text index of the REAL signatures the
// shell exposes — command classes, op registry, allowed material/geometry keys,
// globals — so the model references real APIs instead of hallucinating
// (THREE.Tree3D, metal:1, wrong AddObjectCommand arity).
//
// Fully local: just keyword search over in-memory chunks. No model, no egress.
//
// API:
//   buildIndex()                 → rebuild (call on load / when ops change)
//   retrieveForPrompt(text, n=6) → compact string of the most relevant chunks
//   findAPI(text, n=6)           → ranked chunks [{ name, kind, sig, text }]
//   MATERIAL_KEYS, COMMAND_ARITY, ALLOWED_CLASSES  (consumed by validate.js)

import { PARAM_ORDER } from '../scene/geometryParams.js';
import { listOps, registerOp } from '../mesh/ops/index.js';
import { THREEJS_API } from './threejsApi.js';

// ── Curated, hand-verified facts (the source of truth the model must follow) ──

// Command signatures — these match the real constructors in js/commands/.
const COMMANDS = [
	{ name: 'AddObjectCommand',         sig: 'new AddObjectCommand(editor, object)',                       use: 'add an object to the scene' },
	{ name: 'RemoveObjectCommand',      sig: 'new RemoveObjectCommand(editor, object)',                    use: 'remove an object' },
	{ name: 'SetPositionCommand',       sig: 'new SetPositionCommand(editor, object, new Vector3(x,y,z))', use: 'move an object' },
	{ name: 'SetRotationCommand',       sig: 'new SetRotationCommand(editor, object, new Euler(x,y,z))',   use: 'rotate (radians)' },
	{ name: 'SetScaleCommand',          sig: 'new SetScaleCommand(editor, object, new Vector3(x,y,z))',    use: 'scale an object' },
	{ name: 'SetMaterialColorCommand',  sig: "new SetMaterialColorCommand(editor, object, 'color', 0xRRGGBB)", use: 'recolor a material' },
	{ name: 'SetMaterialCommand',       sig: 'new SetMaterialCommand(editor, object, newMaterial)',        use: 'replace the whole material / change material type' },
	{ name: 'SetValueCommand',          sig: 'new SetValueCommand(editor, object, attributeName, value)',  use: 'set a scalar property' },
];

// Command argument counts (for arity validation). -1 = variadic/ignore.
export const COMMAND_ARITY = {
	AddObjectCommand: 2, RemoveObjectCommand: 2,
	SetPositionCommand: 3, SetRotationCommand: 3, SetScaleCommand: 3,
	SetMaterialColorCommand: 4, SetMaterialCommand: 3, SetValueCommand: 4,
};

// Allowed material option keys (MeshStandard/Physical/Basic/Phong/Lambert union).
export const MATERIAL_KEYS = new Set( [
	'color', 'map', 'opacity', 'transparent', 'side', 'wireframe', 'visible', 'name',
	'emissive', 'emissiveIntensity', 'emissiveMap',
	'metalness', 'metalnessMap', 'roughness', 'roughnessMap',
	'normalMap', 'aoMap', 'aoMapIntensity', 'bumpMap', 'displacementMap',
	'envMap', 'envMapIntensity', 'flatShading', 'vertexColors', 'alphaMap',
	// MeshPhysicalMaterial
	'transmission', 'ior', 'thickness', 'clearcoat', 'clearcoatRoughness',
	'sheen', 'sheenColor', 'specularIntensity', 'reflectivity', 'iridescence',
	// Phong/Lambert
	'shininess', 'specular',
] );

// Material constructors we support.
const MATERIALS = [
	{ name: 'MeshStandardMaterial', sig: 'new MeshStandardMaterial({color, metalness, roughness, map, emissive})', use: 'default PBR material' },
	{ name: 'MeshPhysicalMaterial', sig: 'new MeshPhysicalMaterial({color, transmission, ior, thickness, roughness, clearcoat})', use: 'glass / liquid / car paint' },
	{ name: 'MeshBasicMaterial',    sig: 'new MeshBasicMaterial({color, map, wireframe})', use: 'unlit material' },
	{ name: 'MeshPhongMaterial',    sig: 'new MeshPhongMaterial({color, shininess, specular})', use: 'shiny material' },
	{ name: 'MeshLambertMaterial',  sig: 'new MeshLambertMaterial({color})', use: 'matte material' },
	{ name: 'LineBasicMaterial',    sig: 'new LineBasicMaterial({color})', use: 'material for Line objects' },
];

// THREE classes exposed as globals (no THREE. prefix). Source of truth for
// "is this a real class" in validation.
const CORE_CLASSES = [
	'Mesh', 'Group', 'Line', 'Points', 'Shape', 'Path',
	'Color', 'Vector3', 'Vector2', 'Euler', 'Quaternion',
	'CatmullRomCurve3', 'QuadraticBezierCurve3', 'CubicBezierCurve3',
	'DirectionalLight', 'PointLight', 'AmbientLight', 'SpotLight', 'HemisphereLight',
	'AnimationClip', 'VectorKeyframeTrack', 'QuaternionKeyframeTrack',
	'NumberKeyframeTrack', 'ColorKeyframeTrack', 'BooleanKeyframeTrack',
];

// ── Index state ───────────────────────────────────────────────────────────────

let _chunks = [];                  // [{ name, kind, sig, use, text, terms, source }]
export const ALLOWED_CLASSES = new Set();

// Callable helper globals the shell exposes to generated code (functions, not
// classes). Used by validate.js (B3) to tell a real global from an invented
// helper like backWall(). Op-registry names are merged in at buildIndex().
export const SCOPE_FUNCTIONS = new Set( [
	'findObject', 'findAll', 'findOfType', 'findNear', 'findByDescription', 'findParts',
	'whatsVisible', 'whatsAt', 'findAPI', 'getSize', 'getTopY', 'getCenter', 'placeOnTop',
	'makeTexture', 'makeCheckerTex', 'makeGridTex', 'lineFromPoints', 'makeChair', 'makeTable', 'fetchAPI', 'summarize', 'describeObject',
	'listCandidates', 'resolvePartAI', 'askScene', 'colorToName', 'evalAI',
	'diagnoseImport', 'relabelAsset',
	'enterEditMode', 'exitEditMode', 'extrude', 'inset', 'bevel', 'deleteFaces', 'weld', 'planarUV', 'boxUV',
	'booleanUnion', 'booleanSubtract', 'booleanIntersect', 'mirrorMesh', 'arrayDuplicate', 'subdivide',
	'objectToJS', 'sceneToJS', 'sceneEqual', 'showJS', 'addClip',
] );

// source: 'curated' (hand-verified, authoritative) | 'three' (tern typedefs).
// Curated chunks outrank tern chunks on ties so the command/material/geometry
// signatures the editor actually exposes stay at the top of retrieval.
function _addChunk( name, kind, sig, use, source = 'curated' ) {

	const text = `${ name } — ${ kind }\n  ${ sig }${ use ? '\n  // ' + use : '' }`;
	const terms = ( name + ' ' + ( use || '' ) + ' ' + sig ).toLowerCase();
	_chunks.push( { name, kind, sig, use, text, terms, source } );

}

export function buildIndex() {

	_chunks = [];
	ALLOWED_CLASSES.clear();

	for ( const c of COMMANDS )  { _addChunk( c.name, 'command', c.sig, c.use ); ALLOWED_CLASSES.add( c.name ); }
	for ( const m of MATERIALS ) { _addChunk( m.name, 'material', m.sig, m.use ); ALLOWED_CLASSES.add( m.name ); }
	for ( const c of CORE_CLASSES ) ALLOWED_CLASSES.add( c );
	// Keyframe-animation API — curated chunks so retrieval teaches the exact
	// track/clip signatures and the addClip(object, clip) registration helper.
	_addChunk( 'addClip', 'op', 'addClip(object, clip)', 'register a finished AnimationClip on an object (default scene) so it shows in the Animations panel and can be played' );
	_addChunk( 'AnimationClip', 'animation', 'new AnimationClip(name, duration, tracks[])', 'a named animation; pass duration -1 to auto-compute from track times' );
	_addChunk( 'VectorKeyframeTrack', 'animation', "new VectorKeyframeTrack(obj.uuid+'.position', times[], values[])", 'animate position or scale; values are flattened x,y,z per time (3 per keyframe)' );
	_addChunk( 'QuaternionKeyframeTrack', 'animation', "new QuaternionKeyframeTrack(obj.uuid+'.quaternion', times[], values[])", 'animate rotation; values are flattened x,y,z,w per time (4 per keyframe) from Quaternion.setFromEuler' );
	_addChunk( 'NumberKeyframeTrack', 'animation', "new NumberKeyframeTrack(obj.uuid+'.material.opacity', times[], values[])", 'animate a single numeric property (1 value per keyframe)' );
	_addChunk( 'ColorKeyframeTrack', 'animation', "new ColorKeyframeTrack(obj.uuid+'.material.color', times[], values[])", 'animate a color; values are flattened r,g,b per time (3 per keyframe)' );
	// Geometry constructors from the supported-params table
	for ( const [ type, order ] of Object.entries( PARAM_ORDER ) ) {

		const params = order.length ? order.join( ', ' ) : '…';
		_addChunk( type, 'geometry', `new ${ type }(${ params })`, null );
		ALLOWED_CLASSES.add( type );

	}

	// Modeling + scene-intelligence + edit-mode ops from the live registry
	for ( const op of listOps() ) {

		const ps = Object.entries( op.params || {} ).map( ( [ k, v ] ) => `${ k }: ${ v }` ).join( ', ' );
		_addChunk( op.name, 'op', `${ op.name }(${ ps })`, op.description );
		// ops are functions in scope, not classes — not added to ALLOWED_CLASSES
		SCOPE_FUNCTIONS.add( op.name );

	}

	// Full three.js API (tern typedefs) — instance methods and properties with docs.
	// RETRIEVAL ONLY: NOT added to ALLOWED_CLASSES (most three.js classes are not
	// shell globals — validation must stay tied to what the scope provides).
	//
	// CRITICAL: skip CONSTRUCTOR signatures (`new X(...)`) for classes that are NOT
	// exposed as globals. Surfacing `new BufferGeometry()` / `new SplineCurve()` /
	// `new Clock()` told a capable model to "use these EXACTLY", and then the code
	// failed at validate/runtime because those classes don't exist in scope (the
	// observed ping-pong-table / net failure). Method/property hints stay — they're
	// invoked on real instances the scene already has (e.g. mesh.geometry).
	for ( const c of THREEJS_API ) {

		if ( c.kind === 'three-class' && ! ALLOWED_CLASSES.has( c.name ) ) continue;
		_addChunk( c.name, c.kind, c.sig, c.use, 'three' );

	}

	return _chunks.length;

}

// ── Retrieval (keyword tier — deterministic, no model) ────────────────────────

// Common words that cause spurious substring hits ("the" → "Lathe…") — skipped
// during scoring. Intent verbs (add/move/rotate…) are handled by TOPIC_HINTS.
const STOPWORDS = new Set( [
	'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'onto', 'your', 'you',
	'please', 'make', 'want', 'need', 'some', 'all', 'any', 'new', 'put', 'use', 'using',
	'about', 'over', 'under', 'near', 'next', 'are', 'was', 'has', 'its', 'out', 'off',
	'degrees', 'degree', 'deg', 'units', 'unit', 'one', 'two',
	// Intent verbs — mapped to commands by TOPIC_HINTS; as bare terms they exact-match
	// every .add()/.remove() method and drown out the relevant geometry/material chunk.
	'add', 'create', 'place', 'spawn', 'remove', 'delete', 'move',
] );

function _score( chunk, queryTerms ) {

	let s = 0;
	const lname = chunk.name.toLowerCase();
	for ( const t of queryTerms ) {

		if ( ! t || t.length < 3 || STOPWORDS.has( t ) || /^\d+$/.test( t ) ) continue;
		// Match the member tail too, so "rotation"/"lookat" hit "Object3D.rotation".
		const tail = lname.includes( '.' ) ? lname.slice( lname.lastIndexOf( '.' ) + 1 ) : lname;
		if ( lname === t || tail === t ) s += 10;
		else if ( tail.includes( t ) ) s += 5;
		else if ( lname.includes( t ) ) s += 3;
		if ( chunk.terms.includes( t ) ) s += 1;

	}
	// Curated, hand-verified chunks outrank tern typedefs on ties.
	if ( s > 0 && chunk.source === 'curated' ) s += 3;
	return s;

}

// Intent → topic expansion so "add a light" pulls AddObjectCommand + the lights.
const TOPIC_HINTS = [
	{ re: /\b(add|create|new|place|spawn)\b/, names: [ 'AddObjectCommand' ] },
	{ re: /\b(remove|delete)\b/,              names: [ 'RemoveObjectCommand' ] },
	{ re: /\b(move|position|next to|above|below|place)\b/, names: [ 'SetPositionCommand' ] },
	{ re: /\b(rotate|turn|spin)\b/,           names: [ 'SetRotationCommand' ] },
	{ re: /\b(scale|bigger|smaller|resize)\b/, names: [ 'SetScaleCommand' ] },
	{ re: /\b(color|colour|paint|recolor|red|green|blue|purple)\b/, names: [ 'SetMaterialColorCommand' ] },
	{ re: /\b(material|metal|glass|matte|shiny|basic|unlit)\b/, names: [ 'SetMaterialCommand', 'MeshStandardMaterial', 'MeshPhysicalMaterial' ] },
	{ re: /\b(light|lamp|sun)\b/,             names: [ 'DirectionalLight', 'PointLight', 'AmbientLight', 'SpotLight' ] },
	{ re: /\b(glass|transparent|liquid)\b/,   names: [ 'MeshPhysicalMaterial' ] },
];

export function findAPI( text, n = 6 ) {

	if ( ! _chunks.length ) buildIndex();
	const q = String( text ).toLowerCase();
	const queryTerms = q.split( /[^a-z0-9]+/ ).filter( Boolean );

	// Topic-forced chunks first
	const forced = new Set();
	for ( const h of TOPIC_HINTS ) if ( h.re.test( q ) ) h.names.forEach( nm => forced.add( nm ) );

	const scored = _chunks.map( c => ( {
		c,
		s: _score( c, queryTerms ) + ( forced.has( c.name ) ? 8 : 0 ),
	} ) ).filter( x => x.s > 0 );

	scored.sort( ( a, b ) => b.s - a.s );
	return scored.slice( 0, n ).map( x => x.c );

}

/**
 * Compact string of the most relevant real signatures, to inject BEFORE
 * generation. Empty string when nothing matches (don't waste tokens).
 */
export function retrieveForPrompt( text, n = 6 ) {

	const hits = findAPI( text, n );
	if ( ! hits.length ) return '';
	// Signatures only — kept lean to protect the small model's context window.
	// Full docs are available on demand via the findAPI() tool, not injected here.
	return 'REAL API SIGNATURES (use these EXACTLY — do not invent variants):\n'
		+ hits.map( h => '  ' + h.sig ).join( '\n' );

}

// ── AI-callable tool ──────────────────────────────────────────────────────────

registerOp( 'findAPI', {
	description: 'Retrieve the REAL signatures/keys for an intent from the local API index (no hallucination). Returns matching command/op/material/geometry signatures.',
	params: { text: 'string' },
	example: 'findAPI("set material color")',
} );
