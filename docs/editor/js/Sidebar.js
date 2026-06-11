import { UITabbedPanel, UISpan } from './libs/ui.js';

import { SidebarScene } from './Sidebar.Scene.js';
import { SidebarProperties } from './Sidebar.Properties.js';
import { SidebarProject } from './Sidebar.Project.js';
import { SidebarSettings } from './Sidebar.Settings.js';
import { SidebarGit } from './Sidebar.Git.js';
import { SidebarExport } from './Sidebar.Export.js';
import { SidebarStencils } from './Sidebar.Stencils.js';
import { Animation } from './Animation.js';
import { Shell } from './Shell.js';

// ── Inline SVG icon helper (22×22, no inline styles — CSS handles layout) ─────────────────
function tabSvg( inner ) {

	return `<svg viewBox="0 0 16 16" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ inner }</svg>`;

}

const TAB_ICONS = {
	'scene':      tabSvg( '<rect x="2" y="2" width="12" height="12" rx="1.5"/><path d="M5 6h6M5 9.5h4"/>' ),
	'project':    tabSvg( '<path d="M2 5h4l1.5 1.5H14v7H2z"/>' ),
	'settings':   tabSvg( '<circle cx="8" cy="8" r="2.5"/><path d="M8 1.5V3M8 13v1.5M1.5 8H3M13 8h1.5M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M12.8 3.2l-1.1 1.1M4.3 11.7l-1.1 1.1"/>' ),
	'git':        tabSvg( '<circle cx="5" cy="12" r="1.5"/><circle cx="11" cy="4" r="1.5"/><circle cx="11" cy="12" r="1.5"/><path d="M5 10.5V7.5a2 2 0 0 1 2-2H10.5M11 5.5v5"/>' ),
	'export':     tabSvg( '<path d="M8 2v8M5 5l3-3 3 3"/><path d="M3 11v1.5A1.5 1.5 0 0 0 4.5 14h7A1.5 1.5 0 0 0 13 12.5V11"/>' ),
	'stencils':   tabSvg( '<rect x="3" y="6" width="10" height="7" rx="1"/><rect x="5" y="3.5" width="6" height="2.5" rx="1"/><rect x="7" y="1.5" width="2" height="2" rx="0.5"/>' ),
	'animations': tabSvg( '<circle cx="8" cy="8" r="6"/><path d="M6.5 5.5l5 2.5-5 2.5z"/>' ),
	'shelltab':   tabSvg( '<polyline points="3,5 7,8 3,11"/><line x1="9" y1="11" x2="13" y2="11"/>' ),
};

