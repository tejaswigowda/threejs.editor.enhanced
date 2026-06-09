import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';

import { UINumber, UIPanel, UIRow, UISelect, UIText } from './libs/ui.js';
import { UIBoolean } from './libs/ui.three.js';

function SidebarProjectRenderer( editor ) {

	const config = editor.config;
	const signals = editor.signals;
	const strings = editor.strings;

	let currentRenderer = null;

	const container = new UIPanel();
	container.setBorderTop( '0px' );

	// Renderer

	const rendererRow = new UIRow();
	container.add( rendererRow );

	rendererRow.add( new UIText( strings.getKey( 'sidebar/project/renderer' ) ).setClass( 'Label' ) );

	const rendererTypeSelect = new UISelect().setOptions( {
		'WebGLRenderer': 'WebGL',
		'WebGPURenderer': 'WebGPU'
	} ).setWidth( '150px' ).onChange( createRenderer );
	rendererTypeSelect.setValue( config.getKey( 'project/renderer/type' ) );
	rendererRow.add( rendererTypeSelect );

	// Antialias

	const antialiasRow = new UIRow();
	container.add( antialiasRow );

	antialiasRow.add( new UIText( strings.getKey( 'sidebar/project/antialias' ) ).setClass( 'Label' ) );

	const antialiasBoolean = new UIBoolean( config.getKey( 'project/renderer/antialias' ) ).onChange( createRenderer );
	antialiasRow.add( antialiasBoolean );

	// Shadows

	const shadowsRow = new UIRow();
	container.add( shadowsRow );

	shadowsRow.add( new UIText( strings.getKey( 'sidebar/project/shadows' ) ).setClass( 'Label' ) );

	const shadowsBoolean = new UIBoolean( config.getKey( 'project/renderer/shadows' ) ).onChange( updateShadows );
	shadowsRow.add( shadowsBoolean );

	const shadowTypeSelect = new UISelect().setOptions( {
		0: 'Basic',
		1: 'PCF',
		3: 'VSM'
	} ).setWidth( '125px' ).onChange( updateShadows );
	shadowTypeSelect.setValue( config.getKey( 'project/renderer/shadowType' ) );
	shadowsRow.add( shadowTypeSelect );

	function updateShadows() {

		currentRenderer.shadowMap.enabled = shadowsBoolean.getValue();
		currentRenderer.shadowMap.type = parseFloat( shadowTypeSelect.getValue() );

		signals.rendererUpdated.dispatch();

	}

	// Tonemapping

	const toneMappingRow = new UIRow();
	container.add( toneMappingRow );

	toneMappingRow.add( new UIText( strings.getKey( 'sidebar/project/toneMapping' ) ).setClass( 'Label' ) );

	const toneMappingSelect = new UISelect().setOptions( {
		0: 'No',
		1: 'Linear',
		2: 'Reinhard',
		3: 'Cineon',
		4: 'ACESFilmic',
		6: 'AgX',
		7: 'Neutral'
	} ).setWidth( '120px' ).onChange( updateToneMapping );
	toneMappingSelect.setValue( config.getKey( 'project/renderer/toneMapping' ) );
	toneMappingRow.add( toneMappingSelect );

	const toneMappingExposure = new UINumber( config.getKey( 'project/renderer/toneMappingExposure' ) );
	toneMappingExposure.setDisplay( toneMappingSelect.getValue() === '0' ? 'none' : '' );
	toneMappingExposure.setWidth( '30px' ).setMarginLeft( '10px' );
	toneMappingExposure.setRange( 0, 10 );
	toneMappingExposure.onChange( updateToneMapping );
	toneMappingRow.add( toneMappingExposure );

	function updateToneMapping() {

		toneMappingExposure.setDisplay( toneMappingSelect.getValue() === '0' ? 'none' : '' );

		currentRenderer.toneMapping = parseFloat( toneMappingSelect.getValue() );
		currentRenderer.toneMappingExposure = toneMappingExposure.getValue();
		signals.rendererUpdated.dispatch();

	}

	//

	async function createRenderer() {

		const rendererType = rendererTypeSelect.getValue();
		const antialias = antialiasBoolean.getValue();

		let newRenderer = null;

		try {

			if ( rendererType === 'WebGPURenderer' ) {

				newRenderer = new WebGPURenderer( { antialias: antialias, logarithmicDepthBuffer: true } );
				await newRenderer.init();

			} else {

				newRenderer = new THREE.WebGLRenderer( { antialias: antialias, logarithmicDepthBuffer: true } );

			}

		} catch ( error ) {

			console.error( error );
			showRendererError( rendererType, error );
			if ( newRenderer && typeof newRenderer.dispose === 'function' ) newRenderer.dispose();
			return;

		}

		hideRendererError();

		currentRenderer = newRenderer;

		currentRenderer.shadowMap.enabled = shadowsBoolean.getValue();
		currentRenderer.shadowMap.type = parseFloat( shadowTypeSelect.getValue() );
		currentRenderer.toneMapping = parseFloat( toneMappingSelect.getValue() );
		currentRenderer.toneMappingExposure = toneMappingExposure.getValue();

		signals.rendererCreated.dispatch( currentRenderer );
		signals.rendererUpdated.dispatch();

	}

	// Graceful fallback when a GPU context can't be created (e.g. Linux/Chrome
	// software rendering with llvmpipe/SwiftShader, or a blocklisted GPU). Without
	// this the WebGLRenderer constructor throws and the editor renders a blank page.

	function showRendererError( rendererType, error ) {

		let overlay = document.getElementById( 'webgl-error-overlay' );

		if ( overlay === null ) {

			overlay = document.createElement( 'div' );
			overlay.id = 'webgl-error-overlay';
			overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;' +
				'align-items:center;justify-content:center;background:#191919;color:#d6d6d6;' +
				'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;' +
				'padding:24px;box-sizing:border-box;';
			document.body.appendChild( overlay );

		}

		const isWebGPU = rendererType === 'WebGPURenderer';
		const api = isWebGPU ? 'WebGPU' : 'WebGL';
		const message = ( error && error.message ) ? String( error.message ) : String( error );

		overlay.innerHTML =
			'<div style="max-width:560px;line-height:1.55;">' +
				'<h2 style="margin:0 0 12px;font-size:18px;color:#fff;">Could not start the 3D view</h2>' +
				'<p style="margin:0 0 12px;">Your browser was unable to create a <strong>' + api + '</strong> ' +
				'context, so the editor can\u2019t render. This usually means hardware ' +
				'acceleration is disabled or the GPU is being emulated in software ' +
				'(e.g. <code>llvmpipe</code> / SwiftShader on Linux).</p>' +
				'<p style="margin:0 0 8px;">Try one of the following, then reload:</p>' +
				'<ul style="margin:0 0 14px;padding-left:20px;">' +
					'<li>Enable <em>Use hardware acceleration when available</em> in your browser settings and restart it.</li>' +
					'<li>Confirm WebGL works at <a href="https://get.webgl.org/" style="color:#4ea1ff;" target="_blank" rel="noopener">get.webgl.org</a>.</li>' +
					'<li>On Linux, update your GPU drivers, or launch Chrome with ' +
						'<code>--enable-unsafe-swiftshader</code> (software fallback) or ' +
						'<code>--use-gl=angle --use-angle=gl</code>.</li>' +
					( isWebGPU ? '<li>Switch the renderer back to <strong>WebGL</strong> in Project \u203A Renderer.</li>' : '' ) +
				'</ul>' +
				'<button id="webgl-error-reload" style="margin-right:8px;padding:6px 14px;' +
					'background:#2a82da;color:#fff;border:none;border-radius:4px;cursor:pointer;">Reload</button>' +
				'<details style="margin-top:14px;color:#9a9a9a;">' +
					'<summary style="cursor:pointer;">Technical details</summary>' +
					'<pre style="white-space:pre-wrap;word-break:break-word;margin:8px 0 0;font-size:12px;">' +
						message.replace( /[<>&]/g, c => ( { '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ c ] ) ) +
					'</pre>' +
				'</details>' +
			'</div>';

		const reloadButton = document.getElementById( 'webgl-error-reload' );
		if ( reloadButton !== null ) reloadButton.onclick = () => location.reload();

	}

	function hideRendererError() {

		const overlay = document.getElementById( 'webgl-error-overlay' );
		if ( overlay !== null ) overlay.remove();

	}

	createRenderer();


	// Signals

	signals.editorCleared.add( function () {

		currentRenderer.shadowMap.enabled = true;
		currentRenderer.shadowMap.type = THREE.PCFShadowMap;
		currentRenderer.toneMapping = THREE.NeutralToneMapping;
		currentRenderer.toneMappingExposure = 1;

		shadowsBoolean.setValue( currentRenderer.shadowMap.enabled );
		shadowTypeSelect.setValue( currentRenderer.shadowMap.type );
		toneMappingSelect.setValue( currentRenderer.toneMapping );
		toneMappingExposure.setValue( currentRenderer.toneMappingExposure );
		toneMappingExposure.setDisplay( currentRenderer.toneMapping === 0 ? 'none' : '' );

		signals.rendererUpdated.dispatch();

	} );

	signals.rendererUpdated.add( function () {

		config.setKey(
			'project/renderer/type', rendererTypeSelect.getValue(),
			'project/renderer/antialias', antialiasBoolean.getValue(),
			'project/renderer/shadows', shadowsBoolean.getValue(),
			'project/renderer/shadowType', parseFloat( shadowTypeSelect.getValue() ),
			'project/renderer/toneMapping', parseFloat( toneMappingSelect.getValue() ),
			'project/renderer/toneMappingExposure', toneMappingExposure.getValue()
		);

	} );

	return container;

}

export { SidebarProjectRenderer };
