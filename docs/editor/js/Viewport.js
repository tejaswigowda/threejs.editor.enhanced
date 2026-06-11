import * as THREE from 'three';
import { PMREMGenerator } from 'three/webgpu';

import { TransformControls } from 'three/addons/controls/TransformControls.js';

import { UIPanel } from './libs/ui.js';

import { EditorControls } from './EditorControls.js';

import { ViewportControls } from './Viewport.Controls.js';

import { ViewHelper } from './Viewport.ViewHelper.js';
import { XR } from './Viewport.XR.js';

import { SetPositionCommand } from './commands/SetPositionCommand.js';
import { SetRotationCommand } from './commands/SetRotationCommand.js';
import { SetScaleCommand } from './commands/SetScaleCommand.js';
import { MultiCmdsCommand } from './commands/MultiCmdsCommand.js';

import { ColorEnvironment } from 'three/addons/environments/ColorEnvironment.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { ViewportPathtracer } from './Viewport.Pathtracer.js';

function Viewport( editor ) {

	const selector = editor.selector;
	const signals = editor.signals;

	const container = new UIPanel();
	container.setId( 'viewport' );
	container.setPosition( 'absolute' );

	container.add( new ViewportControls( editor ) );

	//

	let renderer = null;
	let pmremGenerator = null;
	let pathtracer = null;

	const camera = editor.camera;
	const scene = editor.scene;
	const sceneHelpers = editor.sceneHelpers;

	// helpers

	const GRID_COLORS_LIGHT = [ 0x999999, 0x777777 ];
	const GRID_COLORS_DARK = [ 0x555555, 0x888888 ];

	const grid = new THREE.Group();

	// Infinite grid: a large ground plane drawn with a shader so the lines appear
	// to extend forever and fade out with distance. The plane follows the camera
	// each frame (see render()), while the lines stay locked to world coordinates.

	const gridMaterial = new THREE.ShaderMaterial( {
		uniforms: {
			uColor1: { value: new THREE.Color( GRID_COLORS_LIGHT[ 0 ] ) },
			uColor2: { value: new THREE.Color( GRID_COLORS_LIGHT[ 1 ] ) },
			uDistance: { value: 100 }
		},
		vertexShader: /* glsl */`
			varying vec3 vWorldPos;
			void main() {
				vec4 world = modelMatrix * vec4( position, 1.0 );
				vWorldPos = world.xyz;
				gl_Position = projectionMatrix * viewMatrix * world;
			}
		`,
		fragmentShader: /* glsl */`
			uniform vec3 uColor1;
			uniform vec3 uColor2;
			uniform float uDistance;
			varying vec3 vWorldPos;

			// Anti-aliased grid lines at the given spacing (in world units).
			float getGrid( float size ) {
				vec2 r = vWorldPos.xz / size;
				vec2 grid = abs( fract( r - 0.5 ) - 0.5 ) / fwidth( r );
				return 1.0 - min( min( grid.x, grid.y ), 1.0 );
			}

			void main() {
				float minorLine = getGrid( 1.0 );
				float majorLine = getGrid( 10.0 );

				float d = distance( cameraPosition.xz, vWorldPos.xz );
				float minorFade = 1.0 - clamp( d / uDistance, 0.0, 1.0 );
				float majorFade = 1.0 - clamp( d / ( uDistance * 5.0 ), 0.0, 1.0 );

				float alpha = max( minorLine * minorFade, majorLine * majorFade );
				if ( alpha <= 0.001 ) discard;

				// Major (decade) lines take the stronger colour; they coincide with minor lines.
				vec3 color = mix( uColor1, uColor2, majorLine );
				gl_FragColor = vec4( color, alpha );
			}
		`,
		transparent: true,
		side: THREE.DoubleSide,
		depthWrite: false,
		extensions: { derivatives: true }
	} );

	const gridGeometry = new THREE.PlaneGeometry( 10000, 10000 );
	gridGeometry.rotateX( - Math.PI / 2 );

	const infiniteGrid = new THREE.Mesh( gridGeometry, gridMaterial );
	infiniteGrid.frustumCulled = false;
	grid.add( infiniteGrid );

	const viewHelper = new ViewHelper( camera, container );
	viewHelper.onRequireRender = () => render();

	//

	const box = new THREE.Box3();

	const selectionBox = new THREE.Box3Helper( box );
	selectionBox.material.depthTest = false;
	selectionBox.material.transparent = true;
	selectionBox.visible = false;
	sceneHelpers.add( selectionBox );

	// Extra selection boxes for the non-primary objects of a multi-selection

	const multiSelectionBoxes = [];

	function clearMultiSelectionBoxes() {

		for ( let i = 0; i < multiSelectionBoxes.length; i ++ ) {

			sceneHelpers.remove( multiSelectionBoxes[ i ] );
			multiSelectionBoxes[ i ].geometry.dispose();

		}

		multiSelectionBoxes.length = 0;

	}

	function addMultiSelectionBox( object ) {

		const helperBox = new THREE.Box3();
		helperBox.setFromObject( object, true );

		if ( helperBox.isEmpty() ) return;

		const helper = new THREE.Box3Helper( helperBox, 0xffaa00 );
		helper.material.depthTest = false;
		helper.material.transparent = true;
		helper.userData.object = object;
		sceneHelpers.add( helper );
		multiSelectionBoxes.push( helper );

	}

	function updateMultiSelectionBoxes() {

		for ( let i = 0; i < multiSelectionBoxes.length; i ++ ) {

			const helper = multiSelectionBoxes[ i ];
			helper.box.setFromObject( helper.userData.object, true );

		}

	}

	// Pivot used as a shared transform anchor when several objects are selected

	const selectionPivot = new THREE.Group();
	selectionPivot.name = '__selectionPivot';

	let pivotActive = false;
	const _pivotStartMatrix = new THREE.Matrix4();
	const _pivotStartInverse = new THREE.Matrix4();
	const _dragStartWorld = new Map(); // object -> Matrix4 ( world at drag start )
	const _dragStartLocal = new Map(); // object -> { position, rotation, scale }

	const _tmpMatrix = new THREE.Matrix4();
	const _tmpDelta = new THREE.Matrix4();
	const _tmpParentInverse = new THREE.Matrix4();

	let objectPositionOnDown = null;
	let objectRotationOnDown = null;
	let objectScaleOnDown = null;

	const transformControls = new TransformControls( camera );
	transformControls.addEventListener( 'axis-changed', function () {

		if ( editor.viewportShading !== 'realistic' ) render();

	} );
	transformControls.addEventListener( 'objectChange', function () {

		if ( pivotActive ) {

			// Apply the pivot's delta transform to every selected object

			selectionPivot.updateMatrixWorld( true );

			_tmpDelta.multiplyMatrices( selectionPivot.matrixWorld, _pivotStartInverse );

			const selection = editor.getSelectedObjects();

			for ( let i = 0; i < selection.length; i ++ ) {

				const object = selection[ i ];
				const startWorld = _dragStartWorld.get( object );
				if ( startWorld === undefined ) continue;

				_tmpMatrix.multiplyMatrices( _tmpDelta, startWorld );

				object.parent.updateMatrixWorld( true );
				_tmpParentInverse.copy( object.parent.matrixWorld ).invert();
				_tmpMatrix.premultiply( _tmpParentInverse );

				_tmpMatrix.decompose( object.position, object.quaternion, object.scale );
				object.updateMatrixWorld( true );

				signals.objectChanged.dispatch( object );

			}

		} else {

			signals.objectChanged.dispatch( transformControls.object );

		}

	} );
	transformControls.addEventListener( 'mouseDown', function () {

		const object = transformControls.object;

		if ( pivotActive ) {

			selectionPivot.updateMatrixWorld( true );
			_pivotStartMatrix.copy( selectionPivot.matrixWorld );
			_pivotStartInverse.copy( _pivotStartMatrix ).invert();

			_dragStartWorld.clear();
			_dragStartLocal.clear();

			const selection = editor.getSelectedObjects();

			for ( let i = 0; i < selection.length; i ++ ) {

				const selected = selection[ i ];
				selected.updateMatrixWorld( true );
				_dragStartWorld.set( selected, selected.matrixWorld.clone() );
				_dragStartLocal.set( selected, {
					position: selected.position.clone(),
					rotation: selected.rotation.clone(),
					scale: selected.scale.clone()
				} );

			}

		} else {

			objectPositionOnDown = object.position.clone();
			objectRotationOnDown = object.rotation.clone();
			objectScaleOnDown = object.scale.clone();

		}

		controls.enabled = false;

	} );
	transformControls.addEventListener( 'mouseUp', function () {

		const object = transformControls.object;

		if ( pivotActive ) {

			const selection = editor.getSelectedObjects();
			const commands = [];

			for ( let i = 0; i < selection.length; i ++ ) {

				const selected = selection[ i ];
				const start = _dragStartLocal.get( selected );
				if ( start === undefined ) continue;

				if ( ! start.position.equals( selected.position ) ) {

					commands.push( new SetPositionCommand( editor, selected, selected.position.clone(), start.position ) );

				}

				if ( ! start.rotation.equals( selected.rotation ) ) {

					commands.push( new SetRotationCommand( editor, selected, selected.rotation.clone(), start.rotation ) );

				}

				if ( ! start.scale.equals( selected.scale ) ) {

					commands.push( new SetScaleCommand( editor, selected, selected.scale.clone(), start.scale ) );

				}

			}

			if ( commands.length > 0 ) {

				editor.execute( new MultiCmdsCommand( editor, commands ) );

			}

			updateSelectionPivot();

		} else if ( object !== undefined ) {

			switch ( transformControls.getMode() ) {

				case 'translate':

					if ( ! objectPositionOnDown.equals( object.position ) ) {

						editor.execute( new SetPositionCommand( editor, object, object.position, objectPositionOnDown ) );

					}

					break;

				case 'rotate':

					if ( ! objectRotationOnDown.equals( object.rotation ) ) {

						editor.execute( new SetRotationCommand( editor, object, object.rotation, objectRotationOnDown ) );

					}

					break;

				case 'scale':

					if ( ! objectScaleOnDown.equals( object.scale ) ) {

						editor.execute( new SetScaleCommand( editor, object, object.scale, objectScaleOnDown ) );

					}

					break;

			}

		}

		controls.enabled = true;

	} );

	sceneHelpers.add( transformControls.getHelper() );

	//

	const xr = new XR( editor, transformControls ); // eslint-disable-line no-unused-vars

	// events

	function updateAspectRatio() {

		for ( const uuid in editor.cameras ) {

			const camera = editor.cameras[ uuid ];

			const aspect = container.dom.offsetWidth / container.dom.offsetHeight;

			if ( camera.isPerspectiveCamera ) {

				camera.aspect = aspect;

			} else {

				camera.left = - aspect;
				camera.right = aspect;

			}

			camera.updateProjectionMatrix();

			const cameraHelper = editor.helpers[ camera.id ];
			if ( cameraHelper ) cameraHelper.update();

		}

	}

	const onDownPosition = new THREE.Vector2();
	const onUpPosition = new THREE.Vector2();
	const onDoubleClickPosition = new THREE.Vector2();

	function getMousePosition( dom, x, y ) {

		const rect = dom.getBoundingClientRect();
		return [ ( x - rect.left ) / rect.width, ( y - rect.top ) / rect.height ];

	}

	function handleClick( additive = false ) {

		if ( onDownPosition.distanceTo( onUpPosition ) === 0 ) {

			const intersects = selector.getPointerIntersects( onUpPosition, camera );
			signals.intersectionsDetected.dispatch( intersects, additive );

			render();

		}

	}

	function onMouseDown( event ) {

		// event.preventDefault();

		if ( event.target !== renderer.domElement ) return;

		const array = getMousePosition( container.dom, event.clientX, event.clientY );
		onDownPosition.fromArray( array );

		document.addEventListener( 'mouseup', onMouseUp );

	}

	function onMouseUp( event ) {

		const array = getMousePosition( container.dom, event.clientX, event.clientY );
		onUpPosition.fromArray( array );

		handleClick( event.shiftKey || event.ctrlKey || event.metaKey );

		document.removeEventListener( 'mouseup', onMouseUp );

	}

	function onTouchStart( event ) {

		const touch = event.changedTouches[ 0 ];

		const array = getMousePosition( container.dom, touch.clientX, touch.clientY );
		onDownPosition.fromArray( array );

		document.addEventListener( 'touchend', onTouchEnd );

	}

	function onTouchEnd( event ) {

		const touch = event.changedTouches[ 0 ];

		const array = getMousePosition( container.dom, touch.clientX, touch.clientY );
		onUpPosition.fromArray( array );

		handleClick();

		document.removeEventListener( 'touchend', onTouchEnd );

	}

	function onDoubleClick( event ) {

		const array = getMousePosition( container.dom, event.clientX, event.clientY );
		onDoubleClickPosition.fromArray( array );

		const intersects = selector.getPointerIntersects( onDoubleClickPosition, camera );

		if ( intersects.length > 0 ) {

			const intersect = intersects[ 0 ];

			signals.objectFocused.dispatch( intersect.object );

		}

	}

	container.dom.addEventListener( 'mousedown', onMouseDown );
	container.dom.addEventListener( 'touchstart', onTouchStart, { passive: false } );
	container.dom.addEventListener( 'dblclick', onDoubleClick );

	// controls need to be added *after* main logic,
	// otherwise controls.enabled doesn't work.

	const controls = new EditorControls( camera );
	controls.addEventListener( 'change', function () {

		signals.cameraChanged.dispatch( camera );
		signals.refreshSidebarObject3D.dispatch( camera );

	} );
	viewHelper.center = controls.center;

	editor.controls = controls;

	// signals

	signals.editorCleared.add( function () {

		controls.center.set( 0, 0, 0 );
		if ( pathtracer ) pathtracer.reset();

		initPT();

		signals.sceneEnvironmentChanged.dispatch( editor.environmentType );

	} );

	signals.transformModeChanged.add( function ( mode ) {

		transformControls.setMode( mode );

		render();

	} );

	signals.snapChanged.add( function ( dist ) {

		transformControls.setTranslationSnap( dist );

	} );

	signals.spaceChanged.add( function ( space ) {

		transformControls.setSpace( space );

		render();

	} );

	signals.rendererUpdated.add( function () {

		scene.traverse( function ( child ) {

			if ( child.material !== undefined ) {

				child.material.needsUpdate = true;

			}

		} );

		render();

	} );

	signals.rendererCreated.add( function ( newRenderer ) {

		if ( renderer !== null ) {

			renderer.setAnimationLoop( null );

			try {

				pmremGenerator.dispose();

			} catch ( e ) {

				console.warn( 'PMREMGenerator dispose error:', e );

			}

			renderer.dispose();

			container.dom.removeChild( renderer.domElement );

		}

		controls.connect( newRenderer.domElement );
		transformControls.connect( newRenderer.domElement );

		renderer = newRenderer;

		renderer.setAnimationLoop( animate );
		renderer.setClearColor( 0xaaaaaa );

		if ( window.matchMedia ) {

			const mediaQuery = window.matchMedia( '(prefers-color-scheme: dark)' );
			mediaQuery.addEventListener( 'change', function ( event ) {

				renderer.setClearColor( event.matches ? 0x333333 : 0xaaaaaa );
				updateGridColors( gridMaterial, event.matches ? GRID_COLORS_DARK : GRID_COLORS_LIGHT );

				render();

			} );

			renderer.setClearColor( mediaQuery.matches ? 0x333333 : 0xaaaaaa );
			updateGridColors( gridMaterial, mediaQuery.matches ? GRID_COLORS_DARK : GRID_COLORS_LIGHT );

		}

		renderer.getClearColor( editor.viewportColor );

		renderer.setPixelRatio( window.devicePixelRatio );
		renderer.setSize( container.dom.offsetWidth, container.dom.offsetHeight );

		if ( renderer.isWebGLRenderer ) {

			pmremGenerator = new THREE.PMREMGenerator( renderer );
			pmremGenerator.compileEquirectangularShader();

			pathtracer = new ViewportPathtracer( renderer );

		} else {

			pmremGenerator = new PMREMGenerator( renderer );

			pathtracer = null;

		}

		container.dom.appendChild( renderer.domElement );

		signals.sceneEnvironmentChanged.dispatch( editor.environmentType );

		render();

	} );

	signals.rendererDetectKTX2Support.add( function ( ktx2Loader ) {

		ktx2Loader.detectSupport( renderer );

	} );

	signals.sceneGraphChanged.add( function () {

		initPT();
		render();

	} );

	signals.cameraChanged.add( function () {

		if ( pathtracer ) pathtracer.reset();

		render();

	} );

	signals.objectSelected.add( function ( object ) {

		selectionBox.visible = false;
		transformControls.detach();

		if ( object !== null && object !== scene && object !== camera ) {

			box.setFromObject( object, true );

			if ( box.isEmpty() === false ) {

				selectionBox.visible = true;

			}

		}

		render();

	} );

	function updateSelectionPivot() {

		const selection = editor.getSelectedObjects();
		const center = new THREE.Vector3();
		const objectPosition = new THREE.Vector3();

		for ( let i = 0; i < selection.length; i ++ ) {

			selection[ i ].updateMatrixWorld( true );
			objectPosition.setFromMatrixPosition( selection[ i ].matrixWorld );
			center.add( objectPosition );

		}

		if ( selection.length > 0 ) center.divideScalar( selection.length );

		selectionPivot.position.copy( center );
		selectionPivot.rotation.set( 0, 0, 0 );
		selectionPivot.scale.set( 1, 1, 1 );
		selectionPivot.updateMatrixWorld( true );

	}

	signals.selectionChanged.add( function ( selection ) {

		clearMultiSelectionBoxes();
		transformControls.detach();
		pivotActive = false;

		if ( selectionPivot.parent !== null ) selectionPivot.parent.remove( selectionPivot );

		// Filter out non-transformable picks ( scene / camera )

		const transformable = selection.filter( o => o !== null && o !== scene && o !== camera );

		if ( transformable.length === 1 ) {

			transformControls.attach( transformable[ 0 ] );

		} else if ( transformable.length > 1 ) {

			// Draw a box for every selected object and attach the gizmo to a shared pivot

			selectionBox.visible = false;

			for ( let i = 0; i < transformable.length; i ++ ) {

				addMultiSelectionBox( transformable[ i ] );

			}

			sceneHelpers.add( selectionPivot );
			updateSelectionPivot();
			pivotActive = true;
			transformControls.attach( selectionPivot );

		}

		render();

	} );

	signals.objectFocused.add( function ( object ) {

		controls.focus( object );

	} );

	signals.geometryChanged.add( function ( object ) {

		if ( object !== undefined ) {

			box.setFromObject( object, true );

		}

		initPT();
		render();

	} );

	signals.objectChanged.add( function ( object ) {

		if ( editor.selected === object ) {

			box.setFromObject( object, true );

		}

		if ( multiSelectionBoxes.length > 0 ) {

			updateMultiSelectionBoxes();

		}

		if ( object.isPerspectiveCamera ) {

			object.updateProjectionMatrix();

		}

		const helper = editor.helpers[ object.id ];

		if ( helper !== undefined && helper.isSkeletonHelper !== true ) {

			helper.update();

		}

		// update light helper when light target is changed

		for ( const id in editor.helpers ) {

			const helper = editor.helpers[ id ];

			if ( helper.light && helper.light.target === object ) {

				helper.update();

			}

		}

		initPT();
		render();

	} );

	signals.objectRemoved.add( function ( object ) {

		controls.enabled = true; // see #14180

		if ( object === transformControls.object ) {

			transformControls.detach();

		}

	} );

	signals.materialChanged.add( function () {

		updatePTMaterials();
		render();

	} );

	// background

	signals.sceneBackgroundChanged.add( function ( backgroundType, backgroundColor, backgroundTexture, backgroundEquirectangularTexture, backgroundColorSpace, backgroundBlurriness, backgroundIntensity, backgroundRotation ) {

		editor.backgroundType = backgroundType;

		scene.background = null;

		switch ( backgroundType ) {

			case 'Color':

				scene.background = new THREE.Color( backgroundColor );

				break;

			case 'Texture':

				if ( backgroundTexture ) {

					backgroundTexture.colorSpace = backgroundColorSpace;
					backgroundTexture.needsUpdate = true;

					scene.background = backgroundTexture;

				}

				break;

			case 'Equirectangular':

				if ( backgroundEquirectangularTexture ) {

					backgroundEquirectangularTexture.mapping = THREE.EquirectangularReflectionMapping;
					backgroundEquirectangularTexture.colorSpace = backgroundColorSpace;
					backgroundEquirectangularTexture.needsUpdate = true;

					scene.background = backgroundEquirectangularTexture;
					scene.backgroundBlurriness = backgroundBlurriness;
					scene.backgroundIntensity = backgroundIntensity;
					scene.backgroundRotation.y = backgroundRotation * THREE.MathUtils.DEG2RAD;

				}

				break;

		}

		if ( useBackgroundAsEnvironment ) {

			signals.sceneEnvironmentChanged.dispatch( editor.environmentType );

		}

		updatePTBackground();
		render();

	} );

	// environment

	let useBackgroundAsEnvironment = false;

	signals.sceneEnvironmentChanged.add( function ( environmentType, environmentEquirectangularTexture ) {

		editor.environmentType = environmentType;

		scene.environment = null;

		useBackgroundAsEnvironment = false;

		switch ( environmentType ) {

			case 'Equirectangular':

				if ( environmentEquirectangularTexture ) {

					scene.environment = environmentEquirectangularTexture;
					scene.environment.mapping = THREE.EquirectangularReflectionMapping;

				}

				break;

			case 'Default':

				useBackgroundAsEnvironment = true;

				if ( scene.background !== null ) {

					if ( scene.background.isColor ) {

						scene.environment = pmremGenerator.fromScene( new ColorEnvironment( scene.background ), 0.04 ).texture;

					} else if ( scene.background.isTexture ) {

						scene.environment = scene.background;
						scene.environment.mapping = THREE.EquirectangularReflectionMapping;
						scene.environmentRotation.y = scene.backgroundRotation.y;

					}

				} else {

					scene.environment = pmremGenerator.fromScene( new RoomEnvironment(), 0.04 ).texture;

				}

				break;

		}

		updatePTEnvironment();
		render();

	} );

	// fog

	signals.sceneFogChanged.add( function ( fogType, fogColor, fogNear, fogFar, fogDensity ) {

		switch ( fogType ) {

			case 'None':
				scene.fog = null;
				break;
			case 'Fog':
				scene.fog = new THREE.Fog( fogColor, fogNear, fogFar );
				break;
			case 'FogExp2':
				scene.fog = new THREE.FogExp2( fogColor, fogDensity );
				break;

		}

		render();

	} );

	signals.sceneFogSettingsChanged.add( function ( fogType, fogColor, fogNear, fogFar, fogDensity ) {

		switch ( fogType ) {

			case 'Fog':
				scene.fog.color.setHex( fogColor );
				scene.fog.near = fogNear;
				scene.fog.far = fogFar;
				break;
			case 'FogExp2':
				scene.fog.color.setHex( fogColor );
				scene.fog.density = fogDensity;
				break;

		}

		render();

	} );

	signals.viewportCameraChanged.add( function () {

		const viewportCamera = editor.viewportCamera;

		if ( viewportCamera.isPerspectiveCamera || viewportCamera.isOrthographicCamera ) {

			updateAspectRatio();

		}

		// disable EditorControls when setting a user camera

		controls.enabled = ( viewportCamera === editor.camera );

		initPT();
		render();

	} );

	signals.viewportShadingChanged.add( function () {

		const viewportShading = editor.viewportShading;

		switch ( viewportShading ) {

			case 'realistic':
				if ( pathtracer ) pathtracer.init( scene, editor.viewportCamera );
				break;

			case 'solid':
				scene.overrideMaterial = null;
				break;

			case 'normals':
				scene.overrideMaterial = new THREE.MeshNormalMaterial();
				break;

			case 'wireframe':
				scene.overrideMaterial = new THREE.MeshBasicMaterial( { color: 0x000000, wireframe: true } );
				break;

		}

		render();

	} );

	//

	signals.windowResize.add( function () {

		updateAspectRatio();

		if ( renderer === null ) return;

		renderer.setSize( container.dom.offsetWidth, container.dom.offsetHeight );
		if ( pathtracer ) pathtracer.setSize( container.dom.offsetWidth, container.dom.offsetHeight );

		render();

	} );

	signals.showHelpersChanged.add( function ( appearanceStates ) {

		grid.visible = appearanceStates.gridHelper;

		sceneHelpers.traverse( function ( object ) {

			switch ( object.type ) {

				case 'CameraHelper':

				{

					object.visible = appearanceStates.cameraHelpers;
					break;

				}

				case 'PointLightHelper':
				case 'DirectionalLightHelper':
				case 'SpotLightHelper':
				case 'HemisphereLightHelper':

				{

					object.visible = appearanceStates.lightHelpers;
					break;

				}

				case 'SkeletonHelper':

				{

					object.visible = appearanceStates.skeletonHelpers;
					break;

				}

				default:

				{

					// not a helper, skip.

				}

			}

		} );


		render();

	} );

	signals.cameraResetted.add( updateAspectRatio );

	// animations

	let prevActionsInUse = 0;

	const timer = new THREE.Timer(); // only used for animations

	function animate() {

		timer.update();

		const mixer = editor.mixer;
		const delta = timer.getDelta();

		let needsUpdate = false;

		// Animations

		const actions = mixer.stats.actions;

		if ( actions.inUse > 0 || prevActionsInUse > 0 ) {

			prevActionsInUse = actions.inUse;

			mixer.update( delta );
			needsUpdate = true;

			if ( editor.selected !== null ) {

				editor.selected.updateWorldMatrix( false, true ); // avoid frame late effect for certain skinned meshes (e.g. Michelle.glb)
				selectionBox.box.setFromObject( editor.selected, true ); // selection box should reflect current animation state

			}

			signals.morphTargetsUpdated.dispatch();

		}

		// View Helper

		if ( viewHelper.animating === true ) {

			viewHelper.update( delta );
			needsUpdate = true;

		}

		if ( renderer.xr.isPresenting === true ) {

			needsUpdate = true;

		}

		if ( needsUpdate === true ) render();

		updatePT();

	}

	function initPT() {

		if ( pathtracer && editor.viewportShading === 'realistic' ) {

			pathtracer.init( scene, editor.viewportCamera );

		}

	}

	function updatePTBackground() {

		if ( pathtracer && editor.viewportShading === 'realistic' ) {

			pathtracer.setBackground( scene.background, scene.backgroundBlurriness );

		}

	}

	function updatePTEnvironment() {

		if ( pathtracer && editor.viewportShading === 'realistic' ) {

			pathtracer.setEnvironment( scene.environment );

		}

	}

	function updatePTMaterials() {

		if ( pathtracer && editor.viewportShading === 'realistic' ) {

			pathtracer.updateMaterials();

		}

	}

	function updatePT() {

		if ( pathtracer && editor.viewportShading === 'realistic' ) {

			pathtracer.update();
			editor.signals.pathTracerUpdated.dispatch( pathtracer.getSamples() );

		}

	}

	//

	let startTime = 0;
	let endTime = 0;

	function render() {

		if ( renderer === null ) return;

		startTime = performance.now();

		renderer.setViewport( 0, 0, container.dom.offsetWidth, container.dom.offsetHeight );
		renderer.render( scene, editor.viewportCamera );

		if ( camera === editor.viewportCamera ) {

			renderer.autoClear = false;
			if ( grid.visible === true ) {

				// Keep the infinite grid plane centred under the camera so it always fills the view.
				infiniteGrid.position.set( editor.viewportCamera.position.x, 0, editor.viewportCamera.position.z );
				renderer.render( grid, camera );

			}
			if ( sceneHelpers.visible === true ) renderer.render( sceneHelpers, camera );
			if ( renderer.xr.isPresenting !== true ) viewHelper.render( renderer );
			renderer.autoClear = true;

		}

		endTime = performance.now();
		editor.signals.sceneRendered.dispatch( endTime - startTime );

	}

	return container;

}

function updateGridColors( material, colors ) {

	material.uniforms.uColor1.value.setHex( colors[ 0 ] );
	material.uniforms.uColor2.value.setHex( colors[ 1 ] );

}

export { Viewport };
