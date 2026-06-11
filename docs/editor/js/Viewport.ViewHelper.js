import {
	BoxGeometry,
	CanvasTexture,
	Color,
	Euler,
	EdgesGeometry,
	LineBasicMaterial,
	LineSegments,
	Mesh,
	MeshBasicMaterial,
	Object3D,
	OrthographicCamera,
	Quaternion,
	Raycaster,
	Spherical,
	SRGBColorSpace,
	Vector2,
	Vector3,
	Vector4
} from 'three';

import { UIPanel } from './libs/ui.js';

const DIM = 128; // size of the gizmo viewport in pixels

// BoxGeometry material/group order: [ +X, -X, +Y, -Y, +Z, -Z ]
const FACES = [
	{ type: 'posX', label: 'RIGHT' },
	{ type: 'negX', label: 'LEFT' },
	{ type: 'posY', label: 'TOP' },
	{ type: 'negY', label: 'BOTTOM' },
	{ type: 'posZ', label: 'FRONT' },
	{ type: 'negZ', label: 'BACK' }
];

const BASE_COLOR = new Color( 0xffffff );
const HOVER_COLOR = new Color( '#9ecbff' );

/**
 * A navigation gizmo rendered as a labeled cube ( ViewCube ). Each face is
 * labeled TOP / BOTTOM, LEFT / RIGHT, FRONT / BACK and clicking a face
 * animates the camera to look along that direction.
 *
 * Keeps the same public API as the three.js `ViewHelper` so it is a drop-in
 * replacement: `render( renderer )`, `handleClick( event )`, `update( delta )`,
 * `animating`, `center`, `dispose()`.
 */
class ViewHelper extends Object3D {

