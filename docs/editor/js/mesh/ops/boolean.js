// ── Boolean operations (M1) ───────────────────────────────────────────────────
// Wraps three-bvh-csg Evaluator in the editor's Command pattern so every
// boolean op lands on the undo stack and is callable identically from UI and AI.
//
// three-bvh-csg: https://github.com/gkjohnson/three-bvh-csg
// CDN import is resolved via the importmap in index.html.

import * as THREE from 'three';
import { Brush, Evaluator, ADDITION, SUBTRACTION, INTERSECTION } from 'three-bvh-csg';
import { Command } from '../../Command.js';
import { registerOp } from './index.js';

// ── Internal command ──────────────────────────────────────────────────────────
// Undo/redo is fully in-memory; we deliberately skip toJSON/fromJSON because
// CSG result geometry is heavyweight and session-reload undo is not required.

class BooleanOpCommand extends Command {

	constructor( editor, opLabel, resultMesh, inputA, inputB, keepInputs ) {

		super( editor );
		this.type         = 'BooleanOpCommand';
		this.name         = opLabel;
		this.resultMesh   = resultMesh;
		this.inputA       = inputA;
		this.inputB       = inputB;
		this.keepInputs   = keepInputs;

	}

	execute() {

		this.editor.addObject( this.resultMesh );

		if ( ! this.keepInputs ) {

			this.editor.removeObject( this.inputA );
			this.editor.removeObject( this.inputB );

		}

		this.editor.select( this.resultMesh );

	}

	undo() {

		this.editor.removeObject( this.resultMesh );

		if ( ! this.keepInputs ) {

			this.editor.addObject( this.inputA );
			this.editor.addObject( this.inputB );

		}

		this.editor.deselect();

	}

}

// ── Shared evaluator (stateless across calls) ─────────────────────────────────
const _evaluator = new Evaluator();

// ── Core runner ───────────────────────────────────────────────────────────────

function _runBoolean( editor, meshA, meshB, csgOp, opLabel, keepInputs ) {

	if ( ! meshA || ! meshA.isMesh ) throw new Error( `${ opLabel }: first arg must be a THREE.Mesh` );
	if ( ! meshB || ! meshB.isMesh ) throw new Error( `${ opLabel }: second arg must be a THREE.Mesh` );

	// Ensure world matrices are current
	meshA.updateMatrixWorld( true );
	meshB.updateMatrixWorld( true );

	// Build brushes that replicate each mesh's world transform
	const brushA = new Brush( meshA.geometry, meshA.material );
	brushA.position.setFromMatrixPosition( meshA.matrixWorld );
	brushA.quaternion.setFromRotationMatrix( meshA.matrixWorld );
	// Extract world scale
	const scaleA = new THREE.Vector3();
	meshA.matrixWorld.decompose( new THREE.Vector3(), new THREE.Quaternion(), scaleA );
	brushA.scale.copy( scaleA );
	brushA.updateMatrixWorld( true );

	const brushB = new Brush( meshB.geometry, meshB.material );
	brushB.position.setFromMatrixPosition( meshB.matrixWorld );
	brushB.quaternion.setFromRotationMatrix( meshB.matrixWorld );
	const scaleB = new THREE.Vector3();
	meshB.matrixWorld.decompose( new THREE.Vector3(), new THREE.Quaternion(), scaleB );
	brushB.scale.copy( scaleB );
	brushB.updateMatrixWorld( true );

	const result = _evaluator.evaluate( brushA, brushB, csgOp );
	result.name         = `${ meshA.name || 'MeshA' } ${ opLabel } ${ meshB.name || 'MeshB' }`;
	result.castShadow   = meshA.castShadow;
	result.receiveShadow = meshA.receiveShadow;
	result.geometry.computeVertexNormals();

	// Recipe: describes provenance but is not independently replayable
	// (inputs are consumed; codegen emits a comment + buffer fallback for these)
	result.userData.recipe = [ {
		op:    'boolean' + opLabel,
		a:     meshA.name || meshA.uuid.slice( 0, 8 ),
		b:     meshB.name || meshB.uuid.slice( 0, 8 ),
		label: opLabel,
	} ];

	const cmd = new BooleanOpCommand( editor, opLabel, result, meshA, meshB, keepInputs );
	editor.execute( cmd );
	return result;

}

// ── Public ops ────────────────────────────────────────────────────────────────

/**
 * Merge meshA and meshB into a single combined mesh.
 * @param {Editor}      editor
 * @param {THREE.Mesh}  meshA
 * @param {THREE.Mesh}  meshB
 * @param {boolean}     [keepInputs=false]  keep input meshes in scene after op
 * @returns {THREE.Mesh} result mesh (already added to scene)
 */
export function booleanUnion( editor, meshA, meshB, keepInputs = false ) {

	return _runBoolean( editor, meshA, meshB, ADDITION, 'Union', keepInputs );

}

/**
 * Subtract meshB from meshA (cut a hole).
 */
export function booleanSubtract( editor, meshA, meshB, keepInputs = false ) {

	return _runBoolean( editor, meshA, meshB, SUBTRACTION, 'Subtract', keepInputs );

}

/**
 * Keep only the overlapping volume of meshA and meshB.
 */
export function booleanIntersect( editor, meshA, meshB, keepInputs = false ) {

	return _runBoolean( editor, meshA, meshB, INTERSECTION, 'Intersect', keepInputs );

}

// ── Register ops for AI serialization ────────────────────────────────────────

registerOp( 'booleanUnion', {
	description: 'Merge two meshes into one combined shape',
	params: { meshA: 'Mesh', meshB: 'Mesh', 'keepInputs?': 'boolean=false' },
	example: 'booleanUnion(meshA, meshB)',
} );

registerOp( 'booleanSubtract', {
	description: 'Subtract meshB from meshA — cuts a hole',
	params: { meshA: 'Mesh', meshB: 'Mesh', 'keepInputs?': 'boolean=false' },
	example: 'booleanSubtract(prism, hole)',
} );

registerOp( 'booleanIntersect', {
	description: 'Keep only the overlapping volume of two meshes',
	params: { meshA: 'Mesh', meshB: 'Mesh', 'keepInputs?': 'boolean=false' },
	example: 'booleanIntersect(meshA, meshB)',
} );
