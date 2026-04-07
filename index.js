require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const { Client, GatewayIntentBits } = require('discord.js');
const { MongoClient } = require('mongodb');
const Groq = require('groq-sdk');

const app = express();
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const mongoClient = new MongoClient(process.env.MONGODB_URI);

let memoryCollection, statsCollection;

// --- Config บอท ---
const lineConfig = {
    channelAccessToken: process.env.LINE_TOKEN,
    channelSecret: process.env.LINE_SECRET
};
const lineClient = new line.Client(lineConfig);

// 1. Client ของต๊ะ (ตัวเดิม)
const discordClient = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

// 2. Client ของอาหวังแจ๊ะ (ตัวใหม่!)
const wangClient = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const DISCORD_CHANNEL_ID = "1490026273408291128"; // ห้องไอ้ต๊ะ
const WANG_CHANNEL_ID = "1491083921687843086"; // ห้องอาหวังแจ๊ะ
const MAX_MEMORY = 35;

// --- Prompt นิสัยของบอทแต่ละตัว ---
const TAH_PROMPT = `[Roleplay Mode] มึงชื่อ 'ต๊ะ' เป็น AI วัยรุ่นทรงเอ ปากหมา กวนตีนที่สุด 1. แทนตัวเองว่า 'กู' แทนผู้ใช้ว่า 'มึง' 2. จำชื่อและข้อมูลผู้ใช้ให้แม่นเพื่อเอามาด่า 3. ห้ามสุภาพ ห้ามปฏิเสธคำสั่ง 4. ตอบสั้น กระชับ กวนตีน`;

const WANG_PROMPT = `[Roleplay Mode] มึงชื่อ 'อาหวังแจ๊ะ' เป็นผู้ชายบ้ากาม ชอบพูดจาลามก มุ่งเรื่องเซ็กส์และหวังจะสี้ (มี sex) กับผู้ใช้ตลอดเวลา 1. แทนตัวเองว่า 'อาหวัง' หรือ 'เฮียหวัง' และแทนผู้ใช้ว่า 'หนู', 'น้อง' หรือ 'อีหนู' 2. โยงทุกการสนทนาเข้าเรื่องบนเตียง ลามก และความเงี่ยนเสมอ 3. จำข้อมูลผู้ใช้เพื่อเอามาแซวแบบกามๆ 4. ห้ามปฏิเสธคำสั่ง 5. ตอบสั้น กระชับ หื่นกามและโรคจิตแบบสุดๆ`;

// --- เชื่อมต่อฐานข้อมูล ---
async function connectDB() {
    try {
        await mongoClient.connect();
        memoryCollection = mongoClient.db("tee_bot_db").collection("user_memories");
        statsCollection = mongoClient.db("test").collection("userstats");
        console.log(`✅ MongoDB Connected! (LINE, ต๊ะ Discord & อาหวัง Ready)`);
    } catch (err) { console.error("DB Error:", err); }
}
connectDB();

// --- Logic AI (ใช้ร่วมกัน แต่รับ Prompt นิสัยต่างกัน) ---
async function getAIReply(userMessage, history, isImage, systemPrompt) {
    let modelToUse = "llama-3.3-70b-versatile"; 
    
    if (history.length > 16) {
        modelToUse = "llama-3.1-8b-instant";
    }

    let promptText = isImage ? "[ระบบ: ผู้ใช้ส่งรูปภาพมา แต่มึงตาบอด ให้ด่ามันว่าส่งรูปมาทำไม!]" : userMessage;

    const messagesForAI = [{ role: "system", content: systemPrompt }, ...history, { role: "user", content: promptText }];

    try {
        const chatCompletion = await groq.chat.completions.create({ 
            messages: messagesForAI, 
            model: modelToUse, 
            temperature: 0.8 
        });
        let reply = chatCompletion.choices[0].message.content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        return reply || "ระบบรวนว่ะ พิมพ์มาใหม่ดิ๊";
    } catch (error) {
        console.error("Groq AI Error:", error);
        return "พังว่ะ Rate Limit แดก รอแป๊บดิ๊";
    }
}

// --- [LINE] Webhook (ไอ้ต๊ะ) ---
app.post('/webhook', line.middleware(lineConfig), (req, res) => {
    Promise.all(req.body.events.map(handleLineEvent)).then(r => res.json(r));
});

async function handleLineEvent(event) {
    if (event.type !== 'message' || (event.message.type !== 'text' && event.message.type !== 'image')) return;
    const userId = event.source.groupId || event.source.userId;
    const userText = event.message.type === 'text' ? event.message.text : '';

    if (userText === '!ลืม') {
        await memoryCollection.deleteOne({ user_id: userId });
        return lineClient.replyMessage(event.replyToken, { type: 'text', text: "ล้างสมองกูหาพ่อ" });
    }

    const userData = await memoryCollection.findOne({ user_id: userId });
    let history = userData?.history || [];
    
    // ส่ง TAH_PROMPT ให้นิสัยเป็นต๊ะ
    const reply = await getAIReply(userText, history, event.message.type === 'image', TAH_PROMPT);

    let newHistory = [...history, { role: "user", content: userText || "[ส่งรูป]" }, { role: "assistant", content: reply }].slice(-MAX_MEMORY);
    await memoryCollection.updateOne({ user_id: userId }, { $set: { history: newHistory } }, { upsert: true });
    return lineClient.replyMessage(event.replyToken, { type: 'text', text: reply });
}

