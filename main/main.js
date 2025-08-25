pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js";
let selectTag = null;
let isTag = false;
let isPenActive = false;
let isEraserActive = false;
let currentFilter = "all";
const FileInput = document.getElementById("file-btn");

document.getElementById("chalkboard").addEventListener("click", function() {
    FileInput.click();
});

FileInput.addEventListener("change", function(e) {
    const file = e.target.files[0];
    const reader = new FileReader();

    reader.onload = function() {
        const base64Data = reader.result;
        localStorage.setItem("uploadedPDF", base64Data);

        document.getElementById("chalkboard").classList.add("hidden");
        document.getElementById("book-layout").classList.remove("hidden");

        renderPDF(base64Data);
    };
    reader.readAsDataURL(file);
});

window.addEventListener("DOMContentLoaded", () => {

    const savedPDF = localStorage.getItem("uploadedPDF");
    if (savedPDF) {
        document.getElementById("chalkboard").classList.add("hidden");
        document.getElementById("book-layout").classList.remove("hidden");
        renderPDF(savedPDF);

        const checkLoad = setInterval(() => {
            const spans = document.querySelectorAll(".textLayer span");
            if (spans.length > 0) {
                console.log("pdf 렌더링 완료, span 개수:", spans.length);
                clearInterval(checkLoad);
                setTimeout(()=> {
                    loadData();

                    setTimeout(() => {
                        const allTab = document.querySelector('.tab[data-tag="all"]');
                        if (allTab) {
                            allTab.classList.add("active");
                            currentFilter = "all";
                            noteView("all");
                            
                            const noteItems = document.querySelectorAll(".note-item");
                            console.log("정리뷰 항목 개수:", noteItems.length);
                        }
                    }, 500);


                },100);
            }
        }, 100);
    }
});

const viewer = document.getElementById("pdf-container");

function renderPDF(dataUrl) {
    const pdfContainer = document.getElementById("pdf-container");
    pdfContainer.innerHTML = "";

    pdfjsLib.getDocument(dataUrl).promise.then((pdf) => {
        const totalPg = pdf.numPages;

        for (let i = 1; i <= totalPg; i++) {
            pdf.getPage(i).then((page) => {
                const wrap = document.createElement("div");
                wrap.classList.add("wrap");

                const pageDiv = document.createElement("div");
                pageDiv.classList.add("page");
                pageDiv.dataset.pageNumber = i;

                const width = page.view[2];
                const height = page.view[3];
                const ratio = width / height;
                let scale;
                if (ratio > 1.1) {
                    scale = 0.7;
                } else if (ratio < 0.9) {
                    scale = 1.2;
                } else {
                    scale = 1.3;
                }

                const viewport = page.getViewport({ scale });

                const canvas = document.createElement("canvas");
                const context = canvas.getContext("2d");

                const outputScale = window.devicePixelRatio || 1;
                canvas.width = viewport.width * outputScale;
                canvas.height = viewport.height * outputScale;
                canvas.style.width = `${viewport.width}px`;
                canvas.style.height = `${viewport.height}px`;
                context.scale(outputScale, outputScale);

                const textLayer = document.createElement("div");
                textLayer.classList.add("textLayer");
                textLayer.style.width = `${viewport.width}px`;
                textLayer.style.height = `${viewport.height}px`;
                textLayer.style.top = "0";
                textLayer.style.left = "0";
                textLayer.style.position = 'absolute';

                page.render({
                    canvasContext: context,
                    viewport: viewport
                }).promise.then(() => {
                    page.getTextContent().then(function(textContent) {
                        pdfjsLib.renderTextLayer({
                            textContent: textContent,
                            container: textLayer,
                            viewport: viewport,
                            textDivs: [],
                            enhanceTextSelection: true
                        }).promise.then(() => {
                            textLayer.querySelectorAll("span").forEach((span) => {
                                const width = span.getBoundingClientRect().width;
                                const height = span.getBoundingClientRect().height;

                                if (width < 2 || height < 2) {
                                    span.remove();
                                }
                            });
                        });
                    });
                });

                pageDiv.appendChild(canvas);
                pageDiv.appendChild(textLayer);
                wrap.appendChild(pageDiv);
                viewer.appendChild(wrap);
            });
        }
    });
}


