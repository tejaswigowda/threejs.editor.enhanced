// ── summarize.js + spatial helpers ───────────────────────────────────────────
// Two representations of the live scene for AI context injection:
//
//   summarizeScene(editor)     — structured object (backward-compat, used by tests)
//   sceneContextString(editor) — compact JS-comment string (preferred for AI prompts)
//
// sceneContextString produces one line per object in JS comment style:
//   // [selected] "Human" Mesh BoxGeometry(0.6,1.8,0.5) color:#ffcc99 at(0,0.9,0)
//   // "Ground"   Mesh PlaneGeometry(10,10) color:#888888 at(0,0,0) rot(-1.57,0,0)
//   // "Sun"      DirectionalLight color:#ffffff intensity:1 at(5,10,3)
//   // "Tree"     Group(2 children) at(3,0,-2)
//
// This format is far more token-efficient than JSON and is what a code model
// naturally reads, since it mirrors the JS output it produces.

const MAX_OBJECTS = 60;

// ── Helpers ───────────────────────────────────────────────────────────────────

function r4( v ) { return Math.round( v * 1e4 ) / 1e4; }
function r2( v ) { return Math.round( v * 1e2 ) / 1e2; }
function arr4( a ) { return a.map( r4 ); }

function colorHex( color ) {

	if ( ! color ) return undefined;
	return '#' + color.getHexString();

}

// ── World-space size helpers ──────────────────────────────────────────────────

/**
 * World-space bounding box size of any Object3D (handles Groups too).
 * Uses THREE.Box3 for accuracy. Returns null if the object has no geometry.
 */
function worldSize( obj ) {

	const THREE = window.THREE;
	if ( ! THREE ) return null;

	const box = new THREE.Box3().setFromObject( obj );
	if ( box.isEmpty() ) return null;

	const size = new THREE.Vector3();
	box.getSize( size );
	return size;

}

/**
 * World-space Y coordinate of the top face of an Object3D's bounding box.
 * Useful for "place on top of" operations.
 */
export function getTopY( obj ) {

	const THREE = window.THREE;
	if ( ! THREE ) return obj.position.y;

	const box = new THREE.Box3().setFromObject( obj );
	return box.isEmpty() ? obj.position.y : box.max.y;

}

/**
 * World-space center of an Object3D's bounding box.
 */
export function getWorldCenter( obj ) {

	const THREE = window.THREE;
	if ( ! THREE ) return obj.position.clone();

	const box    = new THREE.Box3().setFromObject( obj );
	const center = new THREE.Vector3();
	box.getCenter( center );
	return center;

}

/**
 * World-space bounding box size {x, y, z} of an Object3D.
 * Returns {x:0,y:0,z:0} for empty objects.
 */
export function getSize( obj ) {

	const s = worldSize( obj );
	return s ? { x: s.x, y: s.y, z: s.z } : { x: 0, y: 0, z: 0 };

}

// ── Key shape params only — omit segment counts (noise for small models)
const KEY_PARAMS = {
	BoxGeometry:          [ 'width', 'height', 'depth' ],
	SphereGeometry:       [ 'radius' ],
	CylinderGeometry:     [ 'radiusTop', 'radiusBottom', 'height' ],
	ConeGeometry:         [ 'radius', 'height' ],
	PlaneGeometry:        [ 'width', 'height' ],
	CircleGeometry:       [ 'radius' ],
	TorusGeometry:        [ 'radius', 'tube' ],
	TorusKnotGeometry:    [ 'radius', 'tube' ],
	RingGeometry:         [ 'innerRadius', 'outerRadius' ],
	DodecahedronGeometry: [ 'radius' ],
	IcosahedronGeometry:  [ 'radius' ],
	OctahedronGeometry:   [ 'radius' ],
	TetrahedronGeometry:  [ 'radius' ],
	CapsuleGeometry:      [ 'radius', 'length' ],
};

function geomSummary( geom ) {

	if ( ! geom || ! geom.type ) return null;
	const keys  = KEY_PARAMS[ geom.type ];
	const params = geom.parameters;
	if ( ! keys || ! params ) return geom.type;
	const args = keys.map( k => r2( params[ k ] ?? 0 ) ).join( ',' );
	return geom.type + '(' + args + ')';

}

// ── sceneContextString ────────────────────────────────────────────────────────

/**
 * Compact JS-comment string describing the live scene.
 * This is the preferred format for AI context — readable by code models.
 *
 * @param  {Editor} editor
 * @returns {string}
 */
