// ── codegen.js ────────────────────────────────────────────────────────────────
// Conversion 4: Scene / Object3D / three.js JSON  →  executable JS
//
// Given a live object or three.js JSON, emits clean, human-readable JavaScript
// that recreates it when executed through the shell.  Output always terminates
// with editor.execute(new AddObjectCommand(editor, ...)) so changes land on the
// undo stack.
//
// PUBLIC API
//   objectToJS(object)                 live Object3D → JS string
//   jsonToJS(json)                     three.js scene JSON → JS string for all roots
//   objectJSONToJS(json)               single-object JSON → JS string
//   sceneToJS(editor)                  entire editor scene → JS string
//
// LOSSY HANDLING
//   If a geometry cannot be reconstructed from constructor args, the function
//   emits a clearly-flagged JSON-load fallback rather than silently wrong code.
//   Callers can detect this via the returned metadata.lossy flag.

import { deriveArgs, isReconstructable } from './geometryParams.js';
import { materialToOptions, isSupportedMaterial } from './materialProps.js';

// ── Recipe helpers ────────────────────────────────────────────────────────────

// Op names that are independently replayable (primitive constructor + these ops = exact mesh)
const REPLAYABLE_OPS = new Set( [ 'extrude', 'inset', 'bevel', 'deleteFaces', 'weld', 'planarUV', 'boxUV' ] );

/**
 * Summarise a recipe array as a human-readable one-liner.
 */
function recipeDesc( recipe ) {

	return recipe.map( step => {

		if ( step.op === 'primitive' ) return `${ step.type }(${ ( step.args || [] ).join( ',' ) })`;
		if ( step.op.startsWith( 'boolean' ) ) return `${ step.op }("${ step.a }", "${ step.b }")`;
		if ( step.op === 'mirrorMesh' ) return `mirrorMesh("${ step.source }", '${ step.axis }')`;

		const ps = Object.entries( step.params || {} )
			.map( ( [ k, v ] ) => `${ k }:${ v }` ).join( ',' );
		return `${ step.op }(${ ps })`;

	} ).join( ' → ' );

}

/**
 * Return true if a recipe can be exactly replayed from its primitive + edit ops.
 * Recipes containing boolean/mirror/array provenance steps are descriptive-only.
 */
function isReplayable( recipe ) {

	if ( ! recipe || ! recipe.length ) return false;
	const [ head, ...rest ] = recipe;
	if ( head.op !== 'primitive' || head.type === 'BufferGeometry' ) return false;
	return rest.every( s => REPLAYABLE_OPS.has( s.op ) );

}

// ── Transform helpers ─────────────────────────────────────────────────────────

function r5( v ) { return Math.round( v * 1e5 ) / 1e5; }

/**
 * Decompose a flat 16-float matrix into position/rotation/scale.
 * Returns { position:[x,y,z], rotation:[x,y,z], scale:[x,y,z] }.
 */
function decomposeMatrix( matrix16 ) {

	const THREE = window.THREE;
	const m  = new THREE.Matrix4().fromArray( matrix16 );
	const pos = new THREE.Vector3();
	const quat = new THREE.Quaternion();
	const scl = new THREE.Vector3();
	m.decompose( pos, quat, scl );
	const euler = new THREE.Euler().setFromQuaternion( quat, 'XYZ' );

	return {
		position: [ pos.x, pos.y, pos.z ].map( r5 ),
		rotation: [ euler.x, euler.y, euler.z ].map( r5 ),
		scale:    [ scl.x, scl.y, scl.z ].map( r5 ),
	};

}

/**
 * Emit transform lines (position/rotation/scale) for a variable name.
 * Skips identity values.
 */
function emitTransform( varName, pos, rot, scl, indent ) {

	const lines = [];
	const i = indent ?? '';

	if ( pos.some( v => v !== 0 ) ) {

		lines.push( `${i}${varName}.position.set(${pos.join(', ')});` );

	}

	if ( rot.some( v => v !== 0 ) ) {

		lines.push( `${i}${varName}.rotation.set(${rot.join(', ')});  // radians XYZ` );

	}

	if ( scl.some( v => v !== 1 ) ) {

		lines.push( `${i}${varName}.scale.set(${scl.join(', ')});` );

	}

	return lines;

}

// ── Geometry codegen ──────────────────────────────────────────────────────────

