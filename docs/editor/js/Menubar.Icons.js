// ── Menubar.Icons.js ────────────────────────────────────────────────────────
// Shared line icons for menubar actions. setMenuIcon() turns a menu option into
// an icon-only row whose text label (and shortcut, if any) shows on hover via
// the native title tooltip.

function svg( inner ) {

	return `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

}

const ICONS = {

	// File
	'new': svg( '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>' ),
	'open': svg( '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>' ),
	'save': svg( '<path d="M5 3h11l3 3v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M8 3v5h7M8 21v-7h8v7"/>' ),
	'import': svg( '<path d="M12 3v12M8 11l4 4 4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>' ),

	// Edit
	'undo': svg( '<path d="M9 7l-5 5 5 5"/><path d="M4 12h11a5 5 0 0 1 5 5v1"/>' ),
	'redo': svg( '<path d="M15 7l5 5-5 5"/><path d="M20 12H9a5 5 0 0 0-5 5v1"/>' ),
	'center': svg( '<circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>' ),
	'clone': svg( '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>' ),
	'delete': svg( '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>' ),
	'group': svg( '<rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="3 2"/><rect x="6.5" y="6.5" width="4.5" height="4.5" rx="1"/><rect x="13" y="13" width="4.5" height="4.5" rx="1"/>' ),
	'ungroup': svg( '<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/>' ),
	'showJS': '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><text x="12" y="16" fill="currentColor" stroke="none" text-anchor="middle" font-family="monospace" font-size="9" font-weight="bold">JS</text></svg>',

	// View
	'gridHelper': svg( '<path d="M3 3h18v18H3z"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>' ),
	'cameraHelpers': svg( '<path d="M3 7h11v10H3z"/><path d="M14 10l7-3v10l-7-3z"/>' ),
	'lightHelpers': svg( '<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M5 19l2-2"/>' ),
	'skeletonHelpers': svg( '<circle cx="7" cy="7" r="2.4"/><circle cx="17" cy="17" r="2.4"/><path d="M8.7 8.7l6.6 6.6"/>' ),
	'fullscreen': svg( '<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M3 16v3a2 2 0 0 0 2 2h3"/>' ),
	'sidebar': svg( '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>' ),

};

// Replace a menu option's content with an icon; the label/shortcut moves to the
// hover tooltip. Returns the option so it can be chained.
function setMenuIcon( option, name, label ) {

	const dom = option.dom;
	dom.textContent = ''; // drop any existing label/shortcut nodes
	dom.dataset.tooltip = label; // shown via CSS tooltip on hover
	dom.setAttribute( 'aria-label', label );
	dom.classList.add( 'icon-option' );

	const span = document.createElement( 'span' );
	span.style.display = 'inline-flex';
	span.style.alignItems = 'center';
	span.innerHTML = ICONS[ name ] || '';
	dom.appendChild( span );

	return option;

}

// Update an option's hover tooltip (e.g. when a toggle flips show/hide state).
function setMenuTooltip( option, label ) {

	option.dom.dataset.tooltip = label;
	option.dom.setAttribute( 'aria-label', label );
	return option;

}

export { setMenuIcon, setMenuTooltip, ICONS };
