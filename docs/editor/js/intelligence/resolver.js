// ── resolver.js ───────────────────────────────────────────────────────────────
// Query resolution over derived descriptors.
//   Path A — deterministic rule match (no inference, free, offline).
//   Path B — disambiguation by the ALREADY-LOADED code LLM over a pre-filtered,
//            compact descriptor table (no new model).
//
// Never silently wrong: returns confidence and ranked candidates; ambiguous
// queries surface candidates rather than guessing.

import { decodeName } from '../scene/summarize.js';
import { isMeaningfulName } from '../import/diagnostics.js';

// ── Query parsing ─────────────────────────────────────────────────────────────

const COLOR_WORDS = [ 'red', 'orange', 'yellow', 'lime', 'green', 'teal', 'cyan',
	'blue', 'purple', 'magenta', 'pink', 'brown', 'gray', 'grey', 'black', 'white' ];

const REGION_WORDS = {
	left: [ 'x', 'left' ], right: [ 'x', 'right' ],
	top: [ 'y', 'top' ], bottom: [ 'y', 'bottom' ], upper: [ 'y', 'top' ], lower: [ 'y', 'bottom' ],
	front: [ 'z', 'front' ], back: [ 'z', 'back' ], rear: [ 'z', 'back' ],
};

// part nouns → shape role hints (guesses, carry low weight)
const SHAPE_WORDS = {
	arm: 'elongated', leg: 'elongated', limb: 'elongated', wing: 'elongated',
	pole: 'elongated', rod: 'elongated', bar: 'elongated', pipe: 'elongated',
	panel: 'flat', plate: 'flat', sheet: 'flat', screen: 'flat', floor: 'flat', wall: 'flat',
	box: 'blocky', block: 'blocky', body: 'blocky', head: 'blocky', cube: 'blocky',
	wheel: 'blocky', // round but compact
};

const SIZE_WORDS = {
	biggest: 'largest', largest: 'largest', tallest: 'largest', longest: 'largest', main: 'largest',
	smallest: 'smallest', tiniest: 'smallest', littlest: 'smallest',
};

// Words that carry no part-identity (stripped before matching cached labels).
const LABEL_STOP = new Set( [ 'the', 'and', 'make', 'turn', 'set', 'change', 'this',
	'that', 'these', 'those', 'with', 'into', 'for', 'all', 'both', 'two', 'part', 'parts',
	'red', 'orange', 'yellow', 'lime', 'green', 'teal', 'cyan', 'blue', 'purple', 'magenta',
	'pink', 'brown', 'gray', 'grey', 'black', 'white', 'bigger', 'smaller', 'color', 'colour' ] );

export function parseQuery( text ) {

	const t = String( text ).toLowerCase();
	const words = t.split( /[^a-z0-9]+/ ).filter( Boolean );

	const q = { colors: [], regions: [], shapes: [], size: null, pair: false, tokens: words, raw: t };

	for ( const w of words ) {

		const c = w === 'grey' ? 'gray' : w;
		if ( COLOR_WORDS.includes( c ) ) q.colors.push( c );
		if ( REGION_WORDS[ w ] ) q.regions.push( REGION_WORDS[ w ] );
		if ( SHAPE_WORDS[ w ] ) q.shapes.push( SHAPE_WORDS[ w ] );
		if ( SIZE_WORDS[ w ] ) q.size = SIZE_WORDS[ w ];
		if ( w === 'two' || w === 'pair' || w === 'both' ) q.pair = true;

	}

	return q;

}

// ── Path A: deterministic scoring ─────────────────────────────────────────────

/**
 * @param {Array} nodes   candidate nodes (each with userData.descriptors)
 * @param {object} q       parsed query
 * @returns {Array<{ node, score, reasons }>}  ranked, descending
 */