/**
 * Emit JS to create a geometry constant.
 * Returns { code: string, lossy: bool, lossyReason?: string, varName: string }.
 *
 * @param {object} geomJSON  entry from .geometries[] or live geometry .toJSON()
 * @param {string} varName   JS variable name to assign
 * @param {string} indent
 */
function emitGeometry( geomJSON, varName, indent = '' ) {

	const result = deriveArgs( geomJSON );

	if ( result.lossy ) {

		// Lossy fallback: reconstruct via ObjectLoader from embedded JSON
		const jsonStr = JSON.stringify( {
			metadata: { version: 4.6, type: 'BufferGeometry', generator: 'codegen-fallback' },
			...geomJSON,
		} );

		const code = [
			`${indent}// ⚠ LOSSY FALLBACK: ${result.reason}`,
			`${indent}// This geometry cannot be reconstructed from constructor args.`,
			`${indent}// It has been embedded as JSON and will be loaded via ObjectLoader.`,
			`${indent}var ${varName} = (function() {`,
			`${indent}  var loader = new THREE.BufferGeometryLoader();`,
			`${indent}  return loader.parse(${jsonStr});`,
			`${indent}})();`,
		].join( '\n' );

		return { code, lossy: true, lossyReason: result.reason, varName };

	}

	const args = result.args.map( a => {

		if ( typeof a === 'boolean' ) return String( a );
		if ( typeof a === 'number' ) return r5( a );
		return JSON.stringify( a );

	} );

	const code = `${indent}var ${varName} = new THREE.${geomJSON.type}(${args.join(', ')});`;

	return { code, lossy: false, varName };

}

// ── Material codegen ──────────────────────────────────────────────────────────

/**
 * Emit JS to create a material constant.
 * Returns { code: string, lossy: bool, varName: string }.
 *
 * @param {object} matJSON  entry from .materials[]
 * @param {string} varName
 * @param {string} indent
 */
function emitMaterial( matJSON, varName, indent = '' ) {

	if ( ! isSupportedMaterial( matJSON.type ) ) {

		// Unsupported material — fallback to MeshStandardMaterial with color
		const colorVal = typeof matJSON.color === 'number'
			? '0x' + matJSON.color.toString( 16 ).padStart( 6, '0' )
			: '0xffffff';

		const code = [
			`${indent}// ⚠ LOSSY FALLBACK: unsupported material type "${matJSON.type}"`,
			`${indent}// Emitting MeshStandardMaterial with approximate color.`,
			`${indent}var ${varName} = new THREE.MeshStandardMaterial({ color: ${colorVal} });`,
		].join( '\n' );

		return { code, lossy: true, lossyReason: `Unsupported material type: ${matJSON.type}`, varName };

	}

	const opts = materialToOptions( matJSON );
	const code = `${indent}var ${varName} = new THREE.${matJSON.type}(${opts});`;

	return { code, lossy: false, varName };

}

// ── Light codegen ─────────────────────────────────────────────────────────────

function emitLight( objJSON, varName, indent = '' ) {

	const type      = objJSON.type;
	const color     = objJSON.color !== undefined
		? '0x' + objJSON.color.toString( 16 ).padStart( 6, '0' )
		: '0xffffff';
	const intensity = objJSON.intensity !== undefined ? r5( objJSON.intensity ) : 1;
	const distance  = objJSON.distance  !== undefined ? r5( objJSON.distance )  : null;

	let ctor;

	if ( type === 'DirectionalLight' ) {

		ctor = `new THREE.DirectionalLight(${color}, ${intensity})`;

	} else if ( type === 'PointLight' ) {

		ctor = distance !== null
			? `new THREE.PointLight(${color}, ${intensity}, ${distance})`
			: `new THREE.PointLight(${color}, ${intensity})`;

	} else if ( type === 'SpotLight' ) {

		ctor = distance !== null
			? `new THREE.SpotLight(${color}, ${intensity}, ${distance})`
			: `new THREE.SpotLight(${color}, ${intensity})`;

	} else if ( type === 'AmbientLight' ) {

		ctor = `new THREE.AmbientLight(${color}, ${intensity})`;

	} else if ( type === 'HemisphereLight' ) {

		const groundColor = objJSON.groundColor !== undefined
			? '0x' + objJSON.groundColor.toString( 16 ).padStart( 6, '0' )
			: '0x000000';
		ctor = `new THREE.HemisphereLight(${color}, ${groundColor}, ${intensity})`;

	} else {

		// Unknown light — generic fallback
		ctor = `new THREE.PointLight(${color}, ${intensity})`;

	}

	const code = `${indent}var ${varName} = ${ctor};`;

	return { code, lossy: false, varName };

}

