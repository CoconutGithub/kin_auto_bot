module.exports = {
    // 모니터링할 키워드 목록
    keywords: [
        // 예: "나의프로젝트", "특정기술"
        // 여기에 사용자가 원하는 키워드를 추가하세요.
    ],

    // 검색 주기 (밀리초 단위, 기본 60초)
    searchInterval: 60 * 1000,

    // AI 모델 설정
    aiModel: "gemini-1.5-flash", // gemma-3-1b가 API에 없다면 flash 사용 권장, 있으면 교체 가능

    // 최대 답변 길이 등
    maxAnswerLength: 500,
};
