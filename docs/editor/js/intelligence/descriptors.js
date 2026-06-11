// ── descriptors.js ────────────────────────────────────────────────────────────
// Layer 1 (geometry/spatial/shape/adjacency) + Layer 2 (color) descriptor
// derivation. Pure math + texture pixel sampling — NO model.
//
// indexSubtree(root) computes node.userData.descriptors for every node in the
// subtree. Idempotent: skips nodes whose geometry hash is unchanged.
//
// Descriptor bundle shape (per node):
//   {
//     v: 1,                          schema version
//     geomHash: string,             for invalidation
//     bbox: { center:[x,y,z], size:[x,y,z] },   world-space
//     region: { x, y, z },          'left|center|right' etc.
//     shape: 'elongated'|'flat'|'blocky'|'thin',
//     orientation: 'vertical'|'horizontal'|null,
//     sizeRank: 'largest'|'medium'|'smallest',
//     volume: number,
//     role: 'leaf'|'group',
//     childCount, depth, parentName,
//     adjacency: [names...],        siblings whose bbox this overlaps
//     color: { name, base, hex } | null,
//     materials: [string...],       decoded material name(s) ("Rims","Grille")
//     pair: { mateUuid, axis, side } | null
//   }

import { colorToName, rgbToColorName } from './colorName.js';
import { detectSymmetryPairs } from './symmetry.js';
import { materialNames } from '../scene/summarize.js';

const SCHEMA = 1;

// ── Geometry hash (cheap, for invalidation) ───────────────────────────────────

export function geometryHash( geometry ) {

	if ( ! geometry ) return 'none';
	const pos = geometry.attributes && geometry.attributes.position;
	if ( ! pos ) return 'empty';
	if ( ! geometry.boundingSphere ) geometry.computeBoundingSphere();
	const r = geometry.boundingSphere ? Math.round( geometry.boundingSphere.radius * 1000 ) : 0;
	return `${ pos.count }:${ r }`;

}

// ── World-space bbox helpers ──────────────────────────────────────────────────

function worldBox( obj ) {

	const THREE = window.THREE;
	const box = new THREE.Box3().setFromObject( obj );
	if ( box.isEmpty() ) return null;
	const c = new THREE.Vector3(), s = new THREE.Vector3();
	box.getCenter( c );
	box.getSize( s );
	return { box, center: [ c.x, c.y, c.z ], size: [ s.x, s.y, s.z ] };

}

// ── Region: normalize centroid into parent bbox [0..1]³ ───────────────────────

function regionOf( centroid, parentInfo ) {

	const out = {};
	const axes = [ 'x', 'y', 'z' ];
	const lo = [ 'left', 'bottom', 'back' ];
	const hi = [ 'right', 'top', 'front' ];

	for ( let i = 0; i < 3; i ++ ) {

		const pc = parentInfo.center[ i ];
		const ps = parentInfo.size[ i ] || 1e-4;
		const t  = ( centroid[ i ] - ( pc - ps / 2 ) ) / ps; // 0..1
		out[ axes[ i ] ] = t < 0.38 ? lo[ i ] : t > 0.62 ? hi[ i ] : 'center';

	}

	return out;

}

// ── Shape hint from sorted bbox dims ──────────────────────────────────────────

function shapeOf( size ) {

	const s = [ ...size ].sort( ( a, b ) => a - b ); // ascending [small, mid, large]
	const [ small, mid, large ] = s;
	const eps = 1e-5;
	if ( large < eps ) return 'blocky';

	const longRatio = large / ( mid + eps );
	const flatRatio = small / ( mid + eps );

	if ( longRatio > 2.2 && flatRatio > 0.5 ) return 'elongated'; // one axis ≫ others
	if ( flatRatio < 0.18 ) return 'flat';                         // one axis ≪ others
	if ( longRatio > 2.2 ) return 'thin';                          // long and slim
	return 'blocky';

}

function orientationOf( size ) {

	// Index of the longest axis
	let li = 0;
	for ( let i = 1; i < 3; i ++ ) if ( size[ i ] > size[ li ] ) li = i;
	if ( size[ li ] < 1e-5 ) return null;
	if ( li === 1 ) return 'vertical';
	return 'horizontal';

}

// ── Color (Layer 2) ───────────────────────────────────────────────────────────

