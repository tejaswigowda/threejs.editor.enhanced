// ── eval.js ───────────────────────────────────────────────────────────────────
// Standing eval set + 4-axis rubric (Change Set E). Turns the ad-hoc eval run
// (pong / chess / ping-pong / billiards / basketball hoop) into a repeatable
// regression + generalization gate.
//
// The four axes are the ones the live runs actually surfaced:
//   1. Structure-valid    — ran clean, named, AddObjectCommand, no loop/prose/overflow
//   2. Spatially-grounded — flat things flat (X-Z), objects rest on ground, no walls
//   3. Semantically-complete — right parts AND plausible (distinct sizes, not degenerate)
//   4. Not-overfit/distinct — non-chess prompts don't emit the chess template;
//        recolors produce DISTINCT colors (no shared-material collision)
//
// Axis 4 exists because two automated runs scored "make a traffic intersection"
// as ✓✓✓ while it was a green/cream chessboard both times — the gauge read green
// over a known fault. Canary prompts + the overfit detector make it visible.
//
// Scoring is split into PURE functions (unit-testable in node, no DOM/WebGPU) and
// a dependency-injected runner that drives the real agentic loop in the browser.
//
// Gate usage: run after every prompt change; run 1.5B vs 7B side-by-side to decide
// routing; run BEFORE any distillation harvest (see the sequencing note in the
// handover — do not harvest until structure + grounding are clean across the set).

// ── Prompt set (tiered) ─────────────────────────────────────────────────────────
// expect: { minObjects, flat, minParts } — only the fields relevant to a tier.

export const EVAL_PROMPTS = [
	// Taught — must not regress.
	{ prompt: 'make a pong scene',        tier: 'taught',        expect: { minObjects: 4 } },

	// Near-neighbour — generalize from the taught example.
	{ prompt: 'make a ping pong table',   tier: 'near-neighbor', expect: { minObjects: 4 } },
	{ prompt: 'make an air hockey table', tier: 'near-neighbor', expect: { minObjects: 4 } },

	// Structural — flat grids / repeated layout, each a DIFFERENT structure.
	{ prompt: 'make a chess board',       tier: 'structural',    expect: { minObjects: 1, flat: true } },
	{ prompt: 'make a tiled floor',       tier: 'structural',    expect: { minObjects: 1, flat: true } },
	{ prompt: 'make a staircase',         tier: 'structural',    expect: { minObjects: 3 } },
	{ prompt: 'make a fence',             tier: 'structural',    expect: { minObjects: 3 } },

	// Overfit canaries — boards where a chessboard is the WRONG answer. They MUST
	// NOT all come back as 8×8 alternating grids (the chess few-shot over-copying).
	{ prompt: 'make a backgammon board',  tier: 'overfit-canary', expect: { minObjects: 1, noChessTemplate: true } },
	{ prompt: 'make a go board',          tier: 'overfit-canary', expect: { minObjects: 1, noChessTemplate: true } },
	{ prompt: 'make a monopoly board',    tier: 'overfit-canary', expect: { minObjects: 1, noChessTemplate: true } },

	// Compositional — multi-part world objects (the model-size ceiling).
	{ prompt: 'make a basketball hoop',   tier: 'compositional', expect: { minObjects: 3, minParts: 3 } },
	{ prompt: 'make a desk lamp',         tier: 'compositional', expect: { minObjects: 3, minParts: 3 } },
	{ prompt: 'make a park bench',        tier: 'compositional', expect: { minObjects: 3, minParts: 3 } },

	// Lookup / edit — operate on a pre-seeded scene (setup runs before the prompt).
	// These exercise findObject / removal / "no-effect" recovery, not construction,
	// so expect.minObjects is 0 (the scored objects are the ADDED ones).
	{ prompt: 'clear the scene', tier: 'lookup-edit', expect: { minObjects: 0 },
		setup: "(function(){const a=new Mesh(new BoxGeometry(1,1,1),new MeshStandardMaterial());a.name='Box';editor.execute(new AddObjectCommand(editor,a));const b=new Mesh(new SphereGeometry(0.5),new MeshStandardMaterial());b.name='Ball';editor.execute(new AddObjectCommand(editor,b));})();" },
	{ prompt: 'make the red one bigger', tier: 'lookup-edit', expect: { minObjects: 0 },
		setup: "(function(){const s=new Mesh(new SphereGeometry(0.5),new MeshStandardMaterial({color:0xff2222}));s.name='Red Sphere';s.position.y=0.5;editor.execute(new AddObjectCommand(editor,s));})();" },
	{ prompt: 'delete the cube on the left', tier: 'lookup-edit', expect: { minObjects: 0 },
		setup: "(function(){const c=new Mesh(new BoxGeometry(1,1,1),new MeshStandardMaterial({color:0x3366ff}));c.name='Cube';c.position.set(-3,0.5,0);editor.execute(new AddObjectCommand(editor,c));})();" },

	// Material — distinct independent colors (guards the shared-material collision).
	{ prompt: 'make the paddles red and blue', tier: 'material', expect: { minObjects: 0, distinctColors: 2 },
		setup: "(function(){const pl=new Mesh(new BoxGeometry(0.3,0.2,2),new MeshStandardMaterial({color:0xffffff}));pl.name='Paddle Left';pl.position.set(-3,0.1,0);editor.execute(new AddObjectCommand(editor,pl));const pr=new Mesh(new BoxGeometry(0.3,0.2,2),new MeshStandardMaterial({color:0xffffff}));pr.name='Paddle Right';pr.position.set(3,0.1,0);editor.execute(new AddObjectCommand(editor,pr));})();" },

	// Layout — "X and Y" must be placed APART (not co-located) with shape-appropriate
	// primitives (a bat is elongated, not a cube). Spatial axis catches co-location.
	{ prompt: 'make a bat and ball',      tier: 'layout',        expect: { minObjects: 2 } },

	// Animation — author a keyframe CLIP on a seeded object (no new scene objects, so
	// minObjects is 0). Guards that the animation classes + addClip stay in scope and
	// that the model emits a clip instead of a forbidden requestAnimationFrame loop.
	{ prompt: 'make the box bounce', tier: 'animation', expect: { minObjects: 0 },
		setup: "(function(){const b=new Mesh(new BoxGeometry(1,1,1),new MeshStandardMaterial({color:0x3366ff}));b.name='Box';b.position.y=0.5;editor.execute(new AddObjectCommand(editor,b));editor.select(b);})();" },
	{ prompt: 'spin it 360 degrees over 2 seconds', tier: 'animation', expect: { minObjects: 0 },
		setup: "(function(){const w=new Mesh(new CylinderGeometry(1,1,0.2,24),new MeshStandardMaterial({color:0x888888}));w.name='Wheel';w.position.y=1;w.rotation.x=Math.PI/2;editor.execute(new AddObjectCommand(editor,w));editor.select(w);})();" },

	// Off-domain — open generalization. A traffic intersection is NOT a chessboard.
	{ prompt: 'make a small kitchen',     tier: 'off-domain',    expect: { minObjects: 3 } },
	{ prompt: 'make a traffic intersection', tier: 'off-domain', expect: { minObjects: 3, noChessTemplate: true } },
];

