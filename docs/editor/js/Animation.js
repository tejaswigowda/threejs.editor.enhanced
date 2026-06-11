import * as THREE from 'three';

import { UIPanel, UIText, UIButton, UINumber, UICheckbox } from './libs/ui.js';

import { AnimationPathHelper } from 'three/addons/helpers/AnimationPathHelper.js';

function Animation( editor ) {

	const signals = editor.signals;
	const strings = editor.strings;
	const mixer = editor.mixer;

	// ── Keyframe authoring state ─────────────────────────────────────────────
	// playheadTime is the authoritative authoring time (seconds). The clip action
	// is ONLY left active while actually playing — at every other moment we sample
	// the pose then release the action, so the selected object stays freely
	// editable (the gizmo would otherwise fight a paused-but-active action, which
	// the render loop keeps writing every frame).
	let playheadTime = 0;
	let playing = false;
	let selectedKeyframe = null;          // { trackName, index }
	let suppressAutoKey = false;          // guards our own pose writes from re-keying
	let autoKey = false;                  // record a key whenever the object changes
	let fps = 0;                          // 0 = no snapping; otherwise snap times to 1/fps
	const recordChannels = { position: true, rotation: true, scale: true };

	// Lives in its own sidebar tab (no longer a docked bottom bar).
	const container = new UIPanel();
	container.dom.style.display = 'flex';
	container.dom.style.flexDirection = 'column';

	// Top bar - playback controls
	const controlsPanel = new UIPanel();
	controlsPanel.dom.style.padding = '6px 10px';
	controlsPanel.dom.style.borderBottom = '1px solid #ccc';
	controlsPanel.dom.style.display = 'flex';
	controlsPanel.dom.style.alignItems = 'center';
	controlsPanel.dom.style.justifyContent = 'center';
	controlsPanel.dom.style.gap = '6px';
	controlsPanel.dom.style.flexWrap = 'wrap';
	controlsPanel.dom.style.flexShrink = '0';
	container.add( controlsPanel );

	// SVG icons
	const playIcon = '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 1.5v9l7-4.5z" fill="currentColor"/></svg>';
	const pauseIcon = '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 1h3v10H2zM7 1h3v10H7z" fill="currentColor"/></svg>';
	const stopIcon = '<svg width="12" height="12" viewBox="0 0 12 12"><rect x="2" y="2" width="8" height="8" fill="currentColor"/></svg>';

	const playButton = new UIButton();
	playButton.dom.innerHTML = playIcon;
	playButton.dom.style.width = '24px';
	playButton.dom.style.height = '24px';
	playButton.dom.style.padding = '0';
	playButton.dom.style.borderRadius = '4px';
	playButton.dom.style.display = 'flex';
	playButton.dom.style.alignItems = 'center';
	playButton.dom.style.justifyContent = 'center';
	playButton.onClick( function () {

		play();

	} );
	controlsPanel.add( playButton );

	const pauseButton = new UIButton();
	pauseButton.dom.innerHTML = pauseIcon;
	pauseButton.dom.style.width = '24px';
	pauseButton.dom.style.height = '24px';
	pauseButton.dom.style.padding = '0';
	pauseButton.dom.style.borderRadius = '4px';
	pauseButton.dom.style.display = 'flex';
	pauseButton.dom.style.alignItems = 'center';
	pauseButton.dom.style.justifyContent = 'center';
	pauseButton.onClick( function () {

		pause();

	} );
	controlsPanel.add( pauseButton );

	const stopButton = new UIButton();
	stopButton.dom.innerHTML = stopIcon;
	stopButton.dom.style.width = '24px';
	stopButton.dom.style.height = '24px';
	stopButton.dom.style.padding = '0';
	stopButton.dom.style.borderRadius = '4px';
	stopButton.dom.style.display = 'flex';
	stopButton.dom.style.alignItems = 'center';
	stopButton.dom.style.justifyContent = 'center';
	stopButton.onClick( function () {

		stop();

	} );
	controlsPanel.add( stopButton );

	// Time display
	const timeDisplay = document.createElement( 'div' );
	timeDisplay.style.display = 'flex';
	timeDisplay.style.alignItems = 'center';
	timeDisplay.style.justifyContent = 'center';
	timeDisplay.style.gap = '4px';
	timeDisplay.style.height = '24px';
	timeDisplay.style.padding = '0 8px';
	timeDisplay.style.background = 'rgba(0,0,0,0.05)';
	timeDisplay.style.borderRadius = '4px';
	timeDisplay.style.fontFamily = 'monospace';
	timeDisplay.style.fontSize = '11px';
	controlsPanel.dom.appendChild( timeDisplay );

	const timeText = new UIText( '0.00' ).setWidth( '36px' );
	timeText.dom.style.textAlign = 'right';
	timeDisplay.appendChild( timeText.dom );

	const separator = new UIText( '/' );
	timeDisplay.appendChild( separator.dom );

	const durationText = new UIText( '0.00' ).setWidth( '36px' );
	timeDisplay.appendChild( durationText.dom );

	// Time Scale
	const mixerTimeScaleNumber = new UINumber( 1 ).setWidth( '60px' ).setRange( - 10, 10 );
	mixerTimeScaleNumber.onChange( function () {

		mixer.timeScale = mixerTimeScaleNumber.getValue();

	} );

	controlsPanel.add( new UIText( strings.getKey( 'sidebar/animations/timescale' ) ).setClass( 'Label' ) );
	controlsPanel.add( mixerTimeScaleNumber );

	// ── Authoring toolbar (keyframe editing) ─────────────────────────────────
	const authorPanel = new UIPanel();
	authorPanel.dom.style.padding = '6px 10px';
	authorPanel.dom.style.borderBottom = '1px solid #ccc';
	authorPanel.dom.style.display = 'flex';
	authorPanel.dom.style.alignItems = 'center';
	authorPanel.dom.style.justifyContent = 'center';
	authorPanel.dom.style.gap = '6px';
	authorPanel.dom.style.flexWrap = 'wrap';
	authorPanel.dom.style.flexShrink = '0';
	authorPanel.dom.style.fontSize = '11px';
	container.add( authorPanel );

	function toolButton( label, title, onClick ) {

		const b = new UIButton( label );
		b.dom.title = title;
		b.dom.style.height = '22px';
		b.dom.style.padding = '0 8px';
		b.dom.style.borderRadius = '4px';
		b.dom.style.fontSize = '11px';
		b.onClick( onClick );
		authorPanel.add( b );
		return b;

	}

	toolButton( '+ Clip', 'Create a new empty animation clip', function () {

		createClip();
		update();

	} );

	toolButton( '◆ Key', 'Insert/update a keyframe for the selected object at the playhead', function () {

		setKey();

	} );

	toolButton( 'Del Key', 'Delete the selected keyframe', function () {

		deleteSelectedKey();

	} );

	toolButton( '🗑 Clip', 'Delete the current clip', function () {

		deleteClip();

	} );

	// Channel toggles (which transform channels Set Key / Auto-Key records)
	function channelToggle( labelText, key ) {

		const wrap = document.createElement( 'label' );
		wrap.style.display = 'flex';
		wrap.style.alignItems = 'center';
		wrap.style.gap = '2px';
		wrap.style.cursor = 'pointer';
		wrap.title = labelText + ' channel';
		const cb = new UICheckbox( recordChannels[ key ] );
		cb.onChange( function () {

			recordChannels[ key ] = cb.getValue();

		} );
		wrap.appendChild( cb.dom );
		const t = document.createElement( 'span' );
		t.textContent = labelText;
		wrap.appendChild( t );
		authorPanel.dom.appendChild( wrap );

	}

	const channelSep = document.createElement( 'span' );
	channelSep.textContent = '|';
	channelSep.style.opacity = '0.4';
	authorPanel.dom.appendChild( channelSep );

	channelToggle( 'P', 'position' );
	channelToggle( 'R', 'rotation' );
	channelToggle( 'S', 'scale' );

	// Auto-Key toggle
	const autoWrap = document.createElement( 'label' );
	autoWrap.style.display = 'flex';
	autoWrap.style.alignItems = 'center';
	autoWrap.style.gap = '3px';
	autoWrap.style.cursor = 'pointer';
	autoWrap.title = 'Automatically insert a keyframe whenever the selected object is transformed';
	const autoKeyCheck = new UICheckbox( autoKey );
	autoKeyCheck.onChange( function () {

		autoKey = autoKeyCheck.getValue();

	} );
	autoWrap.appendChild( autoKeyCheck.dom );
	const autoLabel = document.createElement( 'span' );
	autoLabel.textContent = 'Auto';
	autoWrap.appendChild( autoLabel );
	authorPanel.dom.appendChild( autoWrap );

	// Snap (FPS) — 0 disables time snapping
	authorPanel.add( new UIText( 'Snap' ).setClass( 'Label' ).setWidth( 'auto' ) );
	const fpsNumber = new UINumber( fps ).setWidth( '44px' ).setRange( 0, 240 ).setPrecision( 0 );
	fpsNumber.dom.title = 'Snap keyframe times to this FPS grid (0 = off)';
	fpsNumber.onChange( function () {

		fps = Math.max( 0, Math.round( fpsNumber.getValue() ) );

	} );
	authorPanel.add( fpsNumber );

	// Editable playhead time — lets you author keys at an exact time (even past the
	// current clip duration, which then extends the clip on the next Set Key).
	authorPanel.add( new UIText( 'Time' ).setClass( 'Label' ).setWidth( 'auto' ) );
	const timeInput = new UINumber( 0 ).setWidth( '56px' ).setPrecision( 3 ).setRange( 0, Infinity );
	timeInput.dom.title = 'Playhead time in seconds';
	timeInput.onChange( function () {

		gotoTime( Math.max( 0, snap( timeInput.getValue() ) ) );

	} );
	authorPanel.add( timeInput );

	// Timeline area with track rows. A fixed height gives the inner track list a
	// scroll basis inside the (auto-height) sidebar tab.
	const timelineArea = document.createElement( 'div' );
	timelineArea.style.height = '360px';
	timelineArea.style.display = 'flex';
	timelineArea.style.flexDirection = 'column';
	timelineArea.style.overflow = 'hidden';
	timelineArea.style.position = 'relative';
	container.dom.appendChild( timelineArea );

	// Scrollable track list
	const trackListContainer = document.createElement( 'div' );
	trackListContainer.style.flex = '1';
	trackListContainer.style.overflowY = 'auto';
	trackListContainer.style.overflowX = 'hidden';
	timelineArea.appendChild( trackListContainer );

	// Playhead (spans entire timeline area)
	const playhead = document.createElement( 'div' );
	playhead.style.position = 'absolute';
	playhead.style.top = '0';
	playhead.style.bottom = '0';
	playhead.style.width = '2px';
	playhead.style.background = '#f00';
	playhead.style.left = '150px'; // Start at timeline start (after labels)
	playhead.style.pointerEvents = 'none';
	playhead.style.zIndex = '10';
	timelineArea.appendChild( playhead );

	// Timeline scrubbing
	let isDragging = false;
	const labelWidth = 150;

	function updateTimeFromPosition( clientX ) {

		if ( ! currentClip ) return;

		const rect = timelineArea.getBoundingClientRect();
		const timelineWidth = rect.width - labelWidth;
		const x = Math.max( 0, Math.min( clientX - rect.left - labelWidth, timelineWidth ) );
		const percent = timelineWidth > 0 ? x / timelineWidth : 0;
		const time = percent * ( currentClip.duration || 0 );
		gotoTime( time );

	}

	timelineArea.addEventListener( 'mousedown', function ( event ) {

		const rect = timelineArea.getBoundingClientRect();
		if ( event.clientX - rect.left > labelWidth ) {

			event.preventDefault();

			isDragging = true;
			updateTimeFromPosition( event.clientX );

		}

	} );

	document.addEventListener( 'mousemove', function ( event ) {

		if ( isDragging ) {

			updateTimeFromPosition( event.clientX );

		}

	} );

	document.addEventListener( 'mouseup', function () {

		isDragging = false;

	} );

	// Track colors by type
	const trackColors = {
		position: '#4CAF50',
		quaternion: '#2196F3',
		rotation: '#2196F3',
		scale: '#FF9800',
		morphTargetInfluences: '#9C27B0',
		default: '#607D8B'
	};

	function getTrackColor( trackName ) {

		for ( const type in trackColors ) {

			if ( trackName.endsWith( '.' + type ) ) {

				return trackColors[ type ];

			}

		}

		return trackColors.default;

	}

	function getTrackType( trackName ) {

		const parts = trackName.split( '.' );
		return parts[ parts.length - 1 ];

	}

	// Hover path helper
	let hoverHelper = null;
	let currentAction = null;
	let currentClip = null;
	let currentRoot = null;

	// ── Keyframe track editing helpers ───────────────────────────────────────
	// All track edits rebuild the affected KeyframeTrack (typed arrays are
	// immutable in practice for the mixer's cached interpolants), then commitClip()
	// uncaches + rebinds so the change is reflected immediately.

	function trackProperty( name ) {

		return name.substring( name.lastIndexOf( '.' ) + 1 );

	}

	function findTrack( clip, name ) {

		for ( const t of clip.tracks ) if ( t.name === name ) return t;
		return null;

	}

	function valueArray( object, property ) {

		switch ( property ) {

			case 'position': return [ object.position.x, object.position.y, object.position.z ];
			case 'scale': return [ object.scale.x, object.scale.y, object.scale.z ];
			case 'quaternion': return [ object.quaternion.x, object.quaternion.y, object.quaternion.z, object.quaternion.w ];
			default: return [];

		}

	}

	function makeTrack( property, name, times, values ) {

		if ( property === 'quaternion' ) return new THREE.QuaternionKeyframeTrack( name, times, values );
		return new THREE.VectorKeyframeTrack( name, times, values );

	}

	// Rebuild preserving the original track's subclass (Vector/Quaternion/Number/Color…).
	function rebuildTrack( track, times, values ) {

		return new track.constructor( track.name, times, values );

	}

	function snap( time ) {

		if ( fps > 0 ) return Math.round( time * fps ) / fps;
		return time;

	}

	function setKeyframe( clip, object, property, time ) {

		const name = object.uuid + '.' + property;
		const value = valueArray( object, property );
		const stride = value.length;
		const existing = findTrack( clip, name );

		if ( ! existing ) {

			clip.tracks.push( makeTrack( property, name, [ time ], value ) );
			return;

		}

		const times = Array.from( existing.times );
		const values = Array.from( existing.values );

		let idx = - 1;
		for ( let i = 0; i < times.length; i ++ ) {

			if ( Math.abs( times[ i ] - time ) < 1e-4 ) { idx = i; break; }

		}

		if ( idx !== - 1 ) {

			for ( let k = 0; k < stride; k ++ ) values[ idx * stride + k ] = value[ k ];

		} else {

			let ins = times.length;
			for ( let i = 0; i < times.length; i ++ ) { if ( times[ i ] > time ) { ins = i; break; } }
			times.splice( ins, 0, time );
			values.splice( ins * stride, 0, ...value );

		}

		clip.tracks[ clip.tracks.indexOf( existing ) ] = rebuildTrack( existing, times, values );

	}

	function removeKeyframeAt( clip, track, index ) {

		const stride = track.getValueSize();
		const times = Array.from( track.times );
		const values = Array.from( track.values );
		times.splice( index, 1 );
		values.splice( index * stride, stride );

		const i = clip.tracks.indexOf( track );
		if ( times.length === 0 ) {

			clip.tracks.splice( i, 1 ); // drop empty track
			return;

		}

		clip.tracks[ i ] = rebuildTrack( track, times, values );

	}

	function moveKeyframeTime( clip, track, index, newTime ) {

		const stride = track.getValueSize();
		const times = Array.from( track.times );
		const values = Array.from( track.values );
		const val = values.slice( index * stride, index * stride + stride );
		times.splice( index, 1 );
		values.splice( index * stride, stride );

		let ins = times.length;
		for ( let i = 0; i < times.length; i ++ ) { if ( times[ i ] > newTime ) { ins = i; break; } }
		times.splice( ins, 0, newTime );
		values.splice( ins * stride, 0, ...val );

		clip.tracks[ clip.tracks.indexOf( track ) ] = rebuildTrack( track, times, values );
		return { index: ins };

	}

	// ── Clip lifecycle ───────────────────────────────────────────────────────

	function nextClipName() {

		const clips = getAnimationClips();
		return 'Clip ' + ( clips.length + 1 );

	}

	function createClip( name ) {

		const clip = new THREE.AnimationClip( name || nextClipName(), - 1, [] );
		editor.scene.animations.push( clip );

		currentClip = clip;
		currentRoot = editor.scene;
		currentAction = null;
		playheadTime = 0;
		selectedKeyframe = null;

		durationText.setValue( '0.00' );
		signals.objectChanged.dispatch( editor.scene );
		updatePlayheadUI();
		return clip;

	}

	function removeClipFromRoots( clip ) {

		const scene = editor.scene;
		let i = scene.animations.indexOf( clip );
		if ( i !== - 1 ) scene.animations.splice( i, 1 );
		scene.traverse( function ( o ) {

			if ( o.animations ) {

				const j = o.animations.indexOf( clip );
				if ( j !== - 1 ) o.animations.splice( j, 1 );

			}

		} );

	}

	function deleteClip() {

		if ( ! currentClip ) return;
		if ( confirm( 'Delete animation "' + ( currentClip.name || 'Clip' ) + '"?' ) === false ) return;

		if ( currentAction ) currentAction.stop();
		editor.mixer.uncacheClip( currentClip );
		removeClipFromRoots( currentClip );

		currentClip = null;
		currentAction = null;
		currentRoot = null;
		selectedKeyframe = null;
		playing = false;
		playheadTime = 0;

		durationText.setValue( '0.00' );
		timeText.setValue( '0.00' );
		signals.sceneGraphChanged.dispatch();
		update();
		updatePlayheadUI();

	}

	function renameClip( clip ) {

		const name = prompt( 'Clip name:', clip.name || 'Clip' );
		if ( name === null ) return;
		clip.name = name.trim() || clip.name;
		update();

	}

	// ── Keyframe authoring ─────────────────────────────────────────────────────

	function setKey() {

		const object = editor.selected;
		if ( ! object || object === editor.scene ) {

			alert( 'Select an object to key.' );
			return;

		}

		if ( ! currentClip ) createClip();

		const time = snap( playheadTime );
		let changed = false;

		suppressAutoKey = true;
		if ( recordChannels.position ) { setKeyframe( currentClip, object, 'position', time ); changed = true; }
		if ( recordChannels.rotation ) { setKeyframe( currentClip, object, 'quaternion', time ); changed = true; }
		if ( recordChannels.scale ) { setKeyframe( currentClip, object, 'scale', time ); changed = true; }
		suppressAutoKey = false;

		if ( changed ) commitClip();

	}

	function deleteSelectedKey() {

		if ( ! currentClip || ! selectedKeyframe ) return;
		const track = findTrack( currentClip, selectedKeyframe.trackName );
		if ( ! track ) return;

		removeKeyframeAt( currentClip, track, selectedKeyframe.index );
		selectedKeyframe = null;
		commitClip();

	}

	// Recompute duration + rebind the action so edits take effect, then re-pose.
	function commitClip() {

		if ( ! currentClip ) return;

		currentClip.resetDuration();

		suppressAutoKey = true;
		if ( currentAction ) currentAction.stop();
		editor.mixer.uncacheClip( currentClip );
		currentAction = currentRoot ? editor.mixer.clipAction( currentClip, currentRoot ) : null;
		applyPoseAtPlayhead();
		suppressAutoKey = false;

		durationText.setValue( currentClip.duration.toFixed( 2 ) );
		update();
		updatePlayheadUI();

	}

	// ── Playback / scrubbing ────────────────────────────────────────────────

	// Sample the clip at playheadTime, write the pose, then release the action so
	// the selected object remains freely editable (see authoring-state note above).
	function applyPoseAtPlayhead() {

		if ( ! currentClip || ! currentRoot ) return;

		const a = editor.mixer.clipAction( currentClip, currentRoot );
		a.reset();
		a.enabled = true;
		a.play();
		a.time = Math.min( playheadTime, currentClip.duration || 0 );
		editor.mixer.update( 0 );
		a.stop(); // deactivate — object keeps the written transform, now editable
		currentAction = a;

		if ( editor.selected ) editor.signals.objectChanged.dispatch( editor.selected );

	}

	function gotoTime( time ) {

		playing = false;
		// Clamp only the lower bound — the playhead may sit BEYOND the current clip
		// duration so the user can author a key at a later time (which then extends
		// the clip on commit). An empty/short clip would otherwise be un-authorable.
		playheadTime = Math.max( 0, time );

		suppressAutoKey = true;
		applyPoseAtPlayhead();
		suppressAutoKey = false;
		updatePlayheadUI();

	}

	function play() {

		if ( ! currentClip || ! currentRoot ) return;
		if ( ( currentClip.duration || 0 ) <= 0 ) return;

		const a = editor.mixer.clipAction( currentClip, currentRoot );
		a.reset();
		a.enabled = true;
		a.paused = false;
		a.time = playheadTime % currentClip.duration;
		a.play();
		currentAction = a;
		playing = true;

	}

	function pause() {

		if ( playing && currentAction ) {

			gotoTime( currentAction.time ); // releases + poses at the current time

		}

	}

	function stop() {

		playing = false;
		if ( currentAction ) currentAction.stop();
		gotoTime( 0 );

	}

	function updatePlayheadUI() {

		const rect = timelineArea.getBoundingClientRect();
		const timelineWidth = rect.width - labelWidth;
		const dur = currentClip ? ( currentClip.duration || 0 ) : 0;
		const frac = dur > 0 ? Math.min( playheadTime / dur, 1 ) : 0;
		playhead.style.left = ( labelWidth + frac * timelineWidth ) + 'px';
		timeText.setValue( playheadTime.toFixed( 2 ) );
		timeInput.setValue( playheadTime );

	}

	// Get all clips from scene animations
	function getAnimationClips() {

		const scene = editor.scene;
		const clips = [];
		const seen = new Set();

		scene.traverse( function ( object ) {

			if ( object.animations && object.animations.length > 0 ) {

				for ( const clip of object.animations ) {

					if ( ! seen.has( clip.uuid ) ) {

						seen.add( clip.uuid );
						clips.push( { clip: clip, root: object } );

					}

				}

			}

		} );

		// Also check scene.animations directly
		for ( const clip of scene.animations ) {

			if ( ! seen.has( clip.uuid ) ) {

				seen.add( clip.uuid );
				clips.push( { clip: clip, root: scene } );

			}

		}

		return clips;

	}

	function getObjectName( trackName, root ) {

		// Extract UUID from track name (format: uuid.property)
		const dotIndex = trackName.lastIndexOf( '.' );
		if ( dotIndex === - 1 ) return trackName;

		const uuid = trackName.substring( 0, dotIndex );
		const object = root.getObjectByProperty( 'uuid', uuid );

		return object ? ( object.name || 'Object' ) : uuid.substring( 0, 8 );

	}

	function update() {

		trackListContainer.innerHTML = '';

		const clips = getAnimationClips();

		if ( clips.length === 0 ) {

			return;

		}

		for ( const { clip, root } of clips ) {

			// Clip header row
			const clipRow = document.createElement( 'div' );
			clipRow.style.display = 'flex';
			clipRow.style.alignItems = 'center';
			clipRow.style.height = '24px';
			clipRow.style.borderBottom = '1px solid #ccc';
			clipRow.style.cursor = 'pointer';
			clipRow.style.background = currentClip === clip ? 'rgba(0, 136, 255, 0.1)' : '';

			const clipLabel = document.createElement( 'div' );
			clipLabel.style.width = labelWidth + 'px';
			clipLabel.style.padding = '0 10px';
			clipLabel.style.fontSize = '11px';
			clipLabel.style.fontWeight = 'bold';
			clipLabel.style.overflow = 'hidden';
			clipLabel.style.textOverflow = 'ellipsis';
			clipLabel.style.whiteSpace = 'nowrap';
			clipLabel.style.flexShrink = '0';
			clipLabel.style.boxSizing = 'border-box';
			clipLabel.textContent = clip.name || 'Animation';
			clipRow.appendChild( clipLabel );

			const clipTimeline = document.createElement( 'div' );
			clipTimeline.style.flex = '1';
			clipTimeline.style.height = '100%';
			clipTimeline.style.background = 'rgba(0,0,0,0.03)';
			clipRow.appendChild( clipTimeline );

			clipRow.addEventListener( 'click', function () {

				if ( editor.selected !== root ) {

					signals.objectSelected.remove( selectDefaultClip );
					editor.select( root );
					signals.objectSelected.add( selectDefaultClip );

				}

				selectClip( clip, root );
				update(); // Refresh to update highlighting

			} );

			clipRow.addEventListener( 'dblclick', function ( event ) {

				event.stopPropagation();
				renameClip( clip );

			} );

			trackListContainer.appendChild( clipRow );

			// Only show tracks for selected clip
			if ( currentClip === clip ) {

				const duration = clip.duration || 1; // avoid divide-by-zero for single-key clips

				for ( const track of clip.tracks ) {

					const times = track.times;
					if ( times.length === 0 ) continue;

					const startTime = times[ 0 ];
					const endTime = times[ times.length - 1 ];
					const startPercent = ( startTime / duration ) * 100;
					const widthPercent = ( ( endTime - startTime ) / duration ) * 100;

					const trackRow = document.createElement( 'div' );
					trackRow.style.display = 'flex';
					trackRow.style.alignItems = 'center';
					trackRow.style.height = '20px';
					trackRow.style.borderBottom = '1px solid #eee';

					// Track label
					const trackLabel = document.createElement( 'div' );
					trackLabel.style.width = labelWidth + 'px';
					trackLabel.style.padding = '0 10px 0 20px';
					trackLabel.style.fontSize = '10px';
					trackLabel.style.overflow = 'hidden';
					trackLabel.style.textOverflow = 'ellipsis';
					trackLabel.style.whiteSpace = 'nowrap';
					trackLabel.style.flexShrink = '0';
					trackLabel.style.boxSizing = 'border-box';
					trackLabel.style.color = '#666';

					const objectName = getObjectName( track.name, root );
					const trackType = getTrackType( track.name );
					trackLabel.textContent = objectName + '.' + trackType;
					trackLabel.title = track.name;
					trackRow.appendChild( trackLabel );

					// Track timeline with block
					const trackTimeline = document.createElement( 'div' );
					trackTimeline.style.flex = '1';
					trackTimeline.style.height = '100%';
					trackTimeline.style.position = 'relative';
					trackTimeline.style.background = 'rgba(0,0,0,0.02)';

					const block = document.createElement( 'div' );
					block.style.position = 'absolute';
					block.style.left = startPercent + '%';
					block.style.width = Math.max( 0.5, widthPercent ) + '%';
					block.style.top = '3px';
					block.style.bottom = '3px';
					block.style.background = getTrackColor( track.name );
					block.style.borderRadius = '2px';
					block.style.opacity = '0.6';
					block.title = trackType + ': ' + startTime.toFixed( 2 ) + 's - ' + endTime.toFixed( 2 ) + 's';

					trackTimeline.appendChild( block );

					// Add keyframe markers (selectable, draggable to retime, click to scrub)
					for ( let i = 0; i < times.length; i ++ ) {

						const keyframePercent = ( times[ i ] / duration ) * 100;
						const keyframe = document.createElement( 'div' );
						keyframe.style.position = 'absolute';
						keyframe.style.left = keyframePercent + '%';
						keyframe.style.top = '50%';
						keyframe.style.width = '8px';
						keyframe.style.height = '8px';
						keyframe.style.marginLeft = '-4px';
						keyframe.style.marginTop = '-4px';
						keyframe.style.background = getTrackColor( track.name );
						keyframe.style.borderRadius = '1px';
						keyframe.style.transform = 'rotate(45deg)';
						keyframe.style.cursor = 'ew-resize';
						keyframe.style.zIndex = '5';
						keyframe.title = times[ i ].toFixed( 3 ) + 's — click to scrub, drag to retime';

						const isSelected = selectedKeyframe &&
							selectedKeyframe.trackName === track.name &&
							selectedKeyframe.index === i;
						if ( isSelected ) {

							keyframe.style.background = '#ff5722';
							keyframe.style.boxShadow = '0 0 0 2px #fff, 0 0 0 3px #ff5722';

						}

						( function attachKeyframe( el, trackName, kfIndex, keyTime, tl ) {

							el.addEventListener( 'mousedown', function ( event ) {

								event.stopPropagation();
								event.preventDefault();

								const startX = event.clientX;
								const dur = currentClip ? ( currentClip.duration || 0 ) : 0;
								const rect = tl.getBoundingClientRect();
								let moved = false;
								let pendingTime = keyTime;

								function onMove( ev ) {

									if ( Math.abs( ev.clientX - startX ) > 3 ) moved = true;
									if ( ! moved ) return;

									let frac = rect.width > 0 ? ( ev.clientX - rect.left ) / rect.width : 0;
									frac = Math.max( 0, Math.min( 1, frac ) );
									pendingTime = snap( frac * ( dur || 0 ) );
									el.style.left = ( dur > 0 ? ( pendingTime / dur ) * 100 : 0 ) + '%';

								}

								function onUp() {

									document.removeEventListener( 'mousemove', onMove );
									document.removeEventListener( 'mouseup', onUp );

									const liveTrack = findTrack( currentClip, trackName );
									if ( moved && liveTrack ) {

										const r = moveKeyframeTime( currentClip, liveTrack, kfIndex, pendingTime );
										selectedKeyframe = { trackName: trackName, index: r.index };
										playheadTime = pendingTime;
										commitClip();

									} else {

										selectedKeyframe = { trackName: trackName, index: kfIndex };
										gotoTime( keyTime );
										update();

									}

								}

								document.addEventListener( 'mousemove', onMove );
								document.addEventListener( 'mouseup', onUp );

							} );

						} )( keyframe, track.name, i, times[ i ], trackTimeline );

						trackTimeline.appendChild( keyframe );

					}

					trackRow.appendChild( trackTimeline );

					// Hover on position tracks to show path helper
					if ( track.name.endsWith( '.position' ) && track.getValueSize() === 3 ) {

						const uuid = track.name.replace( '.position', '' );
						const object = root.getObjectByProperty( 'uuid', uuid );

						if ( object ) {

							trackRow.addEventListener( 'mouseenter', function () {

								showPath( clip, object );

							} );

							trackRow.addEventListener( 'mouseleave', function () {

								hidePath();

							} );

						}

					}

					trackListContainer.appendChild( trackRow );

				}

			}

		}

	}

	function selectClip( clip, root ) {

		// Stop current action
		if ( currentAction ) {

			currentAction.stop();

		}

		playing = false;
		selectedKeyframe = null;
		playheadTime = 0;

		if ( currentClip === clip ) {

			// Unselect clip
			currentAction = null;
			currentClip = null;
			currentRoot = null;

			timeText.setValue( '0.00' );
			durationText.setValue( '0.00' );

		} else {

			// Select clip without playing
			currentClip = clip;
			currentRoot = root;
			currentAction = editor.mixer.clipAction( clip, root );

			// Update duration display
			durationText.setValue( clip.duration.toFixed( 2 ) );

		}

		updatePlayheadUI();

	}

	function showPath( clip, object ) {

		hidePath();

		hoverHelper = new AnimationPathHelper( currentRoot, clip, object );
		editor.sceneHelpers.add( hoverHelper );
		signals.sceneGraphChanged.dispatch();

	}

	function hidePath() {

		if ( hoverHelper ) {

			editor.sceneHelpers.remove( hoverHelper );
			hoverHelper.dispose();
			hoverHelper = null;
			signals.sceneGraphChanged.dispatch();

		}

	}

	function clear() {

		hidePath();
		trackListContainer.innerHTML = '';
		currentAction = null;
		currentClip = null;
		currentRoot = null;
		selectedKeyframe = null;
		playing = false;
		playheadTime = 0;
		timeText.setValue( '0.00' );
		durationText.setValue( '0.00' );

	}

	// Drive the playhead/time read-out from the action only while actually playing.
	// (When paused/scrubbing the playhead is positioned by updatePlayheadUI.)
	function updateTime() {

		if ( playing && currentAction && currentClip && ( currentClip.duration || 0 ) > 0 ) {

			playheadTime = currentAction.time % currentClip.duration;
			updatePlayheadUI();

		}

		requestAnimationFrame( updateTime );

	}

	function selectDefaultClip( object ) {

		if ( object !== null && object.animations && object.animations.length > 0 ) {

			selectClip( object.animations[ 0 ], object );
			update();

		}

	}

	// Auto-Key: record a keyframe whenever the selected object is transformed by
	// the user (gizmo / sidebar). Guarded against our own pose writes.
	function onObjectChanged( object ) {

		if ( suppressAutoKey || ! autoKey || playing ) return;
		if ( ! currentClip ) return;
		if ( ! object || object !== editor.selected || object === editor.scene ) return;

		setKey();

	}

	updateTime();

	// Auto-select clip when an object with animations is selected
	signals.objectSelected.add( selectDefaultClip );

	// Update when scene changes
	signals.editorCleared.add( clear );
	signals.objectChanged.add( onObjectChanged );
	signals.objectAdded.add( update );
	signals.objectRemoved.add( update );

	update();

	return container;

}

export { Animation };
