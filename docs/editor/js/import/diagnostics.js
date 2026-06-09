// ── import/diagnostics.js ─────────────────────────────────────────────────────
// Stage 3 detection helpers + Stage 7 (DIAGNOSTICS / SUGGESTIONS) messaging.
//
// The DETECTION is deterministic (traverse + count). The LANGUAGE the user reads
// is templated here too, but the richer free-form suggestions ("want me to add a
// turntable animation?") are produced by the LLM in the pipeline — this module
// gives it the structured facts and a safe default message.
//
// Two honest outcomes drive everything downstream:
//   • mergedMesh  → sub-part edits must fail gracefully (Guard 1).
//   • textured    → "make it red" tints, it does not replace (Guard 3).

import { decodeName } from '../scene/summarize.js';

// Names a glТF/OBJ exporter emits when it has nothing meaningful to say.
const MEANINGLESS = /^(object|mesh|node|group|geometry|primitive|polygon|defaultmaterial|material|scene|root|untitled|model)[\s._-]*\d*$/i;

/** A name is "meaningful" if it isn't empty and isn't an exporter placeholder. */
export function isMeaningfulName( raw ) {

	const n = decodeName( raw || '' ).trim();
	if ( ! n ) return false;
	return ! MEANINGLESS.test( n );

}

function meshIsTextured( mesh ) {

	const mats = Array.isArray( mesh.material ) ? mesh.material : [ mesh.material ];
	return mats.some( m => m && m.map );

}

/**
 * Inspect an imported root and report structural facts the user/AI must know.
 *
 * @param {THREE.Object3D} root
 * @returns {{
 *   meshCount:number, groupCount:number, nodeCount:number,
 *   namedMeshCount:number, namedFraction:number,
 *   texturedMeshCount:number, hasAnimations:boolean,
 *   mergedMesh:boolean, opaqueNames:boolean
 * }}
 */
export function diagnoseImport( root ) {

	let meshCount = 0, groupCount = 0, nodeCount = 0;
	let namedMeshCount = 0, texturedMeshCount = 0;

	root.traverse( n => {

		if ( n === root ) { /* count root below by its kind */ }
		nodeCount ++;

		if ( n.isMesh ) {

			meshCount ++;
			if ( isMeaningfulName( n.name ) ) namedMeshCount ++;
			if ( meshIsTextured( n ) ) texturedMeshCount ++;

		} else if ( n.isGroup || ( n.children && n.children.length && ! n.isMesh ) ) {

			groupCount ++;

		}

	} );

	const namedFraction = meshCount ? namedMeshCount / meshCount : 0;

	// Single mesh (or the whole asset reduces to one renderable) ⇒ no separable
	// parts. This is the gothic-bed case: sub-part edits can't be honoured.
	const mergedMesh = meshCount <= 1;

	// Most parts carry exporter placeholders (the dumptruck's Object_N) ⇒ the
	// LLM labeling pass is the thing that makes this asset addressable.
	const opaqueNames = meshCount > 1 && namedFraction < 0.5;

	return {
		meshCount,
		groupCount,
		nodeCount,
		namedMeshCount,
		namedFraction: Math.round( namedFraction * 100 ) / 100,
		texturedMeshCount,
		hasAnimations: !! ( root.animations && root.animations.length ),
		mergedMesh,
		opaqueNames,
	};

}

/**
 * Deterministic, always-safe one-liners derived from the diagnosis. The pipeline
 * shows these immediately; the LLM may add richer suggestions on top.
 *
 * @param {ReturnType<typeof diagnoseImport>} d
 * @param {string} [name]
 * @returns {string[]}
 */
export function diagnosticMessages( d, name = 'asset' ) {

	const msgs = [];

	if ( d.mergedMesh ) {

		msgs.push( `Imported "${ name }" as a single merged mesh — its parts can't be separated, so part-level edits (e.g. "just the sheets") aren't possible. I can recolor or transform it as a whole.` );

	} else if ( d.opaqueNames ) {

		msgs.push( `Imported "${ name }" with ${ d.meshCount } parts, most unnamed — labeling them so you can refer to parts by description.` );

	} else {

		msgs.push( `Imported "${ name }" with ${ d.meshCount } separable parts.` );

	}

	if ( d.texturedMeshCount > 0 ) {

		msgs.push( `${ d.texturedMeshCount } part(s) are textured: setting a color will TINT the texture (map × color), not replace it. To get a solid color the texture must be removed/replaced.` );

	}

	if ( d.hasAnimations ) {

		msgs.push( 'This asset ships with animation clips — they can be played.' );

	}

	return msgs;

}
