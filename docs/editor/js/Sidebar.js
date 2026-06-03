import { UITabbedPanel, UISpan } from './libs/ui.js';

import { SidebarScene } from './Sidebar.Scene.js';
import { SidebarProperties } from './Sidebar.Properties.js';
import { SidebarProject } from './Sidebar.Project.js';
import { SidebarSettings } from './Sidebar.Settings.js';
import { Shell } from './Shell.js';

function Sidebar( editor ) {

	const strings = editor.strings;
	const signals = editor.signals;

	const container = new UITabbedPanel();
	container.setId( 'sidebar' );

	const sidebarProperties = new SidebarProperties( editor );

	const scene = new UISpan().add(
		new SidebarScene( editor ),
		sidebarProperties
	);
	const project = new SidebarProject( editor );
	const settings = new SidebarSettings( editor );
	const shell = new Shell( editor );

	container.addTab( 'scene', strings.getKey( 'sidebar/scene' ), scene );
	container.addTab( 'project', strings.getKey( 'sidebar/project' ), project );
	container.addTab( 'settings', strings.getKey( 'sidebar/settings' ), settings );
	// Tab id 'shelltab' must NOT collide with the Shell container's own id 'shell'.
	container.addTab( 'shelltab', 'Shell', shell );
	container.select( 'scene' );

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