export function scoreCandidates( nodes, q ) {

	// If a color group is named ("red person"), restrict to descendants of the
	// best-matching colored group first.
	let pool = nodes;

	if ( q.colors.length ) {

		const groups = nodes.filter( n => {

			const d = n.userData.descriptors;
			return d && d.role === 'group' && d.color && q.colors.includes( d.color.base );

		} );

		if ( groups.length ) {

			// Largest matching group = "the red person"
			groups.sort( ( a, b ) => b.userData.descriptors.volume - a.userData.descriptors.volume );
			const top = groups[ 0 ];
			const within = [];
			top.traverse( c => { if ( c !== top && c.userData.descriptors ) within.push( c ); } );
			if ( within.length ) pool = within;

		}

	}

	const ranked = [];

	for ( const node of pool ) {

		const d = node.userData.descriptors;
		if ( ! d ) continue;

		let score = 0;
		const reasons = [];

		// Stage-4 LLM label match — the import labeling pass cached human nouns in
		// userData.label ("Dump Bed", "Tail Light (right)"). This is what makes an
		// opaque Object_N asset addressable: "make the dump bed red" matches here.
		const label = node.userData.label;
		if ( label && q.tokens.length ) {

			const ll = String( label ).toLowerCase();
			let hits = 0;
			for ( const w of q.tokens ) {

				if ( w.length < 3 || LABEL_STOP.has( w ) ) continue;
				if ( ll.includes( w ) ) hits ++;

			}

			if ( hits > 0 ) { score += 4 * hits; reasons.push( 'label:' + label ); }

		}

		// Meaningful original-name match — many GLBs name a mesh "Body", "Cab",
		// "Wheel_FL". Gated by isMeaningfulName so exporter placeholders (Object_7,
		// mesh_0) add no noise. Weaker than an LLM label, stronger than shape alone.
		const rawName = node.name;
		if ( rawName && q.tokens.length && isMeaningfulName( rawName ) ) {

			const nn = decodeName( rawName ).toLowerCase();
			let hits = 0;
			for ( const w of q.tokens ) {

				if ( w.length < 3 || LABEL_STOP.has( w ) ) continue;
				if ( nn.includes( w ) ) hits ++;

			}

			if ( hits > 0 ) { score += 3 * hits; reasons.push( 'name:' + decodeName( rawName ) ); }

		}

		// Material-name match — glTF carries semantic material names ("Rims",
		// "Grille", "Glass") even when every mesh is an opaque Object_N. They are a
		// strong identity signal: "make the grille silver" matches material "Grille".
		// Weighted like a meaningful node name (just under an LLM label).
		const materials = d.materials;
		if ( materials && materials.length && q.tokens.length ) {

			const mm = materials.join( ' ' ).toLowerCase();
			let hits = 0;
			for ( const w of q.tokens ) {

				if ( w.length < 3 || LABEL_STOP.has( w ) ) continue;
				if ( mm.includes( w ) ) hits ++;

			}

			if ( hits > 0 ) { score += 3 * hits; reasons.push( 'material:' + materials.join( '/' ) ); }

		}

		// Color
		if ( q.colors.length && d.color ) {

			if ( q.colors.includes( d.color.base ) ) { score += 3; reasons.push( 'color' ); }
			else score -= 1;

		}

		// Region — prefer explicit symmetry side, fall back to bbox region
		for ( const [ axis, side ] of q.regions ) {

			if ( axis === 'x' && d.pair && d.pair.side === side ) { score += 3; reasons.push( 'pair-' + side ); }
			else if ( d.region[ axis ] === side ) { score += 2; reasons.push( side ); }
			else score -= 0.5;

		}

		// Shape
		if ( q.shapes.length ) {

			if ( q.shapes.includes( d.shape ) ) { score += 2; reasons.push( 'shape:' + d.shape ); }
			// elongated parts that have a symmetric mate read strongly as limbs
			if ( q.shapes.includes( 'elongated' ) && d.shape === 'elongated' && d.pair ) { score += 1; reasons.push( 'limb-pair' ); }

		}

		// Size
		if ( q.size && d.sizeRank === q.size ) { score += 2; reasons.push( 'size:' + q.size ); }

		// Pair request ("the two wheels")
		if ( q.pair && d.pair ) { score += 1; reasons.push( 'paired' ); }

		if ( score > 0 ) ranked.push( { node, score, reasons } );

	}

	ranked.sort( ( a, b ) => b.score - a.score );

	// A part reference ("truck body", "the panel") names a RENDERABLE part. When
	// any mesh matched, drop structural wrapper groups (the .glb root,
	// "Sketchfab_model", merge containers) from the result: they represent the
	// WHOLE asset and tie on shape:blocky, and a material edit on a Group is a
	// silent no-op. Color-group queries already narrow the pool to meshes upstream.
	const meshHits = ranked.filter( r => r.node.isMesh );
	return meshHits.length ? meshHits : ranked;

}

