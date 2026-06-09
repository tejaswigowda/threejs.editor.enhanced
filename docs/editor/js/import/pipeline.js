// ── import/pipeline.js ────────────────────────────────────────────────────────
// Orchestrates the import stages on a freshly-loaded asset root. Wires the
// DETERMINISTIC steps (normalize → harvest descriptors → diagnose) and the LLM
// steps (label pass → suggestions) into one entry point the loaders call.
//
//   Stage 2  normalize      (deterministic, reversible)
//   Stage 3  indexSubtree   (deterministic — descriptors)
//   Stage 3  diagnose       (deterministic — merged-mesh / opaque-names / textured)
//   Stage 4  label pass     (LLM, once, cached)   ★
//   Stage 7  suggestion     (LLM, optional, gated)
//
// LLM interprets, deterministic computes: load/scale/ground/harvest are math; the
// LLM only labels, diagnoses, suggests.

import { indexSubtree } from '../intelligence/descriptors.js';
import { normalizeImportedObject } from './normalize.js';
import { diagnoseImport, diagnosticMessages } from './diagnostics.js';
import { labelImportedAsset } from './labelPass.js';
import { registerOp } from '../mesh/ops/index.js';

function defaultLog( msg ) { try { console.log( msg ); } catch { /* noop */ } }

// Stage 7 — one optional free-form suggestion ON TOP of the deterministic facts.
async function suggestWorkflow( editor, name, diag ) {

	const aiEngine = editor && editor.aiEngine;
	if ( ! aiEngine || ! aiEngine.ready ) return null;

	const facts = [
		`name: ${ name }`,
		`parts: ${ diag.meshCount }`,
		diag.mergedMesh ? 'single merged mesh (parts not separable)' : 'parts separable',
		diag.texturedMeshCount ? `${ diag.texturedMeshCount } textured part(s)` : 'untextured',
		diag.hasAnimations ? 'has animation clips' : 'no clips',
	].join( ', ' );

	try {

		const reply = await aiEngine.complete( [
			{ role: 'system', content: 'You just helped import a 3D asset into an editor. In ONE short sentence, offer the single most useful next action (e.g. ground & scale to real size, add a turntable animation, play its clip). No preamble.' },
			{ role: 'user', content: facts },
		], { maxTokens: 48, temperature: 0.2 } );
		const line = String( reply || '' ).split( /\r?\n/ )[ 0 ].trim();
		return line || null;

	} catch {

		return null;

	}

}

/**
 * Run the import pipeline on an asset root that has ALREADY been added to the
 * scene via AddObjectCommand. Safe to call fire-and-forget; the deterministic
 * stages complete synchronously before the first await.
 *
 * @param {Editor} editor
 * @param {THREE.Object3D} root
 * @param {object} [opts]
 * @param {(msg:string)=>void} [opts.log]   where user-facing lines go
 * @param {boolean} [opts.normalize=true]   run Stage 2
 * @param {boolean} [opts.label=true]       run Stage 4 (needs a loaded LLM)
 * @param {boolean} [opts.suggest=false]    run Stage 7 (needs a loaded LLM)
 * @param {object}  [opts.normalizeOpts]    forwarded to normalize
 * @returns {Promise<{ diag:object, normalized:object|null, labels?:object }>}
 */
export async function runImportPipeline( editor, root, opts = {} ) {

	const log = opts.log || defaultLog;
	const name = root.name || 'asset';

	root.userData.imported = true;

	// Stage 2 — NORMALIZE (deterministic, reversible).
	let normalized = null;
	if ( opts.normalize !== false ) {

		try {

			normalized = await normalizeImportedObject( editor, root, opts.normalizeOpts || {} );
			if ( normalized && normalized.changed ) {

				const s = normalized.autoscaled ? `scaled ×${ normalized.scaleFactor }, ` : '';
				log( `↳ Normalized "${ name }": ${ s }centered & grounded (reversible — undo to restore).` );

			}

		} catch ( e ) {

			log( `↳ Could not normalize "${ name }": ${ e && e.message || e }` );

		}

	}

	// Stage 3 — harvest descriptors NOW (the label pass + diagnosis need them).
	try { indexSubtree( root, true ); } catch { /* descriptors are best-effort */ }

	// Stage 3 — diagnose (deterministic) and surface the always-safe messages.
	const diag = diagnoseImport( root );
	for ( const m of diagnosticMessages( diag, name ) ) log( 'ℹ ' + m );

	const result = { diag, normalized };

	// Stage 4 — LLM labeling pass (once, cached). ★
	if ( opts.label !== false ) {

		try {

			const labels = await labelImportedAsset( editor, root );
			result.labels = labels;
			if ( labels.labeled > 0 ) {

				log( `↳ Labeled ${ labels.labeled }/${ labels.total } part(s) — you can now refer to them by description.` );

			} else if ( labels.skipped === 'no-llm' ) {

				log( '↳ Load an AI model to auto-label this asset\'s parts for natural-language editing.' );

			}

		} catch ( e ) {

			log( `↳ Labeling skipped: ${ e && e.message || e }` );

		}

	}

	// Stage 7 — one optional suggestion.
	if ( opts.suggest ) {

		const tip = await suggestWorkflow( editor, name, diag );
		if ( tip ) log( '💡 ' + tip );

	}

	return result;

}

// ── AI-discoverable ops ───────────────────────────────────────────────────────

registerOp( 'diagnoseImport', {
	description: 'Report structural facts about an imported asset: merged-mesh (parts not separable), opaque/placeholder names, textured parts, animation clips. Returns the diagnosis and prints safe notes.',
	params: { obj: 'Object3D' },
	example: 'diagnoseImport(editor.selected)',
} );

registerOp( 'relabelAsset', {
	description: 'Re-run the LLM labeling pass on an imported asset, caching human part labels in userData.label so parts become addressable by description.',
	params: { obj: 'Object3D' },
	example: 'relabelAsset(editor.selected)',
} );