// ── Per-object codegen ────────────────────────────────────────────────────────

/**
 * Recursively emit JS for an object node from three.js JSON.
 * Returns { lines: string[], lossy: bool, lossyReasons: string[] }.
 *
 * @param {object}  objJSON   object node from the JSON tree
 * @param {Map}     geomMap   uuid → geometry JSON record
 * @param {Map}     matMap    uuid → material JSON record
 * @param {Map}     sharedGeom  uuid → already-declared var name (dedup)
 * @param {Map}     sharedMat   uuid → already-declared var name (dedup)
 * @param {string}  varName   JS variable name for this object
 * @param {string}  indent
 * @param {number}  depth
 */
function emitObject( objJSON, geomMap, matMap, sharedGeom, sharedMat, varName, indent, depth ) {

	const lines = [];
	let lossy = false;
	const lossyReasons = [];

	const type = objJSON.type;
	const isRoot = depth === 0;

	// ── Mesh ──────────────────────────────────────────────────────────────────
	if ( type === 'Mesh' || type === 'SkinnedMesh' ) {

		const recipe = objJSON.userData?.recipe;

		// ── Recipe path (replayable: primitive + edit ops) ────────────────────
		if ( isReplayable( recipe ) ) {

			const matJSON = matMap.get( objJSON.material );
			const matVar  = `mat_${ varName }`;

			if ( matJSON ) {

				const m = emitMaterial( matJSON, matVar, indent );
				lines.push( m.code );
				if ( m.lossy ) { lossy = true; lossyReasons.push( m.lossyReason ); }

			} else {

				lines.push( `${ indent }var ${ matVar } = new THREE.MeshStandardMaterial();` );

			}

			const [ head, ...steps ] = recipe;
			const argsStr = ( head.args || [] ).map( a =>
				typeof a === 'number' ? r5( a ) : JSON.stringify( a )
			).join( ', ' );

			lines.push( `${ indent }// Recipe: ${ recipeDesc( recipe ) }` );
			lines.push( `${ indent }var ${ varName } = new THREE.Mesh(new THREE.${ head.type }(${ argsStr }), ${ matVar });` );

			if ( steps.length ) {

				lines.push( `${ indent }${ varName }.userData._recipeReplay = true;` );
				lines.push( `${ indent }var _emc = editor.editModeController;` );
				lines.push( `${ indent }_emc.enter(${ varName });` );

				for ( const step of steps ) {

					if ( step.selection?.ids?.length ) {

						const fn = step.selection.mode === 'vertex' ? 'selectVertices'
							: step.selection.mode === 'edge' ? 'selectEdges' : 'selectFaces';
						lines.push( `${ indent }${ fn }(${ step.selection.ids.join( ', ' ) });` );

					}

					const ps = Object.values( step.params || {} )
						.map( v => typeof v === 'string' ? JSON.stringify( v ) : r5( v ) )
						.join( ', ' );
					lines.push( `${ indent }${ step.op }(${ ps });` );

				}

				lines.push( `${ indent }_emc.exit();` );
				lines.push( `${ indent }delete ${ varName }.userData._recipeReplay;` );

			}

			// Name + transform + children handled below — skip to the end of Mesh block

		// ── Provenance-only recipe (boolean / mirror result) ──────────────────
		} else if ( recipe?.length ) {

			const desc = recipeDesc( recipe );
			lines.push( `${ indent }// Recipe (non-replayable — geometry serialised below): ${ desc }` );

			// Fall through to normal geometry + material emission
			const geomJSON = geomMap.get( objJSON.geometry );
			const matJSON  = matMap.get(  objJSON.material );

			let geomVar;

			if ( geomJSON ) {

				geomVar = `geom_${ varName }`;
				const g = emitGeometry( geomJSON, geomVar, indent );
				lines.push( g.code );
				if ( g.lossy ) { lossy = true; lossyReasons.push( g.lossyReason ); }

			} else {

				geomVar = `geom_${ varName }`;
				lines.push( `${ indent }var ${ geomVar } = new THREE.BufferGeometry();` );
				lossy = true; lossyReasons.push( 'Missing geometry' );

			}

			let matVar;

			if ( matJSON ) {

				matVar = `mat_${ varName }`;
				const m = emitMaterial( matJSON, matVar, indent );
				lines.push( m.code );
				if ( m.lossy ) { lossy = true; lossyReasons.push( m.lossyReason ); }

			} else {

				matVar = `mat_${ varName }`;
				lines.push( `${ indent }var ${ matVar } = new THREE.MeshStandardMaterial();` );

			}

			lines.push( `${ indent }var ${ varName } = new THREE.Mesh(${ geomVar }, ${ matVar });` );

		// ── Normal path (no recipe) ───────────────────────────────────────────
		} else {

		const geomJSON = geomMap.get( objJSON.geometry );
		const matJSON  = matMap.get(  objJSON.material );

		// Geometry
		let geomVar;

		if ( geomJSON && sharedGeom.has( geomJSON.uuid ) ) {

			geomVar = sharedGeom.get( geomJSON.uuid );

		} else if ( geomJSON ) {

			geomVar = `geom_${varName}`;
			const g = emitGeometry( geomJSON, geomVar, indent );
			lines.push( g.code );
			if ( g.lossy ) { lossy = true; lossyReasons.push( g.lossyReason ); }
			sharedGeom.set( geomJSON.uuid, geomVar );

		} else {

			// Missing geometry — emit empty BufferGeometry
			geomVar = `geom_${varName}`;
			lines.push( `${indent}var ${geomVar} = new THREE.BufferGeometry(); // ⚠ geometry data missing` );
			lossy = true;
			lossyReasons.push( 'Missing geometry reference' );

		}

		// Material
		let matVar;

		if ( matJSON && sharedMat.has( matJSON.uuid ) ) {

			matVar = sharedMat.get( matJSON.uuid );

		} else if ( matJSON ) {

			matVar = `mat_${varName}`;
			const m = emitMaterial( matJSON, matVar, indent );
			lines.push( m.code );
			if ( m.lossy ) { lossy = true; lossyReasons.push( m.lossyReason ); }
			sharedMat.set( matJSON.uuid, matVar );

		} else {

			matVar = `mat_${varName}`;
			lines.push( `${indent}var ${matVar} = new THREE.MeshStandardMaterial(); // ⚠ material data missing` );
			lossy = true;
			lossyReasons.push( 'Missing material reference' );

		}

		lines.push( `${indent}var ${varName} = new THREE.Mesh(${geomVar}, ${matVar});` );

		} // end normal path

	// ── Group / Object3D ──────────────────────────────────────────────────────
	} else if ( type === 'Group' || type === 'Object3D' ) {

		lines.push( `${indent}var ${varName} = new THREE.Group();` );

	// ── Lights ────────────────────────────────────────────────────────────────
	} else if ( type.endsWith( 'Light' ) ) {

		const l = emitLight( objJSON, varName, indent );
		lines.push( l.code );
		if ( l.lossy ) { lossy = true; lossyReasons.push( l.lossyReason ); }

	// ── Camera ────────────────────────────────────────────────────────────────
	} else if ( type === 'PerspectiveCamera' ) {

		const fov    = r5( objJSON.fov    ?? 50 );
		const aspect = r5( objJSON.aspect ?? 1 );
		const near   = r5( objJSON.near   ?? 0.1 );
		const far    = r5( objJSON.far    ?? 2000 );
		lines.push( `${indent}var ${varName} = new THREE.PerspectiveCamera(${fov}, ${aspect}, ${near}, ${far});` );

	} else if ( type === 'OrthographicCamera' ) {

		const left   = r5( objJSON.left   ?? -1 );
		const right  = r5( objJSON.right  ??  1 );
		const top    = r5( objJSON.top    ??  1 );
		const bottom = r5( objJSON.bottom ?? -1 );
		const near   = r5( objJSON.near   ??  0.1 );
		const far    = r5( objJSON.far    ??  2000 );
		lines.push( `${indent}var ${varName} = new THREE.OrthographicCamera(${left}, ${right}, ${top}, ${bottom}, ${near}, ${far});` );

	// ── Fallback: JSON-load ───────────────────────────────────────────────────
	} else {

		const jsonStr = JSON.stringify( objJSON );
		lines.push( `${indent}// ⚠ LOSSY FALLBACK: unsupported node type "${type}"` );
		lines.push( `${indent}var ${varName} = new THREE.ObjectLoader().parse(${jsonStr});` );
		lossy = true;
		lossyReasons.push( `Unsupported node type: ${type}` );

	}

	// ── Name ──────────────────────────────────────────────────────────────────
	if ( objJSON.name ) {

		lines.push( `${indent}${varName}.name = ${JSON.stringify( objJSON.name )};` );

	}

	// ── Transform ─────────────────────────────────────────────────────────────
	if ( objJSON.matrix ) {

		const { position, rotation, scale } = decomposeMatrix( objJSON.matrix );
		lines.push( ...emitTransform( varName, position, rotation, scale, indent ) );

	}

	// ── Children ──────────────────────────────────────────────────────────────
	const childNodes = objJSON.children ?? [];

	for ( let ci = 0; ci < childNodes.length; ci++ ) {

		const childJSON = childNodes[ ci ];
		const childVar  = `${varName}_c${ci}`;
		const childResult = emitObject(
			childJSON, geomMap, matMap, sharedGeom, sharedMat,
			childVar, indent + '  ', depth + 1
		);

		lines.push( ...childResult.lines );
		lines.push( `${indent}${varName}.add( ${childVar} );` );

		if ( childResult.lossy ) {

			lossy = true;
			lossyReasons.push( ...childResult.lossyReasons );

		}

	}

	return { lines, lossy, lossyReasons };

}

