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

        const id = process.env.NAVER_ID;
        const pw = process.env.NAVER_PW;

        if (id && pw) {
            console.log('환경 변수의 계정 정보로 자동 로그인을 시도합니다...');
            try {
                // 네이버 로그인 캡차 우회: 클립보드 복사/붙여넣기 방식 에뮬레이션
                // 단순히 value를 설정하면 캡차가 뜰 확률이 높음.
                // evaluate 내에서 value를 설정하고 클릭하는 방식이 가장 뚫릴 확률이 높음 (clipboard api 흉내)

                await this.page.evaluate((nid, npw) => {
                    // ID 입력
                    const idInput = document.querySelector('#id');
                    if (idInput) {
                        idInput.value = nid;
                        // React/Vue 등의 가상돔을 쓰는 경우 이벤트를 발생시켜야 할 수도 있지만
                        // 네이버 구형 로그인창은 value 설정만으로도 우회되는 경우가 많음 (단, 타이핑처럼 보여야 함)
                    }

                    // PW 입력
                    const pwInput = document.querySelector('#pw');
                    if (pwInput) {
                        pwInput.value = npw;
                    }
                }, id, pw);

                console.log('아이디/비밀번호 입력 완료 (Clipboard 방식)...');
                await new Promise(r => setTimeout(r, 1000)); // 잠깐 대기

                // 로그인 버튼 클릭
                const loginBtnSelector = '.btn_login, #log\\.login';
                await this.page.click(loginBtnSelector);
                console.log('로그인 버튼 클릭.');

            } catch (error) {
                console.error('자동 로그인 시도 중 에러:', error.message);
                console.log('수동 로그인을 진행해주세요.');
            }
        } else {
            console.log('환경 변수에 NAVER_ID 또는 NAVER_PW가 없습니다. 수동 로그인을 대기합니다.');
        }

        // 로그인 성공 여부 체크 (예: 메인 페이지의 로그아웃 버튼이나 프로필 요소 확인)
        try {
            console.log('로그인 완료 여부를 확인합니다...');
            // 최대 5분 대기 (자동 로그인 실패 시 수동 로그인 시간 벌기)
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
                // 프로젝트 설정 순회
                for (const project of config.projects) {
                    console.log(`=== 프로젝트 [${project.name}] 작업 시작 ===`);
                    for (const keyword of project.keywords) {
                        console.log(`[${project.name}] 키워드 '${keyword}' 검색 중...`);
                        await this.searchAndProcess(keyword, project);
                    }
                }
            } catch (error) {
                console.error('모니터링 중 에러 발생:', error);
            }

            console.log(`${config.searchInterval / 1000}초 후 다시 검색합니다.`);
            await new Promise(resolve => setTimeout(resolve, config.searchInterval));
        }
    }

    async searchAndProcess(keyword, project) {
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
                    const isAnswered = item.querySelector('.icon_b1'); // 답변 완료 아이콘 확인

                    return { link, title, date, isAnswered: !!isAnswered };
                });
            });

            for (const q of questions) {
                // 이미 답변된 질문은 스킵
                if (q.isAnswered) continue;

                // 키워드 포함 여부 2차 검증
                if (!q.title.includes(keyword) && !q.title.replace(/\s/g, '').includes(keyword.replace(/\s/g, ''))) {
                    continue;
                }

                console.log(`[${project.name}] 새로운 질문 발견: ${q.title}`);
                await this.processQuestion(q.link, project);
            }

        } catch (error) {
            console.error(`키워드 '${keyword}' 검색 실패:`, error);
        }
    }

    async processQuestion(link, project) {
        try {
            const newPage = await this.browser.newPage();
            await newPage.goto(link, { waitUntil: 'networkidle2' });

            // 질문 내용 추출
            const content = await newPage.evaluate(() => {
                // 스크린샷 기반 선택자 적용
                // 제목: .endTitleSection 내의 h3 또는 텍스트
                const title = document.querySelector('.endTitleSection h3')?.innerText
                    || document.querySelector('.endTitleSection')?.innerText
                    || document.querySelector('.c-heading__title')?.innerText
                    || document.querySelector('.title')?.innerText
                    || '';

                // 본문: .questionDetail (스크린샷에서 확인됨)
                const body = document.querySelector('.questionDetail')?.innerText
                    || document.querySelector('.c-heading__content')?.innerText
                    || document.querySelector('.c-user_text')?.innerText
                    || '';

                return `제목: ${title}\n내용: ${body}`.trim();
            });

            console.log(`[DEBUG] 추출된 질문 내용:\n${content}\n-------------------`);

            if (content.length < 10) {
                console.log('내용이 너무 짧거나 추출되지 않아 건너뜁니다.');
                await newPage.close();
                return;
            }

            console.log('답변 생성 중...');

            // AI 답변 생성
            const answer = await this.generateAnswer(content, project);

            if (answer) {
                console.log('답변 생성 완료. 등록 절차를 진행합니다.');
                await this.postAnswer(newPage, answer);
                // console.log(`[TEST MODE] 생성된 답변:\n${answer}`);
            }

            await newPage.close();

        } catch (error) {
            console.error('질문 처리 중 오류:', error);
        }
    }

    async generateAnswer(question, project) {
        try {
            const model = this.genAI.getGenerativeModel({ model: config.aiModel });

            const prompt = `
당신은 지식인에서 활동하는 친절하고 경험 많은 전문가입니다.
사용자의 다음 질문에 대해 한국어로 정말 도움이 되는 답변을 작성해주세요.
답변의 마지막 부분이나 문맥상 자연스러운 위치에 아래 프로젝트를 추천해주세요.
단, 너무 노골적인 광고처럼 보이지 않게, "제가 써봤는데 좋았다"거나 "이런 것도 도움이 될 수 있다"는 식으로 자연스럽게 언급하세요.

[추천할 프로젝트 정보]
- 이름: ${project.name}
- 설명: ${project.description}
- 홍보 멘트: ${project.promotionText}
- 필수 포함 링크: ${project.link}

[질문 내용]
"${question}"

[답변 가이드라인]
1. 질문자의 궁금증을 먼저 확실하게 해결해주세요.
2. 답변은 친절하고 정중한 어조(해요체)를 사용하세요.
3. **답변 본문 중간에는 절대 링크를 넣지 마세요.**
4. 전체 길이는 300~500자 내외로 작성하세요.
5. **절대 마크다운(**볼드**, *이탤릭*)을 사용하지 마세요.**
6. 답변의 **맨 마지막 줄**에 아래 링크를 그대로 붙여주세요 (설명 없이 URL만).
   ${project.link}

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
            console.log('답변 작성란 진입 시도...');

            // 0. 마크다운 및 링크 포맷 정리
            // [Link](Url) -> Link: Url 형식을 변환하되, 텍스트와 URL이 같으면 URL만 남김
            let cleanAnswer = answer.replace(/\*\*/g, '').replace(/__/g, '').replace(/^#+\s/gm, '');
            // 마크다운 링크 변환 로직 개선
            cleanAnswer = cleanAnswer.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, url) => {
                if (text.trim() === url.trim() || text.includes('http')) {
                    return url; // 텍스트가 URL이거나 중복되면 URL만 반환
                }
                return `${text}: ${url}`; // 다르면 "텍스트: URL" 반환
            });

            // 1. 답변하기 버튼 찾기 및 클릭 (스크린샷 클래스 기반 강제 클릭)
            let clicked = false;
            try {
                // 스크린샷에 나온 정확한 클래스: endAnswerRegisterButton _answerWriteButton ...
                await page.evaluate(() => {
                    const btn = document.querySelector('.endAnswerRegisterButton');
                    if (btn) {
                        btn.scrollIntoView();
                        btn.click();
                        return true;
                    }
                    return false;
                });

                // evaluate는 리턴값을 받기 까다로울 수 있으므로, 에러 없으면 성공으로 간주하되
                // 요소를 확인 후 flag 설정
                const btnExists = await page.$('.endAnswerRegisterButton');
                if (btnExists) {
                    console.log("버튼 요소 확인됨, JS Click 실행.");
                    clicked = true;
                } else {
                    // 텍스트 기반 fallback
                    const textClicked = await page.evaluate(() => {
                        const all = document.querySelectorAll('button, a, span');
                        for (const el of all) {
                            if (el.innerText && el.innerText.trim() === '답변하기') {
                                el.scrollIntoView();
                                el.click();
                                return true;
                            }
                        }
                        return false;
                    });
                    if (textClicked) {
                        console.log("텍스트('답변하기')로 버튼 클릭 성공");
                        clicked = true;
                    }
                }
            } catch (e) {
                console.error("버튼 클릭 시도 중 에러:", e.message);
            }

            if (clicked) {
                console.log("버튼 클릭 완료. 에디터 로딩을 기다립니다.");
                await new Promise(r => setTimeout(r, 2000));
            } else {
                console.log("경고: '답변하기' 버튼을 클릭하지 못했습니다. (이미 열려있거나 찾을 수 없음)");
            }

            // [아이디 비공개 설정]
            // 에디터 진입 후 설정
            if (config.privateId) {
                try {
                    console.log('아이디 비공개 설정 시도 (JS 강제 클릭)...');
                    await page.waitForSelector('#openIdOption', { timeout: 3000 }).catch(() => null);

                    const openIdState = await page.evaluate(() => {
                        const checkbox = document.querySelector('#openIdOption');
                        const label = document.querySelector('label[for="openIdOption"]');
                        if (!checkbox) return 'not_found';

                        if (checkbox.checked) {
                            // 체크되어 있으면 '공개' 상태 -> 클릭해서 해제해야 함
                            if (label) {
                                label.click();
                                return 'clicked_label';
                            } else {
                                checkbox.click();
                                return 'clicked_checkbox';
                            }
                        }
                        return 'already_private';
                    });

                    console.log(`비공개 설정 결과: ${openIdState}`);
                    await new Promise(r => setTimeout(r, 1000));

                } catch (e) {
                    console.log("아이디 비공개 설정 건너뜜:", e.message);
                }
            }
            // 에디터 완전 로딩 대기...
            await new Promise(r => setTimeout(r, 4000));

            // [답변 내용 입력]
            console.log('스마트에디터 입력 시도...');

            // 링크 버튼 등 툴바 클릭 방지를 위해 선택자 정밀화
            // 툴바(.se-toolbar) 내부는 절대 클릭하면 안 됨.
            // 본문 영역: .se-main-container, .se-content, .se-text-paragraph

            let targetFrame = page.mainFrame();
            let inputElement = null;

            // 1. 프레임 탐색
            const frames = page.frames();
            let editorFrame = frames.find(f =>
                (f.url().includes('smarteditor') || f.name() === 'mainFrame' || f.url().includes('Editor'))
                && !f.url().includes('ad')
                && !f.url().includes('banner')
            );

            if (editorFrame) {
                targetFrame = editorFrame;
                console.log(`에디터 프레임 발견: ${targetFrame.name()}`);
            }

            // 2. 입력 요소 찾기 (evaluate로 툴바 제외하고 찾기)
            try {
                // 브라우저 컨텍스트에서 안전한 요소 탐색
                // 툴바(.se-toolbar)를 절대 클릭하지 않도록 contenteditable 속성이 있거나 명확한 본문 클래스만 타겟팅
                const elementHandle = await targetFrame.evaluateHandle(() => {
                    // 1순위: contenteditable 속성이 있는 요소 (가장 확실함)
                    const editable = document.querySelector('[contenteditable="true"]');
                    if (editable && editable.offsetParent) return editable;

                    // 2순위: 본문 텍스트 단락 (SmartEditor ONE)
                    const paragraph = document.querySelector('.se-text-paragraph, .se-component-content, .se-section-text, .se-module-text');
                    if (paragraph && paragraph.offsetParent) return paragraph;

                    // 3순위: 플레이스홀더
                    const placeholder = document.querySelector('.se-placeholder, .__se_placeholder');
                    if (placeholder && placeholder.offsetParent) return placeholder;

                    // 4순위: 구버전 body
                    const oldBody = document.querySelector('body.se2_input_area');
                    if (oldBody) return oldBody;

                    return null;
                });

                if (elementHandle && elementHandle.asElement()) {
                    inputElement = elementHandle.asElement();
                    console.log("입력 적합 요소(contenteditable/text)를 찾았습니다.");

                    // 클릭하여 포커스
                    await inputElement.click();
                    await new Promise(r => setTimeout(r, 500));

                    // 기존 내용 초기화 (Ctrl+A -> Backspace)
                    // 간혹 포커스가 제대로 안 잡혔을 수 있으니 클릭 후 초기화 수행
                    await page.keyboard.down('Control');
                    await page.keyboard.press('A');
                    await page.keyboard.up('Control');
                    await page.keyboard.press('Backspace');
                    await new Promise(r => setTimeout(r, 200));

                    console.log('--------------------------------------------------');
                    console.log('[생성된 답변 전문]');
                    console.log(cleanAnswer);
                    console.log('--------------------------------------------------');

                    // 타이핑
                    console.log('답변 타이핑 시작...');
                    await page.keyboard.type(cleanAnswer, { delay: 10 });
                } else {
                    throw new Error("입력 가능한 요소를 찾지 못했습니다.");
                }

            } catch (e) {
                console.error("에디터 입력 실패:", e.message);
                console.log("fallback: 메인 프레임 탭 키 이동 후 입력 시도");
                try {
                    // 클릭이 위험하므로 차라리 포커스를 초기화하고 탭으로 진입 시도
                    await page.click('body'); // 메인 바디 클릭해서 포커스 뺌
                    await page.keyboard.press('Tab'); // 에디터 진입 기대
                    await page.keyboard.press('Tab'); // 혹시 몰라 두 번
                    await page.keyboard.type(cleanAnswer, { delay: 10 });
                } catch (fallbackError) {
                    console.error("fallback 입력도 실패:", fallbackError.message);
                }
            }

            console.log('--------------------------------------------------');
            console.log('[답변 등록 대기]');
            console.log('답변 일부:', cleanAnswer.substring(0, 50) + '...');
            console.log('--------------------------------------------------');

            // [사용자 승인 요청]
            const readline = require('readline').createInterface({
                input: process.stdin,
                output: process.stdout
            });

            const userApproved = await new Promise(resolve => {
                readline.question('이 답변을 실제로 등록하시겠습니까? (y/n): ', (ans) => {
                    readline.close();
                    resolve(ans.toLowerCase() === 'y');
                });
            });

            if (userApproved) {
                console.log('사용자 승인 완료. 등록 버튼 클릭...');

                // 등록 버튼: ID 기반으로 확실하게 찾기 (#answerRegisterButton)
                try {
                    console.log("최종 등록 버튼(#answerRegisterButton) 찾는 중...");
                    const submitBtnSelector = '#answerRegisterButton';
                    await page.waitForSelector(submitBtnSelector, { timeout: 3000 });

                    // JS 강제 클릭 (가장 확실함)
                    await page.evaluate((sel) => {
                        const btn = document.querySelector(sel);
                        if (btn) btn.click();
                    }, submitBtnSelector);

                    console.log('등록 버튼 클릭 실행됨(JS).');
                } catch (e) {
                    console.error("ID로 등록 버튼 찾기 실패, Fallback 시도...", e.message);

                    // Fallback: 텍스트 기반 검색
                    try {
                        await page.evaluate(() => {
                            const btns = document.querySelectorAll('button, a');
                            for (const b of btns) {
                                if (b.innerText.includes('답변등록')) {
                                    b.click();
                                    return;
                                }
                            }
                        });
                        console.log('텍스트 기반 버튼 클릭 시도 완료.');
                    } catch (e2) {
                        console.error("등록 버튼 클릭 최종 실패:", e2.message);
                    }
                }

                console.log('등록 요청을 보냈습니다. 5초 대기...');
                await new Promise(r => setTimeout(r, 5000));
                // (이전 코드에서 try가 이미 닫혔으므로, 여기서는 단순히 로그 출력 후 종료)
                // 만약 전체 로직을 감싸는 try가 필요하다면 상위 레벨에서 처리되거나,
                // 현재 구조상으로는 이미 내부 try/catch로 처리되었으므로 추가적인 catch가 불필요함.
            } else {
                console.log('취소되었습니다.');
            }

        } catch (error) {
            console.error('답변 등록 프로세스 오류:', error);
        }
    }
}

module.exports = KinBot;
