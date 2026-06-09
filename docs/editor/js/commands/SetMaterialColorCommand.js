import { Command } from '../Command.js';
import { colorEditGuard } from '../intelligence/editGuards.js';

// True if any OTHER object in the scene references this exact material instance.
function materialSharedByOthers( editor, exceptObject, material ) {

	if ( ! material ) return false;
	let shared = false;
	editor.scene.traverse( o => {

		if ( shared || o === exceptObject || ! o.material ) return;
		if ( Array.isArray( o.material ) ) { if ( o.material.includes( material ) ) shared = true; }
		else if ( o.material === material ) shared = true;

	} );
	return shared;

}

// Assign a material to an object, respecting a multi-material slot.
function assignMaterial( object, slot, material ) {

	if ( slot === - 1 || ! Array.isArray( object.material ) ) object.material = material;
	else object.material[ slot ] = material;

}

class SetMaterialColorCommand extends Command {

	/**
	 * @param {Editor} editor
	 * @param {THREE.Object3D|null} [object=null]
	 * @param {string} attributeName
	 * @param {?number} [newValue=null] Integer representing a hex color value
	 * @param {number} [materialSlot=-1]
	 * @constructor
	 */
	constructor( editor, object = null, attributeName = '', newValue = null, materialSlot = - 1 ) {

		super( editor );

		this.type = 'SetMaterialColorCommand';
		this.name = editor.strings.getKey( 'command/SetMaterialColor' ) + ': ' + attributeName;
		this.updatable = true;

		this.object = object;
		this.materialSlot = materialSlot;

		const material = ( object !== null ) ? editor.getObjectMaterial( object, materialSlot ) : null;

		this.oldValue = ( material !== null ) ? material[ attributeName ].getHex() : null;
		this.newValue = newValue;

		this.attributeName = attributeName;

	}

	execute() {

		let material = this.editor.getObjectMaterial( this.object, this.materialSlot );

		// Clone-on-write (B′1): if other objects share this exact material instance,
		// recoloring it would bleed to all of them ("make the paddles red and blue"
		// → both go one color). Clone first so ONLY this object changes; siblings
		// keep the original. Done once; the object then points at the clone for
		// both redo and undo, so undo (restore oldValue on the clone) stays correct.
		if ( ! this._deshared && materialSharedByOthers( this.editor, this.object, material ) ) {

			material = material.clone();
			assignMaterial( this.object, this.materialSlot, material );
			this._deshared = true;

		} else {

			material = this.editor.getObjectMaterial( this.object, this.materialSlot );

		}

		material[ this.attributeName ].setHex( this.newValue );

		// Guard 3 (map vs color): on a textured material, setting .color only TINTS
		// (map × color) — the command "succeeds" but the visible color won't match
		// intent (the gothic-bed bug). Surface it once, don't silently mislead.
		if ( this.attributeName === 'color' && ! this._guardWarned && colorEditGuard( material ) ) {

			this._guardWarned = true;
			const msg = '⚠ ' + colorEditGuard( material ).message;
			if ( typeof this.editor.importLog === 'function' ) this.editor.importLog( msg );
			else if ( typeof console !== 'undefined' ) console.warn( msg );

		}

		this.editor.signals.materialChanged.dispatch( this.object, this.materialSlot );

	}

	undo() {

		const material = this.editor.getObjectMaterial( this.object, this.materialSlot );

		material[ this.attributeName ].setHex( this.oldValue );

		this.editor.signals.materialChanged.dispatch( this.object, this.materialSlot );

	}

	update( cmd ) {

		this.newValue = cmd.newValue;

	}

	toJSON() {

		const output = super.toJSON( this );

		output.objectUuid = this.object.uuid;
		output.attributeName = this.attributeName;
		output.oldValue = this.oldValue;
		output.newValue = this.newValue;
		output.materialSlot = this.materialSlot;

		return output;

	}

	fromJSON( json ) {

		super.fromJSON( json );

		this.object = this.editor.objectByUuid( json.objectUuid );
		this.attributeName = json.attributeName;
		this.oldValue = json.oldValue;
		this.newValue = json.newValue;
		this.materialSlot = json.materialSlot;

	}

}

export { SetMaterialColorCommand };
