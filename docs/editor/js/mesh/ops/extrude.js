// ── extrude.js ────────────────────────────────────────────────────────────────
// Extrude selected faces along their averaged normal by `distance`.
// For each selected face:
//   1. New vertices are created at original positions (base ring)
//   2. Original vertices move along normal → new cap position
//   3. Three side quads (6 triangles) connect base to cap
//   4. Original face (now the cap) keeps its half-edges, pointing at moved verts
//
// The result is a "push" extrusion that leaves the surrounding mesh intact.

import { registerOp } from './index.js';

export function extrude( em, selection, { distance = 1 } = {} ) {

	const THREE = window.THREE;
	const facesToProcess = [ ...selection.faces ].filter( id => em.faces[ id ] );

	for ( const faceId of facesToProcess ) {

		const normal = em.faceNormal( faceId );
		const [ v0, v1, v2 ] = em.faceVertices( faceId );

		const dx = normal.x * distance;
		const dy = normal.y * distance;
		const dz = normal.z * distance;

		// Base ring: new vertices at original positions (stay behind)
		const b0 = em.addVertex( v0.x, v0.y, v0.z );
		const b1 = em.addVertex( v1.x, v1.y, v1.z );
		const b2 = em.addVertex( v2.x, v2.y, v2.z );

		// Move original vertices to extruded (cap) position
		v0.x += dx; v0.y += dy; v0.z += dz;
		v1.x += dx; v1.y += dy; v1.z += dz;
		v2.x += dx; v2.y += dy; v2.z += dz;

		// Side quads (two triangles each, wound to face outward)
		em.addFace( b0.id, b1.id, v1.id );   // side 0 — tri A
		em.addFace( b0.id, v1.id, v0.id );   // side 0 — tri B
		em.addFace( b1.id, b2.id, v2.id );   // side 1 — tri A
		em.addFace( b1.id, v2.id, v1.id );   // side 1 — tri B
		em.addFace( b2.id, b0.id, v0.id );   // side 2 — tri A
		em.addFace( b2.id, v0.id, v2.id );   // side 2 — tri B

		// Original face is now the cap — vertices already moved; no topology change needed.

	}

}

registerOp( 'extrude', {
	description: 'Extrude selected faces along their normal',
	params: { 'distance?': 'number=1' },
	example: 'extrude(em, selection, { distance: 2 })',
} );