// ── Path B: LLM disambiguation over a compact descriptor table ────────────────

const RESOLVER_SYSTEM =
`You map a natural-language part reference to a node id, using ONLY the descriptor table.
Reply with exactly: <node_id> <confidence 0-1>   (e.g. "node_47 0.9"). If none fit, reply "none".
Convention: +X / RIGHT = the model's own right. No other output.`;

function descriptorLine( id, node ) {

	const d = node.userData.descriptors;
	if ( ! d ) return `${ id }  (no descriptors)`;
	const bits = [ d.role ];
	if ( node.userData.label ) bits.push( `"${ node.userData.label }"` );
	if ( d.color ) bits.push( d.color.base );
	if ( d.shape ) bits.push( d.shape );
	if ( d.orientation ) bits.push( d.orientation );
	const reg = [ d.region.x, d.region.y, d.region.z ].filter( r => r !== 'center' );
	if ( reg.length ) bits.push( reg.join( '/' ) );
	if ( d.pair ) bits.push( `pair→${ d.pair.mateName }(${ d.pair.side })` );
	if ( d.sizeRank !== 'medium' ) bits.push( d.sizeRank );
	if ( d.materials && d.materials.length ) bits.push( `material:"${ d.materials.join( '/' ) }"` );
	bits.push( `parent:${ d.parentName }` );
	return `${ id }  ${ bits.join( ', ' ) }`;

}

/**
 * Build the compact table + ask the loaded LLM. Pre-filter candidates BEFORE
 * calling this (context budget — never dump 200 nodes).
 *
 * @param {AIEngine} aiEngine
 * @param {string}   text
 * @param {Array}    candidates   pre-filtered nodes
 * @returns {Promise<{ node, confidence } | null>}
 */
export async function resolveWithLLM( aiEngine, text, candidates ) {

	if ( ! aiEngine || ! aiEngine.ready || candidates.length === 0 ) return null;

	const idMap = new Map();
	const lines = candidates.slice( 0, 24 ).map( ( node, i ) => {

		const id = node.name && /^[\w.-]+$/.test( node.name ) ? node.name : `cand_${ i }`;
		idMap.set( id, node );
		return descriptorLine( id, node );

	} );

	const messages = [
		{ role: 'system', content: RESOLVER_SYSTEM },
		{ role: 'user', content: `DESCRIPTOR TABLE:\n${ lines.join( '\n' ) }\n\nQUERY: "${ text }"` },
	];

	const reply = ( await aiEngine.complete( messages, { maxTokens: 24, temperature: 0 } ) ).trim();

	if ( /^none\b/i.test( reply ) ) return null;

	const m = reply.match( /([\w.-]+)\s+([01](?:\.\d+)?)/ );
	const id = m ? m[ 1 ] : reply.split( /\s+/ )[ 0 ];
	const confidence = m ? parseFloat( m[ 2 ] ) : 0.5;

	const node = idMap.get( id );
	return node ? { node, confidence } : null;

}
