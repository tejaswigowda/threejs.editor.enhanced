// ── EditableMesh.js ───────────────────────────────────────────────────────────
// Minimal half-edge mesh for topology-aware editing.
//
// Representation
//   vertices[]  {id, x, y, z, he}           he = one outgoing half-edge
//   halfEdges[] {id, v, twin, next, prev, face, u, vt}  uv per face-corner
//   faces[]     {id, he}  — null = deleted
//
// Build:  new EditableMesh().fromBufferGeometry(geom)
// Export: editableMesh.toBufferGeometry()
//
// Ops mutate these arrays directly. After each op, call toBufferGeometry() and
// rebuild via fromBufferGeometry() so indices are always clean (no null gaps).

const EPS = 1e-5;

export class EditableMesh {

	constructor() {

		this.vertices  = [];
		this.halfEdges = [];
		this.faces     = [];

	}

	// ── Build ─────────────────────────────────────────────────────────────────

	fromBufferGeometry( geom ) {

		this.vertices  = [];
		this.halfEdges = [];
		this.faces     = [];

		const pa = _flattenPositions( geom );
		const ua = _flattenUVs( geom );
		const triCount = Math.floor( pa.length / 9 );

		// Vertex deduplication via quantised-key map
		const vertMap = new Map();
		const inv = 1 / EPS;

		const getV = ( x, y, z ) => {

			const key = `${ Math.round( x * inv ) },${ Math.round( y * inv ) },${ Math.round( z * inv ) }`;
			if ( vertMap.has( key ) ) return vertMap.get( key );
			const id = this.vertices.length;
			this.vertices.push( { id, x, y, z, he: - 1 } );
			vertMap.set( key, id );
			return id;

		};

		const edgeMap = new Map(); // "src,dst" → heId

		for ( let t = 0; t < triCount; t ++ ) {

			const b = t * 9;
			const v0 = getV( pa[ b ],     pa[ b + 1 ], pa[ b + 2 ] );
			const v1 = getV( pa[ b + 3 ], pa[ b + 4 ], pa[ b + 5 ] );
			const v2 = getV( pa[ b + 6 ], pa[ b + 7 ], pa[ b + 8 ] );

			if ( v0 === v1 || v1 === v2 || v0 === v2 ) continue; // degenerate

			const faceId = this.faces.length;
			const heBase = this.halfEdges.length;
			this.faces.push( { id: faceId, he: heBase } );

			const vids = [ v0, v1, v2 ];
			for ( let i = 0; i < 3; i ++ ) {

				const ci = t * 3 + i;
				this.halfEdges.push( {
					id:   heBase + i,
					v:    vids[ i ],
					twin: - 1,
					next: heBase + ( i + 1 ) % 3,
					prev: heBase + ( i + 2 ) % 3,
					face: faceId,
					u:    ua ? ua[ ci * 2 ]     : 0,
					vt:   ua ? ua[ ci * 2 + 1 ] : 0,
				} );

				edgeMap.set( `${ vids[ i ] },${ vids[ ( i + 1 ) % 3 ] }`, heBase + i );

				if ( this.vertices[ vids[ i ] ].he === - 1 ) this.vertices[ vids[ i ] ].he = heBase + i;

			}

		}

		// Build twin table
		for ( const he of this.halfEdges ) {

			if ( he.twin !== - 1 ) continue;
			const dst = this.halfEdges[ he.next ].v;
			const tid = edgeMap.get( `${ dst },${ he.v }` );
			if ( tid !== undefined ) { he.twin = tid; this.halfEdges[ tid ].twin = he.id; }

		}

		return this;

	}

	// ── Export ────────────────────────────────────────────────────────────────

	toBufferGeometry() {

		const THREE = window.THREE;
		const pos = [];
		const uvs = [];
		let hasUV = false;

		for ( const face of this.faces ) {

			if ( ! face ) continue;
			let he = this.halfEdges[ face.he ];

			for ( let i = 0; i < 3; i ++ ) {

				const v = this.vertices[ he.v ];
				pos.push( v.x, v.y, v.z );
				uvs.push( he.u, he.vt );
				if ( he.u !== 0 || he.vt !== 0 ) hasUV = true;
				he = this.halfEdges[ he.next ];

			}

		}

		const g = new THREE.BufferGeometry();
		g.setAttribute( 'position', new THREE.BufferAttribute( new Float32Array( pos ), 3 ) );
		if ( hasUV ) g.setAttribute( 'uv', new THREE.BufferAttribute( new Float32Array( uvs ), 2 ) );
		g.computeVertexNormals();
		return g;

	}

	// ── Queries ───────────────────────────────────────────────────────────────

