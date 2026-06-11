import { UIPanel, UIRow } from './libs/ui.js';
import { setMenuIcon, setMenuTooltip } from './Menubar.Icons.js';

function MenubarStatus( editor ) {

	const strings = editor.strings;

	const container = new UIPanel();
	container.setClass( 'menu right' );

	const options = new UIPanel();
	options.setClass( 'options' );
	container.add( options );

	// Sidebar position — cycles right → left → overlay

	const SIDEBAR_POSITIONS = [ 'right', 'left', 'overlay' ];

	const sidebarToggle = new UIRow();
	sidebarToggle.setClass( 'option' );
	setMenuIcon( sidebarToggle, 'sidebar', 'Sidebar position' );

	let sidebarIndex = Math.max( 0, SIDEBAR_POSITIONS.indexOf( localStorage.getItem( 'sidebar-position' ) ) );

	// Restore any saved sizes onto the CSS variables that drive the layout.
	const savedWidth = localStorage.getItem( 'sidebar-width' );
	const savedHeight = localStorage.getItem( 'sidebar-height' );
	if ( savedWidth !== null ) document.documentElement.style.setProperty( '--sidebar-width', savedWidth + 'px' );
	if ( savedHeight !== null ) document.documentElement.style.setProperty( '--sidebar-height', savedHeight + 'px' );

	function applySidebarPosition() {

		const position = SIDEBAR_POSITIONS[ sidebarIndex ];

		// Remember the last non-overlay position so the close button can restore it.
		if ( position !== 'overlay' ) localStorage.setItem( 'overlay-prev-position', position );

		document.body.classList.remove( 'sidebar-left', 'sidebar-bottom', 'sidebar-overlay' );
		if ( position === 'left' ) document.body.classList.add( 'sidebar-left' );
		else if ( position === 'overlay' ) document.body.classList.add( 'sidebar-overlay' );

		setMenuTooltip( sidebarToggle, 'Inspector: ' + position );

		editor.signals.windowResize.dispatch();

	}

	// Called by the overlay close button to jump back to the last docked position.
	editor.setSidebarToLastPosition = function () {

		const prev = localStorage.getItem( 'overlay-prev-position' ) || 'right';
		const idx = SIDEBAR_POSITIONS.indexOf( prev );
		sidebarIndex = idx !== -1 ? idx : 0;
		localStorage.setItem( 'sidebar-position', SIDEBAR_POSITIONS[ sidebarIndex ] );
		document.body.classList.remove( 'sidebar-hidden' );
		applySidebarPosition();

	};

	sidebarToggle.onClick( function () {

		sidebarIndex = ( sidebarIndex + 1 ) % SIDEBAR_POSITIONS.length;
		localStorage.setItem( 'sidebar-position', SIDEBAR_POSITIONS[ sidebarIndex ] );
		document.body.classList.remove( 'sidebar-hidden' );
		applySidebarPosition();

	} );

	options.add( sidebarToggle );

	applySidebarPosition(); // restore persisted position on load

	// Fullscreen

	const fullscreen = new UIRow();
	fullscreen.setClass( 'option' );
	setMenuIcon( fullscreen, 'fullscreen', strings.getKey( 'menubar/view/fullscreen' ) );
	fullscreen.onClick( function () {

		if ( document.fullscreenElement === null ) {

			document.documentElement.requestFullscreen();

		} else if ( document.exitFullscreen ) {

			document.exitFullscreen();

		}

		// Safari

		if ( document.webkitFullscreenElement === null ) {

			document.documentElement.webkitRequestFullscreen();

		} else if ( document.webkitExitFullscreen ) {

			document.webkitExitFullscreen();

		}

	} );
	options.add( fullscreen );

	return container;

}

export { MenubarStatus };
