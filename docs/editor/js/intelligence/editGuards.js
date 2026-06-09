// ── intelligence/editGuards.js ────────────────────────────────────────────────
// The edit guards that real imported assets require. Pure detection (no model);
// the messages are surfaced so the tool is "never silently wrong".
//
//   Guard 1 — Merged-mesh sub-part edit → handled at resolution (findByDescription
//             returns method:'merged'); see sceneIndex.js.
//   Guard 2 — Shared material clone-on-write → SetMaterialColorCommand.
//   Guard 3 — Map vs color: a material with a .map TINTS (map × color); setting
//             .color does NOT replace the visible color. Detect + tell the user.
//   Guard 4 — Edit conflict: SetMaterialCommand REPLACES the material (wiping
//             prior edits); SetMaterialColorCommand MODIFIES it. Surface it.

/** True if the material (or any in a multi-material array) carries a texture map. */
export function materialHasMap( material ) {

	if ( ! material ) return false;
	const mats = Array.isArray( material ) ? material : [ material ];
	return mats.some( m => m && !! m.map );

}

/**
 * Guard 3 — would a color edit only TINT (because of an existing .map)?
 * @returns {null|{ kind:'tint', message:string }}
 */
export function colorEditGuard( material ) {

	if ( ! materialHasMap( material ) ) return null;
	return {
		kind: 'tint',
		message: 'This part has a texture; setting color TINTS it (texture × color), it does not replace the visible color. To change the base color the texture must be removed/replaced.',
	};

}

/**
 * Guard 4 — would replacing the material discard edits already made to it?
 * Heuristic: the existing material was tweaked away from a fresh default (it has a
 * map, a non-white color set deliberately, or a name suggesting prior authoring).
 * @returns {null|{ kind:'conflict', message:string }}
 */
export function materialReplaceGuard( oldMaterial ) {

	if ( ! oldMaterial ) return null;
	const m = Array.isArray( oldMaterial ) ? oldMaterial[ 0 ] : oldMaterial;
	if ( ! m ) return null;

	const hasMap = !! m.map;
	const named = !! ( m.name && m.name.trim() );
	if ( ! hasMap && ! named ) return null;

	return {
		kind: 'conflict',
		message: 'Replacing this material discards its current texture/edits. Use a color command to MODIFY it instead, or keep the map to TINT.',
	};

}
