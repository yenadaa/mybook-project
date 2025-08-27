// ✨ Firebase SDK 모듈 가져오기
import { getFirestore, collection, addDoc } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js";

// ✨ Firebase 설정 (app.js에서 가져옴)
const firebaseConfig = {
    apiKey: "AIzaSyAQOIZxfDMyjDmKjUHhRbqT0uUbYHF-vs8", // ⬅️ 본인의 Firebase API 키로 변경하세요.
    authDomain: "mybook-95e20.firebaseapp.com",
    projectId: "mybook-95e20",
    storageBucket: "mybook-95e20.appspot.com",
    messagingSenderId: "271137722486",
    appId: "1:271137722486:web:dd3aeaffe60cfae65bcf57"
};

// ✨ Firebase 앱 초기화
const app = window.initializeApp(firebaseConfig);
const db = getFirestore(app);


// (기존 main.js 코드 시작)
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
                clearInterval(checkLoad);
                setTimeout(()=> {
                    loadData();
                    setTimeout(() => {
                        const allTab = document.querySelector('.tab[data-tag="all"]');
                        if (allTab) {
                            allTab.classList.add("active");
                            currentFilter = "all";
                            noteView("all");
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
// ✨ 수정된 정리 뷰 함수 (기능 분석 버튼 추가)
function noteView(filterTag = null) {
    const noteWrap = document.querySelector(".note-wrap");
    if (!noteWrap) return;

    const notes = getDataList(filterTag);

    noteWrap.innerHTML = ""; // 기존 항목 모두 삭제

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

        // ✨ 기능 분석 버튼들을 담을 컨테이너
        const buttonContainer = document.createElement("div");
        buttonContainer.classList.add("note-buttons");

        // ✨ 학습 분석 버튼 생성
        const actions = [
            { id: 'summary', name: '요약' },
            { id: 'mindmap', name: '맵' },
            { id: 'chain-thought', name: '질문' },
            { id: 'compare', name: '비교' }
        ];

        actions.forEach(action => {
            const btn = document.createElement("button");
            btn.textContent = action.name;
            btn.addEventListener("click", async (e) => {
                const targetButton = e.target;
                targetButton.textContent = '분석중...';
                targetButton.disabled = true;
                
                // API 호출
                const result = await processText(note.text, action.id);
                alert(result); // 결과를 alert로 표시

                targetButton.textContent = action.name;
                targetButton.disabled = false;
            });
            buttonContainer.appendChild(btn);
        });
        
        // (기존 삭제 버튼 코드)
        const deleteBtn = document.createElement("button");
        deleteBtn.classList.add("delete-btn");
        deleteBtn.innerHTML = `...`; // SVG 코드 생략
        deleteBtn.addEventListener("click", () => {
            // (삭제 로직)
        });
        
        noteItem.appendChild(noteText);
        noteItem.appendChild(buttonContainer); // 버튼 컨테이너 추가
        noteItem.appendChild(deleteBtn);
        noteWrap.appendChild(noteItem);
    });
}


// ✨ app.js에서 가져온 API 요청 처리 함수
async function processText(inputText, type) {
    if (!inputText.trim()) {
        return "분석할 텍스트가 없습니다.";
    }

    const API_KEY = "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"; // ⬅️ 본인의 OpenAI API 키로 변경하세요.
    const API_ENDPOINT = "https://api.openai.com/v1/chat/completions";

    let userPrompt = "";
    if (type === "summary") {
        userPrompt = `다음 글을 핵심 포인트만 뽑아서 요약해줘: ${inputText}`;
    } else if (type === "mindmap") {
        userPrompt = `다음 글의 핵심 개념들을 중심으로 마인드맵을 구성하고, 각 개념 간의 관계를 설명해줘: ${inputText}`;
    } else if (type === "chain-thought") {
        userPrompt = `다음 글의 핵심 주제에 대해 꼬리 질문(Chain of Thought) 방식으로 심화 학습 질문 3개를 만들어줘: ${inputText}`;
    } else if (type === "compare") {
        userPrompt = `다음 글에 나오는 핵심 개념들을 비교하고 차이점을 표 형식으로 요약해줘: ${inputText}`;
    }

    try {
        const response = await fetch(API_ENDPOINT, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${API_KEY}`
            },
            body: JSON.stringify({
                model: "gpt-4o",
                messages: [{ role: "user", content: userPrompt }],
                temperature: 0.7
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error.message);
        }

        const data = await response.json();
        const result = data.choices[0]?.message?.content;

        if (result) {
            // ✨ Firebase에 결과 저장
            const analysisData = {
                input: inputText,
                type: type,
                result: result,
                createdAt: new Date()
            };
            await addDoc(collection(db, "analysis_results"), analysisData);
            return result;
        } else {
            return "요청에 실패했습니다. API 응답을 확인하세요.";
        }
    } catch (error) {
        console.error("API 요청 중 오류 발생:", error);
        return `오류가 발생했습니다: ${error.message}`;
    }
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
} //test