export function sceneContextString( editor ) {

	const scene    = editor.scene;
	const camera   = editor.camera;
	const selected = editor.selected;
	const lines    = [];
	let   count    = 0;

	scene.traverse( function ( obj ) {

		if ( obj === scene ) return;
		if ( count >= MAX_OBJECTS ) return;
		count ++;

		const sel    = ( obj === selected ) ? '[selected] ' : '';
		const name   = '"' + ( obj.name || '?' ) + '"';
		const parts  = [ sel + name ];

		if ( obj.isMesh ) {

			parts.push( 'Mesh' );
			const gs = geomSummary( obj.geometry );
			if ( gs ) parts.push( gs );

			// World size: geometry dims × scale — lets AI reason about placement
			const ws = worldSize( obj );
			if ( ws ) parts.push( 'size(' + r2( ws.x ) + ',' + r2( ws.y ) + ',' + r2( ws.z ) + ')' );

			// Recipe tag — lets AI know this mesh has a recorded construction history
			const recipe = obj.userData?.recipe;
			if ( recipe?.length ) {

				const ops = recipe.slice( 1 ).map( s => s.op ).join( '+' );
				parts.push( ops ? `[recipe:${ recipe[ 0 ].type || '?' }+${ ops }]` : '[recipe]' );

			}
			if ( obj.material ) {

				if ( obj.material.color ) parts.push( 'color:' + colorHex( obj.material.color ) );
				const { opacity = 1, metalness, roughness, emissive } = obj.material;
				if ( opacity < 0.99 ) parts.push( 'opacity:' + r2( opacity ) );
				if ( metalness != null && metalness > 0.01 ) parts.push( 'metal:' + r2( metalness ) );
				if ( roughness != null && Math.abs( roughness - 1 ) > 0.01 ) parts.push( 'rough:' + r2( roughness ) );
				if ( emissive && emissive.getHex() > 0 ) parts.push( 'emissive:' + colorHex( emissive ) );

			}

		} else if ( obj.isLight ) {

			parts.push( obj.type );
			if ( obj.color ) parts.push( 'color:' + colorHex( obj.color ) );
			if ( obj.intensity != null && obj.intensity !== 1 ) parts.push( 'intensity:' + r2( obj.intensity ) );

		} else if ( obj.isGroup || obj.type === 'Group' ) {

			parts.push( 'Group(' + obj.children.length + ' children)' );

		} else {

			parts.push( obj.type );

		}

		// Position
		const p = obj.position;
		parts.push( 'at(' + r2( p.x ) + ',' + r2( p.y ) + ',' + r2( p.z ) + ')' );

		// Scale — only if non-unit
		const s = obj.scale;
		if ( Math.abs( s.x - 1 ) > 0.01 || Math.abs( s.y - 1 ) > 0.01 || Math.abs( s.z - 1 ) > 0.01 ) {

			parts.push( 'scale(' + r2( s.x ) + ',' + r2( s.y ) + ',' + r2( s.z ) + ')' );

		}

		// Rotation — only if non-zero
		const rot = obj.rotation;
		if ( Math.abs( rot.x ) > 0.01 || Math.abs( rot.y ) > 0.01 || Math.abs( rot.z ) > 0.01 ) {

			parts.push( 'rot(' + r2( rot.x ) + ',' + r2( rot.y ) + ',' + r2( rot.z ) + 'rad)' );

		}

		// Parent — only if not direct child of scene
		if ( obj.parent && obj.parent !== scene ) {

			parts.push( '[in:' + ( obj.parent.name || obj.parent.type ) + ']' );

		}

		lines.push( '// ' + parts.join( ' ' ) );

	} );

	// Camera line
	const cp = camera.position;
	let ct   = [ 0, 0, 0 ];
	if ( editor.controls && editor.controls.target ) ct = editor.controls.target.toArray().map( r2 );
	lines.push( '// Camera at(' + r2( cp.x ) + ',' + r2( cp.y ) + ',' + r2( cp.z ) + ') looking at(' + ct.join( ',' ) + ')' );

	return lines.join( '\n' );

}

// ── summarizeScene ────────────────────────────────────────────────────────────
// Structured object form — kept for backward compatibility and for tests.
// AI prompts now prefer sceneContextString.

/**
 * @param  {Editor} editor
 * @returns {{ objectCount, objects, selected, camera }}
 */
export function summarizeScene( editor ) {

	const scene    = editor.scene;
	const camera   = editor.camera;
	const selected = editor.selected;

	let _counter = 0;
	const objects = [];

	scene.traverse( function ( obj ) {

		if ( obj === scene ) return;
		if ( _counter >= MAX_OBJECTS ) return;

		_counter ++;

		const entry = {
			uuid: obj.uuid,
			name: obj.name || '(unnamed)',
			type: obj.type,
			pos:  arr4( obj.position.toArray() ),
		};

		// Scale — only if non-unit
		const s = obj.scale;
		if ( Math.abs( s.x - 1 ) > 0.001 || Math.abs( s.y - 1 ) > 0.001 || Math.abs( s.z - 1 ) > 0.001 ) {

			entry.scale = arr4( s.toArray() );

		}

		// Rotation — only if non-zero
		const r = obj.rotation;
		if ( Math.abs( r.x ) > 0.005 || Math.abs( r.y ) > 0.005 || Math.abs( r.z ) > 0.005 ) {

			entry.rot = arr4( [ r.x, r.y, r.z ] );

		}

		// Parent chain
		if ( obj.parent && obj.parent !== scene ) {

			entry.parent = obj.parent.name || obj.parent.type;

		}

		if ( obj.isMesh ) {

			if ( obj.material && obj.material.color ) entry.color = colorHex( obj.material.color );
			const gs = geomSummary( obj.geometry );
			if ( gs ) entry.geom = gs;

		}

		objects.push( entry );

	} );

	let cameraTarget = [ 0, 0, 0 ];
	if ( editor.controls && editor.controls.target ) {

		cameraTarget = arr4( editor.controls.target.toArray() );

	}

	return {
		objectCount: _counter,
		objects,
		selected: selected ? { uuid: selected.uuid, name: selected.name, type: selected.type } : null,
		camera: { position: arr4( camera.position.toArray() ), target: cameraTarget },
	};

}
