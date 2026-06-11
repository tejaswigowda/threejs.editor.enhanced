import { UITabbedPanel } from './libs/ui.js';

import { SidebarObject } from './Sidebar.Object.js';
import { SidebarGeometry } from './Sidebar.Geometry.js';
import { SidebarMaterial } from './Sidebar.Material.js';
import { SidebarScript } from './Sidebar.Script.js';

// ── Inline SVG icon helper (matches the main sidebar tabs) ────────────────────
function tabSvg( inner ) {

	return `<svg viewBox="0 0 16 16" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ inner }</svg>`;

}

const PROPERTY_TAB_ICONS = {
	'objectTab':   tabSvg( '<path d="M8 1.5l5.5 3v7L8 14.5 2.5 11.5v-7z"/><path d="M2.5 4.5 8 7.5l5.5-3M8 7.5V14.5"/>' ),
	'geometryTab': tabSvg( '<path d="M8 2 14 13H2z"/><path d="M8 2v11M2 13l6-4 6 4"/>' ),
	'materialTab': tabSvg( '<circle cx="8" cy="8" r="6"/><path d="M5.2 5.2a3 3 0 0 1 2.3-1.1"/>' ),
	'scriptTab':   tabSvg( '<polyline points="6,5 3,8 6,11"/><polyline points="10,5 13,8 10,11"/>' ),
};

function SidebarProperties( editor ) {

	const strings = editor.strings;

	const container = new UITabbedPanel();
	container.setId( 'properties' );

	container.addTab( 'objectTab', strings.getKey( 'sidebar/properties/object' ), new SidebarObject( editor ) );
	container.addTab( 'geometryTab', strings.getKey( 'sidebar/properties/geometry' ), new SidebarGeometry( editor ) );
	container.addTab( 'materialTab', strings.getKey( 'sidebar/properties/material' ), new SidebarMaterial( editor ) );
	container.addTab( 'scriptTab', strings.getKey( 'sidebar/properties/script' ), new SidebarScript( editor ) );
	container.select( 'objectTab' );

	// Style the tabs like the main sidebar tabs: stacked icon + label.
	container.tabs.forEach( function ( tab ) {

		const id = tab.dom.id;
		const icon = PROPERTY_TAB_ICONS[ id ] || '';
		const label = tab.dom.textContent;
		tab.dom.innerHTML = `<span class="tab-icon">${ icon }</span><span class="tab-label">${ label }</span>`;

	} );

	function getTabByTabId( tabs, tabId ) {


		return tabs.find( function ( tab ) {

			return tab.dom.id === tabId;

		} );

	}

	const geometryTab = getTabByTabId( container.tabs, 'geometryTab' );
	const materialTab = getTabByTabId( container.tabs, 'materialTab' );
	const scriptTab = getTabByTabId( container.tabs, 'scriptTab' );

	function toggleTabs( object ) {

		container.setHidden( object === null );

		if ( object === null ) return;

		geometryTab.setHidden( ! object.geometry );

		materialTab.setHidden( ! object.material );

		scriptTab.setHidden( object === editor.camera );

		// set active tab

		if ( container.selected === 'geometryTab' ) {

			container.select( geometryTab.isHidden() ? 'objectTab' : 'geometryTab' );

		} else if ( container.selected === 'materialTab' ) {

			container.select( materialTab.isHidden() ? 'objectTab' : 'materialTab' );

		} else if ( container.selected === 'scriptTab' ) {

			container.select( scriptTab.isHidden() ? 'objectTab' : 'scriptTab' );

		}

	}

	editor.signals.objectSelected.add( toggleTabs );

	toggleTabs( editor.selected );

	return container;

}

export { SidebarProperties };