// ── Top-level context resolution ──────────────────────────────────────────────

function buildLookupMaps( json ) {

	const geomMap = new Map();
	const matMap  = new Map();

	for ( const g of ( json.geometries ?? [] ) ) geomMap.set( g.uuid, g );
	for ( const m of ( json.materials  ?? [] ) ) matMap.set(  m.uuid, m );

	return { geomMap, matMap };

}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate executable JS from a three.js scene/object JSON (full format with
 * top-level .geometries and .materials arrays).
 *
 * For a scene JSON: generates one IIFE per root child and adds each to the scene.
 * For an object JSON: generates a single IIFE.
 *
 * @param  {object}  json     Output of scene.toJSON() or object.toJSON()
 * @returns {{ code: string, lossy: boolean, lossyReasons: string[] }}
 */
export function jsonToJS( json ) {

	const { geomMap, matMap } = buildLookupMaps( json );
	const sharedGeom = new Map();
	const sharedMat  = new Map();

	const objectRoot = json.object;
	const type       = objectRoot?.type ?? '';

	// Decide which nodes become roots (each gets its own AddObjectCommand)
	let roots;

	if ( type === 'Scene' ) {

		roots = objectRoot.children ?? [];

	} else {

		roots = [ objectRoot ];

	}

	const blocks = [];
	let overallLossy = false;
	const allLossyReasons = [];

	roots.forEach( ( rootNode, i ) => {

		const varName = `obj${i > 0 ? i : ''}`;
		const result  = emitObject(
			rootNode, geomMap, matMap, sharedGeom, sharedMat,
			varName, '  ', 0
		);

		const header = `// Generated for "${rootNode.name || rootNode.type}" (uuid: ${rootNode.uuid?.slice( 0, 8 ) ?? '?'})`;

		const body = [
			header,
			'(function() {',
			...result.lines,
			`  editor.execute(new AddObjectCommand(editor, ${varName}));`,
			'})();',
		].join( '\n' );

		blocks.push( body );

		if ( result.lossy ) {

			overallLossy = true;
			allLossyReasons.push( ...result.lossyReasons );

		}

	} );

	return {
		code: blocks.join( '\n\n' ),
		lossy: overallLossy,
		lossyReasons: [ ...new Set( allLossyReasons ) ],
	};

}

/**
 * Generate executable JS from a live THREE.Object3D.
 *
 * @param  {THREE.Object3D} object
 * @returns {{ code: string, lossy: boolean, lossyReasons: string[] }}
 */
export function objectToJS( object ) {

	const json = object.toJSON();
	return jsonToJS( json );

}

/**
 * Generate executable JS for the entire editor scene.
 * This produces one IIFE per root child.
 *
 * @param  {Editor} editor
 * @returns {{ code: string, lossy: boolean, lossyReasons: string[] }}
 */
export function sceneToJS( editor ) {

	const json = editor.scene.toJSON();
	return jsonToJS( json );

}
