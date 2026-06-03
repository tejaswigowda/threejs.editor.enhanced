// ── weld.js ───────────────────────────────────────────────────────────────────
// Merge vertices within `threshold` distance of each other.
// After welding, degenerate faces (2+ identical vertex IDs) are deleted.
// A compact() call after this op rebuilds clean topology.

import { registerOp } from './index.js';

export function weld( em, _selection, { threshold = 0.01 } = {} ) {

	const verts = em.vertices;
	const n = verts.length;
	const remap = new Int32Array( n );
	for ( let i = 0; i < n; i ++ ) remap[ i ] = i;

	const t2 = threshold * threshold;

	// Union-Find helpers
	function root( i ) {

		while ( remap[ i ] !== i ) { remap[ i ] = remap[ remap[ i ] ]; i = remap[ i ]; }
		return i;

	}

	function union( a, b ) {

		remap[ root( a ) ] = root( b );

	}

	// O(n²) merge — acceptable for <10k verts in edit mode
	for ( let i = 0; i < n; i ++ ) {

		const vi = verts[ i ];

		for ( let j = i + 1; j < n; j ++ ) {

			const vj = verts[ j ];
			const dx = vi.x - vj.x, dy = vi.y - vj.y, dz = vi.z - vj.z;

			if ( dx * dx + dy * dy + dz * dz <= t2 ) union( i, j );

		}

	}

	// Remap all half-edge vertex references to canonical representatives
	for ( const he of em.halfEdges ) he.v = root( he.v );

	// Delete degenerate faces
	for ( const face of em.faces ) {

		if ( ! face ) continue;
		const hes = em.faceHalfEdges( face.id );
		const ids = hes.map( h => h.v );

		if ( ids[ 0 ] === ids[ 1 ] || ids[ 1 ] === ids[ 2 ] || ids[ 0 ] === ids[ 2 ] ) {

			em.removeFace( face.id );

		}

	}

}

registerOp( 'weld', {
	description: 'Merge vertices within threshold distance and remove degenerate faces',
	params: { 'threshold?': 'number=0.01' },
	example: 'weld(em, selection, { threshold: 0.05 })',
} );
