// Node test for the import-pipeline pure functions. Browser code is ESM with no
// package.json, so run with ABSOLUTE paths from this folder:
//   node docs/editor/js/import/__tests__/import-pipeline.test.mjs
// Uses a tiny THREE stub for the Box3/Vector3 math (computeNormalization accepts
// an injected THREE) so it runs without a browser or three.js.

import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname( fileURLToPath( import.meta.url ) );
const importDir = path.resolve( here, '..' );
const jsDir = path.resolve( importDir, '..' );

const { computeNormalization } = await import( path.join( importDir, 'normalize.js' ) );
const { parseLabelReply, buildLabelTable } = await import( path.join( importDir, 'labelPass.js' ) );
const { isMeaningfulName, diagnoseImport, diagnosticMessages } = await import( path.join( importDir, 'diagnostics.js' ) );
const editEval = await import( path.join( jsDir, 'ai', 'editEval.js' ) );

let pass = 0, fail = 0;
function test( name, fn ) {

	try { fn(); console.log( '  ✓ ' + name ); pass ++; }
	catch ( e ) { console.error( '  ✗ ' + name + '\n      ' + e.message ); fail ++; }

}

// ── Tiny THREE stub ───────────────────────────────────────────────────────────

class V3 {

	constructor( x = 0, y = 0, z = 0 ) { this.x = x; this.y = y; this.z = z; }
	set( x, y, z ) { this.x = x; this.y = y; this.z = z; return this; }
	copy( v ) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
	clone() { return new V3( this.x, this.y, this.z ); }
	multiplyScalar( s ) { this.x *= s; this.y *= s; this.z *= s; return this; }
	add( v ) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
	lengthSq() { return this.x ** 2 + this.y ** 2 + this.z ** 2; }

}

class Box3 {

	setFromObject( root ) {

		const b = root._baseBox, s = root.scale, p = root.position;
		this.min = new V3( b.min.x * s.x + p.x, b.min.y * s.y + p.y, b.min.z * s.z + p.z );
		this.max = new V3( b.max.x * s.x + p.x, b.max.y * s.y + p.y, b.max.z * s.z + p.z );
		return this;

	}
	isEmpty() { return false; }
	getSize( t ) { return t.set( this.max.x - this.min.x, this.max.y - this.min.y, this.max.z - this.min.z ); }
	getCenter( t ) { return t.set( ( this.min.x + this.max.x ) / 2, ( this.min.y + this.max.y ) / 2, ( this.min.z + this.max.z ) / 2 ); }

}

const THREE = { Vector3: V3, Box3 };

function makeRoot( baseBox ) {

	return {
		_baseBox: baseBox,
		scale: new V3( 1, 1, 1 ),
		position: new V3( 0, 0, 0 ),
		updateMatrixWorld() {},
	};

}

// ── normalize.js ──────────────────────────────────────────────────────────────

console.log( 'normalize.js' );

test( 'oversized asset (1000u) auto-scales to ~2u, stays grounded/centered', () => {

	const root = makeRoot( { min: { x: - 500, y: 0, z: - 500 }, max: { x: 500, y: 1000, z: 500 } } );
	const plan = computeNormalization( root, {}, THREE );
	assert.ok( plan.autoscaled, 'should autoscale' );
	assert.ok( Math.abs( plan.newScale[ 0 ] - 0.002 ) < 1e-4, 'scale ≈ 0.002' );
	assert.deepStrictEqual( plan.newPosition, [ 0, 0, 0 ], 'already centered+grounded' );
	assert.ok( plan.changed );

} );

test( 'sane off-center buried asset is centered + grounded, NOT rescaled', () => {

	const root = makeRoot( { min: { x: 2, y: - 3, z: 2 }, max: { x: 4, y: - 1, z: 4 } } );
	const plan = computeNormalization( root, {}, THREE );
	assert.strictEqual( plan.autoscaled, false, 'no autoscale for sane size' );
	assert.strictEqual( plan.scaleFactor, 1 );
	assert.deepStrictEqual( plan.newPosition, [ - 3, 3, - 3 ], 'center X/Z, lift min Y to 0' );

} );

