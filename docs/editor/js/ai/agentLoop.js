// ── agentLoop.js ──────────────────────────────────────────────────────────────
// The bounded agentic loop (Technique 1): generate → validate → execute →
// observe → fix, with capped retries. The reliability unlock.
//
// Pure orchestrator: all side-effecting capabilities are injected by Shell.js so
// the loop stays on the SAME single execution surface and is unit-reasonable.
//
//   runAgentic({ editor, messages, intent, deps, maxRetries })
//     deps = { streamCode, execute, appendOutput,
//              validateCode, snapshotScene, sceneDiff, confirmChange, diffSummary }
//
// Invariants:
//   • Every execution goes through deps.execute (editor.execute → undo stack).
//   • Validation failures are fed back BEFORE executing (no bad run).
//   • Observation only triggers a retry on the safe "nothing happened" signal
//     (diff.total === 0), never on fuzzy value mismatch (avoids retry storms).
//   • Hard cap on iterations — never runaway-loop the local model.
//   • Retry context is CODE-ONLY and SHORT (B2/B3): each retry sees the original
//     request + a one-line error + a truncated snippet of the LAST attempt only.
//     Earlier failed attempts are never stacked, so context can't snowball into
//     a window overflow. A pre-call token-budget guard trims/aborts before MLC's
//     hard throw.

import { estimateTokens, truncateForContext } from '../AIUtils.js';

export const DEFAULT_MAX_RETRIES = 3;

// Default input-token budget when the caller doesn't know the model's window —
// leaves ~600 for output below a 4096 window. Callers should pass an explicit
// tokenBudget derived from the loaded model's actual context window.
const DEFAULT_TOKEN_BUDGET = 3500;

// Collapse any error/feedback into a single short line for the retry prompt.
function oneLine( s, max = 200 ) {

	const line = String( s || '' ).replace( /\s+/g, ' ' ).trim();
	return line.length > max ? line.slice( 0, max ) + '…' : line;

}

// Strict code-only retry prompt (B2): forbids prose, names the failure in 1 line.
// C6: instruct the model to FIX the error while KEEPING every intended object —
// the failure mode was "recovering" by deleting most of the scene so the code runs.
function retryPrompt( errorSummary ) {

	return 'Your previous output failed: ' + oneLine( errorSummary ) + '.\n' +
		'Fix ONLY that error. KEEP every object from your previous attempt — do NOT ' +
		'remove or reduce content to make it run; output the FULL corrected scene.\n' +
		'Output ONLY a single corrected JavaScript block wrapped in ```js … ```.\n' +
		'No explanation. No prose. No comments. Code only.';

}

// Error-translation table (C1): a 1.5B model can't act on "g.add is not a
// function" — it CAN act on a concrete instruction. Map known runtime errors to
// actionable, teaching feedback before feeding them back.
function translateError( raw ) {

	const e = String( raw || '' );
	let m;

	if ( ( m = e.match( /([A-Za-z_$][\w$]*)\.add is not a function/ ) ) ) {

		return `'${ m[ 1 ] }' is not a Group/Object3D, so it has no .add(). To group objects: ` +
			`const group=new Group(); group.add(mesh); then editor.execute(new AddObjectCommand(editor, group)).`;

	}

	if ( ( m = e.match( /([A-Za-z_$][\w$]*) is not a constructor/ ) ) ) {

		return `'${ m[ 1 ] }' is not a real three.js class. Use only documented primitives ` +
			`(BoxGeometry, SphereGeometry, CylinderGeometry, ConeGeometry, TorusGeometry, PlaneGeometry, Group, Mesh).`;

	}

	if ( ( m = e.match( /([A-Za-z_$][\w$]*) is not defined/ ) ) ) {

		return `'${ m[ 1 ] }' is not a defined function or variable. Do NOT call helpers you ` +
			`haven't defined — inline the geometry: new Mesh(new <Geometry>(...), material).`;

	}

	if ( /Unexpected end of input|Unexpected identifier|Unexpected token/.test( e ) ) {

		return 'Your code was incomplete or contained prose. Output ONLY a single complete (function(){ ... })(); block.';

	}

	if ( /Cannot read propert(?:y|ies) of (?:undefined|null)/.test( e ) ) {

		return "You referenced an object that doesn't exist. Use findObject('name') to locate existing objects, or create the object first.";

	}

	return e;

}

