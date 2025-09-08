    pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js";

    let selectTag = null;
    let isTag = false;
    let isPenActive = false;
    let isEraserActive = false;
    let currentFilter = "all";
    const FileInput = document.getElementById("file-btn");

    let undoStack = [];
    let redoStack = [];
    let highlights = [];
    let lastSelectedHighlightId = null;

    const UNDO_BUTTON = document.getElementById("undo-btn");
    const REDO_BUTTON = document.getElementById("redo-btn");

    if (UNDO_BUTTON) {
      UNDO_BUTTON.addEventListener("click", () => {
        undo();
      });
    }
    if (REDO_BUTTON) {
      REDO_BUTTON.addEventListener("click", () => {
        redo();
      });
    }

    function updateButtons() {
      if (UNDO_BUTTON) UNDO_BUTTON.disabled = undoStack.length === 0;
      if (REDO_BUTTON) REDO_BUTTON.disabled = redoStack.length === 0;
    }
    updateButtons();

    function executeCommand(command) {
      undoStack.push(command);
      redoStack = [];
      command.execute();
      updateButtons();
      noteView(currentFilter);
      setTimeout(saveData, 100);
      console.log("실행된 명령:", command.action);
    }

    function undo() {
      if (undoStack.length > 0) {
        const lastCommand = undoStack.pop();
        if (lastCommand) {
          console.log("Undo 실행:", lastCommand.action);
          lastCommand.undo();
          redoStack.push(lastCommand);
          updateButtons();
          noteView(currentFilter);
          setTimeout(saveData, 100);
        }
      }
    }

    function redo() {
      if (redoStack.length > 0) {
        const lastUndoneCommand = redoStack.pop();
        if (lastUndoneCommand) {
          console.log("Redo 실행:", lastUndoneCommand.action);
          lastUndoneCommand.execute();
          undoStack.push(lastUndoneCommand);
          updateButtons();
          noteView(currentFilter);
          setTimeout(saveData, 100);
        }
      }
    }

    class AddHighlightCommand {
      constructor(pageNumber, rects, text) {
        this.action = "add_highlight";
        this.pageNumber = pageNumber;
        this.rects = rects;
        this.text = text;
        this.id = Date.now() + Math.random(); // 충돌 방지
      }
      execute() {
        const newHighlight = {
          page: this.pageNumber,
          rects: this.rects,
          text: this.text,
          id: this.id,
          tag: null,
        };
        highlights.push(newHighlight);
        renderHighlights();

        // 생성 직후 자동 선택
        lastSelectedHighlightId = newHighlight.id;
        console.log("신규 하이라이트 선택됨:", lastSelectedHighlightId);
      }
      undo() {
        highlights = highlights.filter((h) => h.id !== this.id);
        renderHighlights();
        if (lastSelectedHighlightId === this.id) lastSelectedHighlightId = null;
      }
    }

    class RemoveHighlightsCommand {
      constructor(ids) {
        this.action = "remove_highlights_batch";
        this.ids = ids;
        this.highlightData = highlights.filter((h) => this.ids.includes(h.id));
      }
      execute() {
        highlights = highlights.filter((h) => !this.ids.includes(h.id));
        renderHighlights();
      }
      undo() {
        highlights.push(...this.highlightData);
        renderHighlights();
      }
    }

    class AddTagCommand {
      constructor(highlightId, tag) {
        this.action = "add_tag";
        this.highlightId = highlightId;
        this.newTag = tag;
        this.originalTag =
          highlights.find((h) => h.id === highlightId)?.tag || null;
      }
      execute() {
        const highlight = highlights.find((h) => h.id === this.highlightId);
        if (highlight) {
          highlight.tag = this.newTag;
        }
        renderHighlights();
        noteView(currentFilter);
      }
      undo() {
        const highlight = highlights.find((h) => h.id === this.highlightId);
        if (highlight) {
          highlight.tag = this.originalTag;
        }
        renderHighlights();
        noteView(currentFilter);
      }
    }

    class RemoveNoteItemCommand {
      constructor(highlightIds) {
        this.action = "remove_note_item";
        this.highlightIds = highlightIds;
        this.highlightData = highlights.filter((h) =>
          this.highlightIds.includes(h.id)
        );
      }
      execute() {
        highlights = highlights.filter((h) => !this.highlightIds.includes(h.id));
        renderHighlights();
      }
      undo() {
        highlights.push(...this.highlightData);
        renderHighlights();
      }
    }

    document.getElementById("chalkboard").addEventListener("click", function () {
      FileInput.click();
    });

    FileInput.addEventListener("change", function (e) {
      const file = e.target.files[0];
      const reader = new FileReader();
      reader.onload = function () {
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
          const pageDivs = document.querySelectorAll(".page");
          if (pageDivs.length > 0) {
            clearInterval(checkLoad);
            setTimeout(() => {
              loadData();
              renderHighlights();
              const allTab = document.querySelector('.tab[data-tag="all"]');
              if (allTab) {
                allTab.classList.add("active");
                currentFilter = "all";
                noteView("all");
              }
            }, 500);
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
            textLayer.style.position = "absolute";

            page
              .render({
                canvasContext: context,
                viewport: viewport,
              })
              .promise.then(() => {
                page.getTextContent().then(function (textContent) {
                  pdfjsLib
                    .renderTextLayer({
                      textContent: textContent,
                      container: textLayer,
                      viewport: viewport,
                      textDivs: [],
                      enhanceTextSelection: true,
                    })
                    .promise.then(() => {
                      textLayer.querySelectorAll("span").forEach((span) => {
                        const w = span.getBoundingClientRect().width;
                        const h = span.getBoundingClientRect().height;
                        if (w < 2 || h < 2) span.remove();
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
    const tagBtn = document.getElementById("tag-btn");
    const dropdown = document.getElementById("dropdown");

    penBtn1.addEventListener("click", function () {
      isPenActive = !isPenActive;
      if (isPenActive) {
        isEraserActive = false;
        isTag = false;
        penBtn1.classList.add("active");
        eraserBtn.classList.remove("active");
        tagBtn.classList.remove("active");
        dropdown.classList.remove("show");
      } else {
        penBtn1.classList.remove("active");
      }
    });

    eraserBtn.addEventListener("click", function () {
      isEraserActive = !isEraserActive;
      if (isEraserActive) {
        isPenActive = false;
        isTag = false;
        eraserBtn.classList.add("active");
        penBtn1.classList.remove("active");
        tagBtn.classList.remove("active");
        dropdown.classList.remove("show");
      } else {
        eraserBtn.classList.remove("active");
      }
    });

    // 하이라이트 클릭: 지우개/태그 모드 동작
    document.addEventListener("click", function (e) {
      if (isEraserActive && e.target.classList.contains("highlight-span")) {
        const highlightId = parseFloat(e.target.dataset.id);
        if (highlightId) {
          const command = new RemoveHighlightsCommand([highlightId]);
          executeCommand(command);
        }
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      if (isTag && e.target.classList.contains("highlight-span")) {
        const highlightId = parseFloat(e.target.dataset.id);
        if (highlightId) {
          lastSelectedHighlightId = highlightId;
          dropdown.classList.add("show");
        }
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    });

    // 드래그 선택 후 동작
    document.addEventListener("mouseup", function () {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) return;

      const range = selection.getRangeAt(0);
      const selectedText = range.toString().trim();
      if (!selectedText) return;

      const startElement =
        range.startContainer.nodeType === Node.TEXT_NODE
          ? range.startContainer.parentElement
          : range.startContainer;

      const pageDiv = startElement.closest(".page");
      if (!pageDiv) return;

      const pageNumber = pageDiv.dataset.pageNumber;
      const selectionRects = Array.from(range.getClientRects());

      const pageHighlights = highlights.filter((h) => h.page === pageNumber);
      const overlappingHighlights = pageHighlights.filter((h) => {
        return h.rects.some((hRect) =>
          selectionRects.some(
            (sRect) =>
              hRect.left < sRect.right &&
              hRect.right > sRect.left &&
              hRect.top < sRect.bottom &&
              hRect.bottom > sRect.top
          )
        );
      });

      if (isPenActive) {
        const rects = selectionRects.map((r) => {
          const pageRect = pageDiv.getBoundingClientRect();
          return {
            left: r.left - pageRect.left,
            top: r.top - pageRect.top,
            width: r.width,
            height: r.height,
          };
        });
        const command = new AddHighlightCommand(pageNumber, rects, selectedText);
        executeCommand(command);
      } else if (isEraserActive) {
        if (overlappingHighlights.length > 0) {
          const command = new RemoveHighlightsCommand(
            overlappingHighlights.map((h) => h.id)
          );
          executeCommand(command);
        }
      } else if (isTag) {
        if (overlappingHighlights.length === 1) {
          lastSelectedHighlightId = overlappingHighlights[0].id;
        }
      }

      selection.removeAllRanges();
    });

    function toSlug(s) {
      return String(s).trim().replace(/\s+/g, "-");
    }

    function renderHighlights() {
      document.querySelectorAll(".highlight-span").forEach((el) => el.remove());

      highlights.forEach((h) => {
        const pageDiv = document.querySelector(
          `.page[data-page-number="${h.page}"]`
        );
        if (pageDiv && h.rects && Array.isArray(h.rects)) {
          h.rects.forEach((rect) => {
            const highlightSpan = document.createElement("span");
            highlightSpan.classList.add("highlight-span");
            highlightSpan.style.position = "absolute";
            highlightSpan.style.left = `${rect.left}px`;
            highlightSpan.style.top = `${rect.top}px`;
            highlightSpan.style.width = `${rect.width}px`;
            highlightSpan.style.height = `${rect.height}px`;
            highlightSpan.style.backgroundColor = "yellow";
            highlightSpan.style.opacity = "0.4";
            highlightSpan.style.pointerEvents = "auto";
            highlightSpan.style.cursor = "pointer";

            highlightSpan.dataset.id = h.id;
            highlightSpan.dataset.text = h.text;
            if (h.tag) {
              highlightSpan.dataset.tag = h.tag;
              highlightSpan.classList.add(`tag-${toSlug(h.tag)}`);
            }

            pageDiv.appendChild(highlightSpan);
          });
        }
      });
    }

    function getDataList(filterTag = null) {
      const filteredHighlights = highlights.filter((h) => {
        if (filterTag === "all" || !filterTag) return true;
        return h.tag === filterTag;
      });

      const groupedByPageAndId = {};
      filteredHighlights.forEach((h) => {
        const key = `${h.page}-${h.id}`;
        if (!groupedByPageAndId[key]) {
          groupedByPageAndId[key] = {
            text: h.text,
            page: h.page,
            id: h.id,
          };
        }
      });

      return Object.values(groupedByPageAndId);
    }

    function noteView(filterTag = null) {
      const noteWrap = document.querySelector(".note-wrap");
      if (!noteWrap) return;

      const notes = getDataList(filterTag);
      const existingItem = noteWrap.querySelectorAll(".note-item");
      existingItem.forEach((item) => item.remove());

      notes.forEach((note) => {
        const noteItem = document.createElement("div");
        noteItem.classList.add("note-item");

        const noteText = document.createElement("span");
        noteText.textContent = `[p.${note.page}] ${note.text}`;
        noteText.style.cursor = "pointer";
        noteText.addEventListener("click", () => {
          const pageMoving = document.querySelector(
            `.page[data-page-number="${note.page}"]`
          );
          if (pageMoving) {
            pageMoving.scrollIntoView({ behavior: "smooth" });
          }
        });

        const deleteBtn = document.createElement("button");
        deleteBtn.classList.add("delete-btn");
        deleteBtn.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" height="16" viewBox="0 0 320.941 320.941" width="16">
            <path d="m290.853 40.118h-181.049c-9.06 0-17.551 4.016-23.301 11.038l-84.241 102.968c-3.017 3.692-3.017 9.001 0 12.693l84.251 102.978c5.739 7.013 14.231 11.028 23.291 11.028h181.048c16.592 0 30.088-13.497 30.088-30.088v-180.529c.001-16.592-13.496-30.088-30.087-30.088zm10.029 210.617c0 5.534-4.496 10.029-10.029 10.029h-181.049c-3.026 0-5.857-1.342-7.767-3.673l-79.05-96.621 79.04-96.611c1.92-2.341 4.75-3.683 7.777-3.683h181.048c5.534 0 10.029 4.496 10.029 10.029.001.001.001 180.53.001 180.53z"></path>
            <path d="m223.585 103.232-43.056 43.056-43.056-43.056-14.182 14.182 43.056 43.056-43.056 43.056 14.182 14.182 43.056-43.056 43.056 43.056 14.182-14.182-43.056-43.056 43.056-43.056z"></path>
          </svg>
        `;
        deleteBtn.addEventListener("click", () => {
          const command = new RemoveNoteItemCommand([note.id]);
          executeCommand(command);
        });

        noteItem.appendChild(noteText);
        noteItem.appendChild(deleteBtn);
        noteWrap.appendChild(noteItem);
      });
    }

    document.querySelectorAll(".tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        const tag = tab.dataset.tag;
        currentFilter = tag;
        if (tag === "all") {
          noteView();
        } else {
          noteView(tag);
        }
      });
    });

    tagBtn.addEventListener("click", function () {
      isTag = !isTag;
      if (isTag) {
        isPenActive = false;
        isEraserActive = false;
        tagBtn.classList.add("active");
        penBtn1.classList.remove("active");
        eraserBtn.classList.remove("active");
        dropdown.classList.add("show");
      } else {
        tagBtn.classList.remove("active");
        dropdown.classList.remove("show");
      }
    });

    // ▼ 드롭다운 버튼 클릭 시 dataset.tag 사용
    dropdown.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", function () {
        const tag = btn.dataset.tag; // 중요/암기/참고
        console.log("드롭다운 태그 버튼 클릭됨:", tag);
        if (lastSelectedHighlightId) {
          const command = new AddTagCommand(lastSelectedHighlightId, tag);
          executeCommand(command);
          lastSelectedHighlightId = null;
          dropdown.classList.remove("show");
        } else {
          console.warn("선택된 하이라이트가 없습니다!");
        }
      });
    });

    function saveData() {
      try {
        const data = {
          highlights,
          undoStack: undoStack.map((cmd) => ({
            action: cmd.action,
            data: cmd,
          })),
          redoStack: redoStack.map((cmd) => ({
            action: cmd.action,
            data: cmd,
          })),
        };
        localStorage.setItem("pdfHighlightsData", JSON.stringify(data));
        console.log("하이라이트 및 명령 기록 저장 완료");
      } catch (error) {
        console.error("데이터 저장 중 오류 발생:", error);
      }
    }

    function loadData() {
      try {
        const saved = localStorage.getItem("pdfHighlightsData");
        if (saved) {
          const data = JSON.parse(saved);
          highlights = data.highlights || [];
          renderHighlights();
          noteView(currentFilter);
          console.log("하이라이트 및 명령 기록 불러오기 완료");
        }
      } catch (error) {
        console.error("데이터 불러오기 중 오류 발생:", error);
      }
    }