function dominantTextureColor( map ) {

	try {

		const img = map.image;
		if ( ! img || ! ( img.width || img.naturalWidth ) ) return null;

		const N = 16;
		const canvas = document.createElement( 'canvas' );
		canvas.width = canvas.height = N;
		const ctx = canvas.getContext( '2d', { willReadFrequently: true } );
		ctx.drawImage( img, 0, 0, N, N );
		const data = ctx.getImageData( 0, 0, N, N ).data;

		// Bucket by base color name, weight by alpha; take the mode
		const counts = new Map();
		let rSum = 0, gSum = 0, bSum = 0, wSum = 0;

		for ( let i = 0; i < data.length; i += 4 ) {

			const a = data[ i + 3 ] / 255;
			if ( a < 0.5 ) continue;
			const r = data[ i ] / 255, g = data[ i + 1 ] / 255, b = data[ i + 2 ] / 255;
			rSum += r * a; gSum += g * a; bSum += b * a; wSum += a;
			const { base } = rgbToColorName( r, g, b );
			counts.set( base, ( counts.get( base ) || 0 ) + a );

		}

		if ( wSum === 0 ) return null;

		// Mode base, but report the averaged hex for display
		let modeBase = null, modeCount = - 1;
		for ( const [ k, v ] of counts ) if ( v > modeCount ) { modeCount = v; modeBase = k; }

		const ar = rSum / wSum, ag = gSum / wSum, ab = bSum / wSum;
		const named = rgbToColorName( ar, ag, ab );
		const hex = '#' + [ ar, ag, ab ].map( c => Math.round( c * 255 ).toString( 16 ).padStart( 2, '0' ) ).join( '' );

		return { name: named.name, base: modeBase || named.base, hex };

	} catch {

		return null; // CORS-tainted texture or no 2D context

	}

}

function colorOf( mesh ) {

	const mat = Array.isArray( mesh.material ) ? mesh.material[ 0 ] : mesh.material;
	if ( ! mat ) return null;

	// Prefer a real texture's dominant color over a default-white base color
	if ( mat.map && mat.color && mat.color.r > 0.92 && mat.color.g > 0.92 && mat.color.b > 0.92 ) {

		const tex = dominantTextureColor( mat.map );
		if ( tex ) return tex;

	}

	if ( mat.color ) return colorToName( mat.color );
	if ( mat.map ) { const tex = dominantTextureColor( mat.map ); if ( tex ) return tex; }
	return null;

}

// ── Adjacency: which sibling boxes this one overlaps ──────────────────────────

function overlaps( a, b ) {

	return a.box.min.x <= b.box.max.x && a.box.max.x >= b.box.min.x &&
		a.box.min.y <= b.box.max.y && a.box.max.y >= b.box.min.y &&
		a.box.min.z <= b.box.max.z && a.box.max.z >= b.box.min.z;

}

// ── Group dominant color: most common base among descendant meshes ────────────

function groupColor( node ) {

	const counts = new Map();
	let sampleHex = null;

	node.traverse( c => {

		if ( ! c.isMesh ) return;
		const col = colorOf( c );
		if ( ! col ) return;
		counts.set( col.base, ( counts.get( col.base ) || 0 ) + 1 );
		if ( ! sampleHex ) sampleHex = col.hex;

	} );

	if ( counts.size === 0 ) return null;
	let base = null, n = - 1;
	for ( const [ k, v ] of counts ) if ( v > n ) { n = v; base = k; }
	return { name: base, base, hex: sampleHex };

}

// ── Material names (decoded, de-duplicated) ───────────────────────────────────
// glTF carries semantic material names ("Rims", "Grille", "Tail Light") even when
// every mesh is an opaque Object_N — high-value resolution + labeling hints. For a
// mesh: its own material name(s); for a group: the union over descendant meshes.

function materialsOf( node ) {

	if ( node.isMesh ) return materialNames( node );

	const out = [];
	node.traverse( c => {

		if ( ! c.isMesh ) return;
		for ( const m of materialNames( c ) ) if ( ! out.includes( m ) ) out.push( m );

	} );
	return out;

}

/**
 * Compute descriptors for every node in `root`'s subtree (including root).
 * Writes to node.userData.descriptors. Idempotent via geometry hash.
 *
 * @param {THREE.Object3D} root
 * @param {boolean} [force=false]  recompute even if hash matches
 */
