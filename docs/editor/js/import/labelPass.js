// ── import/labelPass.js ───────────────────────────────────────────────────────
// Stage 4 (LLM LABELING PASS) — the key LLM use in import. ★
//
// Turns an opaque `Object_N` asset into a natural-language-addressable one. ONCE,
// at import, the LLM is handed the COMPACT descriptor table (NOT raw geometry)
// harvested deterministically in Stage 3, and proposes a human label per node.
// Labels are cached in node.userData.label so they serialize into scene JSON
// (git-diffable, survive reload) and resolution can match against them later.
//
// "Geometry supplies the modifier, the LLM supplies the noun": descriptors give
// "elongated / red / rear"; the LLM gives "tail light".
//
// For merged-mesh assets there are no separable parts — the whole thing is
// labeled as one object and the pipeline notes parts aren't separable.

import { decodeName } from '../scene/summarize.js';
import { isMeaningfulName } from './diagnostics.js';

const MAX_NODES = 40; // context budget — never dump a 200-node table

const LABEL_SYSTEM =
`You name the parts of a 3D model from a descriptor table (you cannot see geometry).
Each row: an id, then derived facts (shape, color, region, size, symmetry pair, parent, original-name-hint).
Reply with one line per id you can name: "<id>: <short human label>".
Use concrete part nouns (e.g. "Tail Light (right)", "Dump Bed", "Cab", "Front Left Wheel").
Convention: +X / RIGHT = the model's own right. Skip ids you genuinely cannot name. No other text.`;

// ── Build the compact descriptor table the LLM reads ──────────────────────────

function labelableNodes( root ) {

	const out = [];
	root.traverse( n => {

		if ( n === root && ! n.isMesh ) return; // skip the bare wrapper group
		const d = n.userData && n.userData.descriptors;
		if ( ! d ) return;
		if ( n.isMesh || d.role === 'group' ) out.push( n );

	} );
	return out;

}

function row( id, node ) {

	const d = node.userData.descriptors;
	const bits = [ d.role ];
	if ( d.color ) bits.push( d.color.base );
	if ( d.shape ) bits.push( d.shape );
	if ( d.orientation ) bits.push( d.orientation );
	const reg = [ d.region.x, d.region.y, d.region.z ].filter( r => r !== 'center' );
	if ( reg.length ) bits.push( reg.join( '/' ) );
	if ( d.pair ) bits.push( `pair(${ d.pair.side })` );
	if ( d.sizeRank !== 'medium' ) bits.push( d.sizeRank );
	bits.push( `parent:${ d.parentName }` );

	// Original name only as a HINT, and only if it isn't an exporter placeholder.
	const hint = isMeaningfulName( node.name ) ? `, hint:"${ decodeName( node.name ) }"` : '';

	return `${ id }  ${ bits.join( ', ' ) }${ hint }`;

}

/**
 * Build the id→node map and the descriptor text block for the LLM.
 * @returns {{ idMap: Map<string,THREE.Object3D>, table: string, nodes: THREE.Object3D[] }}
 */
export function buildLabelTable( root ) {

	const nodes = labelableNodes( root ).slice( 0, MAX_NODES );
	const idMap = new Map();
	const lines = nodes.map( ( node, i ) => {

		const id = `n${ i }`;
		idMap.set( id, node );
		return row( id, node );

	} );

	return { idMap, table: lines.join( '\n' ), nodes };

}

// ── Parse the LLM reply ───────────────────────────────────────────────────────

/**
 * Parse "id: Label" lines into a Map. Tolerant of ":", "=", "-" separators and
 * surrounding quotes/bullets. Ignores anything that doesn't look like a row.
 * @param {string} text
 * @returns {Map<string,string>}
 */
export function parseLabelReply( text ) {

	const out = new Map();
	for ( const raw of String( text || '' ).split( /\r?\n/ ) ) {

		const line = raw.replace( /^[\s*\-•\d.)]+/, '' ).trim();
		const m = line.match( /^([\w.-]+)\s*[:=]\s*(.+)$/ );
		if ( ! m ) continue;
		const id = m[ 1 ];
		let label = m[ 2 ].trim().replace( /^["'`]|["'`]$/g, '' ).trim();
		if ( label ) out.set( id, label );

	}
	return out;

}

// ── Main: run the pass once, cache to userData.label ──────────────────────────

/**
 * @param {Editor} editor       needs editor.aiEngine (the already-loaded LLM)
 * @param {THREE.Object3D} root indexed (descriptors present) imported root
 * @param {object} [opts]
 * @param {boolean} [opts.force=false] re-run even if labels already cached
 * @returns {Promise<{ labeled:number, total:number, skipped?:string }>}
 */
export async function labelImportedAsset( editor, root, opts = {} ) {

	const aiEngine = editor && editor.aiEngine;
	if ( ! aiEngine || ! aiEngine.ready ) return { labeled: 0, total: 0, skipped: 'no-llm' };

	// Run once: if the root already carries a label pass, don't re-spend tokens.
	if ( ! opts.force && root.userData.labelPass ) return { labeled: 0, total: 0, skipped: 'cached' };

	const { idMap, table, nodes } = buildLabelTable( root );
	if ( nodes.length === 0 ) return { labeled: 0, total: 0, skipped: 'no-nodes' };

	// Merged mesh: one renderable node — label the whole object, note non-separable.
	if ( nodes.length === 1 ) {

		const node = nodes[ 0 ];
		try {

			const reply = await aiEngine.complete( [
				{ role: 'system', content: 'Name this single 3D object in 1-4 words from its descriptor. Reply with only the name.' },
				{ role: 'user', content: table },
			], { maxTokens: 16, temperature: 0 } );
			const name = String( reply || '' ).split( /\r?\n/ )[ 0 ].trim().replace( /^["'`]|["'`]$/g, '' );
			if ( name ) node.userData.label = name;

		} catch { /* leave unlabeled */ }

		node.userData.partsSeparable = false;
		root.userData.labelPass = { v: 1, mergedMesh: true, labeled: node.userData.label ? 1 : 0 };
		return { labeled: node.userData.label ? 1 : 0, total: 1 };

	}

	let labels;
	try {

		const reply = await aiEngine.complete( [
			{ role: 'system', content: LABEL_SYSTEM },
			{ role: 'user', content: `DESCRIPTOR TABLE:\n${ table }` },
		], { maxTokens: 400, temperature: 0 } );
		labels = parseLabelReply( reply );

	} catch ( e ) {

		root.userData.labelPass = { v: 1, error: String( e && e.message || e ), labeled: 0 };
		return { labeled: 0, total: nodes.length, skipped: 'llm-error' };

	}

	let labeled = 0;
	for ( const [ id, label ] of labels ) {

		const node = idMap.get( id );
		if ( ! node ) continue;
		node.userData.label = label;
		labeled ++;

	}

	root.userData.labelPass = { v: 1, mergedMesh: false, labeled, total: nodes.length };
	return { labeled, total: nodes.length };

}
