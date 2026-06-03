// ── bevel.js ──────────────────────────────────────────────────────────────────
// Bevel selected faces: chamfer each face edge outward by `amount`.
// Implementation: inset the face (pull verts toward center), then extrude
// the inset ring outward by a small amount — creates a rounded stepped edge.
//
// This gives a visually useful "bevel" result without requiring the full
// edge-topology surgery of a true Blender-style edge bevel.

import { registerOp } from './index.js';

export function bevel( em, selection, { amount = 0.1, segments = 1 } = {} ) {

	const THREE = window.THREE;
	const facesToProcess = [ ...selection.faces ].filter( id => em.faces[ id ] );

	for ( const faceId of facesToProcess ) {

		const normal = em.faceNormal( faceId );
		const [ v0, v1, v2 ] = em.faceVertices( faceId );
		const center = em.faceCenter( faceId );

		// Step 1: compute inset vertices (the "bevel ring")
		const t = Math.max( 0, Math.min( 0.5, amount ) );
		const lerp = ( v ) => em.addVertex(
			v.x + ( center.x - v.x ) * t,
			v.y + ( center.y - v.y ) * t,
			v.z + ( center.z - v.z ) * t,
		);

		const r0 = lerp( v0 );
		const r1 = lerp( v1 );
		const r2 = lerp( v2 );

		// Step 2: sloped border faces (connecting original outer edges to inner ring)
		em.addFace( v0.id, v1.id, r1.id );
		em.addFace( v0.id, r1.id, r0.id );
		em.addFace( v1.id, v2.id, r2.id );
		em.addFace( v1.id, r2.id, r1.id );
		em.addFace( v2.id, v0.id, r0.id );
		em.addFace( v2.id, r0.id, r2.id );

		// Step 3: replace original face with inner (bevel) cap
		em.removeFace( faceId );
		em.addFace( r0.id, r1.id, r2.id );

	}

}

registerOp( 'bevel', {
	description: 'Chamfer (bevel) selected faces by pulling edges inward and creating a stepped border',
	params: { 'amount?': 'number=0.1' },
	example: 'bevel(em, selection, { amount: 0.15 })',
} );
