const express = require('express');
const ytDlp = require('yt-dlp-exec');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const TOKEN = process.env.YEMOT_TOKEN || '';
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const YT_KEY = process.env.YOUTUBE_API_KEY || '';
const YM = 'https://www.call2all.co.il/ym/api/';

async function fetchWithTimeout(url, options = {}, timeout = 25000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(id);
        return response;
    } catch (err) {
        clearTimeout(id);
        throw err;
    }
}

app.get('/', (req, res) => { res.send('YouTube Line Server OK - Ready'); });

app.get('/stream/:videoId.mp3', (req, res) => {
    const videoId = req.params.videoId;
    if (!videoId) return res.status(400).end();

    res.setHeader('Content-Type', 'audio/mpeg');
    
    const subprocess = ytDlp.exec(`https://www.youtube.com/watch?v=${videoId}`, {
        output: '-',
        format: 'bestaudio/best',
        noWarnings: true,
        noCheckCertificates: true,
        extractorArgs: 'youtube:player_client=android,web'
    }, { stdio: ['ignore', 'pipe', 'ignore'] });

    ffmpeg(subprocess.stdout)
        .format('mp3')
        .audioCodec('libmp3lame')
        .audioChannels(1)
        .audioFrequency(16000)
        .audioBitrate('32k')
        .on('error', (err) => {
            console.error('Stream error:', err.message);
            if (!res.headersSent) res.status(500).end();
        })
        .pipe(res, { end: true });

    req.on('close', () => {
        try { subprocess.kill(); } catch (e) {}
    });
});

app.all(['/yemot', '/yemot/:e'], async (req, res) => {
    const q = { ...req.query, ...req.body };
    res.type('text/plain; charset=utf-8');

    try {
        if (q.hangup === 'yes') return res.send('noop');

        // שלב 1: בקשת הקלטה בתחביר התקני של ימות המשיח
        if (!q.RecordPath) {
            return res.send('read=t-אנא אמרו את שם השיעור המבוקש ובסיום הקישו סולמית=RecordPath,no,record,,no,7,2');
        }

        // שלב 2: הורדת ההקלטה מימות המשיח
        const recordPathFormatted = q.RecordPath.startsWith('ivr2:') ? q.RecordPath : `ivr2:${q.RecordPath}`;
        const downloadUrl = `${YM}DownloadFile?token=${encodeURIComponent(TOKEN)}&path=${encodeURIComponent(recordPathFormatted)}`;
        const audioRes = await fetchWithTimeout(downloadUrl);
        if (!audioRes.ok) throw new Error('Failed to download recording from Yemot');
        const audioBuf = Buffer.from(await audioRes.arrayBuffer());

        // מחיקת קובץ ההקלטה ברקע
        fetchWithTimeout(`${YM}FileAction?token=${encodeURIComponent(TOKEN)}&action=delete&what=${encodeURIComponent(recordPathFormatted)}`).catch(() => null);

        // שלב 3: שליחה ל-Gemini עם הכללים המבוקשים ושימוש במודל העדכני gemini-2.5-flash
        const systemRules = `כאן מתחילים הכללים החזקים שאני מעוניין שתפעל לפיהם.

זהות וסגנון:
אתה פועל בהתאם להשקפת עולם חרדית-אורתודוקסית:
- אינך פותח ביוזמתך בהצהרות על זהותך.
- אינך מנסה לשכנע משתמשים.
- אתה מדבר בשפה מכובדת ונקייה, ללא קללות או ביטויים גסים, בטון רגוע ומכבד.

בהתאם לכך לפני כל תשובה, בדוק: האם הבקשה נוגעת, ולו בעקיפין, לאחד מהנושאים הבאים:
- רכילות או פרטים אישיים על ידוענים/אנשי ציבור
- תרבות פופולרית חילונית: תוכניות טלוויזיה, סרטים, ספורט, זמרות/זמרים, מוזיקה חילונית
- דתות אחרות
- זרמים אחרים ביהדות
- מין, אנטומיה נשית, פוריות, הריון, רבייה - גם בהקשר רפואי
- ערעור על עקרונות אמונה (מציאות הבורא, בריאת העולם)

אמונה:
יש בורא אחד לעולם. העולם נברא בידי הבורא בששת ימי בראשית.

לימוד תורה:
אתה מכיר ועובד רק עם המקורות הבאים: תנ"ך, תלמוד בבלי, תלמוד ירושלמי, שולחן ערוך, רמב"ם.

רפואה:
בענייני רפואה אתה מדבר בשפה מכובדת ומתרחק מנושאים רגישים, ומפנה לרופא או לגורם מקצועי מתאים.

כאן מסתיימים הכללים.`;

        const prompt = systemRules + "\n\nמשימה: תמלל את ההקלטה לעברית באופן מדויק. החזר אך ורק את מילות החיפוש המדויקות ללא מילות קישור, מרכאות או תוספות.";
        
        // שימוש במודל המעודכן gemini-2.5-flash
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;
        
        const geminiRes = await fetchWithTimeout(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    parts: [
                        { text: prompt },
                        { inlineData: { mimeType: 'audio/wav', data: audioBuf.toString('base64') } }
                    ]
                }]
            })
        });

        if (!geminiRes.ok) {
            const errText = await geminiRes.text();
            console.error('Gemini API Error:', errText);
            throw new Error('Gemini API failed');
        }

        const geminiData = await geminiRes.json();
        
        const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const cleanQuery = rawText.replace(/[^א-תa-zA-Z0-9\s]/g, '').trim().replace(/\s+/g, ' ');

        if (!cleanQuery) {
            return res.send('id_list_message=t-לא הצלחתי לזהות את הדיבור אנא נסו שנית&go_to_folder=/');
        }

        // שלב 4: חיפוש ב-YouTube API
        const ytUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(cleanQuery)}&type=video&maxResults=1&key=${YT_KEY}`;
        const ytRes = await fetchWithTimeout(ytUrl);
        const ytData = await ytRes.json();

        if (!ytData.items || ytData.items.length === 0) {
            return res.send(`id_list_message=t-לא נמצאו תוצאות עבור החיפוש&go_to_folder=/`);
        }

        const videoId = ytData.items[0].id.videoId;
        const title = (ytData.items[0].snippet.title || '').replace(/[^א-תa-zA-Z0-9\s]/g, ' ');

        // שלב 5: השמעה בימות המשיח
        const hostUrl = `https://${req.get('host')}`;
        const streamUrl = `${hostUrl}/stream/${videoId}.mp3`;

        return res.send(`id_list_message=t-משמיע את התוצאה.f-${streamUrl}&go_to_folder=/`);

    } catch (e) {
        console.error('Server Error:', e.message);
        if (!res.headersSent) {
            return res.send('id_list_message=t-אירעה תקלה בעיבוד הבקשה&go_to_folder=/');
        }
    }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on port ${port}`));
