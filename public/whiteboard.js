document.addEventListener("DOMContentLoaded", () => {
    
    // =========================================
    // [1] 공통 변수 및 초기화
    // =========================================
    let pageTitles = { 1: "자유 복습 노트" }; // 페이지별 제목 저장
    const BASE_BOOK_ID = "test-book-1";
    let currentPage = 1;

    // --- 서버 주소 설정 ---
    const GRADE_API_URL = "https://gradeblankpaper-kbtdkj4qza-du.a.run.app"; 
    const SAVE_API_URL = "https://savewhiteboard-kbtdkj4qza-du.a.run.app"; 
    const LOAD_API_URL = "https://loadwhiteboard-kbtdkj4qza-du.a.run.app";

    // --- 요소 초기화 ---
    const canvasContainer = document.getElementById('canvas-container');
    const textContainer = document.getElementById('text-editor-container');
    const canvas = document.getElementById('drawingCanvas');
    // willReadFrequently: 캔버스 성능 최적화 옵션
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const btnModeSwitch = document.getElementById('btn-mode-switch');
    const drawingTools = document.getElementById('drawing-tools');

    let inputMode = 'drawing'; 
    let isDrawing = false; 
    let currentTool = 'pen';
    let currentChallengeQuestion = null;


    // =========================================
    // [2] 유틸리티 함수들 (모달, 이미지 처리 등)
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

    // AI 전송용 (배경을 흰색으로 합쳐서 추출)
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
    // [3] 캔버스 및 그리기 로직
    // =========================================
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

    function startDraw(e) { if(inputMode !== 'drawing') return; isDrawing = true; draw(e); }
    function endDraw() { isDrawing = false; ctx.beginPath(); }
    function draw(e) {
        if(!isDrawing) return;
        const rect = canvas.getBoundingClientRect();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        const x = clientX - rect.left;
        const y = clientY - rect.top;
        ctx.lineTo(x, y); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x, y);
        e.preventDefault();
    }

    // 캔버스 이벤트 연결
    canvas.addEventListener('mousedown', startDraw); 
    canvas.addEventListener('mousemove', draw);
    canvas.addEventListener('mouseup', endDraw); 
    canvas.addEventListener('mouseleave', endDraw);
    canvas.addEventListener('touchstart', startDraw, {passive: false}); 
    canvas.addEventListener('touchmove', draw, {passive: false});
    canvas.addEventListener('touchend', endDraw);

    // 툴바 버튼 이벤트
    document.getElementById('btn-pen').onclick = () => { currentTool='pen'; updateToolStyle(); };
    document.getElementById('btn-eraser').onclick = () => { currentTool='eraser'; updateToolStyle(); };
    document.getElementById('btn-clear').onclick = () => ctx.clearRect(0,0,canvas.width, canvas.height);
    document.getElementById('colorPicker').onchange = () => { currentTool='pen'; updateToolStyle(); };
    document.getElementById('btn-back').addEventListener('click', goBack);


    // =========================================
    // [4] 심화 질문 UI 로직
    // =========================================
    const challengeArea = document.getElementById('challenge-area');
    const challengeTextEl = document.getElementById('challenge-text');
    const btnChallengeClose = document.getElementById('btn-challenge-close');
    const btnOpenChallenge = document.getElementById('btn-open-challenge'); 

    function setChallengeMode(question) {
        currentChallengeQuestion = question;
        challengeTextEl.textContent = question;
        challengeArea.style.display = 'block';
        if(btnOpenChallenge) btnOpenChallenge.style.display = 'none';
        
        const submitBtn = document.getElementById('btn-submit');
        submitBtn.textContent = '💬 답변 제출';
        submitBtn.classList.add('btn-answer');
    }

    function closeChallenge() {
        challengeArea.style.display = 'none';
        if (currentChallengeQuestion) {
            if(btnOpenChallenge) btnOpenChallenge.style.display = 'block';
        }
    }

    if(btnOpenChallenge) {
        btnOpenChallenge.addEventListener('click', () => {
            challengeArea.style.display = 'block';
            btnOpenChallenge.style.display = 'none';
        });
    }
    btnChallengeClose.addEventListener('click', closeChallenge);


    // =========================================
    // [5] 서버 통신 기능 (채점, 힌트, 저장, 로드)
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

    // 3. 데이터 저장 (자동저장 지원)
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

    // 4. 데이터 불러오기 (이미지 명찰 오류 해결)
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

            if (!res.ok) {
                // 데이터 없음 = 새 페이지
                return;
            }

            const data = await res.json();

            if (data.text) document.getElementById('typingArea').value = data.text;
            
            if (data.imageData) {
                const img = new Image();
                let imageSrc = data.imageData;
                // 명찰 없으면 붙여주기
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

    // 5. 페이지 변경 (다음 장 제목 자동설정)
    async function changePage(offset) {
        const newPage = currentPage + offset;
        if (newPage < 1) {
            showCustomModal("알림", "첫 페이지입니다.");
            return;
        }

        // 현재 페이지 저장
        await saveTempData(true); 

        // 심화 질문 제목으로 넘기기
        if (offset > 0 && currentChallengeQuestion) {
            if (!pageTitles[newPage]) {
                pageTitles[newPage] = "Q. " + currentChallengeQuestion;
            }
            currentChallengeQuestion = null; 
            challengeArea.style.display = 'none';
            if(btnOpenChallenge) btnOpenChallenge.style.display = 'none';
        }

        // 페이지 이동
        currentPage = newPage;
        
        const titleEl = document.getElementById('current-page-topic');
        if(titleEl) {
            titleEl.textContent = pageTitles[currentPage] || "자유 복습 노트";
        }
        document.getElementById('page-indicator').textContent = `${currentPage} p`;

        await loadTempData();
    }


    // =========================================
    // [6] PDF 내보내기 (로딩화면 무시)
    // =========================================
    async function exportToPDF() {
        const loading = document.getElementById('loading');
        const originalPage = currentPage; 
        
        try {
            // 1. PDF 설정 (가로 방향)
            const { jsPDF } = window.jspdf;
            const pdf = new jsPDF('l', 'mm', 'a4'); 
            const pdfWidth = pdf.internal.pageSize.getWidth();
            const pdfHeight = pdf.internal.pageSize.getHeight();

            // 2. UI 정리 (툴바 등 숨기기)
            const toolbar = document.querySelector('.toolbar');
            const panel = document.getElementById('session-questions-panel');
            const openBtn = document.getElementById('btn-open-panel');
            
            toolbar.style.display = 'none';
            if(panel) panel.style.display = 'none';
            if(openBtn) openBtn.style.display = 'none';

            let iterPage = 1;
            let hasData = true;

            while (hasData) {
                loading.style.display = 'flex';
                loading.querySelector('span').textContent = `${iterPage}페이지 굽는 중... 🍳`;

                // (1) 데이터 불러오기
                const pageId = `${BASE_BOOK_ID}_page_${iterPage}`;
                const res = await fetch(LOAD_API_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ bookId: pageId })
                });

                if (!res.ok) { hasData = false; break; }
                const data = await res.json();
                if (!data.text && !data.imageData) { hasData = false; break; }

                // (2) 화면 그리기
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

                // (3) ⭐️ 핵심 수정: 캡처 영역을 'capture-area'로 한정!
                const targetElement = document.getElementById('capture-area');
                
                const canvasElement = await html2canvas(targetElement, {
                    scale: 2, 
                    useCORS: true,
                    backgroundColor: '#ffffff', // 배경 흰색
                    logging: false,
                    // 로딩창만 무시하면 됨 (툴바는 위에서 display:none 함)
                    ignoreElements: (el) => el.id === 'loading' || el.id === 'resultModal'
                });

                const imgData = canvasElement.toDataURL('image/jpeg', 0.95);

                if (iterPage > 1) pdf.addPage(); 

                // (4) 이미지 비율 맞춰 꽉 채우기
                const imgProps = pdf.getImageProperties(imgData);
                const ratio = imgProps.width / imgProps.height;
                const windowRatio = pdfWidth / pdfHeight;

                let renderWidth, renderHeight;
                if (ratio > windowRatio) {
                    renderWidth = pdfWidth;
                    renderHeight = pdfWidth / ratio;
                } else { 
                    renderHeight = pdfHeight;
                    renderWidth = pdfHeight * ratio;
                }

                const x = (pdfWidth - renderWidth) / 2;
                const y = (pdfHeight - renderHeight) / 2;

                pdf.addImage(imgData, 'JPEG', x, y, renderWidth, renderHeight);

                iterPage++;
            }

            if (iterPage > 1) {
                pdf.save(`MyBook_Full_Note.pdf`);
                showCustomModal("✅ 변환 완료", `총 ${iterPage - 1}페이지가 저장되었습니다!`);
            } else {
                showCustomModal("알림", "저장할 내용이 없습니다.");
            }

        } catch (e) {
            console.error(e);
            showCustomModal("❌ 실패", e.message);
        } finally {
            // 복구
            currentPage = originalPage;
            const toolbar = document.querySelector('.toolbar');
            const openBtn = document.getElementById('btn-open-panel');
            const panel = document.getElementById('session-questions-panel'); // 패널도 복구

            toolbar.style.display = 'flex';
            if(panel) panel.style.display = 'flex'; // 원래대로 복구
            if(openBtn) openBtn.style.display = 'block'; // 버튼 상태에 따라 조정 필요
            
            const titleEl = document.getElementById('current-page-topic');
            if(titleEl) titleEl.textContent = pageTitles[currentPage] || "자유 복습 노트";

            await loadTempData(); 
            loading.style.display = 'none';
            loading.querySelector('span').textContent = "AI 선생님이 채점 중입니다... 🤖";
        }
    }

    // =========================================
    // [7] 이벤트 리스너 연결 (여기가 핵심!)
    // =========================================
    
    // 저장/로드/모달 버튼
    document.getElementById('btn-save-temp').addEventListener('click', () => saveTempData(false));
    document.getElementById('btn-load-temp').addEventListener('click', loadTempData);
    document.getElementById('btn-modal-close').addEventListener('click', closeCustomModal);
    
    // 채점/힌트 버튼
    document.getElementById('btn-submit').addEventListener('click', submitReview);
    document.getElementById('btn-hint').addEventListener('click', requestHint);

    // 페이지 버튼
    const prevBtn = document.getElementById('btn-prev-page');
    const nextBtn = document.getElementById('btn-next-page');
    if(prevBtn && nextBtn) {
        prevBtn.addEventListener('click', () => changePage(-1));
        nextBtn.addEventListener('click', () => changePage(1));
    }

    // [중요] PDF 버튼 연결 확인!
    const pdfBtn = document.getElementById('btn-export-pdf');
    if(pdfBtn) {
        pdfBtn.addEventListener('click', exportToPDF);
        console.log("PDF 버튼 연결됨!");
    } else {
        console.error("PDF 버튼이 HTML에 없습니다!");
    }

    // 패널 열고 닫기
    const panelOpenBtn = document.getElementById('btn-open-panel');
    const panelCloseBtn = document.getElementById('btn-close-panel');
    const panel = document.getElementById('session-questions-panel');
    const contentArea = document.querySelector('.content-area');

    if(panelCloseBtn) {
        panelCloseBtn.addEventListener('click', () => {
            panel.style.display = 'none';
            panelOpenBtn.style.display = 'block'; 
            contentArea.style.width = 'calc(100% - 24px)';
            resizeCanvas();
        });
    }
    if(panelOpenBtn) {
        panelOpenBtn.addEventListener('click', () => {
            panel.style.display = 'flex';
            panelOpenBtn.style.display = 'none'; 
            if (window.innerWidth > 1000) {
                contentArea.style.width = 'calc(100% - 24px - 380px)';
            }
            resizeCanvas();
        });
    }

    // 초기 로딩
    loadTempData();

}); // DOMContentLoaded 닫기