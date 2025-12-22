const KinBot = require('./src/bot');
const config = require('./config/settings');
require('dotenv').config();

async function main() {
    if (!process.env.GOOGLE_API_KEY) {
        console.error('오류: .env 파일에 GOOGLE_API_KEY가 설정되지 않았습니다.');
        process.exit(1);
    }

    const bot = new KinBot();

    try {
        await bot.initialize();

        // 로그인 절차
        await bot.login();

        // 모니터링 시작
        console.log(`모니터링 키워드: ${config.keywords.join(', ')}`);
        if (config.keywords.length === 0) {
            console.warn('경고: 설정된 키워드가 없습니다. config/settings.js를 확인해주세요.');
        }

        await bot.monitor();

    } catch (error) {
        console.error('봇 실행 중 오류 발생:', error);
    }
}

main();