test( 'already-normalized asset reports no change', () => {

	const root = makeRoot( { min: { x: - 1, y: 0, z: - 1 }, max: { x: 1, y: 2, z: 1 } } );
	const plan = computeNormalization( root, {}, THREE );
	assert.strictEqual( plan.changed, false );

} );

// ── labelPass.js ──────────────────────────────────────────────────────────────

console.log( 'labelPass.js' );

test( 'parseLabelReply parses id:label lines, tolerant of bullets/quotes', () => {

	const m = parseLabelReply( '- n0: "Dump Bed"\nn1 = Cab\nn2: Tail Light (right)\ngarbage line' );
	assert.strictEqual( m.get( 'n0' ), 'Dump Bed' );
	assert.strictEqual( m.get( 'n1' ), 'Cab' );
	assert.strictEqual( m.get( 'n2' ), 'Tail Light (right)' );
	assert.strictEqual( m.size, 3 );

} );

test( 'buildLabelTable assigns stable n# ids and skips nodes without descriptors', () => {

	const mesh = { isMesh: true, name: 'Object_07', children: [],
		userData: { descriptors: { role: 'leaf', region: { x: 'center', y: 'center', z: 'back' }, shape: 'flat', sizeRank: 'largest', parentName: 'DumpTruck', color: { base: 'gray' } } } };
	const root = { isMesh: false, traverse( fn ) { fn( root ); fn( mesh ); }, userData: {} };
	const { idMap, table } = buildLabelTable( root );
	assert.ok( idMap.has( 'n0' ) );
	assert.ok( /n0/.test( table ) && /largest/.test( table ) );

} );

// ── diagnostics.js ────────────────────────────────────────────────────────────

console.log( 'diagnostics.js' );

test( 'isMeaningfulName rejects exporter placeholders, accepts real nouns', () => {

	assert.strictEqual( isMeaningfulName( 'Object_07' ), false );
	assert.strictEqual( isMeaningfulName( 'mesh_12' ), false );
	assert.strictEqual( isMeaningfulName( '' ), false );
	assert.strictEqual( isMeaningfulName( 'Dump Bed' ), true );
	assert.strictEqual( isMeaningfulName( 'Tail_032Light' ), true ); // decodes to "Tail Light"

} );

test( 'diagnoseImport flags a single mesh as merged', () => {

	const mesh = { isMesh: true, name: 'GothicBed', material: {}, children: [], traverse( fn ) { fn( mesh ); } };
	const d = diagnoseImport( mesh );
	assert.strictEqual( d.mergedMesh, true );
	const msgs = diagnosticMessages( d, 'GothicBed' );
	assert.ok( /single merged mesh/i.test( msgs[ 0 ] ) );

} );

test( 'diagnoseImport flags opaque names on a multi-part asset', () => {

	const parts = [ 'Object_03', 'Object_07', 'Object_12', 'Object_13' ].map( n => ( { isMesh: true, name: n, material: {}, children: [] } ) );
	const root = { isMesh: false, children: parts, traverse( fn ) { fn( root ); parts.forEach( fn ); } };
	const d = diagnoseImport( root );
	assert.strictEqual( d.mergedMesh, false );
	assert.strictEqual( d.opaqueNames, true );

} );

// ── editEval.js scorers ───────────────────────────────────────────────────────

console.log( 'editEval.js' );

function snap( entries ) { return new Map( entries.map( e => [ e.name, e ] ) ); }

test( 'resolved-correct-node passes when ONLY the target recolors to the right base', () => {

	const before = snap( [ { name: 'Object_07', color: 0x888888 }, { name: 'Object_03', color: 0x2266cc } ] );
	const after = snap( [ { name: 'Object_07', color: 0xff0000 }, { name: 'Object_03', color: 0x2266cc } ] );
	const r = editEval.scoreResolvedCorrectNode( before, after, { targetName: 'Object_07', targetColorBase: 'red' } );
	assert.ok( r.pass, r.reasons.join() );

} );