const penBtn1 = document.getElementById("pen1");
const eraserBtn = document.getElementById("eraser-btn");

penBtn1.addEventListener("click", function () {
    isPenActive = !isPenActive;

    if (isPenActive) {
        isEraserActive = false;
        penBtn1.classList.add("active");
        eraserBtn.classList.remove("active");
    } else {
        penBtn1.classList.remove("active");
    }
});

eraserBtn.addEventListener("click", function () {
    isEraserActive = !isEraserActive;

    if (isEraserActive) {
        isPenActive = false;
        eraserBtn.classList.add("active");
        penBtn1.classList.remove("active");
    } else {
        eraserBtn.classList.remove("active");
    }
});

document.addEventListener("mouseup", function () {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;

    const range = selection.getRangeAt(0);
    const selectedText = range.toString().replace(/\s+/g, " ").trim();
    if (!selectedText) return;

    const normalize = (str) => str.replace(/\s+/g, " ").trim();

    let spansInRange = [];

    const allSpans = document.querySelectorAll(".textLayer span");
    spansInRange = Array.from(allSpans).filter(span => {
        const spanRange = document.createRange();
        spanRange.selectNodeContents(span);
        return range.compareBoundaryPoints(Range.END_TO_START, spanRange) < 0 &&
               range.compareBoundaryPoints(Range.START_TO_END, spanRange) > 0;
    });

    if(isPenActive && spansInRange.length === 1) {
        const span = spansInRange[0];
        
        if(
            range.startContainer === range.endContainer &&
            range.startContainer.nodeType === Node.TEXT_NODE &&
            span.contains(range.startContainer)
        ) {
            const wrap = document.createElement("span");
            wrap.classList.add("underlined");

            try {
                tange.surroundContents(wrap);
            } catch (e) {
                const textnode = range.startContainer;
                const start = range.startOffset;
                const end = range.endOffset;

                const mid = textnode.splitText(start);
                const tail = mid.splitText(end - start);

                const marked = document.createElement("span");
                marked.classList.add("underlined");
                marked.textContent = mid.nodeValue;
                mid.replaceWith(marked);
            }

            window.__lastNoteText = range.toString().replace(/\s+/g, " ").trim();
            window.__lastNotePage = span.closest(".page")?.dataset.pageNumber || "1";

            noteView(currentFilter);
            selection.removeAllRanges();
            setTimeout(() => saveData(), 100);
            return;
        }
    } 

    spansInRange = spansInRange.filter(span => {
        const text = normalize(span.textContent || "");
        return text && normalize(selectedText).includes(text);
    });

    if (isPenActive && spansInRange.length > 0) {
        spansInRange.forEach(span => span.classList.add("underlined"));

        window.__lastNoteText = selectedText;
        window.__lastNotePage = spansInRange[0]?.closest(".page")?.dataset.pageNumber || "1";

        noteView();
        selection.removeAllRanges();

        console.log("자동 저장 실행");
        setTimeout(()=>saveData(), 100);

        return;
    }

    if (isEraserActive && spansInRange.length > 0) {
        const underlinedSpans = spansInRange.filter(span => span.classList.contains("underlined"));

        if (underlinedSpans.length > 0) {
            underlinedSpans.forEach(span => {
                span.classList.remove("underlined");
                span.removeAttribute("data-tag");
                span.classList.remove("tag-중요", "tag-암기", "tag-참고");
            });

            noteView(currentFilter); //정리 뷰 업데이트

            console.log("지우개 사용 자동 저장");
            setTimeout(() => saveData(), 100);
        } 
        selection.removeAllRanges();
        return;
    }
});



function getDataList(filterTag = null) {
    const allSpans = document.querySelectorAll(".textLayer span.underlined");
    const groupedByPage = {};

    allSpans.forEach(span => {
        const tag = span.dataset.tag;
        if (filterTag && tag !== filterTag) return; // 태그 필터링

        const page = span.closest(".page")?.dataset.pageNumber || "1";
        if (!groupedByPage[page]) groupedByPage[page] = [];
        groupedByPage[page].push(span.textContent.trim());
    });

    const dataList = [];

    for (const page in groupedByPage) {
        const joined = groupedByPage[page].join(" ").replace(/\s+/g, " ").trim();
        if (joined) {
            dataList.push({ text: joined, page });
        }
    }

    return dataList;
}