	constructor( editorCamera, container ) {

		super();

		this.isViewHelper = true;
		this.animating = false;
		this.center = new Vector3();

		// Drag-to-orbit speed ( radians per pixel ), matched to EditorControls.
		this.rotationSpeed = 0.005;

		// Optional callback invoked when the gizmo needs the viewport to redraw
		// ( e.g. on hover ). Set by the Viewport.
		this.onRequireRender = null;

		this.location = { top: 10, right: null, bottom: 0, left: 0 };

		const domElement = container.dom;

		const orthoCamera = new OrthographicCamera( - 2, 2, 2, - 2, 0, 4 );
		orthoCamera.position.set( 0, 0, 2 );

		// Cube ------------------------------------------------------------------

		const size = 1.6;
		const geometry = new BoxGeometry( size, size, size );

		const materials = FACES.map( ( face ) => new MeshBasicMaterial( {
			map: createFaceTexture( face.label ),
			toneMapped: false,
			transparent: true
		} ) );

		const cube = new Mesh( geometry, materials );
		this.add( cube );

		// Cube edges for a crisp outline

		const edges = new LineSegments(
			new EdgesGeometry( geometry ),
			new LineBasicMaterial( { color: 0x555555, toneMapped: false } )
		);
		this.add( edges );

		// State -----------------------------------------------------------------

		const interactiveObjects = [ cube ];
		const raycaster = new Raycaster();
		const mouse = new Vector2();
		const dummy = new Object3D();

		const point = new Vector3();
		const turnRate = 2 * Math.PI; // angles per second

		const targetPosition = new Vector3();
		const targetQuaternion = new Quaternion();
		const q1 = new Quaternion();
		const q2 = new Quaternion();
		const viewport = new Vector4();
		let radius = 0;

		let hoveredIndex = - 1;

		// Drag-to-orbit state
		const spherical = new Spherical();
		const offset = new Vector3();
		const pointerOld = new Vector2();
		let isPointerDown = false;
		let isDragging = false;
		const DRAG_THRESHOLD = 3; // pixels before a press becomes a drag

		const scope = this;

		// Orbits the editor camera around `center` ( mirrors EditorControls.rotate ).

		function orbit( dx, dy ) {

			offset.copy( editorCamera.position ).sub( scope.center );

			spherical.setFromVector3( offset );
			spherical.theta += dx * scope.rotationSpeed;
			spherical.phi += dy * scope.rotationSpeed;
			spherical.makeSafe();

			offset.setFromSpherical( spherical );

			editorCamera.position.copy( scope.center ).add( offset );
			editorCamera.lookAt( scope.center );

		}

		// Render ----------------------------------------------------------------

		this.render = function ( renderer ) {

			this.quaternion.copy( editorCamera.quaternion ).invert();
			this.updateMatrixWorld();

			point.set( 0, 0, 1 ).applyQuaternion( editorCamera.quaternion );

			const location = this.location;

			let x, y;

			if ( location.left !== null ) {

				x = location.left;

			} else {

				x = domElement.offsetWidth - DIM - location.right;

			}

			if ( location.top !== null ) {

				y = renderer.isWebGPURenderer ? location.top : domElement.offsetHeight - DIM - location.top;

			} else {

				y = renderer.isWebGPURenderer ? domElement.offsetHeight - DIM - location.bottom : location.bottom;

			}

			renderer.clearDepth();

			renderer.getViewport( viewport );
			renderer.setViewport( x, y, DIM, DIM );

			renderer.render( this, orthoCamera );

			renderer.setViewport( viewport.x, viewport.y, viewport.z, viewport.w );

		};

		// Pointer helpers -------------------------------------------------------

		function getGizmoMouse( event ) {

			const rect = domElement.getBoundingClientRect();
			const location = scope.location;

			let offsetX, offsetY;

			if ( location.left !== null ) {

				offsetX = rect.left + location.left;

			} else {

				offsetX = rect.left + domElement.offsetWidth - DIM - location.right;

			}

			if ( location.top !== null ) {

				offsetY = rect.top + location.top;

			} else {

				offsetY = rect.top + domElement.offsetHeight - DIM - location.bottom;

			}

			mouse.x = ( ( event.clientX - offsetX ) / DIM ) * 2 - 1;
			mouse.y = - ( ( event.clientY - offsetY ) / DIM ) * 2 + 1;

			return mouse;

		}

		function intersectFace( event ) {

			raycaster.setFromCamera( getGizmoMouse( event ), orthoCamera );

			const intersects = raycaster.intersectObjects( interactiveObjects, false );

			if ( intersects.length > 0 && intersects[ 0 ].face !== null ) {

				return intersects[ 0 ].face.materialIndex;

			}

			return - 1;

		}

		this.handleClick = function ( event ) {

			if ( this.animating === true ) return false;

			const index = intersectFace( event );

			if ( index !== - 1 ) {

				prepareAnimationData( FACES[ index ].type, this.center );
				this.animating = true;
				return true;

			}

			return false;

		};

		this.handlePointerMove = function ( event ) {

			const index = intersectFace( event );

			if ( index === hoveredIndex ) return false;

			if ( hoveredIndex !== - 1 ) materials[ hoveredIndex ].color.copy( BASE_COLOR );
			if ( index !== - 1 ) materials[ index ].color.copy( HOVER_COLOR );

			hoveredIndex = index;

			return true; // a redraw is needed

		};

		this.clearHover = function () {

			if ( hoveredIndex !== - 1 ) {

				materials[ hoveredIndex ].color.copy( BASE_COLOR );
				hoveredIndex = - 1;
				return true;

			}

			return false;

		};

		// Animation -------------------------------------------------------------

		this.update = function ( delta ) {

			const step = delta * turnRate;

			q1.rotateTowards( q2, step );
			editorCamera.position.set( 0, 0, 1 ).applyQuaternion( q1 ).multiplyScalar( radius ).add( this.center );

			editorCamera.quaternion.rotateTowards( targetQuaternion, step );

			if ( q1.angleTo( q2 ) === 0 ) {

				this.animating = false;

			}

		};

		this.dispose = function () {

			geometry.dispose();
			edges.geometry.dispose();
			edges.material.dispose();

			for ( let i = 0; i < materials.length; i ++ ) {

				if ( materials[ i ].map ) materials[ i ].map.dispose();
				materials[ i ].dispose();

			}

		};

		function prepareAnimationData( type, focusPoint ) {

			switch ( type ) {

				case 'posX':
					targetPosition.set( 1, 0, 0 );
					targetQuaternion.setFromEuler( new Euler( 0, Math.PI * 0.5, 0 ) );
					break;

				case 'posY':
					targetPosition.set( 0, 1, 0 );
					targetQuaternion.setFromEuler( new Euler( - Math.PI * 0.5, 0, 0 ) );
					break;

				case 'posZ':
					targetPosition.set( 0, 0, 1 );
					targetQuaternion.setFromEuler( new Euler() );
					break;

				case 'negX':
					targetPosition.set( - 1, 0, 0 );
					targetQuaternion.setFromEuler( new Euler( 0, - Math.PI * 0.5, 0 ) );
					break;

				case 'negY':
					targetPosition.set( 0, - 1, 0 );
					targetQuaternion.setFromEuler( new Euler( Math.PI * 0.5, 0, 0 ) );
					break;

				case 'negZ':
					targetPosition.set( 0, 0, - 1 );
					targetQuaternion.setFromEuler( new Euler( 0, Math.PI, 0 ) );
					break;

				default:
					console.error( 'ViewHelper: Invalid face.' );

			}

			radius = editorCamera.position.distanceTo( focusPoint );
			targetPosition.multiplyScalar( radius ).add( focusPoint );

			dummy.position.copy( focusPoint );

			dummy.lookAt( editorCamera.position );
			q1.copy( dummy.quaternion );

			dummy.lookAt( targetPosition );
			q2.copy( dummy.quaternion );

		}

		// Overlay panel that captures pointer events over the gizmo ------------

		const panel = new UIPanel();
		panel.setId( 'viewHelper' );
		panel.setPosition( 'absolute' );
		panel.setLeft( '0px' );
		panel.setTop( '10px' );
		panel.setHeight( DIM + 'px' );
		panel.setWidth( DIM + 'px' );

		panel.dom.addEventListener( 'pointerdown', ( event ) => {

			event.stopPropagation();

			if ( this.animating === true ) return;

			isPointerDown = true;
			isDragging = false;
			pointerOld.set( event.clientX, event.clientY );

			if ( this.clearHover() && this.onRequireRender ) this.onRequireRender();

			panel.dom.setPointerCapture( event.pointerId );

		} );

		panel.dom.addEventListener( 'pointermove', ( event ) => {

			event.stopPropagation();

			if ( isPointerDown ) {

				const mx = event.clientX - pointerOld.x;
				const my = event.clientY - pointerOld.y;

				if ( isDragging === false && Math.hypot( mx, my ) > DRAG_THRESHOLD ) {

					isDragging = true;

				}

				if ( isDragging ) {

					orbit( - mx, - my );
					pointerOld.set( event.clientX, event.clientY );
					if ( this.onRequireRender ) this.onRequireRender();

				}

			} else if ( this.handlePointerMove( event ) && this.onRequireRender ) {

				this.onRequireRender();

			}

		} );

		panel.dom.addEventListener( 'pointerup', ( event ) => {

			event.stopPropagation();

			if ( panel.dom.hasPointerCapture( event.pointerId ) ) {

				panel.dom.releasePointerCapture( event.pointerId );

			}

			// A press without dragging is a click → snap to the picked face.

			if ( isPointerDown && isDragging === false ) {

				this.handleClick( event );

			}

			isPointerDown = false;
			isDragging = false;

		} );

		panel.dom.addEventListener( 'pointerleave', () => {

			if ( isPointerDown ) return; // keep orbiting while a drag is in progress
			if ( this.clearHover() && this.onRequireRender ) this.onRequireRender();

		} );

		container.add( panel );

	}

}

function createFaceTexture( label ) {

	const size = 256;
	const canvas = document.createElement( 'canvas' );
	canvas.width = canvas.height = size;

	const context = canvas.getContext( '2d' );

	// face fill
	context.fillStyle = '#dfe3e8';
	context.fillRect( 0, 0, size, size );

	// inner border
	context.strokeStyle = '#9aa3ad';
	context.lineWidth = 10;
	context.strokeRect( 5, 5, size - 10, size - 10 );

	// label
	context.fillStyle = '#2b2f36';
	context.font = 'bold 42px Arial, sans-serif';
	context.textAlign = 'center';
	context.textBaseline = 'middle';
	context.fillText( label, size / 2, size / 2 );

	const texture = new CanvasTexture( canvas );
	texture.colorSpace = SRGBColorSpace;
	texture.anisotropy = 4;

	return texture;

}

export { ViewHelper };
