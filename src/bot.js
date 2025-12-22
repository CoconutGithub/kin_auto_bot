require('dotenv').config();
const puppeteer = require('puppeteer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../config/settings');
const fs = require('fs-extra');

class KinBot {
    constructor() {
        this.browser = null;
        this.page = null;
        this.genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
    }

    async initialize() {
        console.log('봇을 초기화합니다...');
        // 브라우저 실행
        this.browser = await puppeteer.launch({
            headless: process.env.HEADLESS === 'true',
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
            defaultViewport: null,
            // 사용자 데이터 저장을 통해 로그인 세션 유지 시도 (선택 사항)
            userDataDir: './user_data'
        });

        this.page = await this.browser.newPage();
        console.log('브라우저가 실행되었습니다.');
    }

    async login() {
        console.log('네이버 로그인 페이지로 이동합니다...');
        await this.page.goto('https://nid.naver.com/nidlogin.login', { waitUntil: 'networkidle2' });

        // 쿠키 파일이 있으면 불러오기 시도 (구현 예정)

        console.log('로그인을 대기합니다. 브라우저에서 직접 로그인해주세요.');
        console.log('로그인이 완료되면 자동으로 감지하여 진행합니다...');

        // 로그인 성공 여부 체크 (예: 메인 페이지의 로그아웃 버튼이나 프로필 요소 확인)
        try {
            // 최대 5분 대기
            await this.page.waitForFunction(
                () => document.querySelector('#gnb') || window.location.href.includes('naver.com') && !window.location.href.includes('nidlogin'),
                { timeout: 300000 }
            );
            console.log('로그인이 감지되었습니다!');
            // 로그인 후 잠시 대기
            await new Promise(r => setTimeout(r, 2000));
        } catch (e) {
            console.error('로그인 대기 시간 초과');
            throw e;
        }
    }

    async monitor() {
        console.log('질문 모니터링을 시작합니다...');

        while (true) {
            try {
                for (const keyword of config.keywords) {
                    console.log(`'${keyword}' 검색 중...`);
                    await this.searchAndProcess(keyword);
                }
            } catch (error) {
                console.error('모니터링 중 에러 발생:', error);
            }

            console.log(`${config.searchInterval / 1000}초 후 다시 검색합니다.`);
            await new Promise(resolve => setTimeout(resolve, config.searchInterval));
        }
    }

    async searchAndProcess(keyword) {
        // 네이버 지식인 검색 URL (최신순 정렬)
        const searchUrl = `https://kin.naver.com/search/list.naver?query=${encodeURIComponent(keyword)}&sort=date`;

        try {
            await this.page.goto(searchUrl, { waitUntil: 'domcontentloaded' });

            // 질문 리스트 추출
            const questions = await this.page.evaluate(() => {
                const items = document.querySelectorAll('.basic1 li');
                return Array.from(items).map(item => {
                    const titleEl = item.querySelector('dt > a');
                    const link = titleEl.href;
                    const title = titleEl.innerText;
                    const date = item.querySelector('.txt_inline').innerText;
                    const isAnswered = item.querySelector('.icon_b1'); // 답변 완료 아이콘 확인 (클래스명은 변동 가능성 있음)

                    return { link, title, date, isAnswered: !!isAnswered };
                });
            });

            for (const q of questions) {
                // 이미 답변된 질문은 스킵 (설정에 따라 다름, 여기서는 답변 없는 것만 타겟)
                if (q.isAnswered) continue;

                console.log(`새로운 질문 발견: ${q.title}`);
                await this.processQuestion(q.link);
            }

        } catch (error) {
            console.error(`키워드 '${keyword}' 검색 실패:`, error);
        }
    }

    async processQuestion(link) {
        try {
            const newPage = await this.browser.newPage();
            await newPage.goto(link, { waitUntil: 'networkidle2' });

            // 질문 내용 추출
            const content = await newPage.evaluate(() => {
                const title = document.querySelector('.title')?.innerText || '';
                const body = document.querySelector('.c-heading__content')?.innerText || '';
                return `제목: ${title}\n내용: ${body}`;
            });

            console.log('질문 내용 추출 완료. 답변 생성 중...');

            // AI 답변 생성
            const answer = await this.generateAnswer(content);

            if (answer) {
                console.log('답변 생성 완료. 등록을 시도합니다.');
                // await this.postAnswer(newPage, answer); // TODO: 실제 등록 활성화 시 주석 해제
                console.log(`[TEST MODE] 생성된 답변:\n${answer}`);
            }

            await newPage.close();

        } catch (error) {
            console.error('질문 처리 중 오류:', error);
        }
    }

    async generateAnswer(question) {
        try {
            const model = this.genAI.getGenerativeModel({ model: config.aiModel });

            const prompt = `
당신은 친절하고 전문적인 지식인 답변 봇입니다. 
다음 질문에 대해 한국어로 정중하고 도움이 되는 답변을 작성해주세요.
답변은 너무 길지 않게 핵심을 담아주세요.
홍보성 멘트는 자제하고, 정보 전달에 집중하세요.

질문:
"${question}"

답변:
`;
            const result = await model.generateContent(prompt);
            const response = await result.response;
            return response.text();
        } catch (error) {
            console.error('AI 답변 생성 실패:', error);
            return null;
        }
    }

    async postAnswer(page, answer) {
        try {
            console.log('답변 작성란을 찾습니다...');

            // 스마트 에디터 3.0 등 에디터 로딩 대기 (일반적인 텍스트 모드 기준)
            // 지식인은 경우에 따라 에디터가 다를 수 있으나, 보통 본문 입력 textarea나 iframe이 있음.
            // 여기서는 스마트 에디터가 아닌 간단한 텍스트 입력 시도를 가정하거나,
            // 포커스 후 타이핑을 시도합니다.

            // 답변하기 버튼이 있다면 클릭 (페이지 바로 진입 시 열려있을 수도 있음)
            const answerButton = await page.$('.c-user_action .button_answer');
            if (answerButton) {
                await answerButton.click();
                await new Promise(r => setTimeout(r, 1000));
            }

            // 에디터 프레임이나 입력창 찾기
            // 스마트에디터의 경우 복잡하므로, 여기서는 일반적인 접근 시도
            const editorSelector = '#smartEditor iframe'; // 스마트에디터 iframe
            const simpleInputSelector = '#contents'; // 단순 입력창 (예시)

            // 실제 구현 시에는 페이지 구조를 보고 정확한 선택자를 찾아야 함.
            // 우선 간단히 로그만 남기고 실제 클릭은 주석 처리 또는 "답변 등록 버튼" 선택자만 정의

            console.log('답변 내용을 입력합니다 (시뮬레이션)...');

            // 실제 입력 로직 (예시)
            // await page.click('.se-content'); 
            // await page.keyboard.type(answer);

            console.log('답변 등록 버튼을 클릭합니다 (시뮬레이션)...');
            // await page.click('#answerRegisterButton');

            // 등록 완료 대기
            await new Promise(r => setTimeout(r, 3000));
            console.log('답변 등록 절차 완료 (실제 등록은 아직 비활성화됨)');

        } catch (error) {
            console.error('답변 등록 중 오류:', error);
        }
    }
}

module.exports = KinBot;
