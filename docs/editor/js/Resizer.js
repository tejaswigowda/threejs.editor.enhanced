import { UIElement } from './libs/ui.js';

function Resizer( editor ) {

	const signals = editor.signals;

	const dom = document.createElement( 'div' );
	dom.id = 'resizer';

	// Which edge the sidebar is docked to (kept in sync with the body classes
	// set by the menubar's sidebar-position toggle).
	function getPosition() {

		if ( document.body.classList.contains( 'sidebar-left' ) ) return 'left';
		if ( document.body.classList.contains( 'sidebar-bottom' ) ) return 'bottom';
		return 'right';

	}

	function onPointerDown( event ) {

		if ( event.isPrimary === false ) return;

		dom.ownerDocument.addEventListener( 'pointermove', onPointerMove );
		dom.ownerDocument.addEventListener( 'pointerup', onPointerUp );

	}

	function onPointerUp( event ) {

		if ( event.isPrimary === false ) return;

		dom.ownerDocument.removeEventListener( 'pointermove', onPointerMove );
		dom.ownerDocument.removeEventListener( 'pointerup', onPointerUp );

	}

	function onPointerMove( event ) {

		// PointerEvent's movementX/movementY are 0 in WebKit

		if ( event.isPrimary === false ) return;

		const position = getPosition();
		const root = document.documentElement.style;

		if ( position === 'bottom' ) {

			const offsetHeight = document.body.offsetHeight;
			const cY = event.clientY < 0 ? 0 : event.clientY > offsetHeight ? offsetHeight : event.clientY;

			// Sidebar grows upward from the bottom edge; keep room for the menubar.
			const height = Math.min( offsetHeight - 80, Math.max( 150, offsetHeight - cY ) );

			root.setProperty( '--sidebar-height', height + 'px' );
			localStorage.setItem( 'sidebar-height', height );

		} else {

			const offsetWidth = document.body.offsetWidth;
			const cX = event.clientX < 0 ? 0 : event.clientX > offsetWidth ? offsetWidth : event.clientX;

			// Right dock measures from the right edge, left dock from the left. .TabbedPanel min-width: 335px
			const width = Math.max( 335, position === 'left' ? cX : offsetWidth - cX );

			root.setProperty( '--sidebar-width', width + 'px' );
			localStorage.setItem( 'sidebar-width', width );

			// The toolbar re-centers itself from --sidebar-width via CSS.

		}

		signals.windowResize.dispatch();

	}

	dom.addEventListener( 'pointerdown', onPointerDown );

	return new UIElement( dom );

}

export { Resizer };
