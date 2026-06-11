// ── sceneIndex.js ─────────────────────────────────────────────────────────────
// Query primitives over the descriptor index + the SceneIntelligence controller
// that keeps descriptors fresh (eager-on-import, debounced; lazy-on-query).
//
// Public (also registered in the op registry → AI-callable):
//   findByDescription(text)  → { node, confidence, method, candidates }
//   describeObject(node)     → descriptor bundle (computed on demand)
//   listCandidates(text)     → ranked candidates [{ node, score, reasons }]
//   resolvePartAI(text)      → async: Path A then existing-LLM Path B
//
// Never silently wrong: ambiguous queries return ranked candidates + low
// confidence; merged-mesh GLBs (no per-part nodes) are detected and reported.

import { indexSubtree } from './descriptors.js';
import { parseQuery, scoreCandidates, resolveWithLLM } from './resolver.js';
import { registerOp } from '../mesh/ops/index.js';
import { decodeName } from '../scene/summarize.js';
import { labelImportedAsset } from '../import/labelPass.js';

// ── Self-healing labels ───────────────────────────────────────────────────────
// An asset imported BEFORE the AI engine was ready never got its Stage-4 labels
// (labelImportedAsset returned 'no-llm' and left no labelPass). Then every part
// query is unresolvable. When a part query comes in, the engine IS ready, so
// kick off the labeling pass for any imported-but-unlabeled root (fire-and-forget)
// and tell the user to re-run once. Idempotent; runs at most once per root.

const _labelingRoots = new WeakSet();

function ensureLabeled( editor ) {

	const eng = editor && editor.aiEngine;
	if ( ! eng || ! eng.ready || ! editor.scene ) return false;

	let pending = false;
	for ( const root of editor.scene.children ) {

		if ( root.isCamera || ! root.userData || ! root.userData.imported ) continue;
		const lp = root.userData.labelPass;
		if ( lp && lp.labeled > 0 ) continue;       // already labeled
		if ( _labelingRoots.has( root ) ) { pending = true; continue; } // in flight

		_labelingRoots.add( root );
		pending = true;
		Promise.resolve( labelImportedAsset( editor, root, { force: true } ) )
			.then( res => {

				if ( editor.importLog ) editor.importLog( '🏷 Labeled ' + ( res.labeled || 0 ) + ' parts of "' + ( decodeName( root.name ) || 'asset' ) + '". Re-run your command.' );
				if ( editor.signals && editor.signals.sceneGraphChanged ) editor.signals.sceneGraphChanged.dispatch();

			} )
			.catch( () => {} )
			.finally( () => _labelingRoots.delete( root ) );

	}
	return pending;

}

// ── Index maintenance ─────────────────────────────────────────────────────────

/** Recompute descriptors for any scene subtree that lacks fresh ones. */
export function ensureIndexed( editor, force = false ) {

	for ( const child of editor.scene.children ) {

		if ( child.isCamera ) continue;
		indexSubtree( child, force );

	}

}

/** All nodes (excluding scene root + cameras) that carry descriptors. */
function indexedNodes( editor ) {

	const out = [];
	editor.scene.traverse( n => {

		if ( n === editor.scene || n.isCamera ) return;
		if ( n.userData && n.userData.descriptors ) out.push( n );

	} );
	return out;

}

// ── Merged-mesh detection ─────────────────────────────────────────────────────
// A query referencing a sub-part can't be served if the scene is a single mesh
// with no per-part hierarchy.

function looksLikeSubPartQuery( q ) {

	return q.shapes.length > 0 || q.regions.length > 0 || q.pair;

}

function onlyMergedMeshes( nodes ) {

	const meshes = nodes.filter( n => n.isMesh );
	const groups = nodes.filter( n => n.userData.descriptors && n.userData.descriptors.role === 'group' );
	return groups.length === 0 && meshes.every( m => m.children.length === 0 ) && meshes.length <= 1;

}

// ── Path A (sync, free) ───────────────────────────────────────────────────────

/**
 * @returns {{ node, confidence, method, candidates, message? }}
 *   method: 'A' | 'ambiguous' | 'merged' | 'none'
 */
