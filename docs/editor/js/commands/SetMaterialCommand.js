import { Command } from '../Command.js';
import { ObjectLoader } from 'three';
import { materialHasMap } from '../intelligence/editGuards.js';

class SetMaterialCommand extends Command {

	/**
	 * @param {Editor} editor
	 * @param {THREE.Object3D|null} object
	 * @param {THREE.Material|null} newMaterial
	 * @param {number} [materialSlot=-1]
	 * @constructor
	 */
	constructor( editor, object = null, newMaterial = null, materialSlot = - 1 ) {

		super( editor );

		this.type = 'SetMaterialCommand';
		this.name = editor.strings.getKey( 'command/SetMaterial' );

		this.object = object;
		this.materialSlot = materialSlot;

		this.oldMaterial = ( object !== null ) ? editor.getObjectMaterial( object, materialSlot ) : null;
		this.newMaterial = newMaterial;

	}

	execute() {

		this.editor.setObjectMaterial( this.object, this.materialSlot, this.newMaterial );

		// Guard 4 (edit conflict): replacing a material discards what it carried.
		// Most often relevant when the old material was textured — flag that the
		// texture is being dropped so a solid recolor isn't a silent surprise.
		if ( ! this._guardWarned && materialHasMap( this.oldMaterial ) && ! materialHasMap( this.newMaterial ) ) {

			this._guardWarned = true;
			const msg = 'ℹ Replaced a textured material — its texture map was dropped (now a solid color). Undo to restore it.';
			if ( typeof this.editor.importLog === 'function' ) this.editor.importLog( msg );

		}

		this.editor.signals.materialChanged.dispatch( this.object, this.materialSlot );

	}

	undo() {

		this.editor.setObjectMaterial( this.object, this.materialSlot, this.oldMaterial );

		this.editor.signals.materialChanged.dispatch( this.object, this.materialSlot );

	}

	toJSON() {

		const output = super.toJSON( this );

		output.objectUuid = this.object.uuid;
		output.oldMaterial = this.oldMaterial.toJSON();
		output.newMaterial = this.newMaterial.toJSON();
		output.materialSlot = this.materialSlot;

		return output;

	}

	fromJSON( json ) {

		super.fromJSON( json );

		this.object = this.editor.objectByUuid( json.objectUuid );
		this.oldMaterial = parseMaterial( json.oldMaterial );
		this.newMaterial = parseMaterial( json.newMaterial );
		this.materialSlot = json.materialSlot;

		function parseMaterial( json ) {

			const loader = new ObjectLoader();
			const images = loader.parseImages( json.images );
			const textures = loader.parseTextures( json.textures, images );
			const materials = loader.parseMaterials( [ json ], textures );
			return materials[ json.uuid ];

		}

	}

}

export { SetMaterialCommand };
