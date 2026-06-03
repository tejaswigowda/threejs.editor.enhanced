// ── uv.js ─────────────────────────────────────────────────────────────────────
// UV projection ops for Edit Mode.
// UVs are stored per half-edge (face-corner), allowing UV seams.
//
// planarUV(em, selection, axis)  — project onto a plane perpendicular to axis
// boxUV(em, selection)           — per-face project by dominant normal direction

import { registerOp } from './index.js';

// ── Planar UV ─────────────────────────────────────────────────────────────────

/**
 * Project selected face vertices onto a plane perpendicular to `axis`.
 * UV coords are normalised to [0,1] across the selection bounding box.
 *
 * @param {EditableMesh}  em
 * @param {Selection}     selection
 * @param {'x'|'y'|'z'}  [axis='y']
 */
export function planarUV( em, selection, axis = 'y' ) {

	const faces = [ ...selection.faces ].filter( id => em.faces[ id ] );
	if ( ! faces.length ) return;

	// Choose U/V axes based on projection axis
	const [ uAxis, vAxis ] = {
		x: [ 'z', 'y' ],
		y: [ 'x', 'z' ],
		z: [ 'x', 'y' ],
	}[ axis.toLowerCase() ] ?? [ 'x', 'z' ];

	// Compute bounding box of selection for normalisation
	let minU = Infinity, maxU = - Infinity, minV = Infinity, maxV = - Infinity;

	for ( const faceId of faces ) {

		for ( const v of em.faceVertices( faceId ) ) {

			if ( v[ uAxis ] < minU ) minU = v[ uAxis ];
			if ( v[ uAxis ] > maxU ) maxU = v[ uAxis ];
			if ( v[ vAxis ] < minV ) minV = v[ vAxis ];
			if ( v[ vAxis ] > maxV ) maxV = v[ vAxis ];

		}

	}

	const uRange = maxU - minU || 1;
	const vRange = maxV - minV || 1;

	// Assign UVs to half-edges (face-corners)
	for ( const faceId of faces ) {

		const hes = em.faceHalfEdges( faceId );

		for ( const he of hes ) {

			const v = em.vertices[ he.v ];
			he.u  = ( v[ uAxis ] - minU ) / uRange;
			he.vt = ( v[ vAxis ] - minV ) / vRange;

		}

	}

}

// ── Box UV ────────────────────────────────────────────────────────────────────

/**
 * Assign UVs using box (cubic) projection: each face is projected based on its
 * dominant normal direction, then normalised independently.
 */
export function boxUV( em, selection ) {

	const faces = [ ...selection.faces ].filter( id => em.faces[ id ] );

	for ( const faceId of faces ) {

		const n    = em.faceNormal( faceId );
		const ax   = Math.abs( n.x ), ay = Math.abs( n.y ), az = Math.abs( n.z );
		const axis = ax >= ay && ax >= az ? 'x' : ay >= az ? 'y' : 'z';

		const [ uAxis, vAxis ] = { x: [ 'z', 'y' ], y: [ 'x', 'z' ], z: [ 'x', 'y' ] }[ axis ];

		const hes = em.faceHalfEdges( faceId );

		for ( const he of hes ) {

			const v = em.vertices[ he.v ];
			he.u  = v[ uAxis ];
			he.vt = v[ vAxis ];

		}

	}

}

// ── Register ──────────────────────────────────────────────────────────────────

registerOp( 'planarUV', {
	description: "Project UV onto a plane perpendicular to axis ('x'|'y'|'z')",
	params: { 'axis?': "string='y'" },
	example: "planarUV(em, selection, 'y')",
} );

registerOp( 'boxUV', {
	description: 'Box (cubic) UV projection — each face projected by its dominant normal',
	params: {},
	example: 'boxUV(em, selection)',
} );