test( 'no-collateral fails on shared-material bleed', () => {

	const before = snap( [ { name: 'A', color: 0xffffff }, { name: 'B', color: 0xffffff } ] );
	const after = snap( [ { name: 'A', color: 0xff0000 }, { name: 'B', color: 0xff0000 } ] );
	const r = editEval.scoreNoCollateral( before, after, { distinctColors: 2 } );
	assert.strictEqual( r.pass, false );

} );

test( 'graceful-fail passes when merged mesh NOT silently recolored', () => {

	const before = snap( [ { name: 'GothicBed', color: 0x9a7b4f } ] );
	const after = snap( [ { name: 'GothicBed', color: 0x9a7b4f } ] );
	const r = editEval.scoreGracefulFail( before, after, { text: 'This bed is a single mesh, I can\'t isolate the sheets.' }, { mergedFail: true, target: 'GothicBed' } );
	assert.ok( r.pass );

} );

test( 'graceful-fail FAILS when merged mesh silently recolored with no message', () => {

	const before = snap( [ { name: 'GothicBed', color: 0x9a7b4f } ] );
	const after = snap( [ { name: 'GothicBed', color: 0xff0000 } ] );
	const r = editEval.scoreGracefulFail( before, after, { text: '' }, { mergedFail: true, target: 'GothicBed' } );
	assert.strictEqual( r.pass, false );

} );

test( 'colorBase buckets primaries', () => {

	assert.strictEqual( editEval.colorBase( 0xff0000 ), 'red' );
	assert.strictEqual( editEval.colorBase( 0x00ff00 ), 'green' );
	assert.strictEqual( editEval.colorBase( 0x0000ff ), 'blue' );

} );

// ── matchPartNodes (plural part resolution — the "recolor all 12" fix) ─────────
const { matchPartNodes } = await import( path.join( jsDir, 'intelligence', 'sceneIndex.js' ) );

function mesh( name, label, desc ) {

	return { isMesh: true, name, children: [], userData: { label, descriptors: desc || { role: 'mesh' } } };

}

test( 'matchPartNodes resolves "the wheels" to ALL four wheels (label path)', () => {

	const nodes = [
		mesh( 'Object_20', 'Front Left Wheel' ),
		mesh( 'Object_21', 'Front Right Wheel' ),
		mesh( 'Object_22', 'Rear Left Wheel' ),
		mesh( 'Object_23', 'Rear Right Wheel' ),
		mesh( 'Object_05', 'Truck Body' ),
		mesh( 'Object_06', 'Dump Bed' ),
	];
	const r = matchPartNodes( nodes, 'make the wheels black' );
	assert.strictEqual( r.method, 'label' );
	assert.strictEqual( r.nodes.length, 4 );
	assert.ok( r.nodes.every( n => n.userData.label.includes( 'Wheel' ) ) );

} );

test( 'matchPartNodes resolves "the body" to only the body, not the wheels', () => {

	const nodes = [
		mesh( 'Object_20', 'Front Left Wheel' ),
		mesh( 'Object_21', 'Front Right Wheel' ),
		mesh( 'Object_05', 'Truck Body' ),
	];
	const r = matchPartNodes( nodes, 'make the car body red' );
	assert.strictEqual( r.method, 'label' );
	assert.strictEqual( r.nodes.length, 1 );
	assert.strictEqual( r.nodes[ 0 ].userData.label, 'Truck Body' );

} );

test( 'matchPartNodes reports merged mesh instead of recoloring whole asset', () => {

	const nodes = [ mesh( 'GothicBed', 'Gothic Bed' ) ];
	const r = matchPartNodes( nodes, 'make the wheels black' );
	assert.strictEqual( r.method, 'merged' );
	assert.strictEqual( r.nodes.length, 0 );
	assert.ok( /merged/i.test( r.message ) );

} );