function Sidebar( editor ) {

	const strings = editor.strings;
	const signals = editor.signals;

	const container = new UITabbedPanel();
	container.setId( 'sidebar' );

	const sidebarProperties = new SidebarProperties( editor );

	const sidebarScene = new SidebarScene( editor );

	const scene = new UISpan().add( sidebarScene );

	// Place the selected-object tabbed panel (Object/Geometry/Material/Script)
	// directly beneath the outliner tree, above the scene-level properties
	// (background / environment / fog / stats).
	const outlinerDom = sidebarScene.dom.querySelector( '#outliner' );

	if ( outlinerDom !== null ) {

		sidebarScene.dom.insertBefore( sidebarProperties.dom, outlinerDom.nextSibling );

		// Separator between the object panel and the scene-level properties.
		const separator = document.createElement( 'hr' );
		sidebarScene.dom.insertBefore( separator, sidebarProperties.dom.nextSibling );

	} else {

		scene.add( sidebarProperties );

	}
	const project = new SidebarProject( editor );
	const settings = new SidebarSettings( editor );
	const git = new SidebarGit( editor );
	const exporter = new SidebarExport( editor );
	const stencils = new SidebarStencils( editor );
	const animation = new Animation( editor );
	const shell = new Shell( editor );

	// Helper: addTab then inject icon+label into the tab's innerHTML
	function addIconTab( id, label, content ) {

		container.addTab( id, label, content );
		const tab = container.tabs[ container.tabs.length - 1 ];
		const icon = TAB_ICONS[ id ] || '';
		tab.dom.innerHTML = `<span class="tab-icon">${ icon }</span><span class="tab-label">${ label }</span>`;

	}

	addIconTab( 'scene', strings.getKey( 'sidebar/scene' ), scene );
	addIconTab( 'project', strings.getKey( 'sidebar/project' ), project );
	addIconTab( 'settings', strings.getKey( 'sidebar/settings' ), settings );
	addIconTab( 'git', strings.getKey( 'menubar/git' ), git );
	addIconTab( 'export', strings.getKey( 'menubar/file/export' ), exporter );
	addIconTab( 'stencils', 'Stencils', stencils );
	// Tab id avoids 'animation' so the wrapper panel doesn't pick up the old #animation CSS.
	addIconTab( 'animations', strings.getKey( 'sidebar/animations' ), animation );
	// Tab id 'shelltab' must NOT collide with the Shell container's own id 'shell'.
	addIconTab( 'shelltab', 'Shell', shell );
	container.select( 'scene' );

	// ── Overlay drag handle + resize grip ─────────────────────────────────────
	// These elements are always in the DOM but only visible/active when the body
	// has class 'sidebar-overlay' (added by Menubar.Status.js).

	const overlayHandle = document.createElement( 'div' );
	overlayHandle.id = 'overlay-handle';
	overlayHandle.title = 'Drag to move';

	const closeBtn = document.createElement( 'button' );
	closeBtn.id = 'overlay-close';
	closeBtn.textContent = '✕';
	closeBtn.title = 'Close inspector';
	closeBtn.addEventListener( 'click', e => {

		if ( editor.setSidebarToLastPosition ) editor.setSidebarToLastPosition();
		e.stopPropagation();

	} );
	overlayHandle.appendChild( closeBtn );

	container.dom.insertBefore( overlayHandle, container.dom.firstChild );

	const overlayGrip = document.createElement( 'div' );
	overlayGrip.id = 'overlay-grip';
	container.dom.appendChild( overlayGrip );

	// ── Overlay drag / resize behaviour ──────────────────────────────────────
	( function initOverlay() {

		const dom = container.dom;
		const PAD = 10, MIN_W = 280, MIN_H = 200;
		const clamp = ( v, lo, hi ) => Math.max( lo, Math.min( hi, v ) );
		const isOverlay = () => document.body.classList.contains( 'sidebar-overlay' );

		function getSetting( key, def ) {

			const v = localStorage.getItem( key );
			return v !== null ? parseFloat( v ) : def;

		}

		function applyOverlayPos() {

			const defX = window.innerWidth - 360;
			const x = clamp( getSetting( 'overlay-x', defX ),  PAD, window.innerWidth  - MIN_W - PAD );
			const y = clamp( getSetting( 'overlay-y', 46 ),     46,  window.innerHeight - MIN_H - PAD );
			const w = clamp( getSetting( 'overlay-w', 350 ),    MIN_W, window.innerWidth  - PAD * 2 );
			const h = clamp( getSetting( 'overlay-h', 500 ),    MIN_H, window.innerHeight - 46 - PAD );
			dom.style.left   = x + 'px';
			dom.style.top    = y + 'px';
			dom.style.width  = w + 'px';
			dom.style.height = h + 'px';

		}

		function clearOverlayPos() {

			dom.style.left = dom.style.top = dom.style.width = dom.style.height = '';

		}

		// Watch for body class changes to activate/deactivate overlay behaviour.
		new MutationObserver( () => {

			isOverlay() ? applyOverlayPos() : clearOverlayPos();

		} ).observe( document.body, { attributes: true, attributeFilter: [ 'class' ] } );

		// ── Drag ─────────────────────────────────────────────────────────────

		let dragging = false, startX, startY, startL, startT;

		function onDragMove( e ) {

			if ( ! dragging ) return;
			const nx = clamp( startL + e.clientX - startX, PAD, window.innerWidth  - dom.offsetWidth  - PAD );
			const ny = clamp( startT + e.clientY - startY, 46,  window.innerHeight - dom.offsetHeight - PAD );
			dom.style.left = nx + 'px';
			dom.style.top  = ny + 'px';

		}

		function onDragUp() {

			dragging = false;
			localStorage.setItem( 'overlay-x', dom.offsetLeft );
			localStorage.setItem( 'overlay-y', dom.offsetTop );
			document.removeEventListener( 'pointermove', onDragMove );
			document.removeEventListener( 'pointerup',   onDragUp );

		}

		overlayHandle.addEventListener( 'pointerdown', e => {

			if ( ! isOverlay() || e.button !== 0 ) return;
			dragging = true;
			startX = e.clientX;  startY = e.clientY;
			startL = dom.offsetLeft; startT = dom.offsetTop;
			document.addEventListener( 'pointermove', onDragMove );
			document.addEventListener( 'pointerup',   onDragUp );
			e.preventDefault();

		} );

		// ── Resize ───────────────────────────────────────────────────────────

		let resizing = false, startW, startH;

		function onResizeMove( e ) {

			if ( ! resizing ) return;
			const nw = clamp( startW + e.clientX - startX, MIN_W, window.innerWidth  - dom.offsetLeft - PAD );
			const nh = clamp( startH + e.clientY - startY, MIN_H, window.innerHeight - dom.offsetTop  - PAD );
			dom.style.width  = nw + 'px';
			dom.style.height = nh + 'px';

		}

		function onResizeUp() {

			resizing = false;
			localStorage.setItem( 'overlay-w', dom.offsetWidth );
			localStorage.setItem( 'overlay-h', dom.offsetHeight );
			document.removeEventListener( 'pointermove', onResizeMove );
			document.removeEventListener( 'pointerup',   onResizeUp );

		}

		overlayGrip.addEventListener( 'pointerdown', e => {

			if ( ! isOverlay() || e.button !== 0 ) return;
			resizing = true;
			startX = e.clientX;  startY = e.clientY;
			startW = dom.offsetWidth; startH = dom.offsetHeight;
			document.addEventListener( 'pointermove', onResizeMove );
			document.addEventListener( 'pointerup',   onResizeUp );
			e.preventDefault();
			e.stopPropagation();

		} );

	} )();

	// ── Shell / JS signals ────────────────────────────────────────────────────

	// Menu "View → JS Shell" toggles the shell tab; Show JS for Selection reveals it.

	signals.toggleShell.add( function () {

		container.select( container.selected === 'shelltab' ? 'scene' : 'shelltab' );

	} );

	signals.showJSForSelection.add( function () {

		container.select( 'shelltab' );

	} );

	const sidebarPropertiesResizeObserver = new ResizeObserver( function () {

		sidebarProperties.tabsDiv.setWidth( getComputedStyle( container.dom ).width );

	} );

	sidebarPropertiesResizeObserver.observe( container.tabsDiv.dom );

	return container;

}

export { Sidebar };