// First pair of SIBLING objects that actually occupy the same volume (overlap
// heads-up). Mirrors the eval scorer's geometry: real AABB overlap, not centroid
// proximity. Rules:
//   • geometry-only — a Group/Light has no own geometry; its position is a bare
//     origin that says nothing about where its contents sit, so it is skipped.
//   • sibling-only — only compare objects that share the same parent, so a Group
//     is NEVER compared against its own children (parent-vs-child coincides at the
//     group origin and is not an overlap).
//   • blocky-and-buried — flag only when two comparably-sized, BLOCKY objects
//     substantially overlap. Thin overlays/details (plates, lines, rails, legs on
//     a larger flat object) and mere crossings are intentional, not collisions.
// snapshot objects carry pos:[x,y,z], parent:uuid|null, size:[w,h,d]|null.
// Returns [nameA, nameB] or null.
function boxVol( s ) {

	return Math.max( 1e-6, s[ 0 ] ) * Math.max( 1e-6, s[ 1 ] ) * Math.max( 1e-6, s[ 2 ] );

}

// Flatness of a box: smallest dimension over largest. A plate/line/decal is flat
// (≪ 0.2); a cube/sphere is ~1.
function flatness( s ) {

	const dims = s.map( d => Math.abs( d ) );
	return Math.min( ...dims ) / Math.max( ...dims, 1e-6 );

}

function colocatedPair( objs ) {

	for ( let a = 0; a < objs.length; a ++ ) {

		for ( let b = a + 1; b < objs.length; b ++ ) {

			const A = objs[ a ], B = objs[ b ];

			// Geometry-only and sibling-only (see header).
			if ( ! A.size || ! B.size ) continue;
			if ( ( A.parent ?? null ) !== ( B.parent ?? null ) ) continue;

			// Real axis-aligned bounding-box overlap volume.
			let overlap = 1;
			for ( let k = 0; k < 3; k ++ ) {

				const aLo = A.pos[ k ] - A.size[ k ] / 2, aHi = A.pos[ k ] + A.size[ k ] / 2;
				const bLo = B.pos[ k ] - B.size[ k ] / 2, bHi = B.pos[ k ] + B.size[ k ] / 2;
				overlap *= Math.max( 0, Math.min( aHi, bHi ) - Math.max( aLo, bLo ) );

			}
			if ( overlap <= 0 ) continue;

			const volA = boxVol( A.size ), volB = boxVol( B.size );
			const buriedFrac = overlap / Math.min( volA, volB );      // smaller mostly inside the other?
			const sizeRatio = Math.min( volA, volB ) / Math.max( volA, volB ); // comparably sized?
			const smallFlat = flatness( volA <= volB ? A.size : B.size ); // smaller is blocky, not a layer?

			if ( buriedFrac > 0.5 && sizeRatio > 0.25 && smallFlat >= 0.2 ) return [ A.name, B.name ];

		}

	}
	return null;

}

// Distinct named colors mentioned in a request — used by C5 to know how many
// different colors the user asked for ("red and blue" → 2).
const COLOR_WORDS = [ 'red', 'green', 'blue', 'yellow', 'orange', 'purple', 'cyan',
	'magenta', 'white', 'black', 'gray', 'grey', 'brown', 'pink' ];
function countColorWords( intent ) {

	const p = String( intent || '' ).toLowerCase();
	return new Set( COLOR_WORDS.filter( c => new RegExp( '\\b' + c + '\\b' ).test( p ) ) ).size;

}

// ── C7. Subset-request-but-ALL-parts-changed (wrong resolution) ──────────────
// "Count of meshes changed" ≠ "right parts changed". If the user named a SUBSET
// ("wheels","body","the grille") but the edit touched EVERY part of a multi-part
// imported asset, that is a PROBABLE WRONG RESOLUTION (the blind traverse-all
// failure), NOT a success — flag it and steer the model to findParts/findByDescription.
//
// Pure + node-testable. The caller supplies the asset part-name sets so this needs
// no THREE/scene access.
const SUBSET_STOP = new Set( [ 'the', 'a', 'an', 'and', 'or', 'of', 'on', 'in', 'to', 'into',
	'make', 'turn', 'set', 'change', 'paint', 'recolor', 'recolour', 'colour', 'color', 'this',
	'that', 'these', 'those', 'with', 'for', 'its', 'their', 'be', 'should', 'please',
	// whole-asset words — their presence means the user addressed the WHOLE thing
	'all', 'every', 'everything', 'whole', 'entire', 'each',
	// modifiers carry no part identity
	'bigger', 'smaller', 'larger', 'darker', 'lighter', 'brighter',
	...COLOR_WORDS ] );