//정리뷰함수
function noteView(filterTag = null) {
    const noteWrap = document.querySelector(".note-wrap");
    if (!noteWrap) return;

    const notes = getDataList(filterTag);

    const existingItem = noteWrap.querySelectorAll(".note-item");
    existingItem.forEach(item => item.remove());

    const added = new Set();

    notes.forEach((note) => {
        const key = `[p.${note.page}] ${note.text}`;
        if (added.has(key)) return;
        added.add(key);

        const noteItem = document.createElement("div");
        noteItem.classList.add("note-item");
        
        const noteText = document.createElement("span");
        noteText.textContent = key;
        noteText.style.cursor = "pointer";
        
        noteText.addEventListener("click", () => {
            const pageMoving = document.querySelector(`.page[data-page-number="${note.page}"]`);
            if (pageMoving) {
                pageMoving.scrollIntoView({ behavior: "smooth" });
            }
        });
        const deleteBtn = document.createElement("button");  // SVG X 버튼 생성
        deleteBtn.classList.add("delete-btn");

        deleteBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" height="16" viewBox="0 0 320.941 320.941" width="16">
        <path d="m290.853 40.118h-181.049c-9.06 0-17.551 4.016-23.301 11.038l-84.241 102.968c-3.017 3.692-3.017 9.001 0 12.693l84.251 102.978c5.739 7.013 14.231 11.028 23.291 11.028h181.048c16.592 0 30.088-13.497 30.088-30.088v-180.529c.001-16.592-13.496-30.088-30.087-30.088zm10.029 210.617c0 5.534-4.496 10.029-10.029 10.029h-181.049c-3.026 0-5.857-1.342-7.767-3.673l-79.05-96.621 79.04-96.611c1.92-2.341 4.75-3.683 7.777-3.683h181.048c5.534 0 10.029 4.496 10.029 10.029.001.001.001 180.53.001 180.53z"></path>
        <path d="m223.585 103.232-43.056 43.056-43.056-43.056-14.182 14.182 43.056 43.056-43.056 43.056 14.182 14.182 43.056-43.056 43.056 43.056 14.182-14.182-43.056-43.056 43.056-43.056z"></path>
        </svg>
        `

        deleteBtn.addEventListener("click", () => {
        const allSpans = document.querySelectorAll(`.page[data-page-number="${note.page}"] .textLayer span.underlined`);
        
        allSpans.forEach(span => {
            if (span.textContent && note.text.includes(span.textContent.trim())) {
              if (currentFilter === "all") {
                span.classList.remove("underlined");
                span.removeAttribute("data-tag");   
                span.className = "";
                } else {
                span.classList.remove("underlined");
                span.removeAttribute("data-tag");
                span.classList.remove(`tag-${currentFilter}`); // 태그 class도 제거
                }
              }
            });
            noteView(currentFilter); // 다시 렌더링

            console.log("정리뷰 항목 삭제");
            setTimeout(()=>saveData(), 100);
        });

        noteItem.appendChild(noteText);
        noteItem.appendChild(deleteBtn);
        noteWrap.appendChild(noteItem);
    });
}



document.querySelectorAll(".tab").forEach((tab)=>{ //탭 클릭 > active 클래스 부여 
    tab.addEventListener("click", ()=>{
        document.querySelectorAll(".tab").forEach((t)=>t.classList.remove("active"));

        tab.classList.add("active");

        const tag = tab.dataset.tag;
        currentFilter = tag;

        if(tag === "all"){
            noteView();
        } else {
            noteView(tag);
        }
    });
})

const tagBtn = document.getElementById("tag-btn");
const dropdown =document.getElementById("dropdown");

tagBtn.addEventListener("click", ()=> {
    dropdown.classList.toggle("show");
});

document.querySelectorAll("#dropdown button").forEach(button => {
    button.addEventListener("click", ()=> {
        selectTag = button.textContent.trim(); //공백 없이 태그그키워드 담음
        isTag = true;

        dropdown.classList.remove("show");
        tagBtn.classList.add("active");
    });
});

document.addEventListener("click", (e)=> {
    if (!isTag || !selectTag) return;

    if (isTag) {
        isPenActive = false;
        isEraserActive = false;
        penBtn1.classList.remove("active");
        eraserBtn.classList.remove("active");
    };

    const span = e.target;
    if(span.tagName !== "SPAN") return;
    if(!span.classList.contains("underlined")) return;

    const currentPage = span.closest(".page");
    const underlinedSpans = currentPage.querySelectorAll("span.underlined");

    underlinedSpans.forEach(s => {
        s.dataset.tag = selectTag;
        s.classList.add(`tag-${selectTag}`);
    });

    selectTag =null;
    isTag = false;

    tagBtn.classList.remove("active");

    console.log("태그 지정됨, 자동 저장")
    setTimeout(()=>saveData(), 100);
});


function saveData() {
    console.log("저장 함수 실행");

    const underlined =  document.querySelectorAll("span.underlined");
    console.log("밑줄 친 요소 개수:", underlined.length);

    if (underlined.length === 0) {
        console.log("저장할 밑줄이 없음");
        return;
    }

    const saveList = [];
    underlined.forEach((span, index) => {
        const pageElement = span.closest(".page");
        const rect = span.getBoundingClientRect();
        const pageRect = pageElement.getBoundingClientRect();

        const textnode = [...span.childNodes].find(n => n.nodeType === Node.TEXT_NODE);

        const data = {
            text: span.textContent,
            tag: span.dataset.tag,
            page: pageElement.dataset.pageNumber,
            offset: textnode ? textnode.nodeValue.indexOf(span.textContent) : 0,
            position: { //위치정보추가(페이지 기준 상대 좌표)
                left: Math.round(rect.left - pageRect.left),
                top: Math.round(rect.top - pageRect.top),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
            },
            id: `highlight_${Date.now()}_${index}` // 고유 id
        };
        console.log("저장할 항목:", data);
        saveList.push(data);
    });

    console.log("최종 저장 데이터:", saveList);
    localStorage.setItem("mybook_data", JSON.stringify(saveList));

}

function loadData() {
    console.log("불러오기 함수 실행");
    
    const savedData = localStorage.getItem("mybook_data");
    
    if (!savedData) return;

    const dataList = JSON.parse(savedData);
    
    // 기존 밑줄 제거
    document.querySelectorAll("span.underlined").forEach(span => {
        span.classList.remove("underlined");
        span.removeAttribute("data-tag");
        span.classList.remove("tag-중요", "tag-암기", "tag-참고");
    });
    
    // 밑줄 다시 적용
    dataList.forEach(item => {
        const page = document.querySelector(`.page[data-page-number="${item.page}"]`);
        if (!page) return;

        const spans = page.querySelectorAll(".textLayer span");
        spans.forEach(span => {
            const textnode = [...span.childNodes].find(n => n.nodeType === Node.TEXT_NODE);
            if (!textnode) return;

            const idx = textnode.nodeValue.indexOf(item.text);
            if (idx === -1) return;  // 텍스트 못 찾으면 패스

            const rect = span.getBoundingClientRect();
            const pageRect = page.getBoundingClientRect();
            const spanPos = {
                left: Math.round(rect.left - pageRect.left),
                top: Math.round(rect.top - pageRect.top),
                right: Math.round(rect.right - pageRect.left)
            };
            const withinX = item.position.left >= spanPos.left - 4 && item.position.left <= spanPos.right + 4;
            const withinY = Math.abs(item.position.top - spanPos.top) <= 10;
            if(!withinX || !withinY) return;
                

            const mid = textnode.splitText(idx);
            const tail = mid.splitText(item.text.length);

            const marked = document.createElement("span");
            marked.className = "underlined";
            marked.textContent = mid.nodeValue;
            if(item.tag) {
                marked.dataset.tag = item.tag;
                marked.classList.add(`tag-${item.tag}`);
            }
            mid.replaceWith(marked);
        });
    });
    // 정리본 자동 출력
    currentFilter = "all";
    noteView("all");

    // 탭 UI도 "all" 활성화
    const allTab = document.querySelector('.tab[data-tag="all"]');
    if (allTab) {
        document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
        allTab.classList.add("active");
    } 
    console.log("불러오기 완료!");
}