// ── Axis 1: structure ───────────────────────────────────────────────────────────
// result: { hadCode, validateOk, execOk }
export function scoreStructure( result ) {

	const pass = !! ( result && result.hadCode && result.validateOk && result.execOk );
	const reasons = [];
	if ( ! result || ! result.hadCode ) reasons.push( 'no code extracted' );
	else {

		if ( ! result.validateOk ) reasons.push( 'failed API validation' );
		if ( ! result.execOk ) reasons.push( 'threw on execute' );

	}
	return { pass, reasons };

}

// ── Axis 2: spatial grounding ────────────────────────────────────────────────────
// objects: [{ size:[x,y,z], pos:[x,y,z] }] — world-space bounds of ADDED objects.
// Flat-expected scenes must lie in X-Z (small Y spread); nothing should be buried
// well below the ground plane.
export function scoreSpatial( objects, expect = {} ) {

	const reasons = [];
	if ( ! objects || objects.length === 0 ) {

		// No objects ADDED. For a flat-construction request that's a failure; for an
		// edit/lookup op (no construction expected) spatial grounding is N/A → pass.
		return expect.flat ? { pass: false, reasons: [ 'no objects' ] } : { pass: true, reasons: [] };

	}

	// Overall bounding EXTENT per axis (centre ± half-size). Using extents — not
	// just centre spread — means a single wide-flat plane reads as flat, while a
	// stack of cubes reads by its real footprint.
	const extent = axis => {

		const lo = Math.min( ...objects.map( o => o.pos[ axis ] - o.size[ axis ] / 2 ) );
		const hi = Math.max( ...objects.map( o => o.pos[ axis ] + o.size[ axis ] / 2 ) );
		return hi - lo;

	};
	const xExt = extent( 0 ), yExt = extent( 1 ), zExt = extent( 2 );

	// Resting-on-ground: lowest object bottom shouldn't sink far below y=0.
	const lowestBottom = Math.min( ...objects.map( o => o.pos[ 1 ] - o.size[ 1 ] / 2 ) );
	if ( lowestBottom < - 0.25 ) reasons.push( 'object sits below the ground plane' );

	// Co-location (tier-1 geometric check): two objects occupying essentially the
	// SAME volume — "bat and ball" dropped at one point. We measure real bounding-
	// box overlap AND size comparability, not just centroid distance. Centroid-only
	// flags correct geometry: perpendicular thin parts that merely CROSS (grid
	// lines, intersecting roads) share a centre, and a thin overlay resting ON a
	// surface (a line on a board) is fully inside the larger box. Both are valid.
	// Flag only when two COMPARABLY-SIZED, BLOCKY objects substantially overlap.
	const boxVol = o => Math.max( o.size[ 0 ], 1e-4 ) * Math.max( o.size[ 1 ], 1e-4 ) * Math.max( o.size[ 2 ], 1e-4 );
	const flatness = o => {

		const d = o.size.map( x => Math.abs( x ) );
		return Math.min( ...d ) / Math.max( ...d, 1e-6 );

	};
	for ( let a = 0; a < objects.length && ! reasons.includes( 'co-located' ); a ++ ) {

		for ( let b = a + 1; b < objects.length; b ++ ) {

			const A = objects[ a ], B = objects[ b ];

			// Axis-aligned bounding-box overlap volume.
			let overlap = 1;
			for ( let k = 0; k < 3; k ++ ) {

				const aLo = A.pos[ k ] - A.size[ k ] / 2, aHi = A.pos[ k ] + A.size[ k ] / 2;
				const bLo = B.pos[ k ] - B.size[ k ] / 2, bHi = B.pos[ k ] + B.size[ k ] / 2;
				overlap *= Math.max( 0, Math.min( aHi, bHi ) - Math.max( aLo, bLo ) );

			}
			if ( overlap <= 0 ) continue;

			const volA = boxVol( A ), volB = boxVol( B );
			const smaller = Math.min( volA, volB );
			const buriedFrac = overlap / smaller;          // how deep the smaller is inside the other
			const sizeRatio = smaller / Math.max( volA, volB ); // 1 = identical size, →0 = sliver-vs-bulk
			const smallerFlat = flatness( volA <= volB ? A : B ); // is the smaller a thin layer/plate?

			// Stacked-at-one-spot ⇒ comparable sizes AND the smaller is mostly buried
			// AND the smaller is BLOCKY. Crossings have low buriedFrac; thin overlays/
			// details (plates, lines, rails, legs laid on a larger flat object) have
			// low sizeRatio OR low flatness — both are intentional surface/layer detail.
			if ( buriedFrac > 0.5 && sizeRatio > 0.25 && smallerFlat >= 0.2 ) {

				reasons.push( 'objects co-located at the same spot — space them apart' );
				break;

			}

		}

	}

	// Flat layouts: must spread in X-Z, not stand up in X-Y (the chess-wall bug).
	if ( expect.flat ) {

		const planar = Math.max( xExt, zExt );
		if ( planar <= 0.001 ) reasons.push( 'no horizontal spread' );
		else if ( yExt > planar * 0.5 ) reasons.push( 'laid out vertically (X-Y wall) instead of flat (X-Z)' );
		else if ( zExt < planar * 0.25 ) reasons.push( 'collapsed onto a single line, not a 2-D grid' );

	}

	return { pass: reasons.length === 0, reasons };

}