export function findByDescription( editor, text ) {

	ensureIndexed( editor );

	const nodes = indexedNodes( editor );
	const q = parseQuery( text );

	if ( looksLikeSubPartQuery( q ) && onlyMergedMeshes( nodes ) ) {

		return {
			node: null, confidence: 0, method: 'merged', candidates: [],
			message: 'This scene has no per-part nodes (single merged mesh) — individual parts can\'t be selected without geometry segmentation.',
		};

	}

	const ranked = scoreCandidates( nodes, q );

	if ( ranked.length === 0 ) {

		const res = { node: null, confidence: 0, method: 'none', candidates: [] };
		if ( ensureLabeled( editor ) ) res.labeling = true;
		return res;

	}

	// Confidence from score margin between #1 and #2
	const top = ranked[ 0 ];
	const second = ranked[ 1 ];
	const margin = second ? ( top.score - second.score ) / ( top.score || 1 ) : 1;
	const confidence = Math.max( 0, Math.min( 1, 0.5 + 0.5 * margin ) );

	if ( ! second || margin >= 0.34 ) {

		return { node: top.node, confidence, method: 'A', candidates: ranked.slice( 0, 6 ) };

	}

	// Ambiguous — surface candidates, do not guess. If the asset was never labeled,
	// kick off labeling so the next try can resolve deterministically.
	const res = { node: top.node, confidence, method: 'ambiguous', candidates: ranked.slice( 0, 6 ) };
	if ( ensureLabeled( editor ) ) res.labeling = true;
	return res;

}

// ── Path A + Path B (async, uses loaded LLM only when ambiguous) ──────────────

export async function resolvePartAI( editor, text ) {

	const a = findByDescription( editor, text );
	if ( a.method === 'A' || a.method === 'merged' ) return a;

	// Pre-filtered candidate set for the LLM (keeps context small)
	const candidates = ( a.candidates.length ? a.candidates.map( c => c.node ) : indexedNodes( editor ) );

	const b = await resolveWithLLM( editor.aiEngine, text, candidates );
	if ( b && b.node ) return { node: b.node, confidence: b.confidence, method: 'B', candidates: a.candidates };

	return a; // fall back to ambiguous/none from Path A

}

// ── findParts: PLURAL-aware part resolution ───────────────────────────────────
// "make the wheels black" references FOUR parts, not one. findByDescription
// returns a single node, which made the model fall back to recoloring EVERY mesh
// of the asset. findParts returns ALL meshes matching the part noun, so the AI
// can edit just that subset (the wheels) instead of the whole truck.

const PART_STOP = new Set( [ 'the', 'a', 'an', 'and', 'or', 'of', 'on', 'in', 'to', 'into',
	'make', 'turn', 'set', 'change', 'paint', 'recolor', 'colour', 'color', 'this', 'that',
	'these', 'those', 'with', 'for', 'all', 'every', 'both', 'each', 'two', 'three', 'four',
	'part', 'parts', 'piece', 'pieces', 'whole', 'entire', 'bigger', 'smaller', 'larger',
	// colors carry no part identity
	'red', 'orange', 'yellow', 'lime', 'green', 'teal', 'cyan', 'blue', 'purple', 'magenta',
	'pink', 'brown', 'gray', 'grey', 'black', 'white', 'dark', 'light', 'bright' ] );

// Naive singularizer: wheels→wheel, lights→light, glasses→glass. Good enough to
// match a plural request against singular labels ("Front Left Wheel").
function singular( w ) {

	if ( w.endsWith( 'ses' ) || w.endsWith( 'shes' ) || w.endsWith( 'ches' ) ) return w.slice( 0, - 2 );
	if ( w.endsWith( 's' ) && ! w.endsWith( 'ss' ) ) return w.slice( 0, - 1 );
	return w;

}

function partNouns( q ) {

	const out = new Set();
	for ( const w of ( q.tokens || [] ) ) {

		if ( w.length < 3 || PART_STOP.has( w ) ) continue;
		out.add( w );
		out.add( singular( w ) );

	}
	return [ ...out ];

}

// Decoded, lowercased label + node name + material name(s) for a node (what the
// user calls it). Material names ("Rims","Grille") are included so a part is
// matchable by its material even when its node name is an opaque Object_N.
function nodeText( n ) {

	const d = n.userData && n.userData.descriptors;
	const mats = d && d.materials && d.materials.length ? ' ' + d.materials.join( ' ' ) : '';
	const s = ( n.userData && n.userData.label ? n.userData.label + ' ' : '' ) + ( n.name || '' ) + mats;
	return decodeName( s ).toLowerCase();

}

/**
 * Resolve a (possibly plural) part reference to ALL matching meshes.
 *
 * @returns {{ nodes: THREE.Object3D[], method: 'label'|'descriptors'|'merged'|'none', query: string, message?: string }}
 */
export function findParts( editor, text ) {

	ensureIndexed( editor );
	const r = matchPartNodes( indexedNodes( editor ), text );

	// Weak result on an imported asset that was never labeled → start labeling now.
	if ( r.method === 'none' || r.method === 'merged' || r.ambiguous ) {

		if ( ensureLabeled( editor ) ) r.labeling = true;

	}
	return r;

}

/**
 * Pure part-matching over already-indexed nodes (no scene traversal / no THREE),
 * so it is unit-testable. findParts() is this plus index maintenance.
 *
 * @param {THREE.Object3D[]} nodes  nodes carrying userData.descriptors / .label
 * @param {string} text
 */
