import { UIPanel } from './libs/ui.js';

function Shell( editor ) {

	const signals = editor.signals;

	const container = new UIPanel();
	container.setId( 'shell' );
	container.setDisplay( 'none' );

	// --- Output area ---

	const output = document.createElement( 'div' );
	output.id = 'shell-output';
	container.dom.appendChild( output );

	// --- Input row ---

	const inputRow = document.createElement( 'div' );
	inputRow.id = 'shell-input-row';

	const prompt = document.createElement( 'span' );
	prompt.className = 'shell-prompt';
	prompt.textContent = '> ';

	const input = document.createElement( 'textarea' );
	input.id = 'shell-input';
	input.spellcheck = false;
	input.autocomplete = 'off';
	input.rows = 1;
	input.placeholder = 'Enter JS — Shift+Enter for newline, ↑↓ for history';

	inputRow.appendChild( prompt );
	inputRow.appendChild( input );
	container.dom.appendChild( inputRow );

	// --- State ---

	const history = [];
	let historyIndex = -1;
	let savedInput = '';

	// --- Helpers ---

	function appendOutput( text, type ) {

		const line = document.createElement( 'div' );
		line.className = 'shell-line shell-' + type;
		line.innerHTML = String( text )
			.replace( /&/g, '&amp;' )
			.replace( /</g, '&lt;' )
			.replace( />/g, '&gt;' )
			.replace( /\n/g, '<br>' );
		output.appendChild( line );
		output.scrollTop = output.scrollHeight;

	}

	function formatValue( val ) {

		if ( val === null ) return 'null';
		if ( val === undefined ) return 'undefined';
		if ( typeof val === 'function' ) return val.toString().split( '\n' )[ 0 ] + ' … }';
		if ( typeof val === 'object' ) {

			try { return JSON.stringify( val, null, 2 ); } catch { return String( val ); }

		}
		return String( val );

	}

	function execute( code ) {

		code = code.trim();
		if ( ! code ) return;

		history.unshift( code );
		if ( history.length > 500 ) history.pop();
		historyIndex = -1;
		savedInput = '';

		appendOutput( '> ' + code, 'cmd' );

		try {

			// with() allows bare names like `scene`, `camera`, etc. without strict mode
			const scope = {
				editor,
				THREE: window.THREE,
				scene: editor.scene,
				camera: editor.camera,
				renderer: editor.renderer
			};

			// eslint-disable-next-line no-new-func
			const result = ( new Function( '__s__', '__c__', 'with(__s__){return eval(__c__)}' ) )( scope, code );

			if ( result !== undefined ) {

				appendOutput( formatValue( result ), 'result' );

			}

		} catch ( err ) {

			appendOutput( err.toString(), 'error' );

		}

	}

	// --- Input event handling ---

	input.addEventListener( 'keydown', function ( event ) {

		event.stopPropagation(); // prevent global shortcut handler from eating Backspace/Delete

		if ( event.key === 'Enter' && ! event.shiftKey ) {

			event.preventDefault();
			execute( input.value );
			input.value = '';
			input.style.height = 'auto';
			return;

		}

		if ( event.key === 'ArrowUp' ) {

			if ( input.value.indexOf( '\n' ) === - 1 ) {

				event.preventDefault();
				if ( historyIndex === - 1 ) savedInput = input.value;
				if ( historyIndex < history.length - 1 ) {

					historyIndex ++;
					input.value = history[ historyIndex ];

				}

			}

		}

		if ( event.key === 'ArrowDown' ) {

			if ( input.value.indexOf( '\n' ) === - 1 ) {

				event.preventDefault();
				if ( historyIndex > 0 ) {

					historyIndex --;
					input.value = history[ historyIndex ];

				} else if ( historyIndex === 0 ) {

					historyIndex = - 1;
					input.value = savedInput;

				}

			}

		}

		// Auto-grow textarea height
		setTimeout( function () {

			input.style.height = 'auto';
			input.style.height = Math.min( input.scrollHeight, 120 ) + 'px';

		}, 0 );

	} );

	// --- Toggle signal ---

	signals.toggleShell.add( function () {

		const hidden = container.dom.style.display === 'none';
		container.setDisplay( hidden ? '' : 'none' );
		if ( hidden ) setTimeout( () => input.focus(), 50 );

	} );

	// --- Welcome message ---

	appendOutput( 'three.js editor shell  —  available globals: editor  THREE  scene  camera  renderer', 'info' );

	return container;

}

export { Shell };
