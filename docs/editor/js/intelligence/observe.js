// ── observe.js ────────────────────────────────────────────────────────────────
// Deterministic observation for the agentic loop (Technique 3c). No model.
//
// snapshotScene(editor)  → compact map of scene state (existence/transform/color)
// sceneDiff(before, after) → { added, removed, moved, recolored, scaled }
// confirmChange(diff, intent) → loose "did anything matching the intent happen?"
//
// The loop uses this to OBSERVE: did the expected object appear/change? The check
// is intentionally loose (per spec risk #6) — it detects "nothing happened",
// not exact value equality, to avoid false-failure retry storms.

function r3( v ) { return Math.round( v * 1e3 ) / 1e3; }

function colorHexOf( obj ) {

	const mat = Array.isArray( obj.material ) ? obj.material[ 0 ] : obj.material;
	if ( mat && mat.color ) return mat.color.getHex();
	return null;

}

// Own size of an object from its geometry bounding box (scaled). null for groups
// / geometry-less objects. Used by the co-location heads-up to exempt thin
// surface/layer detail sitting on a larger flat object.
function objSize( obj ) {

	const g = obj.geometry;
	if ( ! g ) return null;
	if ( ! g.boundingBox ) g.computeBoundingBox();
	const bb = g.boundingBox;
	if ( ! bb ) return null;
	return [
		( bb.max.x - bb.min.x ) * Math.abs( obj.scale.x ),
		( bb.max.y - bb.min.y ) * Math.abs( obj.scale.y ),
		( bb.max.z - bb.min.z ) * Math.abs( obj.scale.z ),
	];

}

/**
 * @param {Editor} editor
 * @returns {Map<string, object>}  uuid → { name, type, pos, scale, color }
 */
export function snapshotScene( editor ) {

	const snap = new Map();

	editor.scene.traverse( obj => {

		if ( obj === editor.scene || obj.isCamera ) return;
		snap.set( obj.uuid, {
			name:  obj.name || obj.type,
			type:  obj.type,
			pos:   [ r3( obj.position.x ), r3( obj.position.y ), r3( obj.position.z ) ],
			scale: [ r3( obj.scale.x ), r3( obj.scale.y ), r3( obj.scale.z ) ],
			color: colorHexOf( obj ),
			parent: obj.parent ? obj.parent.uuid : null,
			size:  objSize( obj ),
		} );

	} );

	return snap;

}

function arrNe( a, b, eps = 1e-3 ) {

	for ( let i = 0; i < a.length; i ++ ) if ( Math.abs( a[ i ] - b[ i ] ) > eps ) return true;
	return false;

}

/**
 * @returns {{ added:[], removed:[], moved:[], scaled:[], recolored:[], total:number }}
 */
export function sceneDiff( before, after ) {

	const added = [], removed = [], moved = [], scaled = [], recolored = [];

	for ( const [ uuid, a ] of after ) {

		const b = before.get( uuid );
		if ( ! b ) { added.push( a.name ); continue; }
		if ( arrNe( a.pos, b.pos ) ) moved.push( a.name );
		if ( arrNe( a.scale, b.scale ) ) scaled.push( a.name );
		if ( a.color !== b.color ) recolored.push( a.name );

	}

	for ( const [ uuid, b ] of before ) {

		if ( ! after.has( uuid ) ) removed.push( b.name );

	}

	const total = added.length + removed.length + moved.length + scaled.length + recolored.length;
	return { added, removed, moved, scaled, recolored, total };

}

/** Human-readable one-liner for the shell. */
export function diffSummary( d ) {

	const parts = [];
	if ( d.added.length )     parts.push( `+${ d.added.length } added (${ d.added.slice( 0, 3 ).join( ', ' ) })` );
	if ( d.removed.length )   parts.push( `−${ d.removed.length } removed` );
	if ( d.moved.length )     parts.push( `${ d.moved.length } moved` );
	if ( d.scaled.length )    parts.push( `${ d.scaled.length } scaled` );
	if ( d.recolored.length ) parts.push( `${ d.recolored.length } recolored` );
	return parts.length ? parts.join( ', ' ) : 'no change';

}

// Intent → which diff bucket should be non-empty.
const INTENT_EXPECT = [
	{ re: /\b(add|create|new|place|spawn|build)\b/, buckets: [ 'added' ] },
	{ re: /\b(remove|delete|clear)\b/,              buckets: [ 'removed' ] },
	{ re: /\b(move|position|next to|above|below)\b/, buckets: [ 'moved', 'added' ] },
	{ re: /\b(scale|bigger|smaller|resize|grow|shrink)\b/, buckets: [ 'scaled' ] },
	{ re: /\b(color|colour|paint|recolor|red|green|blue|purple|yellow|orange)\b/, buckets: [ 'recolored', 'added' ] },
	{ re: /\b(rotate|turn|spin)\b/,                 buckets: [ 'moved' ] }, // rotation not tracked → allow moved/none
];

