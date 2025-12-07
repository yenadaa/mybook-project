from firebase_admin import initialize_app

# 1. Pipeline
from routers.pipeline import on_pdf_upload

# 2. Chat
from routers.chat import ragChat

# 3. Quiz
from routers.quiz import (
    generateFullDocQuiz,
    generateCustomReview,
    scoreQuizAnswer,
    gradeBlankPaper,
    scoreDiscussionAnswer
)

# 4. Review
from routers.review import (
    sendReviewNotifications,
    generateUserReviewSession,
    submitReviewSession,
    testTriggerNotifications
)

# 5. Tools
from routers.tools import (
    generateQuiz,
    runOcrOnSelection,
    saveQuizItems
)