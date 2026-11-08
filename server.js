const express = require('express');
const ytDlp = require('yt-dlp-exec');
const app = express();

app.use(express.urlencoded({ extended: true }));

const TOKEN = process.env.YEMOT_TOKEN || '';
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const YT_KEY = process.env.YOUTUBE_API_KEY || '';
const YM = 'https://www.call2all.co.il/ym/api/';

// פונקציית עזר לשליחת בקשות API עם מגבלת זמן
async function fetchWithTimeout(url, options = {}, timeout = 15000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return response;
}

app.get('/', (req, res) => { res.send('YouTube Line Server OK'); });

app.all(['/yemot', '/yemot/:e'], async (req, res) => {
    const q = { ...req.query, ...req.body };
    res.type('text/plain');

    try {
        if (q.hangup === 'yes') return res.send('noop=bye');

        // שלב 1: בקשת הקלטה מהמשתמש
        if (!q.RecordPath) {
            const fileName = 'query_' + Date.now();
            return res.send(`read=t-אנא אמרו את שם השיעור לאחר הצפצוף&record=yes&record_filename=${fileName}`);
        }

        // שלב 2: הורדת ההקלטה מימות המשיח
        const downloadUrl = `${YM}DownloadFile?token=${encodeURIComponent(TOKEN)}&path=${encodeURIComponent(q.RecordPath)}`;
        const audioRes = await fetchWithTimeout(downloadUrl);
        if (!audioRes.ok) throw new Error('שגיאה בהורדת הקובץ מימות המשיח');
        const audioBuf = Buffer.from(await audioRes.arrayBuffer());

        // מחיקת ההקלטה מהשרת של ימות המשיח ברקע (חיסכון במקום)
        fetchWithTimeout(`${YM}FileAction?token=${encodeURIComponent(TOKEN)}&action=delete&what=${encodeURIComponent(q.RecordPath)}`).catch(() => null);

        // שלב 3: שליחה ל-Gemini לזיהוי דיבור
        const prompt = "תמלל את ההקלטה לעברית. החזר אך ורק את מילות החיפוש המדויקות ללא מילות קישור, מרכאות או תוספות.";
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`;
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
        }, 20000);

        const geminiData = await geminiRes.json();
        const queryText = (((geminiData.candidates || [])[0] || {}).content || {}).parts[0].text;
        
        if (!queryText || queryText.trim() === '') {
            return res.send('id_list_message=t-לא הצלחתי לזהות מילים בהקלטה&go_to_folder=/');
        }
        
        const cleanQuery = queryText.trim().replace(/\n/g, ' ');

        // שלב 4: חיפוש ב-YouTube API
        const ytUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(cleanQuery)}&type=video&maxResults=1&key=${YT_KEY}`;
        const ytRes = await fetchWithTimeout(ytUrl);
        const ytData = await ytRes.json();

        if (!ytData.items || ytData.items.length === 0) {
            return res.send('id_list_message=t-לא מצאתי תוצאות לחיפוש זה&go_to_folder=/');
        }

        const videoId = ytData.items[0].id.videoId;

        // שלב 5: חילוץ כתובת השמע הישירה באמצעות yt-dlp
        const ytDlpOptions = {
            dumpJson: true,
            format: 'bestaudio/best',
            noWarnings: true,
            noCheckCertificates: true
        };
        const info = await ytDlp(`https://www.youtube.com/watch?v=${videoId}`, ytDlpOptions);
        
        if (!info || !info.url) {
            return res.send('id_list_message=t-תקלה בחילוץ השמע מהשרת&go_to_folder=/');
        }

        // שלב 6: הפעלת השמע בימות המשיח
        return res.send(`read=t-השיעור מתחיל&playfile=${info.url}&go_to_folder=/`);

    } catch (e) {
        console.error('Error during processing:', e);
        if (!res.headersSent) {
            res.send('id_list_message=t-אירעה שגיאה במערכת נסו שוב מאוחר יותר&go_to_folder=/');
        }
    }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`YouTube Line Server running on port ${port}`));