/**
 * Loose confirmation: did SOMETHING matching the intent happen?
 * Returns { ok, expected, reason }. ok=true unless we strongly expected a change
 * and got literally nothing — the only safe signal to trigger a retry.
 */
export function confirmChange( diff, intent ) {

	const text = String( intent ).toLowerCase();
	const expect = INTENT_EXPECT.find( e => e.re.test( text ) );

	// No clear expectation → accept any non-empty diff, don't punish.
	if ( ! expect ) return { ok: diff.total > 0, expected: 'any', reason: diff.total > 0 ? 'changed' : 'no change' };

	const hit = expect.buckets.some( b => diff[ b ] && diff[ b ].length > 0 );

	// Rotation isn't tracked in the snapshot — never fail a rotate on "no change".
	if ( /\b(rotate|turn|spin)\b/.test( text ) ) return { ok: true, expected: 'rotation', reason: 'not tracked' };

	return {
		ok: hit,
		expected: expect.buckets.join( '/' ),
		reason: hit ? 'matched' : `expected ${ expect.buckets.join( '/' ) } change but scene was unchanged`,
	};

}

// ── Tier-2 geometric verify → repair (Technique 3d) ─────────────────────────────
// The executed scene is GROUND TRUTH. After a generation runs, measure the REAL
// world geometry of the objects it added and surface high-confidence physical
// defects (below ground / interpenetration / floating) so the loop can feed exact
// numbers back for ONE corrective pass. This catches structurally-wrong-but-
// non-empty results that diff-based observation (did anything change?) accepts.
//
// World-space — not the snapshot's LOCAL pos — so nested/grouped/rotated parts are
// measured where they actually are. No THREE dependency: the 8 geometry-box
// corners are pushed through obj.matrixWorld by hand.

// Transform a local point by a column-major Matrix4 elements array.
function applyMat4( e, x, y, z ) {

	const w = ( e[ 3 ] * x + e[ 7 ] * y + e[ 11 ] * z + e[ 15 ] ) || 1;
	return [
		( e[ 0 ] * x + e[ 4 ] * y + e[ 8 ]  * z + e[ 12 ] ) / w,
		( e[ 1 ] * x + e[ 5 ] * y + e[ 9 ]  * z + e[ 13 ] ) / w,
		( e[ 2 ] * x + e[ 6 ] * y + e[ 10 ] * z + e[ 14 ] ) / w,
	];

}

// World axis-aligned bounding box of a mesh (accounts for the full parent chain
// AND rotation). { min:[x,y,z], max:[x,y,z] } or null for geometry-less objects.
function worldAABB( obj ) {

	const g = obj.geometry;
	if ( ! g ) return null;
	if ( ! g.boundingBox ) g.computeBoundingBox();
	const bb = g.boundingBox;
	if ( ! bb ) return null;

	obj.updateWorldMatrix( true, false );
	const e = obj.matrixWorld.elements;
	const min = [ Infinity, Infinity, Infinity ];
	const max = [ - Infinity, - Infinity, - Infinity ];

	for ( const x of [ bb.min.x, bb.max.x ] )
		for ( const y of [ bb.min.y, bb.max.y ] )
			for ( const z of [ bb.min.z, bb.max.z ] ) {

				const p = applyMat4( e, x, y, z );
				for ( let k = 0; k < 3; k ++ ) {

					if ( p[ k ] < min[ k ] ) min[ k ] = p[ k ];
					if ( p[ k ] > max[ k ] ) max[ k ] = p[ k ];

				}

			}

	return { min, max };

}

function aabbSize( box ) { return [ box.max[ 0 ] - box.min[ 0 ], box.max[ 1 ] - box.min[ 1 ], box.max[ 2 ] - box.min[ 2 ] ]; }
function aabbVol( s ) { return Math.max( 1e-6, s[ 0 ] ) * Math.max( 1e-6, s[ 1 ] ) * Math.max( 1e-6, s[ 2 ] ); }
function aabbFlat( s ) { const d = s.map( Math.abs ); return Math.min( ...d ) / Math.max( ...d, 1e-6 ); }

