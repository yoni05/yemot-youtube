const express = require('express');
const ytDlp = require('yt-dlp-exec');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

// הגדרת נתיב מנוע ההמרה
ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(express.urlencoded({ extended: true }));

const TOKEN = process.env.YEMOT_TOKEN || '';
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const YT_KEY = process.env.YOUTUBE_API_KEY || '';
const YM = 'https://www.call2all.co.il/ym/api/';

async function fetchWithTimeout(url, options = {}, timeout = 15000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return response;
}

app.get('/', (req, res) => { res.send('YouTube Line Server OK (Optimized MP3 Proxy)'); });

// נתיב נקי להזרמה (Proxy) והמרה ל-MP3 באופטימיזציה לטלפון
app.get('/stream/:videoId.mp3', async (req, res) => {
    const videoId = req.params.videoId;
    if (!videoId) return res.status(400).send('Missing video ID');

    try {
        // שליחת כותרות מידיות למניעת ניתוק מצד ימות המשיח
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Transfer-Encoding', 'chunked');

        const info = await ytDlp(`https://www.youtube.com/watch?v=${videoId}`, {
            dumpJson: true,
            format: 'bestaudio[ext=m4a]/bestaudio/best',
            noWarnings: true,
            noCheckCertificates: true
        });

        if (!info || !info.url) throw new Error('No audio URL found');
        
        ffmpeg(info.url)
            .format('mp3')
            .audioCodec('libmp3lame')
            .audioChannels(1) // מונו לשיפור מהירות וחיסכון ברוחב פס
            .audioBitrate('32k') // דחיסה מותאמת לאיכות טלפון
            .on('error', (err) => {
                console.error('FFmpeg stream error:', err.message);
            })
            .pipe(res, { end: true });

    } catch (e) {
        console.error('Streaming error:', e.message);
        if (!res.headersSent) res.status(500).end();
    }
});

app.all(['/yemot', '/yemot/:e'], async (req, res) => {
    const q = { ...req.query, ...req.body };
    res.type('text/plain');

    try {
        if (q.hangup === 'yes') return res.send('noop=bye');

        if (!q.RecordPath) {
            const fileName = 'query_' + Date.now();
            return res.send(`read=t-אנא אמרו את שם השיעור לאחר הצפצוף&record=yes&record_filename=${fileName}`);
        }

        const downloadUrl = `${YM}DownloadFile?token=${encodeURIComponent(TOKEN)}&path=${encodeURIComponent(q.RecordPath)}`;
        const audioRes = await fetchWithTimeout(downloadUrl);
        if (!audioRes.ok) throw new Error('שגיאה בהורדת הקובץ מימות המשיח');
        const audioBuf = Buffer.from(await audioRes.arrayBuffer());

        fetchWithTimeout(`${YM}FileAction?token=${encodeURIComponent(TOKEN)}&action=delete&what=${encodeURIComponent(q.RecordPath)}`).catch(() => null);

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
        const queryRawText = (((geminiData.candidates || [])[0] || {}).content || {}).parts[0].text || '';
        
        // סינון קפדני: השארת אותיות, מספרים ורווחים בלבד, למניעת קריסות בחיפוש
        const cleanQuery = queryRawText.replace(/[^א-תa-zA-Z0-9\s]/g, '').trim().replace(/\s+/g, ' ');
        
        if (!cleanQuery) {
            return res.send('id_list_message=t-לא הצלחתי לזהות מילים ברורות בהקלטה&go_to_folder=/');
        }

        const ytUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(cleanQuery)}&type=video&maxResults=1&key=${YT_KEY}`;
        const ytRes = await fetchWithTimeout(ytUrl);
        const ytData = await ytRes.json();

        if (!ytData.items || ytData.items.length === 0) {
            return res.send('id_list_message=t-לא מצאתי תוצאות לחיפוש זה&go_to_folder=/');
        }

        const videoId = ytData.items[0].id.videoId;

        // הפניה לנתיב המקומי בשרת (Proxy)
        const hostUrl = `https://${req.get('host')}`;
        const streamUrl = `${hostUrl}/stream/${videoId}.mp3`;
        
        return res.send(`read=t-השיעור מתחיל&playfile=${streamUrl}&go_to_folder=/`);

    } catch (e) {
        console.error('Error during processing:', e.message);
        if (!res.headersSent) {
            res.send('id_list_message=t-אירעה שגיאה במערכת נסו שוב מאוחר יותר&go_to_folder=/');
        }
    }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`YouTube Line Server running on port ${port}`));