// Words that, when present, mean the request is explicitly about the WHOLE asset
// (so an all-parts change is correct, not a misresolution).
const WHOLE_WORDS = new Set( [ 'all', 'every', 'everything', 'whole', 'entire', 'each' ] );

function subsetContentNouns( intent ) {

	const out = [];
	for ( const w of String( intent || '' ).toLowerCase().split( /[^a-z0-9]+/ ) ) {

		if ( w.length < 3 || SUBSET_STOP.has( w ) ) continue;
		out.push( w );

	}
	return out;

}

/**
 * @param {string} intent
 * @param {Set<string>} changedNames  names of meshes changed this turn
 * @param {Array<{ name:string, label?:string, meshNames:string[] }>} assets
 *        imported multi-part roots (each with the names of ALL its part meshes)
 * @returns {{ asset:string, noun:string, count:number } | null}
 */
export function flagSubsetAllChanged( intent, changedNames, assets ) {

	const words = String( intent || '' ).toLowerCase().split( /[^a-z0-9]+/ );
	if ( words.some( w => WHOLE_WORDS.has( w ) ) ) return null; // explicit whole-asset request

	const nouns = subsetContentNouns( intent );
	if ( ! nouns.length ) return null; // no part noun → not a subset request

	for ( const asset of ( assets || [] ) ) {

		const parts = asset.meshNames || [];
		if ( parts.length < 3 ) continue; // only meaningful for multi-part assets

		// If the request names the ASSET itself ("make the truck red"), an all-parts
		// change is the correct interpretation — don't flag.
		const assetText = ( ( asset.label || '' ) + ' ' + ( asset.name || '' ) ).toLowerCase();
		if ( nouns.some( n => assetText.includes( n ) ) ) continue;

		// Did EVERY part of this asset change?
		if ( parts.every( m => changedNames.has( m ) ) ) {

			return { asset: asset.label || asset.name, noun: nouns[ 0 ], count: parts.length };

		}

	}

	return null;

}

// Build the imported multi-part asset inventory the C7 check needs from the live
// scene: each imported root → the names of ALL its descendant part meshes.
function importedMultiPartAssets( editor ) {

	const assets = [];
	if ( ! editor || ! editor.scene ) return assets;

	for ( const root of editor.scene.children ) {

		if ( root.isCamera || ! root.userData || ! root.userData.imported ) continue;
		const meshNames = [];
		root.traverse( o => { if ( o.isMesh ) meshNames.push( o.name || o.type ); } );
		if ( meshNames.length >= 3 ) {

			assets.push( { name: root.name || root.type, label: root.userData.label || '', meshNames } );

		}

	}
	return assets;

}