	faceVertices( faceId ) {

		const face = this.faces[ faceId ];
		if ( ! face ) return [];
		const out = [];
		let he = this.halfEdges[ face.he ];
		for ( let i = 0; i < 3; i ++ ) { out.push( this.vertices[ he.v ] ); he = this.halfEdges[ he.next ]; }
		return out;

	}

	faceHalfEdges( faceId ) {

		const face = this.faces[ faceId ];
		if ( ! face ) return [];
		const out = [];
		let he = this.halfEdges[ face.he ];
		for ( let i = 0; i < 3; i ++ ) { out.push( he ); he = this.halfEdges[ he.next ]; }
		return out;

	}

	faceNormal( faceId ) {

		const THREE = window.THREE;
		const [ v0, v1, v2 ] = this.faceVertices( faceId );
		if ( ! v0 ) return new THREE.Vector3( 0, 1, 0 );
		const ab = new THREE.Vector3( v1.x - v0.x, v1.y - v0.y, v1.z - v0.z );
		const ac = new THREE.Vector3( v2.x - v0.x, v2.y - v0.y, v2.z - v0.z );
		return ab.cross( ac ).normalize();

	}

	faceCenter( faceId ) {

		const THREE = window.THREE;
		const verts = this.faceVertices( faceId );
		const c = new THREE.Vector3();
		for ( const v of verts ) c.add( new THREE.Vector3( v.x, v.y, v.z ) );
		return c.multiplyScalar( 1 / 3 );

	}

	// All unique directed edge pairs as [heId, twinId] where heId < twinId
	edges() {

		const seen = new Set();
		const out  = [];

		for ( const he of this.halfEdges ) {

			if ( he.twin === - 1 ) { out.push( [ he.id, - 1 ] ); continue; }
			const key = Math.min( he.id, he.twin ) + ',' + Math.max( he.id, he.twin );
			if ( ! seen.has( key ) ) { seen.add( key ); out.push( [ he.id, he.twin ] ); }

		}

		return out;

	}

	// ── Mutation ──────────────────────────────────────────────────────────────

	addVertex( x, y, z ) {

		const id = this.vertices.length;
		this.vertices.push( { id, x, y, z, he: - 1 } );
		return this.vertices[ id ];

	}

	addFace( v0, v1, v2, u0 = 0, vt0 = 0, u1 = 0, vt1 = 0, u2 = 0, vt2 = 0 ) {

		const faceId = this.faces.length;
		const heBase = this.halfEdges.length;
		this.faces.push( { id: faceId, he: heBase } );

		this.halfEdges.push(
			{ id: heBase,     v: v0, twin: - 1, next: heBase + 1, prev: heBase + 2, face: faceId, u: u0,  vt: vt0 },
			{ id: heBase + 1, v: v1, twin: - 1, next: heBase + 2, prev: heBase,     face: faceId, u: u1,  vt: vt1 },
			{ id: heBase + 2, v: v2, twin: - 1, next: heBase,     prev: heBase + 1, face: faceId, u: u2,  vt: vt2 },
		);

		for ( const [ i, vid ] of [ [ 0, v0 ], [ 1, v1 ], [ 2, v2 ] ] ) {

			if ( this.vertices[ vid ].he === - 1 ) this.vertices[ vid ].he = heBase + i;

		}

		return this.faces[ faceId ];

	}

	removeFace( faceId ) { this.faces[ faceId ] = null; }

	// Remove null faces; rebuild clean sequential EditableMesh from current geometry
	compact() { return new EditableMesh().fromBufferGeometry( this.toBufferGeometry() ); }

}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _flattenPositions( geom ) {

	const pos = geom.attributes.position;
	if ( geom.index ) {

		const idx = geom.index.array;
		const out = new Float32Array( idx.length * 3 );
		for ( let i = 0; i < idx.length; i ++ ) {

			out[ i * 3 ]     = pos.getX( idx[ i ] );
			out[ i * 3 + 1 ] = pos.getY( idx[ i ] );
			out[ i * 3 + 2 ] = pos.getZ( idx[ i ] );

		}

		return out;

	}

	return pos.array;

}

function _flattenUVs( geom ) {

	if ( ! geom.attributes.uv ) return null;
	const uv = geom.attributes.uv;

	if ( geom.index ) {

		const idx = geom.index.array;
		const out = new Float32Array( idx.length * 2 );
		for ( let i = 0; i < idx.length; i ++ ) {

			out[ i * 2 ]     = uv.getX( idx[ i ] );
			out[ i * 2 + 1 ] = uv.getY( idx[ i ] );

		}

		return out;

	}

	return uv.array;

}