function overlapVol( A, B ) {

	let v = 1;
	for ( let k = 0; k < 3; k ++ ) v *= Math.max( 0, Math.min( A.max[ k ], B.max[ k ] ) - Math.max( A.min[ k ], B.min[ k ] ) );
	return v;

}

// Does some OTHER mesh sit beneath `m` (XZ footprints overlap and its top reaches
// m's base within tol)? i.e. is there something to rest on.
function hasSupportBelow( m, all, tol ) {

	for ( const o of all ) {

		if ( o.uuid === m.uuid ) continue;
		const xOv = Math.min( m.box.max[ 0 ], o.box.max[ 0 ] ) - Math.max( m.box.min[ 0 ], o.box.min[ 0 ] );
		const zOv = Math.min( m.box.max[ 2 ], o.box.max[ 2 ] ) - Math.max( m.box.min[ 2 ], o.box.min[ 2 ] );
		if ( xOv <= 0 || zOv <= 0 ) continue;
		// o's top reaches up to (or through) m's base, and o is not entirely above m.
		if ( o.box.max[ 1 ] >= m.box.min[ 1 ] - tol && o.box.min[ 1 ] <= m.box.max[ 1 ] ) return true;

	}
	return false;

}

/**
 * Inspect the objects added between `before` and `after` for physical defects.
 * Pure read of the live scene (no mutation). Returns { ok, issues:[string] }.
 *
 * @param {Editor} editor
 * @param {Map} before  uuid → snapshot (pre-execution)
 * @param {Map} after   uuid → snapshot (post-execution)
 */
export function inspectScene( editor, before, after ) {

	const GROUND = - 0.25; // tolerance below y=0 before "sunk"
	const FLOAT  = 0.4;    // base height above which "resting on the ground" no longer applies
	const TOL    = 0.15;   // contact tolerance for support

	// Live meshes added this attempt (new uuids with own geometry — skip groups/lights).
	const uuidToObj = new Map();
	editor.scene.traverse( o => uuidToObj.set( o.uuid, o ) );

	const added = [];
	for ( const uuid of after.keys() ) {

		if ( before.has( uuid ) ) continue;
		const obj = uuidToObj.get( uuid );
		if ( ! obj || ! obj.geometry ) continue;
		const box = worldAABB( obj );
		if ( ! box ) continue;
		added.push( { uuid, name: obj.name || obj.type, box, size: aabbSize( box ) } );

	}
	if ( added.length === 0 ) return { ok: true, issues: [] };

	// All meshes (added + pre-existing) for support context.
	const all = [];
	editor.scene.traverse( o => {

		if ( ! o.geometry ) return;
		const box = worldAABB( o );
		if ( box ) all.push( { uuid: o.uuid, name: o.name || o.type, box } );

	} );

	const issues = [];

	// 1. Below ground — the most common, highest-confidence defect.
	for ( const m of added ) {

		if ( m.box.min[ 1 ] < GROUND )
			issues.push( `"${ m.name }" sinks below the ground: its lowest point is y=${ m.box.min[ 1 ].toFixed( 2 ) } (ground is y=0). Raise it so its base sits at or above y=0.` );

	}

	// 2. Interpenetration — two comparably-sized BLOCKY added meshes deeply
	//    overlapping (one buried in the other). Thin overlays/details are exempt.
	for ( let a = 0; a < added.length; a ++ ) {

		for ( let b = a + 1; b < added.length; b ++ ) {

			const A = added[ a ], B = added[ b ];
			const ov = overlapVol( A.box, B.box );
			if ( ov <= 0 ) continue;
			const vA = aabbVol( A.size ), vB = aabbVol( B.size );
			const buried = ov / Math.min( vA, vB );
			const ratio  = Math.min( vA, vB ) / Math.max( vA, vB );
			const flat   = aabbFlat( vA <= vB ? A.size : B.size );
			if ( buried > 0.5 && ratio > 0.25 && flat >= 0.2 )
				issues.push( `"${ A.name }" and "${ B.name }" occupy the same space (one is buried inside the other). Move them apart so they only meet at their surfaces.` );

		}

	}

	// 3. Floating — an added mesh clearly off the ground with nothing beneath it.
	for ( const m of added ) {

		if ( m.box.min[ 1 ] <= FLOAT ) continue;          // resting on/near the ground
		if ( hasSupportBelow( m, all, TOL ) ) continue;   // standing on another object
		issues.push( `"${ m.name }" floats in mid-air: its base is at y=${ m.box.min[ 1 ].toFixed( 2 ) } with nothing beneath it. Rest it on the ground or on top of a supporting object.` );

	}

	return { ok: issues.length === 0, issues };

}

