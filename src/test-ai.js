require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../config/settings');

async function testAI() {
    console.log(`API Key 확인 중... ${process.env.GOOGLE_API_KEY ? 'OK' : 'MISSING'}`);
    console.log(`모델: ${config.aiModel}`);

    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
    const model = genAI.getGenerativeModel({ model: config.aiModel });

    try {
        console.log('테스트 프롬프트 전송 중...');
        const result = await model.generateContent("안녕? 너는 어떤 모델이니?");
        const response = await result.response;
        console.log('답변:', response.text());
        console.log('AI 테스트 성공!');
    } catch (error) {
        console.error('AI 테스트 실패:', error.message);
        console.log('팁: 모델명이 정확한지, API 키가 유효한지 확인해주세요.');
        console.log('사용 가능한 모델 예시: gemini-1.5-flash, gemini-1.5-pro');
    }
}

testAI();