test( 'matchPartNodes returns none (not all) for an unknown part', () => {

	const nodes = [
		mesh( 'Object_20', 'Front Left Wheel' ),
		mesh( 'Object_05', 'Truck Body' ),
	];
	const r = matchPartNodes( nodes, 'make the antenna green' );
	assert.strictEqual( r.nodes.length, 0 );
	assert.notStrictEqual( r.method, 'label' );

} );

// ── scoreCandidates: structural-group exclusion + name matching ───────────────
const { parseQuery, scoreCandidates } = await import( path.join( jsDir, 'intelligence', 'resolver.js' ) );

function descNode( name, isMeshFlag, desc ) {

	return { isMesh: isMeshFlag, name, userData: { descriptors: desc } };

}
const D = ( role, shape ) => ( { role, shape, region: { x: 'center', y: 'center', z: 'center' }, sizeRank: 'medium', parentName: 'Scene' } );

test( 'scoreCandidates drops wrapper groups when a mesh matches (no Group no-op)', () => {

	const nodes = [
		descNode( 'dumptruck.glb', false, D( 'group', 'blocky' ) ),
		descNode( 'Sketchfab_model', false, D( 'group', 'blocky' ) ),
		descNode( 'Object_3', true, D( 'mesh', 'blocky' ) ),
		descNode( 'Object_4', true, D( 'mesh', 'blocky' ) ),
	];
	const ranked = scoreCandidates( nodes, parseQuery( 'truck body' ) );
	assert.ok( ranked.length > 0 );
	assert.ok( ranked.every( r => r.node.isMesh ), 'only meshes should remain' );

} );

test( 'scoreCandidates ranks a meaningfully-named mesh above shape-only ties', () => {

	const nodes = [
		descNode( 'Body', true, D( 'mesh', 'blocky' ) ),
		descNode( 'Object_4', true, D( 'mesh', 'blocky' ) ),
	];
	const ranked = scoreCandidates( nodes, parseQuery( 'truck body' ) );
	assert.strictEqual( ranked[ 0 ].node.name, 'Body' );

} );

test( 'matchPartNodes best-guesses ONE mesh (not all) when an asset has no labels', () => {

	const nodes = [
		mesh( 'Object_3', '', D( 'mesh', 'blocky' ) ),
		mesh( 'Object_4', '', D( 'mesh', 'blocky' ) ),
		mesh( 'Object_5', '', D( 'mesh', 'blocky' ) ),
	];
	const r = matchPartNodes( nodes, 'make the truck body red' );
	assert.strictEqual( r.method, 'descriptors' );
	assert.strictEqual( r.nodes.length, 1 );
	assert.strictEqual( r.ambiguous, true );

} );

// ── S4: label confidence parsing (parseLabelRows) ─────────────────────────────
const { parseLabelRows } = await import( path.join( importDir, 'labelPass.js' ) );

console.log( 'labelPass.js — confidence' );

test( 'parseLabelRows extracts optional confidence ("| 0.9", "(0.4)") and label', () => {

	const m = parseLabelRows( 'n0: Dump Bed | 0.9\nn1: Cab (0.4)\nn2: Grille' );
	assert.strictEqual( m.get( 'n0' ).label, 'Dump Bed' );
	assert.strictEqual( m.get( 'n0' ).confidence, 0.9 );
	assert.strictEqual( m.get( 'n1' ).label, 'Cab' );
	assert.strictEqual( m.get( 'n1' ).confidence, 0.4 );
	assert.strictEqual( m.get( 'n2' ).label, 'Grille' );
	assert.strictEqual( m.get( 'n2' ).confidence, null ); // optional — absent is fine

} );

