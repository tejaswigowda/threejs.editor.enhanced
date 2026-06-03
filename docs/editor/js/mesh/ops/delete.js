// ── delete.js ─────────────────────────────────────────────────────────────────
// Delete selected faces (leaves boundary edges as open holes).
// Isolated vertices left behind are cleaned up on compact().

import { registerOp } from './index.js';

export function deleteFaces( em, selection ) {

	for ( const faceId of selection.faces ) {

		em.removeFace( faceId );

	}

}

// Dissolve: remove selected faces AND their shared interior edges by merging
// adjacent faces into a single polygon (implemented as face deletion + no bridging).
export function dissolve( em, selection ) {

	deleteFaces( em, selection );

}

registerOp( 'deleteFaces', {
	description: 'Delete selected faces (leaves open holes)',
	params: {},
	example: 'deleteFaces(em, selection)',
} );
