import { UIHorizontalRule, UIPanel, UIRow } from './libs/ui.js';
import { setMenuIcon, setMenuTooltip } from './Menubar.Icons.js';

function MenubarView( editor ) {

	const signals = editor.signals;
	const strings = editor.strings;

	const container = new UIPanel();
	container.setClass( 'menu' );

	const title = new UIPanel();
	title.setClass( 'title' );
	title.setTextContent( strings.getKey( 'menubar/view' ) );
	container.add( title );

	const options = new UIPanel();
	options.setClass( 'options' );
	container.add( options );

	// Helpers

	const states = {

		gridHelper: true,
		cameraHelpers: true,
		lightHelpers: true,
		skeletonHelpers: true

	};

	// Each helper toggle shows its icon; the hover label reflects what a click
	// will do next ("Hide …" when visible, "Show …" when hidden).

	function addHelperToggle( iconName, stateKey ) {

		const base = strings.getKey( 'menubar/view/' + iconName );
		const option = new UIRow().addClass( 'option' ).addClass( 'toggle' );
		setMenuIcon( option, iconName, base );

		function refresh() {

			option.toggleClass( 'toggle-on', states[ stateKey ] );
			setMenuTooltip( option, ( states[ stateKey ] ? 'Hide ' : 'Show ' ) + base );

		}

		option.onClick( function () {

			states[ stateKey ] = ! states[ stateKey ];
			refresh();
			signals.showHelpersChanged.dispatch( states );

		} );

		refresh();
		options.add( option );

	}

	addHelperToggle( 'gridHelper', 'gridHelper' );
	addHelperToggle( 'cameraHelpers', 'cameraHelpers' );
	addHelperToggle( 'lightHelpers', 'lightHelpers' );
	addHelperToggle( 'skeletonHelpers', 'skeletonHelpers' );

	// new helpers are visible by default, the global visibility state
	// of helpers is managed in this component. every time a helper is added,
	// we request a viewport updated by firing the showHelpersChanged signal.

	signals.helperAdded.add( function () {

		signals.showHelpersChanged.dispatch( states );

	} );

	//

	options.add( new UIHorizontalRule() );

	// Show JS for selection

	const option = new UIRow();
	option.setClass( 'option' );
	setMenuIcon( option, 'showJS', strings.getKey( 'menubar/view/showJS' ) );
	option.onClick( function () {

		signals.showJSForSelection.dispatch();

	} );
	options.add( option );

	return container;

}

export { MenubarView };
