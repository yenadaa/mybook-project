import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js"; 
import { getFirestore, collection, addDoc } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js"; 

// Firebase 설정 
const firebaseConfig = { 
  apiKey: "AIzaSyAQOIZxfDMyjDmKjUHhRbqT0uUbYHF-vs8", 
  authDomain: "mybook-95e20.firebaseapp.com", 
  projectId: "mybook-95e20", 
  storageBucket: "mybook-95e20.firebasestorage.app", 
  messagingSenderId: "271137722486", 
  appId: "1:271137722486:web:dd3aeaffe60cfae65bcf57" 
}; 

const app = initializeApp(firebaseConfig); 
const db = getFirestore(app); 

// 마지막 요약 정보 저장 변수 (전역 선언) 
let lastSummary = {}; 

// API 요청을 처리하는 함수
async function processText(type) {
  const inputText = document.getElementById("inputText").value; 
  if (!inputText.trim()) { 
    alert("분석할 글을 입력하세요."); 
    return; 
  } 

  let userPrompt = ""; 
  
  // 새로운 기능에 대한 프롬프트 구성
  if (type === "mindmap") {
    userPrompt = `다음 글의 핵심 개념들을 중심으로 마인드맵을 구성하고, 각 개념 간의 관계를 설명해줘: ${inputText}`;
  } else if (type === "chain-thought") {
    userPrompt = `다음 글의 핵심 주제에 대해 꼬리 질문(Chain of Thought) 방식으로 심화 학습 질문 3개를 만들어줘: ${inputText}`;
  } else if (type === "compare") {
    userPrompt = `다음 글에 나오는 핵심 개념들을 비교하고 차이점을 표 형식으로 요약해줘: ${inputText}`;
  } else { // 기존 요약 기능
    userPrompt = `다음 글을 핵심 포인트만 뽑아서 요약해줘: ${inputText}`;
  }

  // OpenAI API 요청 (이 부분은 기존 코드와 동일)
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", { 
      method: "POST", 
      headers: {  
        "Content-Type": "application/json", 
        "Authorization": `Bearer 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`
      }, 
      body: JSON.stringify({ 
        model: "gpt-4o", 
        messages: [{ role: "user", content: userPrompt }], 
        temperature: 0.7 
      }) 
    }); 

    const data = await response.json(); 

    if (data.choices && data.choices[0]) { 
      const result = data.choices[0].message.content; 
      document.getElementById("output").innerText = result; 
      document.getElementById("feedback").style.display = "block"; 

      // 결과 저장
      lastSummary = { 
        input: inputText, 
        type: type, 
        summary: result, 
        createdAt: new Date() 
      }; 

      await addDoc(collection(db, "summaries"), lastSummary); 
    } else { 
      document.getElementById("output").innerText = "요청에 실패했습니다. API 키 또는 요청을 확인하세요."; 
    }
  } catch (error) {
    console.error("API 요청 중 오류 발생:", error);
    document.getElementById("output").innerText = "오류가 발생했습니다. 잠시 후 다시 시도해주세요.";
  }
}

// 버튼 이벤트 리스너 등록
document.getElementById("mindmapBtn").addEventListener("click", () => processText("mindmap"));
document.getElementById("chainThoughtBtn").addEventListener("click", () => processText("chain-thought"));
document.getElementById("compareBtn").addEventListener("click", () => processText("compare"));
document.getElementById("summaryBtn").addEventListener("click", () => processText("keypoints"));


// 피드백 버튼 이벤트 (기존 코드와 동일)
document.getElementById("likeBtn").addEventListener("click", async () => { 
  if (!lastSummary.summary) { 
    alert("요약한 결과가 없습니다."); 
    return; 
  } 
  await addDoc(collection(db, "feedbacks"), { 
    ...lastSummary, 
    feedback: "like", 
    feedbackTime: new Date() 
  }); 
  alert("좋아요를 등록했어요!"); 
}); 

document.getElementById("dislikeBtn").addEventListener("click", async () => { 
  if (!lastSummary.summary) { 
    alert("요약한 결과가 없습니다."); 
    return; 
  } 
  await addDoc(collection(db, "feedbacks"), { 
    ...lastSummary, 
    feedback: "dislike", 
    feedbackTime: new Date() 
  }); 
  alert("싫어요를 등록했어요!"); 
});