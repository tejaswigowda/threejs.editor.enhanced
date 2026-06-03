// ── inset.js ──────────────────────────────────────────────────────────────────
// Inset selected faces: shrink each face toward its center by `amount`.
// For each selected face:
//   1. New inner vertices are lerped toward the face center
//   2. Three border quads (6 triangles) fill the gap between outer and inner edges
//   3. The original face is updated to use inner vertices (shrunken cap)

import { registerOp } from './index.js';

export function inset( em, selection, { amount = 0.2 } = {} ) {

	const THREE = window.THREE;
	const facesToProcess = [ ...selection.faces ].filter( id => em.faces[ id ] );

	for ( const faceId of facesToProcess ) {

		const [ v0, v1, v2 ] = em.faceVertices( faceId );
		const center = em.faceCenter( faceId );
		const t = Math.max( 0, Math.min( 1, amount ) );

		// Inner (inset) vertex positions: lerp from corner toward center
		const lerp = ( v ) => ( {
			x: v.x + ( center.x - v.x ) * t,
			y: v.y + ( center.y - v.y ) * t,
			z: v.z + ( center.z - v.z ) * t,
		} );

		const i0 = em.addVertex( ...Object.values( lerp( v0 ) ) );
		const i1 = em.addVertex( ...Object.values( lerp( v1 ) ) );
		const i2 = em.addVertex( ...Object.values( lerp( v2 ) ) );

		// Border quads connecting outer edge to inner edge
		em.addFace( v0.id, v1.id, i1.id );
		em.addFace( v0.id, i1.id, i0.id );
		em.addFace( v1.id, v2.id, i2.id );
		em.addFace( v1.id, i2.id, i1.id );
		em.addFace( v2.id, v0.id, i0.id );
		em.addFace( v2.id, i0.id, i2.id );

		// Replace original face with inner triangle
		em.removeFace( faceId );
		em.addFace( i0.id, i1.id, i2.id );

	}

}

registerOp( 'inset', {
	description: 'Inset selected faces toward their center (0=no change, 1=collapse to point)',
	params: { 'amount?': 'number=0.2' },
	example: 'inset(em, selection, { amount: 0.3 })',
} );
