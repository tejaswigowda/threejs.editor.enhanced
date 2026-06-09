// ── import/normalize.js ───────────────────────────────────────────────────────
// Stage 2 (NORMALIZE) of the asset-import pipeline. DETERMINISTIC — no model.
//
// Imported assets are routinely 1000× too big, off-center, or buried under the
// floor. On import we put them in a sane pose:
//   • scale to a sane default real-world size (only when units are clearly wrong),
//   • center on the origin in X and Z,
//   • rest on the ground (min Y = 0).
//
// Everything is reversible: the change is applied through Set*Command instances
// wrapped in a MultiCmdsCommand → it lands on the undo stack like any edit. The
// original transform is also recorded in userData so the pose can be inspected.
//
// This is pure getSize()/getCenter() arithmetic. The LLM is never involved here.

// NOTE: the Set*/MultiCmds command classes are imported lazily inside
// normalizeImportedObject so this module's pure math (computeNormalization) can
// be unit-tested in plain node without resolving the 'three' bare specifier.

// Default target for the largest world-space dimension (metres-ish).
const DEFAULT_TARGET_MAX = 2.0;

// Only auto-scale when the asset is CLEARLY in the wrong unit system. A model
// that is already a few units across is left alone (rescaling sane assets is the
// more annoying failure mode than leaving an oddly-sized one).
const TOO_BIG = 50;     // maxDim above this ⇒ likely cm/mm exported as m
const TOO_SMALL = 0.05; // maxDim below this ⇒ likely scaled-down export

function round( v, p = 1e5 ) { return Math.round( v * p ) / p; }

/**
 * Compute the normalization plan for a freshly-imported root WITHOUT mutating it
 * permanently (it is briefly mutated to measure the scaled box, then restored).
 *
 * @param {THREE.Object3D} root
 * @param {object} [opts]
 * @param {number} [opts.targetMax]  desired largest dimension after scaling
 * @param {boolean} [opts.forceScale] scale to targetMax even if units look sane
 * @param {boolean} [opts.ground=true] drop min Y to 0
 * @param {boolean} [opts.center=true] center X/Z on origin
 * @param {object} [THREE=window.THREE]
 * @returns {null | {
 *   scaleFactor:number, autoscaled:boolean, maxDim:number,
 *   newScale:[number,number,number], newPosition:[number,number,number],
 *   original:{ scale:[number,number,number], position:[number,number,number] },
 *   changed:boolean
 * }}
 */
export function computeNormalization( root, opts = {}, THREE = ( typeof window !== 'undefined' ? window.THREE : null ) ) {

	if ( ! root || ! THREE ) return null;

	const {
		targetMax = DEFAULT_TARGET_MAX,
		forceScale = false,
		ground = true,
		center = true,
	} = opts;

	const origScale = root.scale.clone();
	const origPos = root.position.clone();

	root.updateMatrixWorld( true );
	const box0 = new THREE.Box3().setFromObject( root );
	if ( box0.isEmpty() ) return null;

	const size0 = new THREE.Vector3(); box0.getSize( size0 );
	const maxDim = Math.max( size0.x, size0.y, size0.z );
	if ( maxDim <= 0 ) return null;

	// 1. Decide scale factor.
	let scaleFactor = 1;
	let autoscaled = false;
	if ( forceScale || maxDim > TOO_BIG || maxDim < TOO_SMALL ) {

		scaleFactor = targetMax / maxDim;
		autoscaled = true;

	}

	const newScale = origScale.clone().multiplyScalar( scaleFactor );

	// 2. Measure the box AFTER scaling so centering/grounding use real numbers.
	root.scale.copy( newScale );
	root.updateMatrixWorld( true );
	const box1 = new THREE.Box3().setFromObject( root );
	const c1 = new THREE.Vector3(); box1.getCenter( c1 );

	// Offset that moves center → (0, *, 0) and min Y → 0.
	const offset = new THREE.Vector3(
		center ? - c1.x : 0,
		ground ? - box1.min.y : 0,
		center ? - c1.z : 0,
	);
	const newPosition = origPos.clone().add( offset );

	// 3. Restore — the actual change goes through commands, not here.
	root.scale.copy( origScale );
	root.position.copy( origPos );
	root.updateMatrixWorld( true );

	const changed = scaleFactor !== 1 || offset.lengthSq() > 1e-12;

	return {
		scaleFactor: round( scaleFactor ),
		autoscaled,
		maxDim: round( maxDim ),
		newScale: [ round( newScale.x ), round( newScale.y ), round( newScale.z ) ],
		newPosition: [ round( newPosition.x ), round( newPosition.y ), round( newPosition.z ) ],
		original: {
			scale: [ round( origScale.x ), round( origScale.y ), round( origScale.z ) ],
			position: [ round( origPos.x ), round( origPos.y ), round( origPos.z ) ],
		},
		changed,
	};

}

/**
 * Apply a normalization plan reversibly (undo stack). Records the original
 * transform in userData so the pose is inspectable / re-derivable.
 *
 * @param {Editor} editor
 * @param {THREE.Object3D} root
 * @param {object} [opts] forwarded to computeNormalization
 * @returns {null | object}  the plan that was applied (or null if no change)
 */
export async function normalizeImportedObject( editor, root, opts = {} ) {

	const THREE = window.THREE;
	const plan = computeNormalization( root, opts, THREE );
	if ( ! plan || ! plan.changed ) return plan;

	const { MultiCmdsCommand } = await import( '../commands/MultiCmdsCommand.js' );
	const { SetScaleCommand } = await import( '../commands/SetScaleCommand.js' );
	const { SetPositionCommand } = await import( '../commands/SetPositionCommand.js' );

	// Record reversible bookkeeping on the asset itself.
	root.userData.importNormalize = {
		original: plan.original,
		applied: { scale: plan.newScale, position: plan.newPosition },
		scaleFactor: plan.scaleFactor,
		autoscaled: plan.autoscaled,
	};

	const cmds = [];
	if ( plan.scaleFactor !== 1 ) {

		cmds.push( new SetScaleCommand( editor, root, new THREE.Vector3( ...plan.newScale ) ) );

	}

	cmds.push( new SetPositionCommand( editor, root, new THREE.Vector3( ...plan.newPosition ) ) );

	const multi = new MultiCmdsCommand( editor, cmds );
	multi.name = 'Normalize Imported Asset';
	editor.execute( multi );

	return plan;

}