// ── Axis 3: semantic completeness + plausibility ─────────────────────────────────
// Count is NECESSARY but not SUFFICIENT (E2c): a desk lamp with 3 identical boxes
// "has 3 parts" yet is degenerate. So for multi-part objects we also require the
// parts to differ in size — decomposition means DISTINCT primitives, not clones.
export function scoreSemantic( objectCount, partCount, expect = {}, objects = [] ) {

	const reasons = [];
	if ( expect.minObjects && objectCount < expect.minObjects ) {

		reasons.push( `only ${ objectCount } object(s), expected ≥ ${ expect.minObjects }` );

	}
	if ( expect.minParts && partCount < expect.minParts ) {

		reasons.push( `only ${ partCount } grouped part(s), expected ≥ ${ expect.minParts } (single-primitive = under-decomposed)` );

	}

	// Plausibility: a decomposed object whose parts are ALL the same size is a
	// degenerate "stack of identical boxes", not a real decomposition.
	if ( expect.minParts && objects.length >= 2 ) {

		const key = o => o.size.map( v => Math.round( v * 100 ) ).join( ',' );
		const distinctSizes = new Set( objects.map( key ) ).size;
		if ( distinctSizes === 1 ) {

			reasons.push( 'all parts are identical in size — degenerate decomposition, not distinct parts' );

		}

	}

	return { pass: reasons.length === 0, reasons };

}

// ── Axis 4: not-overfit / distinct result ────────────────────────────────────────
// Two failure modes this guards:
//   • few-shot over-copy: a non-chess prompt emits the chess template ((i+j)%2
//     alternating tiles). The chess few-shot over-generalized to every "board".
//   • shared-material collision: a recolor asked for N distinct colors but the
//     meshes share one material, so they all end up one color.
// code: the generated source. distinctColorCount: unique material colors in scene.
const CHESS_SIGNATURE = /\(\s*i\s*\+\s*j\s*\)\s*%\s*2/;