export function matchPartNodes( nodes, text ) {

	const q = parseQuery( text );
	const nouns = partNouns( q );

	// Merged mesh + a sub-part request → can't isolate parts. Say so (Guard 1).
	if ( ( looksLikeSubPartQuery( q ) || nouns.length ) && onlyMergedMeshes( nodes ) ) {

		return {
			nodes: [], method: 'merged', query: text,
			message: 'This asset is a single merged mesh — its parts can\'t be isolated. I can edit the whole object instead.',
		};

	}

	// Primary path: match the Stage-4 labels / node names by part noun.
	if ( nouns.length ) {

		const matched = nodes.filter( n => n.isMesh && nouns.some( t => nodeText( n ).includes( t ) ) );
		if ( matched.length ) return { nodes: matched, method: 'label', query: text };

	}

	// Fallback: descriptor scoring (shape/region/color). With NO label/name match the
	// signal is weak (e.g. several blocky meshes tie on "body"), so be CONSERVATIVE:
	// recoloring the whole shape-tied cluster would repaint most of the asset — exactly
	// the bug we're guarding against. Return only the single best mesh and flag it as a
	// guess so the caller can ask the user to name the part (or run relabelAsset).
	const ranked = scoreCandidates( nodes, q ).filter( r => r.score >= 2 && r.node.isMesh );
	if ( ranked.length ) {

		const ambiguous = ranked.length > 1 && ranked[ 1 ].score >= ranked[ 0 ].score;
		return { nodes: [ ranked[ 0 ].node ], method: 'descriptors', ambiguous, query: text };

	}

	return { nodes: [], method: 'none', query: text };

}

// ── Describe / list ───────────────────────────────────────────────────────────

export function describeObject( editor, node ) {

	if ( ! node ) return null;
	if ( ! node.userData.descriptors ) {

		// Index its top-level ancestor so sibling-relative facts are correct
		let root = node;
		while ( root.parent && root.parent !== editor.scene ) root = root.parent;
		indexSubtree( root, true );

	}
	return node.userData.descriptors || null;

}

export function listCandidates( editor, text ) {

	ensureIndexed( editor );
	return scoreCandidates( indexedNodes( editor ), parseQuery( text ) );

}

// ── SceneIntelligence controller ──────────────────────────────────────────────

export class SceneIntelligence {

	constructor( editor ) {

		this.editor = editor;
		this._dirty = new Set();
		this._timer = null;

		// Eager-on-import, debounced so a 200-node bulk load doesn't thrash.
		editor.signals.objectAdded.add( obj => {

			let root = obj;
			while ( root.parent && root.parent !== editor.scene ) root = root.parent;
			if ( root && ! root.isCamera ) this._dirty.add( root );
			this._schedule();

		} );

		// Invalidate descriptors when geometry changes (modeling ops).
		editor.signals.geometryChanged.add( obj => {

			if ( obj && obj.userData && obj.userData.descriptors ) {

				delete obj.userData.descriptors.geomHash; // forces recompute next pass
				let root = obj;
				while ( root.parent && root.parent !== editor.scene ) root = root.parent;
				if ( root ) { this._dirty.add( root ); this._schedule(); }

			}

		} );

	}

	_schedule() {

		if ( this._timer ) return;
		this._timer = setTimeout( () => {

			this._timer = null;
			const roots = [ ...this._dirty ];
			this._dirty.clear();
			for ( const r of roots ) {

				if ( r.parent ) indexSubtree( r ); // still in scene

			}

		}, 250 );

	}

}

// ── Register query primitives in the op registry (AI-discoverable) ────────────

registerOp( 'findByDescription', {
	description: 'Resolve a natural-language part reference (e.g. "right arm of the red person") to a SINGLE scene node using geometry+color+symmetry descriptors. Returns { node, confidence, method, candidates }.',
	params: { text: 'string' },
	example: 'findByDescription("the red box on the left")',
} );

registerOp( 'findParts', {
	description: 'Resolve a PLURAL part reference (e.g. "the wheels", "the tail lights") to ALL matching meshes of an imported asset, using the import-time labels. Use this to edit a SUBSET of parts instead of traversing/recoloring the whole object. Returns { nodes, method }.',
	params: { text: 'string' },
	example: 'findParts("the wheels")',
} );

registerOp( 'describeObject', {
	description: 'Return the derived descriptor bundle (region, shape, color, symmetry pair, size rank) for a node.',
	params: { node: 'Object3D' },
	example: 'describeObject(editor.selected)',
} );

registerOp( 'listCandidates', {
	description: 'Return ranked candidate nodes for an ambiguous description, for disambiguation.',
	params: { text: 'string' },
	example: 'listCandidates("the two wheels at the back")',
} );
