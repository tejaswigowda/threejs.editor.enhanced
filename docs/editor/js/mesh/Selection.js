// ── Selection.js ──────────────────────────────────────────────────────────────
// Sub-object selection for Edit Mode: vertex / edge / face.
// Each mode keeps a Set of element IDs from the active EditableMesh.

export class Selection {

	constructor() {

		this.mode     = 'face';       // 'vertex' | 'edge' | 'face'
		this.vertices = new Set();
		this.edges    = new Set();    // half-edge IDs (canonical: smaller of pair)
		this.faces    = new Set();

	}

	setMode( mode ) {

		this.mode = mode;
		this.clear();

	}

	get ids() {

		return this[ this.mode === 'vertex' ? 'vertices' : this.mode === 'edge' ? 'edges' : 'faces' ];

	}

	toggle( id ) {

		const s = this.ids;
		if ( s.has( id ) ) s.delete( id ); else s.add( id );

	}

	add( id )    { this.ids.add( id ); }
	remove( id ) { this.ids.delete( id ); }
	has( id )    { return this.ids.has( id ); }

	clear() {

		this.vertices.clear();
		this.edges.clear();
		this.faces.clear();

	}

	selectAll( editableMesh ) {

		this.clear();

		if ( this.mode === 'face' ) {

			for ( const f of editableMesh.faces ) { if ( f ) this.faces.add( f.id ); }

		} else if ( this.mode === 'vertex' ) {

			for ( const v of editableMesh.vertices ) this.vertices.add( v.id );

		} else {

			for ( const [ a, b ] of editableMesh.edges() ) this.edges.add( Math.min( a, b === - 1 ? a : b ) );

		}

	}

	get count() { return this.ids.size; }

	// Compact JSON for AI context injection
	summarize( editableMesh ) {

		const THREE = window.THREE;
		const box = new THREE.Box3();

		if ( this.mode === 'face' ) {

			for ( const fid of this.faces ) {

				for ( const v of editableMesh.faceVertices( fid ) ) {

					box.expandByPoint( new THREE.Vector3( v.x, v.y, v.z ) );

				}

			}

		} else if ( this.mode === 'vertex' ) {

			for ( const vid of this.vertices ) {

				const v = editableMesh.vertices[ vid ];
				box.expandByPoint( new THREE.Vector3( v.x, v.y, v.z ) );

			}

		}

		const size   = new THREE.Vector3();
		const center = new THREE.Vector3();
		box.getSize( size );
		box.getCenter( center );

		return {
			mode:   this.mode,
			count:  this.count,
			bounds: {
				center: [ Math.round( center.x * 100 ) / 100, Math.round( center.y * 100 ) / 100, Math.round( center.z * 100 ) / 100 ],
				size:   [ Math.round( size.x * 100 ) / 100, Math.round( size.y * 100 ) / 100, Math.round( size.z * 100 ) / 100 ],
			},
		};

	}

}