export function scoreNotOverfit( code, prompt, expect = {}, distinctColorCount = null ) {

	const reasons = [];
	const p = String( prompt || '' ).toLowerCase();
	const src = String( code || '' );

	// Chess template emitted for something that is NOT a checkered board.
	const checkerOk = /\b(chess|checker|draught)/.test( p );
	if ( expect.noChessTemplate && CHESS_SIGNATURE.test( src ) && ! checkerOk ) {

		reasons.push( 'copied the chessboard template ((i+j)%2 grid) for a non-chess request' );

	}

	// Recolor must yield the requested number of DISTINCT colors.
	if ( expect.distinctColors && distinctColorCount !== null && distinctColorCount < expect.distinctColors ) {

		reasons.push( `colors collapsed to ${ distinctColorCount } (expected ${ expect.distinctColors } distinct) — likely a shared material instance` );

	}

	return { pass: reasons.length === 0, reasons };

}

// ── D1 routing heuristic ─────────────────────────────────────────────────────────
// "basketball hoop → single cone" is a genuine 1.5B knowledge limit, not a prompt
// bug. Detect requests that likely need multi-part world-knowledge decomposition
// AND came back under-decomposed, so the UI can suggest the Power (7B) tier.

const COMPOSITIONAL_HINT = /\b(hoop|lamp|bench|chair|desk|table|car|truck|house|kitchen|robot|tree|bicycle|bike|drone|guitar|piano|crane|windmill|lighthouse|rocket|castle|bridge|skeleton|person|animal|dog|cat|horse)\b/i;

export function looksCompositional( intent ) {

	return COMPOSITIONAL_HINT.test( String( intent || '' ) );

}

/**
 * Should we suggest escalating this request to the Power tier?
 * @param {string} intent     the user request
 * @param {number} partCount  number of grouped/primitive parts produced
 * @param {boolean} alreadyPower  true if a Power-class model is already loaded
 */
export function shouldSuggestPower( intent, partCount, alreadyPower = false ) {

	return ! alreadyPower && looksCompositional( intent ) && partCount <= 1;

}

// ── Runner (browser; dependency-injected like the agentic loop) ──────────────────
// deps = {
//   generate(prompt) -> Promise<{ hadCode, validateOk, execOk, objects, partCount,
//                                 code, distinctColorCount }>,
//   clearScene()     -> Promise<void> | void,   // reset between prompts
//   seed(code)       -> void,                   // pre-seed lookup/edit/material scenes
//   log(line)        -> void,                   // progress output
// }
export async function runEval( { prompts = EVAL_PROMPTS, deps } ) {

	const { generate, clearScene, seed, log = () => {} } = deps;
	const results = [];

	for ( const item of prompts ) {

		if ( clearScene ) await clearScene();
		if ( item.setup && seed ) await seed( item.setup ); // pre-seed lookup/edit/material scenes
		log( `▶ ${ item.tier }: ${ item.prompt }` );

		let gen;
		try { gen = await generate( item.prompt ); }
		catch ( err ) { gen = { hadCode: false, validateOk: false, execOk: false, objects: [], partCount: 0, error: err.message }; }

		const structure = scoreStructure( gen );
		const spatial   = scoreSpatial( gen.objects, item.expect );
		const semantic  = scoreSemantic( ( gen.objects || [] ).length, gen.partCount || 0, item.expect, gen.objects || [] );
		const distinct  = scoreNotOverfit( gen.code, item.prompt, item.expect, gen.distinctColorCount ?? null );

		results.push( { ...item, structure, spatial, semantic, distinct, suggestPower: shouldSuggestPower( item.prompt, gen.partCount || 0 ) } );

	}

	return results;

}

// Render a compact 4-axis pass/fail table.
export function formatTable( results ) {

	const mark = r => ( r.pass ? '✓' : '✗' );
	const lines = [
		'tier            | struct | spatial | semantic | distinct | prompt',
		'----------------|--------|---------|----------|----------|-------',
	];
	for ( const r of results ) {

		lines.push(
			`${ r.tier.padEnd( 15 ) } |   ${ mark( r.structure ) }    |    ${ mark( r.spatial ) }    |     ${ mark( r.semantic ) }    |    ${ mark( r.distinct ) }     | ${ r.prompt }`
		);
		const why = [ ...r.structure.reasons, ...r.spatial.reasons, ...r.semantic.reasons, ...r.distinct.reasons ];
		if ( why.length ) lines.push( `                · ${ why.join( '; ' ) }` );

	}
	return lines.join( '\n' );

}
