require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

async function listModels() {
    console.log(`API Key 확인 중... ${process.env.GOOGLE_API_KEY ? 'OK' : 'MISSING'}`);
    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

    try {
        console.log('사용 가능한 모델 목록을 조회합니다...');
        // 빈 모델을 가져와서 listModels 호출 (GoogleGenerativeAI 인스턴스에서 매니저 접근 필요 등)
        // SDK 버전에 따라 다를 수 있으므로, 제너럴하게 ModelManager 사용 시도
        // v0.1.0 이상에서는 genAI.getGenerativeModelMain? 아니면 아래 방식.

        // 현재 SDK에서 listModels가 직접 노출되지 않을 수 있으므로
        // fetch를 사용하여 직접 호출해보거나 도큐먼트 참조.
        // 하지만 간단히 gemini-1.5-flash로 테스트해보는게 빠름.

        // 우선 확실한 모델로 테스트 다시 제안
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const result = await model.generateContent("Test");
        console.log("gemini-1.5-flash 연결 성공!");

    } catch (error) {
        console.log("----------------------------------------");
        console.error('모델 조회/테스트 중 오류:', error.message);
        console.log("----------------------------------------");
        console.log("가능한 원인:");
        console.log("1. API 키가 유효하지 않음 (이전 로그에 'API key not valid'가 있었음)");
        console.log("2. 해당 모델명이 API에서 지원되지 않음");
    }
}

// 직접 API 엔드포인트로 모델 리스트 조회 시도
async function fetchModels() {
    if (!process.env.GOOGLE_API_KEY) return;
    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GOOGLE_API_KEY}`);
        const data = await response.json();

        if (data.models) {
            console.log("\n[사용 가능한 모델 목록]");
            data.models.forEach(m => {
                if (m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent')) {
                    console.log(`- ${m.name.replace('models/', '')}`);
                }
            });
        } else {
            console.log("모델 목록을 가져올 수 없습니다:", data);
        }
    } catch (e) {
        console.error("API 요청 실패:", e);
    }
}

fetchModels();
