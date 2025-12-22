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
        this.historyPath = './data/history.json';
        this.answeredQuestions = new Set();
    }

    async initialize() {
        console.log('봇을 초기화합니다...');

        await this.loadHistory();

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

    getDocId(urlOrId) {
        try {
            // 이미 숫자(ID) 형식이면 그대로 반환
            if (/^\d+$/.test(urlOrId)) {
                return urlOrId;
            }
            const urlObj = new URL(urlOrId);
            return urlObj.searchParams.get('docId');
        } catch (e) {
            return null;
        }
    }

    async loadHistory() {
        try {
            if (await fs.pathExists(this.historyPath)) {
                const data = await fs.readJson(this.historyPath);
                // URL이 저장되어 있어도 docId만 추출해서 Set에 저장
                this.answeredQuestions = new Set(
                    data.map(url => this.getDocId(url)).filter(id => id !== null)
                );
                console.log(`기존 답변 기록을 불러왔습니다. (${this.answeredQuestions.size}개)`);
            } else {
                console.log('새로운 답변 기록 파일을 생성합니다.');
                this.answeredQuestions = new Set();
                await fs.outputJson(this.historyPath, []);
            }
        } catch (error) {
            console.error('히스토리 로드 실패:', error);
        }
    }

    async saveHistory() {
        try {
            await fs.ensureFile(this.historyPath);
            await fs.writeJson(this.historyPath, Array.from(this.answeredQuestions));
            console.log('답변 기록이 저장되었습니다.');
        } catch (error) {
            console.error('히스토리 저장 실패:', error);
        }
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
        // 네이버 지식인 검색 URL (최신순 정렬, 정확도 향상을 위해 따옴표로 감싸서 검색)
        const searchUrl = `https://kin.naver.com/search/list.naver?query=${encodeURIComponent('"' + keyword + '"')}&sort=date`;

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

                // 이미 내가 답변한 기록이 있는 경우 스킵
                const docId = this.getDocId(q.link);
                if (docId && this.answeredQuestions.has(docId)) {
                    console.log(`[Skip] 이미 답변한 질문입니다: ${q.title}`);
                    continue;
                }

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

            // [추가] 답변 생성 전 사용자 승인 요청 (토큰 절약)
            const readline = require('readline').createInterface({
                input: process.stdin,
                output: process.stdout
            });

            const userConfirmed = await new Promise(resolve => {
                readline.question('이 질문에 답변을 생성하시겠습니까? (y/n): ', (ans) => {
                    readline.close();
                    resolve(ans.toLowerCase() === 'y');
                });
            });

            if (!userConfirmed) {
                console.log('사용자가 답변 생성을 취소했습니다. 이 질문은 히스토리에 저장되어 다음 검색 시 스킵됩니다.');

                // [추가] 취소한 질문도 히스토리에 추가하여 다음 검색 시 스킵
                const docId = this.getDocId(link);
                if (docId) {
                    this.answeredQuestions.add(docId);
                    await this.saveHistory();
                }

                await newPage.close();
                return;
            }

            console.log('답변 생성 중...');

            // AI 답변 생성
            const answer = await this.generateAnswer(content, project);

            if (answer) {
                console.log('답변 생성 완료. 등록 절차를 진행합니다.');
                const posted = await this.postAnswer(newPage, answer, project);
                if (posted) {
                    const docId = this.getDocId(link);
                    if (docId) {
                        this.answeredQuestions.add(docId);
                        await this.saveHistory();
                    }
                }
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
            let prompt;

            if (project.name === "보통은.") {
                prompt = `
당신은 '밸런스 게임 마스터'입니다. 
사용자의 질문이 "A vs B" 형태의 밸런스 게임이라면, **둘 중 하나를 확실하게 선택**하고 그 이유를 재치있고 공감가게 설명해주세요.
그리고 답변 마지막에 자연스럽게 "보통은." 사이트에서 다른 사람들의 투표 결과도 확인해보라고 추천해주세요.

[질문]
"${question}"

[사이트 정보]
- 이름: 보통은.
- 설명: 다양한 주제(연애, 사회생활 등)의 밸런스 게임 모음. 로그인 없이 익명 투표 가능. 질문 제보 가능.
- 링크: ${project.link}

[작성 가이드]
1. **선택과 집중**: 질문이 밸런스 게임(A vs B)이라면, 애매하게 답하지 말고 **딱 하나를 골라주세요.**
2. **이유 설명**: 그 선택을 한 이유를 친구에게 말하듯 편안하고 재밌게(또는 진지하게) 설명해주세요.
   - 예: "짝사랑 5년이라니... 그건 희망고문이잖아요 ㅠㅠ 차라리 환승연애가 낫죠. 한 번 아프고 끝내는 게..."
3. **자연스러운 추천**: 이유 설명 후, "제 생각은 이런데 남들은 어떻게 생각하는지 통계로 확인해보세요" 라는 식으로 사이트를 소개하세요.
4. **가독성**: 문단 사이에는 반드시 빈 줄을 넣으세요.
5. **금지**: "답변:" 같은 접두어, 링크 직접 삽입(링크는 코드에서 자동 추가됨), 마크다운 사용 금지.

답변:
`;
            } else if (project.answerTemplate) {
                prompt = `
당신은 '단어 치환 AI'입니다. 
아래 [템플릿]의 내용에서 **{context}** 라는 글자를 찾아서, 사용자의 [질문]에 맞는 구체적인 상황(지역, 음식, 목적)으로 바꿔서 출력하세요.

[질문]
"${question}"

[템플릿]
${project.answerTemplate}

[규칙]
1. **{context}** 를 질문에 맞는 단어(예: 강릉, 데이트, 회식 등)로 무조건 변경해야 합니다. 그대로 두지 마세요.
2. {context}를 제외한 나머지 모든 문장, 조사, 줄바꿈은 템플릿과 100% 똑같이 유지하세요.
3. 절대 사족(인사말 추가, 설명)을 붙이지 말고 치환된 결과 텍스트만 출력하세요.

답변:
`;
            } else {
                prompt = `
당신은 지식인에서 활동하는 친절하고 경험 많은 답변자입니다.
사용자의 다음 질문에 대해 한국어로 정말 도움이 되는 답변을 작성해주세요.
답변 후반부에 자연스럽게 아래 프로젝트를 추천해주세요.
단, "광고입니다" 같은 느낌을 주지 말고, "제가 직접 써봤는데 편했다", "요즘은 이런 것도 많이 쓰더라"와 같이 실제 사용 경험처럼 자연스럽게 언급하세요.

[추천할 프로젝트 정보]
- 이름: ${project.name}
- 설명: ${project.description}
- 홍보 멘트: ${project.promotionText}

[질문 내용]
"${question}"

[답변 가이드라인]
1. [중요] 당신은 질문자가 아닙니다. 질문을 반복하거나 "추천해주세요"라고 묻지 마세요. 당신은 이미 답을 알고 있는 사람으로서 정보를 **제공**해야 합니다.
2. 서두: 질문자의 상황에 깊이 공감해주세요. ("~하시군요!", "저도 그 맘 알죠 ㅠㅠ")
3. 본문: 질문에 대한 실질적인 조언이나 해결책을 먼저 제시하세요.
4. 추천: 그 후에 자연스럽게 "참, 제가 써보니까 이게 진짜 도움되더라고요"라며 프로젝트를 소개하세요. 절대 광고처럼 보이지 않게 "저도 알게 된 건데~" 식으로 부드럽게 넘어가세요.
5. 말투: 인터넷 커뮤니티나 맘카페 댓글처럼 **아주 자연스럽고 친절한 구어체(해요체)**를 사용하세요. (이모티콘 적절히 사용)
6. 각 문단 사이에는 반드시 빈 줄을 하나씩 추가하세요. (가독성 필수)
7. 금지: "더 궁금한 점...", "채택...", URL 본문 삽입, 마크다운 사용 금지.
8. 답변의 맨 마지막 줄에만 아래 링크를 남기세요. (본문 중복 금지)
   ${project.link}

답변:
`;
            }

            // [추가] 재시도 로직 (503 Overloaded 에러 대응)
            const maxRetries = 3;
            let retryCount = 0;

            while (retryCount < maxRetries) {
                try {
                    const result = await model.generateContent(prompt);
                    const response = await result.response;
                    return response.text();
                } catch (apiError) {
                    if (apiError.msg && apiError.msg.includes('503') || apiError.message && apiError.message.includes('503')) {
                        retryCount++;
                        console.warn(`AI 모델 과부하(503) 감지... 재시도 중 (${retryCount}/${maxRetries})`);
                        // 지수 백오프: 2초, 4초, 8초 대기
                        await new Promise(r => setTimeout(r, 2000 * Math.pow(2, retryCount - 1)));
                    } else {
                        // 503이 아닌 다른 에러는 즉시 throw하여 아래 catch 블록으로 이동
                        throw apiError;
                    }
                }
            }

            throw new Error(`AI 모델 과부하가 지속되어 ${maxRetries}회 재시도 실패함.`);
        } catch (error) {
            console.error('AI 답변 생성 실패:', error);
            return null;
        }
    }

    async postAnswer(page, answer, project) {
        try {
            console.log('답변 작성란 진입 시도...');

            // 0. 마크다운 및 링크 포맷 정리
            let cleanAnswer = answer.replace(/\*\*/g, '').replace(/__/g, '').replace(/^#+\s/gm, '');

            // [강제 필터링] 금지된 멘트 삭제
            cleanAnswer = cleanAnswer.replace(/더 궁금한 점이 있으신가요\??|채택 부탁드립니다\.?|도움이 되셨나요\??/g, '');

            // [강제 포맷팅] 문단 간격 넓히기 (네이버 에디터 가독성)
            // \n을 \n\n으로 치환하되, 이미 \n\n인 경우는 유지
            cleanAnswer = cleanAnswer.split('\n').filter(line => line.trim() !== '').join('\n\n');

            // [링크 재배치] 본문 중간에 있을 수 있는 링크를 제거하고 맨 뒤에 강제로 붙임
            // 1. 기존 링크 제거 (중복 방지)
            cleanAnswer = cleanAnswer.split(project.link).join('');

            // 2. 끝 부분 공백 정리
            cleanAnswer = cleanAnswer.trim();

            // 3. 줄바꿈 확보 후 링크 추가 (앞뒤로 줄바꿈이 있어야 에디터에서 링크 활성화됨)
            cleanAnswer += `\n\n${project.link}\n`;

            // 마크다운 링크 변환 (혹시 남아있다면)
            cleanAnswer = cleanAnswer.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, url) => {
                if (text.trim() === url.trim() || text.includes('http')) {
                    return url;
                }
                return `${text}: ${url}`;
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
                    await new Promise(r => setTimeout(r, 500)); // 지우고 잠시 대기 (중요)

                    console.log('--------------------------------------------------');
                    console.log('[생성된 답변 전문]');
                    console.log(cleanAnswer);
                    console.log('--------------------------------------------------');

                    console.log('답변 안전 타이핑(Line-by-Line) 시도...');

                    // [이전 방식 롤백 및 개선]
                    // 한 번에 type()을 호출하면 에디터가 속도를 못 따라가서 글자가 씹힘.
                    // 따라서 줄 단위로 끊어서 타이핑하고, 엔터 처리 후 잠시 대기하는 방식으로 안정성 확보.

                    await inputElement.focus();

                    const lines = cleanAnswer.split('\n');
                    for (let i = 0; i < lines.length; i++) {
                        const line = lines[i];
                        if (line) {
                            // 줄 내용 타이핑 (속도를 15 -> 30ms로 약간 늦춤)
                            await page.keyboard.type(line, { delay: 30 });
                        }

                        // 마지막 줄이 아니면 엔터 입력
                        if (i < lines.length - 1) {
                            await page.keyboard.press('Enter');
                            // [중요] 엔터 후 에디터가 줄바꿈 처리할 시간을 줌 (씹힘 방지 핵심)
                            await new Promise(r => setTimeout(r, 200));
                        }
                    }

                    console.log('답변 타이핑 완료.');
                    await new Promise(r => setTimeout(r, 500)); // 렌더링 대기

                    // [링크 활성화 트리거]
                    // 타이핑 방식이므로 자연스럽게 활성화되겠지만, 확실하게 하기 위해 스페이스+백스페이스
                    await page.keyboard.press('Space');
                    await new Promise(r => setTimeout(r, 100));
                    await page.keyboard.press('Backspace');

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

                console.log('등록 요청을 보냈습니다. 10초 대기...');
                await new Promise(r => setTimeout(r, 10000));

                return true;
            } else {
                console.log('취소되었습니다.');
                return false;
            }

        } catch (error) {
            console.error('답변 등록 프로세스 오류:', error);
            return false;
        }
    }
}

module.exports = KinBot;