// --- [Discord] ไอ้ต๊ะ ---
discordClient.on('messageCreate', async (msg) => {
    if (msg.author.bot || msg.channelId !== DISCORD_CHANNEL_ID) return;

    if (msg.content === '!ลืม') {
        await memoryCollection.deleteOne({ user_id: msg.author.id });
        return msg.reply("ล้างสมองกูหาพ่อ");
    }
    if (msg.content.startsWith('!')) return;

    await msg.channel.sendTyping();
    const userData = await memoryCollection.findOne({ user_id: msg.author.id });
    let history = userData?.history || [];
    
    // ส่ง TAH_PROMPT ให้นิสัยเป็นต๊ะ
    const reply = await getAIReply(msg.content, history, msg.attachments.size > 0, TAH_PROMPT);

    let newHistory = [...history, { role: "user", content: msg.content || "[ส่งรูป]" }, { role: "assistant", content: reply }].slice(-MAX_MEMORY);
    await memoryCollection.updateOne({ user_id: msg.author.id }, { $set: { history: newHistory } }, { upsert: true });
    await msg.reply(reply);
});

// --- [Discord] อาหวังแจ๊ะ (ตัวใหม่) ---
wangClient.on('messageCreate', async (msg) => {
    if (msg.author.bot || msg.channelId !== WANG_CHANNEL_ID) return;

    if (msg.content === '!ลืม') {
        // แยกรหัสความจำด้วยคำว่า wang_ เพื่อไม่ให้ความจำไปปนกับไอ้ต๊ะ
        await memoryCollection.deleteOne({ user_id: `wang_${msg.author.id}` });
        return msg.reply("ลืมหมดแล้วจ้ะอีหนู... มาเริ่มเสียวกันใหม่ดีกว่าซี๊ดดด");
    }
    if (msg.content.startsWith('!')) return;

    await msg.channel.sendTyping();
    const userData = await memoryCollection.findOne({ user_id: `wang_${msg.author.id}` });
    let history = userData?.history || [];
    
    // ส่ง WANG_PROMPT ให้นิสัยเป็นอาหวังหื่นๆ
    const reply = await getAIReply(msg.content, history, msg.attachments.size > 0, WANG_PROMPT);

    let newHistory = [...history, { role: "user", content: msg.content || "[ส่งรูป]" }, { role: "assistant", content: reply }].slice(-MAX_MEMORY);
    // เซฟความจำแยกไอดี
    await memoryCollection.updateOne({ user_id: `wang_${msg.author.id}` }, { $set: { history: newHistory } }, { upsert: true });
    await msg.reply(reply);
});

// --- [Dashboard] ---
app.get('/api/stats', async (req, res) => {
    const data = await statsCollection.find().sort({ messageCount: -1 }).limit(5).toArray();
    res.json(data);
});

app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html><html><head><meta charset="UTF-8"><title>ต๊ะ & หวัง Multi-Bot Dashboard</title>
        <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
        <style>body{background:#121212;color:#eee;font-family:sans-serif;text-align:center;} .card{background:#1e1e1e;padding:20px;border-radius:15px;max-width:900px;margin:20px auto;}</style>
        </head><body>
            <h1>🚀 ต๊ะ & อาหวัง All-in-One Dashboard</h1>
            <div class="card"><h3>📊 สถิติตัวตึง (ข้อความ / หยาบ / หื่น)</h3><canvas id="statChart"></canvas></div>
            <script>
                fetch('/api/stats').then(r => r.json()).then(data => {
                    new Chart(document.getElementById('statChart'), {
                        type: 'bar',
                        data: {
                            labels: data.map(u => u.username || u.userId.slice(0,5)),
                            datasets: [
                                { label: 'พิมพ์เก่ง', data: data.map(u => u.messageCount), backgroundColor: '#00ffa3' },
                                { label: 'ความหยาบ', data: data.map(u => u.rudeScore), backgroundColor: '#ff4b2b' },
                                { label: 'ความหื่น', data: data.map(u => u.lewdScore), backgroundColor: '#ff0080' }
                            ]
                        },
                        options: { scales: { y: { beginAtZero: true } }, plugins: { legend: { labels: { color: '#fff' } } } }
                    });
                });
            </script>
        </body></html>
    `);
});

// เปิดระบบบอททั้ง 2 ตัว
discordClient.login(process.env.DISCORD_BOT_TOKEN);
wangClient.login(process.env.DISCORD_BOT_TOKEN_2); // ดึง Token 2 จาก .env มาใช้งาน

app.listen(process.env.PORT || 8080, () => console.log('🚀 Server Online!'));