// "No effect" observation translation (C2). "Nothing changed" is as uninformative
// as a raw error — name the likely CAUSE so the model can act on it.
function diagnoseNoEffect( code, reason ) {

	const hasIIFE = /\}\s*\)\s*\(/.test( code );
	if ( /function\s+[A-Za-z_$][\w$]*\s*\(/.test( code ) && ! hasIIFE ) {

		return 'Your code defined a function but never ran it. Wrap the body in an IIFE ' +
			'(function(){ ... })(); so it runs immediately.';

	}
	if ( /RemoveObjectCommand|\.remove\s*\(|\bclear\b/i.test( code ) ) {

		return 'Nothing matched for removal — confirm there are non-camera objects in the scene ' +
			'(scene.children.filter(o=>o.type!=="Camera")) before removing.';

	}
	if ( /findObject|findByDescription|findAll|\.filter\s*\(|editor\.selected/.test( code ) ) {

		return "The code ran but changed nothing — a lookup likely returned no object. Verify the " +
			"target exists with findObject('name') using the FULL descriptive phrase (color + shape).";

	}
	return 'The code ran but the scene did not change, though a change was expected (' + reason +
		'). Re-check the target lookup and that an AddObject/Set command actually executes.';

}

export async function runAgentic( { editor, messages, intent, deps, maxRetries = DEFAULT_MAX_RETRIES, shouldAbort, tokenBudget = DEFAULT_TOKEN_BUDGET } ) {

	const { streamCode, execute, appendOutput, validateCode, snapshotScene, sceneDiff, confirmChange, diffSummary, inspectScene, historyLen, rollbackTo } = deps;

	const aborted = () => typeof shouldAbort === 'function' && shouldAbort();

	// Original system + user request. NEVER mutated — retries rebuild from this so
	// failed generations are never carried forward (B3).
	const baseMessages = [ ...messages ];

	// Most-recent failed attempt only: { code, error }. null on the first pass.
	let lastFail = null;

	// Tier-2 geometric repair is capped to a SINGLE corrective pass: placement is
	// the planning ceiling, so retrying a spatial defect more than once risks a
	// churn loop that ends worse than the first try. One measured nudge, then accept.
	let spatialRepaired = false;

	// C7 subset-misresolution correction is likewise capped to ONE corrective pass.
	let subsetRepaired = false;

	for ( let attempt = 0; attempt <= maxRetries; attempt ++ ) {

		// User clicked Stop — don't kick off another generation/retry.
		if ( aborted() ) {

			appendOutput( '■ Stopped by user.', 'info' );
			return { ok: false, aborted: true, attempts: attempt };

		}

		// ── Build a fresh, bounded retry context (no accumulation) ───────────
		let convo = baseMessages;
		if ( lastFail ) {

			convo = [
				...baseMessages,
				{ role: 'assistant', content: truncateForContext( lastFail.code ) },
				{ role: 'user', content: retryPrompt( lastFail.error ) },
			];

			// Pre-call token-budget guard (B3): drop the snippet, then abort rather
			// than letting MLC throw a raw context-window overflow.
			if ( estimateTokens( convo ) > tokenBudget ) {

				convo = [ ...baseMessages, { role: 'user', content: retryPrompt( lastFail.error ) } ];

				if ( estimateTokens( convo ) > tokenBudget ) {

					appendOutput( 'Aborting — prompt exceeds the context window even after trimming.', 'error' );
					return { ok: false, attempts: attempt };

				}

			}

		}

		const code = await streamCode( convo );

		// User clicked Stop mid-generation — bail before running partial code.
		if ( aborted() ) {

			appendOutput( '■ Stopped by user.', 'info' );
			return { ok: false, aborted: true, attempts: attempt + 1 };

		}

		// ── 0. Extraction guard (B1) — no executable code came back ──────────
		if ( ! code ) {

			if ( attempt >= maxRetries ) break;
			appendOutput( `⟳ no code block — retrying (${ attempt + 1 }/${ maxRetries })…`, 'info' );
			lastFail = { code: '', error: 'no code block found — output only a fenced JS block, no prose' };
			continue;

		}

		// ── C4. Stop retrying on byte-identical output ───────────────────────
		// If the model reproduces the exact same code, the feedback failed to move
		// it — burning the remaining retries won't help. Surface and stop.
		if ( lastFail && code === lastFail.code ) {

			appendOutput( '⊘ Model repeated identical code — feedback did not help. Stopping. ' +
				'Try rephrasing, or the Power (7B) model for complex requests.', 'error' );
			return { ok: false, identical: true, attempts: attempt + 1 };

		}

		// ── 1. Static validation against the real API index ──────────────────
		const v = validateCode( code );
		if ( ! v.ok && attempt < maxRetries ) {

			appendOutput( '⚠ API check: ' + v.issues.join( '  |  ' ), 'info' );
			lastFail = { code, error: 'API problems: ' + v.issues.join( '; ' ) };
			continue;

		}

		// ── 2. Execute (undo stack) with before/after observation ────────────
		const before = snapshotScene( editor );
		// Checkpoint the undo stack so a Tier-2 spatial defect can roll THIS attempt
		// back before the corrected (full-scene) retry runs, avoiding duplicate objects.
		const checkpoint = typeof historyLen === 'function' ? historyLen() : null;
		const result = execute( code );

		if ( ! result.ok ) {

			if ( attempt >= maxRetries ) break;
			appendOutput( `⟳ error — retrying (${ attempt + 1 }/${ maxRetries })…`, 'info' );
			lastFail = { code, error: translateError( result.error ) };
			continue;

		}

		// ── 3. Observe ───────────────────────────────────────────────────────
		const after = snapshotScene( editor );
		const diff = sceneDiff( before, after );
		const conf = confirmChange( diff, intent );

		// Safe retry signal: we expected a change and NOTHING happened (nothing to
		// undo, no compounding). Wrong-but-something is accepted (user can undo).
		if ( ! conf.ok && diff.total === 0 && attempt < maxRetries ) {

			appendOutput( `⟳ no effect (${ conf.reason }) — retrying (${ attempt + 1 }/${ maxRetries })…`, 'info' );
			lastFail = { code, error: diagnoseNoEffect( code, conf.reason ) };
			continue;

		}

		// C5 — verify RESULT matches intent, not just that a command ran. If the
		// request named ≥2 distinct colors but the recolored objects collapsed to
		// fewer distinct colors, they share a material (last write wins). With B′1's
		// clone-on-write this normally can't happen, so this is a safe backstop that
		// only fires on a genuine collision.
		const wantColors = countColorWords( intent );
		if ( wantColors >= 2 && diff.recolored.length >= 2 && attempt < maxRetries ) {

			const recolored = diff.recolored;
			const distinct = new Set(
				[ ...after.values() ].filter( o => recolored.includes( o.name ) ).map( o => o.color )
			).size;
			if ( distinct < wantColors ) {

				appendOutput( `⟳ colors collapsed to ${ distinct } (asked ${ wantColors }) — retrying (${ attempt + 1 }/${ maxRetries })…`, 'info' );
				lastFail = { code, error: 'you recolored multiple objects but they SHARE one material, so all show the same color. Give each its OWN material (new Material per mesh) before setting colors, then set each distinct color.' };
				continue;

			}

		}

		// C7 — SUBSET request but ALL parts changed = probable WRONG RESOLUTION.
		// "make the wheels black" that recolored every one of the 12 truck meshes is
		// NOT a success (count-changed ≠ right-parts-changed). Flag it and steer the
		// model to resolve the specific parts via findParts/findByDescription instead
		// of traversing the whole asset. Capped to one corrective pass (subsetRepaired).
		if ( ! subsetRepaired && attempt < maxRetries ) {

			const changedNames = new Set( [ ...diff.recolored, ...diff.moved, ...diff.scaled ] );
			const mis = flagSubsetAllChanged( intent, changedNames, importedMultiPartAssets( editor ) );
			if ( mis ) {

				subsetRepaired = true;
				appendOutput( `⟳ you changed all ${ mis.count } parts of "${ mis.asset }" but the request named "${ mis.noun }" — resolving the specific parts and retrying (${ attempt + 1 }/${ maxRetries })…`, 'info' );

				// Undo this wrong-resolution attempt so the corrected one doesn't stack.
				if ( typeof rollbackTo === 'function' && checkpoint !== null ) rollbackTo( checkpoint );

				lastFail = { code, error: `WRONG RESOLUTION: you changed ALL ${ mis.count } parts of the imported asset, but the user asked only for "${ mis.noun }". Do NOT traverse/recolor the whole asset. Resolve the specific parts with findParts('${ mis.noun }') (or findByDescription('${ mis.noun }') for a single part) and edit ONLY those returned nodes. If it returns nothing, STOP and tell the user the part could not be resolved.` };
				continue;

			}

		}

		// ── 3b. Geometric verify → repair (Tier-2) ──────────────────────
		// The executed scene is GROUND TRUTH. Measure the REAL world geometry of the
		// objects this attempt added; on a high-confidence physical defect (below
		// ground / interpenetration / floating), roll the attempt back and feed exact
		// measurements in for ONE corrective pass. Capped (spatialRepaired) so a
		// planning-ceiling limitation can't spiral into a retry storm.
		if ( ! spatialRepaired && typeof inspectScene === 'function' && attempt < maxRetries ) {

			const insp = inspectScene( editor, before, after );
			if ( insp && ! insp.ok && insp.issues.length ) {

				spatialRepaired = true;
				appendOutput( '⟳ spatial check: ' + insp.issues.map( oneLine ).join( '  |  ' ) +
					` — retrying (${ attempt + 1 }/${ maxRetries })…`, 'info' );

				// Undo this attempt so the corrected full-scene retry doesn't stack on it.
				if ( typeof rollbackTo === 'function' && checkpoint !== null ) rollbackTo( checkpoint );

				lastFail = { code, error: 'spatial problems — ' + insp.issues.join( ' ' ) };
				continue;

			}

		}

		// Tier-1 geometric observe: surface co-located objects (added at nearly the
		// same spot → they overlap). Non-blocking — a heads-up, not a retry (placement
		// quality is the planning ceiling; the prompt rule + Power tier handle it).
		const addedNames = new Set( diff.added );
		const addedObjs = [ ...after.values() ].filter( o => addedNames.has( o.name ) );
		const colo = colocatedPair( addedObjs );
		if ( colo ) appendOutput( `⚠ "${ colo[ 0 ] }" and "${ colo[ 1 ] }" are at nearly the same spot — space objects apart so they don't overlap.`, 'info' );

		appendOutput( '✓ ' + diffSummary( diff ), 'info' );
		return { ok: true, diff, attempts: attempt + 1 };

	}

	appendOutput( `Stopped after ${ maxRetries + 1 } attempts — see messages above.`, 'error' );
	return { ok: false, attempts: maxRetries + 1 };

}
