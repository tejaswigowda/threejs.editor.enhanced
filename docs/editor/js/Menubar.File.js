import { UIPanel, UIRow, UIHorizontalRule } from './libs/ui.js';
import { FileLoader } from 'three';
import { setMenuIcon } from './Menubar.Icons.js';

function MenubarFile( editor ) {

	const strings = editor.strings;

	const container = new UIPanel();
	container.setClass( 'menu' );

	const title = new UIPanel();
	title.setClass( 'title' );
	title.setTextContent( strings.getKey( 'menubar/file' ) );
	container.add( title );

	const options = new UIPanel();
	options.setClass( 'options' );
	container.add( options );

	// New Project — single item, confirms then clears to empty scene

	let option = new UIRow().setClass( 'option' );
	setMenuIcon( option, 'new', strings.getKey( 'menubar/file/new' ) );
	option.onClick( function () {

		if ( confirm( strings.getKey( 'prompt/file/open' ) ) ) {

			editor.clear();
			localStorage.setItem( 'git-skip-autoload', '1' );

		}

	} );
	options.add( option );

	const loader = new FileLoader(); // kept: used by Open and Save paths below

	// Open

	const openProjectForm = document.createElement( 'form' );
	openProjectForm.style.display = 'none';
	document.body.appendChild( openProjectForm );

	const openProjectInput = document.createElement( 'input' );
	openProjectInput.multiple = false;
	openProjectInput.type = 'file';
	openProjectInput.accept = '.json';
	openProjectInput.addEventListener( 'change', async function () {

		const file = openProjectInput.files[ 0 ];

		if ( file === undefined ) return;

		try {

			const json = JSON.parse( await file.text() );

			async function onEditorCleared() {

				await editor.fromJSON( json );

				editor.signals.editorCleared.remove( onEditorCleared );

			}

			editor.signals.editorCleared.add( onEditorCleared );

			editor.clear();

		} catch ( e ) {

			alert( strings.getKey( 'prompt/file/failedToOpenProject' ) );
			console.error( e );

		} finally {

			form.reset();

		}

	} );

	openProjectForm.appendChild( openProjectInput );

	option = new UIRow()
		.addClass( 'option' )
		.onClick( function () {

			if ( confirm( strings.getKey( 'prompt/file/open' ) ) ) {

				openProjectInput.click();

			}

		} );
	setMenuIcon( option, 'open', strings.getKey( 'menubar/file/open' ) );

	options.add( option );

	// Save

	option = new UIRow()
		.addClass( 'option' )
		.onClick( function () {

			const json = editor.toJSON();
			const blob = new Blob( [ JSON.stringify( json ) ], { type: 'application/json' } );
			editor.utils.save( blob, 'project.json' );

		} );
	setMenuIcon( option, 'save', strings.getKey( 'menubar/file/save' ) );

	options.add( option );

	//

	options.add( new UIHorizontalRule() );

	// Import

	const form = document.createElement( 'form' );
	form.style.display = 'none';
	document.body.appendChild( form );

	const fileInput = document.createElement( 'input' );
	fileInput.multiple = true;
	fileInput.type = 'file';
	fileInput.addEventListener( 'change', function () {

		editor.loader.loadFiles( fileInput.files );
		form.reset();

	} );
	form.appendChild( fileInput );

	option = new UIRow();
	option.setClass( 'option' );
	option.onClick( function () {

		fileInput.click();

	} );
	setMenuIcon( option, 'import', strings.getKey( 'menubar/file/import' ) );
	options.add( option );

	return container;

}

export { MenubarFile };