test( 'parseLabelReply stays label-only + back-compat (confidence stripped)', () => {

	const m = parseLabelReply( 'n0: Dump Bed | 0.9\nn1 = Cab\nn2: Tail Light (right)' );
	assert.strictEqual( m.get( 'n0' ), 'Dump Bed' ); // confidence stripped, not glued on
	assert.strictEqual( m.get( 'n1' ), 'Cab' );
	assert.strictEqual( m.get( 'n2' ), 'Tail Light (right)' ); // "(right)" is NOT a confidence

} );

// ── S5: material-name resolution ──────────────────────────────────────────────

console.log( 'material-name resolution (S5)' );

function meshMat( name, materials, label ) {

	return { isMesh: true, name, children: [],
		userData: { label, descriptors: { role: 'mesh', materials,
			region: { x: 'center', y: 'center', z: 'center' }, sizeRank: 'medium', parentName: 'DumpTruck' } } };

}

test( 'matchPartNodes resolves "the grille" via material name on an Object_N mesh', () => {

	const nodes = [
		meshMat( 'Object_09', [ 'Grille' ] ),
		meshMat( 'Object_05', [ 'Body' ] ),
		meshMat( 'Object_20', [ 'Rims' ] ),
	];
	const r = matchPartNodes( nodes, 'make the grille silver' );
	assert.strictEqual( r.method, 'label' ); // label-path now includes material text
	assert.strictEqual( r.nodes.length, 1 );
	assert.strictEqual( r.nodes[ 0 ].name, 'Object_09' );

} );

test( 'scoreCandidates ranks material-name match above shape-only ties', () => {

	const nodes = [
		descNode( 'Object_09', true, { role: 'mesh', shape: 'blocky', materials: [ 'Grille' ],
			region: { x: 'center', y: 'center', z: 'front' }, sizeRank: 'medium', parentName: 'Truck' } ),
		descNode( 'Object_04', true, { role: 'mesh', shape: 'blocky', materials: [ 'Body' ],
			region: { x: 'center', y: 'center', z: 'center' }, sizeRank: 'medium', parentName: 'Truck' } ),
	];
	const ranked = scoreCandidates( nodes, parseQuery( 'the grille' ) );
	assert.strictEqual( ranked[ 0 ].node.name, 'Object_09' );
	assert.ok( ranked[ 0 ].reasons.some( s => /material/.test( s ) ) );

} );

// ── S6: subset-request-but-all-changed flag (flagSubsetAllChanged) ────────────
const { flagSubsetAllChanged } = await import( path.join( jsDir, 'ai', 'agentLoop.js' ) );

console.log( 'agentLoop.js — C7 subset misresolution (S6)' );

const TRUCK = [ { name: 'DumpTruck', label: 'Dump Truck',
	meshNames: [ 'Object_2', 'Object_5', 'Object_7', 'Object_9', 'Object_20', 'Object_21' ] } ];

test( 'flags when "make the wheels black" changed ALL parts of the asset', () => {

	const changed = new Set( TRUCK[ 0 ].meshNames );
	const f = flagSubsetAllChanged( 'make the wheels black', changed, TRUCK );
	assert.ok( f, 'should flag wrong resolution' );
	assert.strictEqual( f.noun, 'wheels' );
	assert.strictEqual( f.count, 6 );

} );

test( 'does NOT flag when only a subset of parts changed (correct resolution)', () => {

	const changed = new Set( [ 'Object_20', 'Object_21' ] ); // just the wheels
	const f = flagSubsetAllChanged( 'make the wheels black', changed, TRUCK );
	assert.strictEqual( f, null );

} );

test( 'does NOT flag a whole-asset request even if all parts changed', () => {

	const changed = new Set( TRUCK[ 0 ].meshNames );
	assert.strictEqual( flagSubsetAllChanged( 'make the truck red', changed, TRUCK ), null ); // names the asset
	assert.strictEqual( flagSubsetAllChanged( 'make everything red', changed, TRUCK ), null ); // whole-word

} );

console.log( `\n${ pass } passed, ${ fail } failed` );
process.exit( fail ? 1 : 0 );
