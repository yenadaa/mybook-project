import * as state from './viewer-state.js';
import { scrollToPage } from './viewer-renderer.js';

export function performSearch() {
    if (!state.pdfDoc) return;
    const q = (state.els.searchInput?.value || '').trim().toLowerCase();
    state.setSearchHits([]);
    state.setSearchCursor(-1);
    
    if (!q) {
        console.log("Search cleared.");
        return;
    }
    
    state.searchIndex.forEach(item => {
        if (!item || !item.textLower) return;
        let lastIndex = -1;
        while ((lastIndex = item.textLower.indexOf(q, lastIndex + 1)) !== -1) {
            state.searchHits.push({ page: item.page, index: lastIndex });
        }
    });
    
    if (state.searchHits.length) {
        moveSearchCursor(0);
        console.log(`Found ${state.searchHits.length} results for "${q}"`);
    } else {
        alert('검색 결과가 없습니다');
        console.log(`No results for "${q}"`);
    }
}

export function moveSearchCursor(dir) {
    if (!state.searchHits.length) return;
    
    if (dir === 0) state.setSearchCursor(0);
    else state.setSearchCursor((state.searchCursor + dir + state.searchHits.length) % state.searchHits.length);

    const hit = state.searchHits[state.searchCursor];
    scrollToPage(hit.page);

    console.log(`Navigating to search result ${state.searchCursor + 1}/${state.searchHits.length} on page ${hit.page}`);
    const wrap = document.querySelector(`.page-wrap[data-page="${hit.page}"]`);
    if (!wrap) return;
    
    wrap.style.outline = `3px solid red`;
    setTimeout(() => wrap.style.outline = 'none', 1500);
    
    // TODO: More precise highlighting of the search term
}