export function indexSubtree( root, force = false ) {

	if ( ! root ) return;

	// 1. Collect nodes + world boxes
	const nodes = [];
	root.traverse( n => { if ( n !== root || n.isMesh || n.isGroup || n.children.length ) nodes.push( n ); } );

	const boxMap = new Map();
	for ( const n of nodes ) {

		const info = worldBox( n );
		if ( info ) boxMap.set( n, info );

	}

	// 2. Group children by parent for sibling-relative computations
	const byParent = new Map();
	for ( const n of nodes ) {

		const p = n.parent;
		if ( ! byParent.has( p ) ) byParent.set( p, [] );
		byParent.get( p ).push( n );

	}

	// 3. Per-node descriptors
	for ( const n of nodes ) {

		const info = boxMap.get( n );
		if ( ! info ) continue;

		const hash = n.isMesh ? geometryHash( n.geometry ) : `grp:${ n.children.length }`;
		const existing = n.userData.descriptors;
		if ( ! force && existing && existing.geomHash === hash && existing.v === SCHEMA ) continue;

		const siblings = ( byParent.get( n.parent ) || [] ).filter( s => s !== n && boxMap.has( s ) );

		// Region relative to parent (or to root if parent is the scene/root)
		const parentInfo = ( n.parent && boxMap.has( n.parent ) )
			? boxMap.get( n.parent )
			: ( boxMap.get( root ) || info );
		const region = regionOf( info.center, parentInfo );

		// Size rank among siblings (+ self) by volume
		const vol = info.size[ 0 ] * info.size[ 1 ] * info.size[ 2 ];
		const sibVols = siblings.map( s => {
			const si = boxMap.get( s );
			return si.size[ 0 ] * si.size[ 1 ] * si.size[ 2 ];
		} );
		let sizeRank = 'medium';
		if ( sibVols.length ) {

			const maxV = Math.max( vol, ...sibVols );
			const minV = Math.min( vol, ...sibVols );
			if ( vol >= maxV - 1e-9 ) sizeRank = 'largest';
			else if ( vol <= minV + 1e-9 ) sizeRank = 'smallest';

		}

		// Adjacency
		const adjacency = [];
		for ( const s of siblings ) {

			if ( overlaps( info, boxMap.get( s ) ) ) adjacency.push( s.name || s.uuid.slice( 0, 6 ) );

		}

		const color = n.isMesh ? colorOf( n ) : groupColor( n );

		n.userData.descriptors = {
			v: SCHEMA,
			geomHash: hash,
			bbox: {
				center: info.center.map( r4 ),
				size:   info.size.map( r4 ),
			},
			region,
			shape: n.isMesh ? shapeOf( info.size ) : 'blocky',
			orientation: orientationOf( info.size ),
			sizeRank,
			volume: r4( vol ),
			role: n.isMesh ? 'leaf' : 'group',
			childCount: n.children.length,
			depth: depthOf( n, root ),
			parentName: ( n.parent && n.parent !== root ? ( n.parent.name || n.parent.type ) : ( root.name || 'root' ) ),
			adjacency,
			color: color || null,
			materials: materialsOf( n ),
			pair: null, // filled in symmetry pass
		};

	}

	// 4. Symmetry pass per parent (mesh siblings only)
	for ( const [ parent, kids ] of byParent ) {

		if ( ! parent || ! boxMap.has( parent ) ) {

			// Parent is root/scene — still pair top-level meshes against root box
			if ( parent !== root && parent !== null ) continue;

		}

		const parentInfo = boxMap.get( parent ) || boxMap.get( root );
		if ( ! parentInfo ) continue;

		const meshKids = kids.filter( k => k.isMesh && boxMap.has( k ) ).map( k => {
			const bi = boxMap.get( k );
			return { node: k, center: bi.center, size: bi.size };
		} );

		if ( meshKids.length < 2 ) continue;

		const pairs = detectSymmetryPairs( parentInfo, meshKids );
		for ( const [ node, info ] of pairs ) {

			if ( node.userData.descriptors ) {

				node.userData.descriptors.pair = {
					mateUuid: info.mate.uuid,
					mateName: info.mate.name || info.mate.uuid.slice( 0, 6 ),
					axis: info.axis,
					side: info.side,
				};

			}

		}

	}

}

// ── Small helpers ─────────────────────────────────────────────────────────────

function r4( v ) { return Math.round( v * 1e4 ) / 1e4; }

function depthOf( node, root ) {

	let d = 0, p = node;
	while ( p && p !== root ) { p = p.parent; d ++; if ( d > 64 ) break; }
	return d;

}
