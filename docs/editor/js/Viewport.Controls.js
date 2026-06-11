import { UIPanel, UISelect } from './libs/ui.js';

function ViewportControls( editor ) {

	const signals = editor.signals;

	// camera panel — bottom left

	const cameraPanel = new UIPanel();
	cameraPanel.setPosition( 'absolute' );
	cameraPanel.setLeft( '10px' );
	cameraPanel.setBottom( '10px' );

	const cameraSelect = new UISelect();
	cameraSelect.onChange( function () {

		editor.setViewportCamera( this.getValue() );

	} );
	cameraPanel.add( cameraSelect );

	signals.cameraAdded.add( update );
	signals.cameraRemoved.add( update );
	signals.objectChanged.add( function ( object ) {

		if ( object.isCamera ) {

			updateCameraList();

		}

	} );

	// shading panel — bottom right

	const shadingPanel = new UIPanel();
	shadingPanel.setPosition( 'absolute' );
	shadingPanel.setRight( '10px' );
	shadingPanel.setBottom( '10px' );

	const shadingSelect = new UISelect();
	shadingSelect.setOptions( { 'realistic': 'realistic', 'solid': 'solid', 'normals': 'normals', 'wireframe': 'wireframe' } );
	shadingSelect.setValue( 'solid' );
	shadingSelect.onChange( function () {

		editor.setViewportShading( this.getValue() );

	} );
	shadingPanel.add( shadingSelect );

	signals.editorCleared.add( function () {

		editor.setViewportCamera( editor.camera.uuid );

		shadingSelect.setValue( 'solid' );
		editor.setViewportShading( shadingSelect.getValue() );

	} );

	signals.cameraResetted.add( update );

	update();

	//

	function updateCameraList() {

		const options = {};

		const cameras = editor.cameras;

		for ( const key in cameras ) {

			const camera = cameras[ key ];
			options[ camera.uuid ] = camera.name;

		}

		cameraSelect.setOptions( options );

		const selectedCamera = ( editor.viewportCamera.uuid in options )
			? editor.viewportCamera
			: editor.camera;

		cameraSelect.setValue( selectedCamera.uuid );

		return selectedCamera;

	}

	function update() {

		const selectedCamera = updateCameraList();
		editor.setViewportCamera( selectedCamera.uuid );

	}

	return [ cameraPanel, shadingPanel ];

}

export { ViewportControls };
