// ── Mirror operation (M2) ─────────────────────────────────────────────────────
// Clones a mesh and reflects it across a world-space axis through the origin.
// The cloned geometry has its axis-coordinate negated and winding order flipped
// so normals remain correct.

import * as THREE from 'three';
import { AddObjectCommand } from '../../commands/AddObjectCommand.js';
import { registerOp } from './index.js';

const _AXIS_INDEX = { x: 0, y: 1, z: 2 };

/**
 * Create a mirrored copy of a mesh across one world-space axis.
 *
 * @param {Editor}     editor
 * @param {THREE.Mesh} mesh          source mesh
 * @param {'x'|'y'|'z'} [axis='x']  axis to mirror across
 * @returns {THREE.Mesh}             the mirrored mesh (already added to scene)
 */
export function mirrorMesh( editor, mesh, axis = 'x' ) {

	if ( ! mesh || ! mesh.isMesh ) throw new Error( 'mirrorMesh: first arg must be a THREE.Mesh' );

	const axisKey = axis.toLowerCase();
	const ai      = _AXIS_INDEX[ axisKey ];

	if ( ai === undefined ) throw new Error( `mirrorMesh: axis must be 'x', 'y', or 'z'` );

	// Clone and negate the axis coordinate
	const geom = mesh.geometry.clone();
	const pos  = geom.attributes.position;

	for ( let i = 0; i < pos.count; i ++ ) {

		pos.setComponent( i, ai, - pos.getComponent( i, ai ) );

	}

	// Flip winding order to preserve correct front-face normals
	if ( geom.index ) {

		const idx = geom.index.array;

		for ( let i = 0; i < idx.length; i += 3 ) {

			const tmp  = idx[ i + 1 ];
			idx[ i + 1 ] = idx[ i + 2 ];
			idx[ i + 2 ] = tmp;

		}

	} else {

		// Non-indexed: swap every second and third vertex of each triangle
		const pa = pos.array;

		for ( let i = 0; i < pa.length; i += 9 ) {

			for ( let c = 0; c < 3; c ++ ) {

				const tmp      = pa[ i + 3 + c ];
				pa[ i + 3 + c ] = pa[ i + 6 + c ];
				pa[ i + 6 + c ] = tmp;

			}

		}

	}

	pos.needsUpdate = true;
	geom.computeVertexNormals();

	// Mirror transform: negate axis component of position; rotation/scale unchanged
	const material = Array.isArray( mesh.material )
		? mesh.material.map( m => m.clone() )
		: mesh.material.clone();

	const mirrored = new THREE.Mesh( geom, material );
	mirrored.name         = ( mesh.name || 'Mesh' ) + '_mirror_' + axisKey;
	mirrored.castShadow   = mesh.castShadow;
	mirrored.receiveShadow = mesh.receiveShadow;

	// Reflect position across the axis plane at origin
	mirrored.position.copy( mesh.position );
	mirrored.position[ axisKey ] = - mesh.position[ axisKey ];
	mirrored.rotation.copy( mesh.rotation );
	mirrored.scale.copy( mesh.scale );

	// Recipe: provenance record — codegen emits comment + buffer fallback
	mirrored.userData.recipe = [ {
		op:     'mirrorMesh',
		source: mesh.name || mesh.uuid.slice( 0, 8 ),
		axis:   axisKey,
	} ];

	editor.execute( new AddObjectCommand( editor, mirrored ) );
	return mirrored;

}

registerOp( 'mirrorMesh', {
	description: "Create a mirrored copy of a mesh across a world-space axis (x/y/z)",
	params: { mesh: 'Mesh', "axis?": "string='x'" },
	example: "mirrorMesh(editor.selected, 'x')",
} );
