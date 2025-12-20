document.addEventListener("DOMContentLoaded", () => {
    
    // =========================================
    // [1] 공통 변수 및 초기화
    // =========================================
    let pageTitles = { 1: "자유 복습 노트" }; 

    const urlParams = new URLSearchParams(window.location.search);
    const BASE_BOOK_ID = urlParams.get('bookId') || "unknown-book";
    console.log("현재 백지 모드 ID:", BASE_BOOK_ID);

    let currentPage = 1;

    // --- 서버 주소 설정 ---
    const GRADE_API_URL = "https://gradeblankpaper-kbtdkj4qza-du.a.run.app"; 
    const SAVE_API_URL = "https://savewhiteboard-kbtdkj4qza-du.a.run.app"; 
    const LOAD_API_URL = "https://loadwhiteboard-kbtdkj4qza-du.a.run.app";

    // --- 요소 초기화 ---
    const canvasContainer = document.getElementById('canvas-container');
    const textContainer = document.getElementById('text-editor-container');
    const canvas = document.getElementById('drawingCanvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    
    const btnModeSwitch = document.getElementById('btn-mode-switch');
    const drawingTools = document.getElementById('drawing-tools');
    
    // 심화 질문 영역 요소
    const challengeArea = document.getElementById('challenge-area');
    const challengeText = document.getElementById('challenge-text');
    const btnCloseChallenge = document.getElementById('btn-challenge-close');

    let inputMode = 'drawing'; 
    let isDrawing = false; 
    let currentTool = 'pen';
    let currentChallengeQuestion = null;


    // =========================================
    // [2] 유틸리티 함수들
    // =========================================
    function showCustomModal(title, text) {
        const modal = document.getElementById('resultModal');
        if (!modal) { alert(title + "\n\n" + text); return; }
        document.getElementById('modalTitle').textContent = title;
        document.getElementById('modalBody').textContent = text;
        modal.style.display = 'flex';
    }

    function closeCustomModal() {
        const modal = document.getElementById('resultModal');
        if (modal) modal.style.display = 'none';
    }

    function getCanvasDataURLWithWhiteBackground() {
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = canvas.width;
        tempCanvas.height = canvas.height;
        const tCtx = tempCanvas.getContext('2d');
        tCtx.fillStyle = '#FFFFFF';
        tCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);
        tCtx.drawImage(canvas, 0, 0);
        return tempCanvas.toDataURL('image/png').split(',')[1];
    }

    function getCurrentPageId() {
        return `${BASE_BOOK_ID}_page_${currentPage}`;
    }

    function goBack() { window.history.back(); }


    // =========================================
    // [2.5] 심화 질문(Challenge) 모드 제어 (⭐️ 추가됨)
    // =========================================
    function setChallengeMode(question) {
        console.log("🔥 심화 질문 모드 진입:", question);
        currentChallengeQuestion = question;

        if (challengeArea && challengeText) {
            challengeText.textContent = question;
            challengeArea.style.display = 'flex'; // 패널 보이기
            challengeArea.classList.remove('hidden');
        } else {
            // HTML 요소가 없을 경우 알림으로 대체
            showCustomModal("🔥 심화 질문 도착", question + "\n\n(상단에 표시될 질문입니다)");
        }
    }

    function closeChallenge() {
        console.log("심화 질문 모드 종료");
        currentChallengeQuestion = null;
        
        if (challengeArea) {
            challengeArea.style.display = 'none';
            challengeArea.classList.add('hidden');
        }
    }


    // =========================================
    // [3] 캔버스 및 그리기 로직 (Pointer Event)
    // =========================================
    // 1. CSS 설정 (필수: 스크롤/확대 방지)
    canvas.style.touchAction = 'none'; 

    btnModeSwitch.addEventListener('click', () => {
        if (inputMode === 'drawing') {
            inputMode = 'text';
            btnModeSwitch.textContent = '🎨 그리기 모드';
            canvasContainer.style.display = 'none';
            textContainer.style.display = 'block';
            drawingTools.style.display = 'none';
        } else {
            inputMode = 'drawing';
            btnModeSwitch.textContent = '⌨️ 타이핑 모드';
            canvasContainer.style.display = 'block';
            textContainer.style.display = 'none';
            drawingTools.style.display = 'flex';
            resizeCanvas();
        }
    });

    function resizeCanvas() {
        if(canvasContainer.clientWidth === 0) return;
        const temp = ctx.getImageData(0,0,canvas.width, canvas.height);
        canvas.width = canvasContainer.clientWidth;
        canvas.height = canvasContainer.clientHeight;
        try { ctx.putImageData(temp, 0, 0); } catch(e){} 
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round'; 
        updateToolStyle();
    }
    window.addEventListener('resize', resizeCanvas);
    setTimeout(resizeCanvas, 100);

    function updateToolStyle() {
        ctx.strokeStyle = document.getElementById('colorPicker').value;
        if(currentTool === 'eraser') { 
            ctx.lineWidth = 20; 
            ctx.globalCompositeOperation = 'destination-out'; 
        } else { 
            ctx.lineWidth = 2; 
            ctx.globalCompositeOperation = 'source-over'; 
        }
    }

    // ⭐️ Pointer Event 사용 (마우스/펜/터치 통합)
    function startDraw(e) {
        if(inputMode !== 'drawing') return;
        if (e.button !== 0 && e.buttons !== 1) return;
        
        e.preventDefault(); 
        isDrawing = true;
        
        ctx.beginPath();
        const { x, y } = getPoint(e);
        ctx.moveTo(x, y);
        ctx.lineTo(x, y);
        ctx.stroke();
    }

    function draw(e) {
        if(!isDrawing) return;
        if(e.buttons !== 1) { endDraw(); return; } 
        
        e.preventDefault();
        const { x, y } = getPoint(e);
        ctx.lineTo(x, y);
        ctx.stroke();
    }

    function endDraw() {
        if (!isDrawing) return;
        isDrawing = false;
        ctx.closePath();
    }

    function getPoint(e) {
        const rect = canvas.getBoundingClientRect();
        return {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top
        };
    }

    // 캔버스 이벤트 연결
    canvas.addEventListener('pointerdown', startDraw); 
    canvas.addEventListener('pointermove', draw);
    canvas.addEventListener('pointerup', endDraw); 
    canvas.addEventListener('pointercancel', endDraw); 
    canvas.addEventListener('pointerout', endDraw);

    // 툴바 버튼 이벤트 연결
    document.getElementById('btn-pen').onclick = () => { currentTool='pen'; updateToolStyle(); };
    document.getElementById('btn-eraser').onclick = () => { currentTool='eraser'; updateToolStyle(); };
    document.getElementById('btn-clear').onclick = () => ctx.clearRect(0,0,canvas.width, canvas.height);
    document.getElementById('colorPicker').onchange = () => { currentTool='pen'; updateToolStyle(); };
    document.getElementById('btn-back').addEventListener('click', goBack);


    // =========================================
    // [5] 서버 통신 기능
    // =========================================

    // 1. 채점 요청
    async function submitReview() {
        const loading = document.getElementById('loading');
        try {
            loading.style.display = 'flex';
            
            const payload = {
                bookId: null, 
                targetQuestion: currentChallengeQuestion
            };

            if (inputMode === 'drawing') {
                payload.imageData = getCanvasDataURLWithWhiteBackground();
            } else {
                const textVal = document.getElementById('typingArea').value.trim();
                if (textVal.length < 2) throw new Error("내용을 입력해주세요!");
                payload.userTextDirect = textVal;
            }

            const res = await fetch(GRADE_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            
            const result = await res.json();
            if (!res.ok || result.error) throw new Error(result.error || `HTTP ${res.status}`);
            
            if (currentChallengeQuestion) {
                    showCustomModal("🤖 튜터 피드백", result.feedback || '(피드백 없음)');
                    if (result.next_question) setChallengeMode(result.next_question);
                    else closeChallenge();
            } else {
                    let msg = `📋 [학습 피드백]\n\n${result.feedback || ''}\n`;
                    if (result.good_points) msg += `\n✅ [잘한 점]\n${result.good_points}\n`;
                    if (result.weak_points) msg += `\n⚠️ [보완할 점]\n${result.weak_points}\n`;
                    if (result.challenge_question) {
                        setChallengeMode(result.challenge_question);
                        msg += "\n🔥 [알림] 심화 질문이 도착했습니다! 상단을 확인하세요.";
                    }
                    showCustomModal("📝 분석 완료", msg);
            }
        } catch (err) {
            showCustomModal("오류 발생", err.message);
        } finally {
            loading.style.display = 'none';
        }
    }

    // 2. 힌트 요청
    async function requestHint() {
        const loading = document.getElementById('loading');
        try {
            loading.style.display = 'flex';
            const payload = { bookId: null, isHint: true };

            if (inputMode === 'drawing') {
                payload.imageData = getCanvasDataURLWithWhiteBackground();
            } else {
                const textVal = document.getElementById('typingArea').value.trim();
                if (!textVal) throw new Error("내용이 없습니다.");
                payload.userTextDirect = textVal;
            }

            const res = await fetch(GRADE_API_URL, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const result = await res.json();
            if(!res.ok) throw new Error(result.error);
            
            showCustomModal("💡 AI 힌트", result.feedback);
        } catch(err) {
            showCustomModal("오류", err.message);
        } finally {
            loading.style.display = 'none';
        }
    }

    // 3. 데이터 저장
    async function saveTempData(isSilent = false) {
        const loading = document.getElementById('loading');
        try {
            if(!isSilent) {
                loading.style.display = 'flex';
                loading.querySelector('span').textContent = "서버에 저장 중... 💾";
            }
            
            const payload = {
                bookId: getCurrentPageId(),
                text: document.getElementById('typingArea').value,
                imageData: canvas.toDataURL() 
            };

            const res = await fetch(SAVE_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!res.ok) throw new Error("서버 응답 오류");

            if(!isSilent) showCustomModal("✅ 저장 완료", `${currentPage}페이지가 저장되었습니다!`);

        } catch (e) {
            if(!isSilent) showCustomModal("❌ 저장 실패", e.message);
        } finally {
            if(!isSilent) {
                loading.style.display = 'none';
                loading.querySelector('span').textContent = "AI 선생님이 채점 중입니다... 🤖";
            }
        }
    }

    // 4. 데이터 불러오기
    async function loadTempData() {
        console.log("Loading Page:", currentPage);
        const loading = document.getElementById('loading');
        
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        document.getElementById('typingArea').value = "";

        try {
            loading.style.display = 'flex';
            loading.querySelector('span').textContent = `${currentPage}페이지 불러오는 중... 📂`;

            const res = await fetch(LOAD_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ bookId: getCurrentPageId() })
            });

            if (!res.ok) return;

            const data = await res.json();

            if (data.text) document.getElementById('typingArea').value = data.text;
            
            if (data.imageData) {
                const img = new Image();
                let imageSrc = data.imageData;
                if (!imageSrc.startsWith('data:image')) {
                    imageSrc = 'data:image/png;base64,' + imageSrc;
                }
                img.onload = function() {
                    ctx.clearRect(0, 0, canvas.width, canvas.height);
                    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                };
                img.src = imageSrc;
            }

        } catch (e) {
            console.error(e);
        } finally {
            loading.style.display = 'none';
            loading.querySelector('span').textContent = "AI 선생님이 채점 중입니다... 🤖";
        }
    }

    // 5. 페이지 변경
    async function changePage(offset) {
        const newPage = currentPage + offset;
        if (newPage < 1) {
            showCustomModal("알림", "첫 페이지입니다.");
            return;
        }

        await saveTempData(true); 

        // 페이지 이동 시 심화 질문 초기화
        if (offset > 0 && currentChallengeQuestion) {
            if (!pageTitles[newPage]) {
                pageTitles[newPage] = "Q. " + currentChallengeQuestion;
            }
            closeChallenge(); // ⭐️ [수정] 함수 호출로 변경
        }

        currentPage = newPage;
        
        const titleEl = document.getElementById('current-page-topic');
        if(titleEl) {
            titleEl.textContent = pageTitles[currentPage] || "자유 복습 노트";
        }
        document.getElementById('page-indicator').textContent = `${currentPage} p`;

        await loadTempData();
    }


    // =========================================
    // [6] PDF 내보내기 (Full Width & UI 숨김)
    // =========================================
    async function exportToPDF() {
        const loading = document.getElementById('loading');
        const originalPage = currentPage; 
        
        try {
            const { jsPDF } = window.jspdf;
            const pdf = new jsPDF('l', 'mm', 'a4'); 
            const pdfWidth = pdf.internal.pageSize.getWidth();
            const pdfHeight = pdf.internal.pageSize.getHeight();

            // UI 숨기기
            const toolbar = document.querySelector('.toolbar');
            const guidePanel = document.getElementById('guideline-panel');
            const openBtn = document.getElementById('btn-open-panel');
            
            toolbar.style.display = 'none';
            if(guidePanel) guidePanel.style.display = 'none';
            if(openBtn) openBtn.style.display = 'none';
            
            // ⭐️ 심화 질문바도 숨겨야 깔끔함
            if(challengeArea) challengeArea.style.display = 'none';

            let iterPage = 1;
            let hasData = true;

            while (hasData) {
                loading.style.display = 'flex';
                loading.querySelector('span').textContent = `${iterPage}페이지 굽는 중... 🍳`;

                const pageId = `${BASE_BOOK_ID}_page_${iterPage}`;
                const res = await fetch(LOAD_API_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ bookId: pageId })
                });

                if (!res.ok) { hasData = false; break; }
                const data = await res.json();
                if (!data.text && !data.imageData) { hasData = false; break; }

                // 캔버스/텍스트 복원
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                document.getElementById('typingArea').value = data.text || "";
                
                const titleEl = document.getElementById('current-page-topic');
                if(titleEl) titleEl.textContent = pageTitles[iterPage] || `복습 노트 (${iterPage}페이지)`;

                if (data.imageData) {
                    await new Promise((resolve) => {
                        const img = new Image();
                        let src = data.imageData;
                        if (!src.startsWith('data:image')) src = 'data:image/png;base64,' + src;
                        img.onload = () => {
                            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                            resolve();
                        };
                        img.src = src;
                    });
                }

                // 캡처 (고해상도)
                const targetElement = document.getElementById('capture-area');
                const canvasElement = await html2canvas(targetElement, {
                    scale: 2, 
                    useCORS: true,
                    backgroundColor: '#ffffff',
                    logging: false,
                    ignoreElements: (el) => el.id === 'loading' || el.id === 'resultModal'
                });

                const imgData = canvasElement.toDataURL('image/jpeg', 0.95);

                if (iterPage > 1) pdf.addPage(); 

                // A4 꽉 채우기 계산 로직
                const imgProps = pdf.getImageProperties(imgData);
                const imgRatio = imgProps.width / imgProps.height;
                const pdfRatio = pdfWidth / pdfHeight;

                let renderWidth, renderHeight, offsetX, offsetY;

                if (imgRatio > pdfRatio) {
                    renderWidth = pdfWidth;
                    renderHeight = pdfWidth / imgRatio;
                    offsetX = 0;
                    offsetY = (pdfHeight - renderHeight) / 2; 
                } else {
                    renderHeight = pdfHeight;
                    renderWidth = pdfHeight * imgRatio;
                    offsetX = (pdfWidth - renderWidth) / 2; 
                    offsetY = 0;
                }

                pdf.addImage(imgData, 'JPEG', offsetX, offsetY, renderWidth, renderHeight);
                iterPage++;
            }

            if (iterPage > 1) {
                pdf.save(`MyBook_Full_Note.pdf`);
                showCustomModal(
                    "✅ 저장 완료", 
                    `총 ${iterPage - 1}페이지가 PDF로 변환되었습니다.\n\n(태블릿의 '파일' 앱이나 '다운로드' 폴더를 확인해주세요!)`
                );
            } else {
                showCustomModal("알림", "저장할 내용이 없습니다.");
            }

        } catch (e) {
            console.error(e);
            showCustomModal("❌ 실패", e.message);
        } finally {
            // UI 복구
            currentPage = originalPage;
            const toolbar = document.querySelector('.toolbar');
            const openBtn = document.getElementById('btn-open-panel');
            const guidePanel = document.getElementById('guideline-panel');

            toolbar.style.display = 'flex';
            if(guidePanel) guidePanel.style.display = 'flex';
            if(openBtn) openBtn.style.display = 'block';
            
            // 심화 질문 상태 복구
            if(currentChallengeQuestion && challengeArea) {
                challengeArea.style.display = 'flex';
            }
            
            const titleEl = document.getElementById('current-page-topic');
            if(titleEl) titleEl.textContent = pageTitles[currentPage] || "자유 복습 노트";

            await loadTempData(); 
            loading.style.display = 'none';
            loading.querySelector('span').textContent = "AI 선생님이 채점 중입니다... 🤖";
        }
    }


    // =========================================
    // [7] 이벤트 리스너 연결
    // =========================================
    
    document.getElementById('btn-save-temp').addEventListener('click', () => saveTempData(false));
    document.getElementById('btn-load-temp').addEventListener('click', loadTempData);
    document.getElementById('btn-modal-close').addEventListener('click', closeCustomModal);
    
    document.getElementById('btn-submit').addEventListener('click', submitReview);
    document.getElementById('btn-hint').addEventListener('click', requestHint);

    const prevBtn = document.getElementById('btn-prev-page');
    const nextBtn = document.getElementById('btn-next-page');
    if(prevBtn && nextBtn) {
        prevBtn.addEventListener('click', () => changePage(-1));
        nextBtn.addEventListener('click', () => changePage(1));
    }

    const pdfBtn = document.getElementById('btn-export-pdf');
    if(pdfBtn) {
        pdfBtn.addEventListener('click', exportToPDF);
    }
    
    if(btnCloseChallenge) {
        btnCloseChallenge.addEventListener('click', closeChallenge);
    }

    // 초기 로딩
    loadTempData();

});