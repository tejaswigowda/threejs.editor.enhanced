import { UIPanel, UIButton, UIText } from './libs/ui.js';

function Toolbar( editor ) {

	const signals = editor.signals;
	const strings = editor.strings;

	const container = new UIPanel();
	container.setId( 'toolbar' );

	// translate / rotate / scale

	const translateIcon = document.createElement( 'img' );
	translateIcon.title = strings.getKey( 'toolbar/translate' );
	translateIcon.src = 'images/translate.svg';

	const translate = new UIButton();
	translate.dom.className = 'Button selected';
	translate.dom.appendChild( translateIcon );
	translate.onClick( function () {

		signals.transformModeChanged.dispatch( 'translate' );

	} );
	container.add( translate );

	const rotateIcon = document.createElement( 'img' );
	rotateIcon.title = strings.getKey( 'toolbar/rotate' );
	rotateIcon.src = 'images/rotate.svg';

	const rotate = new UIButton();
	rotate.dom.appendChild( rotateIcon );
	rotate.onClick( function () {

		signals.transformModeChanged.dispatch( 'rotate' );

	} );
	container.add( rotate );

	const scaleIcon = document.createElement( 'img' );
	scaleIcon.title = strings.getKey( 'toolbar/scale' );
	scaleIcon.src = 'images/scale.svg';

	const scale = new UIButton();
	scale.dom.appendChild( scaleIcon );
	scale.onClick( function () {

		signals.transformModeChanged.dispatch( 'scale' );

	} );
	container.add( scale );

	// ── Edit Mode button ──────────────────────────────────────────────────────

	const editBtn = new UIButton();
	editBtn.dom.title = 'Edit Mode (Tab) — select a Mesh first';
	editBtn.dom.style.cssText = 'margin-left:8px;font-size:11px;padding:0 8px;letter-spacing:0.03em;';
	editBtn.setTextContent( 'Edit' );

	editBtn.onClick( function () {

		const emc = editor.editModeController;
		if ( ! emc ) return;

		if ( emc.active ) {

			emc.exit();

		} else if ( editor.selected && editor.selected.isMesh ) {

			emc.enter( editor.selected );

		}

	} );

	container.add( editBtn );

	// ── Selection mode mini-buttons (visible only in Edit Mode) ───────────────

	const modeBar = document.createElement( 'span' );
	modeBar.style.cssText = 'margin-left:6px;display:none;';

	const makeMode = ( label, mode, key ) => {

		const btn = document.createElement( 'button' );
		btn.textContent = label;
		btn.title = `${ mode } select (${ key })`;
		btn.style.cssText = 'font-size:10px;padding:1px 6px;margin:0 1px;cursor:pointer;';
		btn.addEventListener( 'click', () => editor.editModeController && editor.editModeController.setMode( mode ) );
		modeBar.appendChild( btn );
		return btn;

	};

	const vBtn = makeMode( 'V', 'vertex', '1' );
	const eBtn = makeMode( 'E', 'edge',   '2' );
	const fBtn = makeMode( 'F', 'face',   '3' );

	container.dom.appendChild( modeBar );

	// ── Signal handlers ───────────────────────────────────────────────────────

	signals.transformModeChanged.add( function ( mode ) {

		translate.dom.classList.remove( 'selected' );
		rotate.dom.classList.remove( 'selected' );
		scale.dom.classList.remove( 'selected' );

		switch ( mode ) {

			case 'translate': translate.dom.classList.add( 'selected' ); break;
			case 'rotate':    rotate.dom.classList.add( 'selected' );    break;
			case 'scale':     scale.dom.classList.add( 'selected' );     break;

		}

	} );

	signals.editModeChanged.add( function ( { active, mode } ) {

		editBtn.dom.classList.toggle( 'selected', active );
		modeBar.style.display = active ? 'inline' : 'none';

		if ( active && mode ) {

			[ vBtn, eBtn, fBtn ].forEach( b => b.style.fontWeight = 'normal' );
			if ( mode === 'vertex' ) vBtn.style.fontWeight = 'bold';
			if ( mode === 'edge' )   eBtn.style.fontWeight = 'bold';
			if ( mode === 'face' )   fBtn.style.fontWeight = 'bold';

		}

	} );

	// Disable Edit button when no mesh is selected
	signals.objectSelected.add( function ( obj ) {

		editBtn.dom.disabled = ! ( obj && obj.isMesh );

	} );

	return container;

}

export { Toolbar };
