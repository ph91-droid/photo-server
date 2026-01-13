const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Dropbox } = require('dropbox');
const cron = require('node-cron');
const  Jimp  = require('jimp');

const app = express();
const PORT = process.env.PORT || 5000;

// Dropbox設定 (Refresh Tokenを使用して永続化)
const dbx = new Dropbox({
    refreshToken: process.env.DBX_REFRESH_TOKEN,
    clientId: process.env.DBX_CLIENT_ID,
    clientSecret: process.env.DBX_CLIENT_SECRET
});

app.use(cors());
app.use(express.json());

// フォルダパス設定
const PATHS = {
    SOURCE: '/PhotoSelection/Source',  // あなたが写真を入れる元データ
    WEB: '/PhotoSelection/Web',        // システムが生成する軽量版
    ARCHIVE: '/PhotoSelection/Archive', // 期間終了後に移動
    FINAL: '/PhotoSelection/Final',     // 最終納品用
    SELECTIONS: '/PhotoSelection/Selections' // 結果保存
};

// ログ保持用
let statusLogs = [];
function addLog(msg) {
    const log = `[${new Date().toISOString()}] ${msg}`;
    console.log(log);
    statusLogs.push(log);
    if (statusLogs.length > 50) statusLogs.shift();
}

// 修正後のoptimizeImages（ログ出力強化）
async function optimizeImages() {
    try {
        addLog('Starting optimization...');
        const list = await dbx.filesListFolder({ path: PATHS.SOURCE });
        const sourceFiles = list.result.entries.filter(e => e['.tag'] === 'file');
        addLog(`Found ${sourceFiles.length} images in Source.`);

        for (const file of sourceFiles) {
            const webPath = `${PATHS.WEB}/${file.name}`;
            try {
                await dbx.filesGetMetadata({ path: webPath });
                // 存在すればスキップ
            } catch (e) {
                // なければ作成
                addLog(`Optimizing: ${file.name}`);
                try {
                    const download = await dbx.filesDownload({ path: file.path_lower });
                    const buffer = download.result.fileBinary;
                    const image = await Jimp.read(buffer);
                    image.resize(1000, Jimp.AUTO).quality(80);
                    const optimizedBuffer = await image.getBufferAsync(Jimp.MIME_JPEG);
                    await dbx.filesUpload({
                        path: webPath,
                        contents: optimizedBuffer,
                        mode: { '.tag': 'overwrite' }
                    });
                    addLog(`Success: ${file.name}`);
                } catch (innerErr) {
                    addLog(`Failed ${file.name}: ${innerErr.message}`);
                }
            }
        }
        addLog('Optimization cycle finished.');
    } catch (error) {
        addLog(`Optimization Error: ${error.message}`);
    }
}

// フォルダの自動作成
async function initFolders() {
    for (const p of Object.values(PATHS)) {
        try {
            await dbx.filesGetMetadata({ path: p });
        } catch (e) {
            await dbx.filesCreateFolderV2({ path: p });
        }
    }
    optimizeImages(); // 初回実行
}
initFolders();

app.get('/api/debug', async (req, res) => {
    try {
        const sourceList = await dbx.filesListFolder({ path: PATHS.SOURCE });
        const webList = await dbx.filesListFolder({ path: PATHS.WEB });
        res.json({
            status: 'ok',
            source_count: sourceList.result.entries.length,
            web_count: webList.result.entries.length,
            logs: statusLogs
        });
    } catch (e) {
        res.status(500).json({ error: e.message, logs: statusLogs });
    }
});

// API: 画像一覧取得
app.get('/api/images', async (req, res) => {
    try {
        const list = await dbx.filesListFolder({ path: PATHS.WEB });
        const files = list.result.entries.filter(e => e['.tag'] === 'file');

        const images = await Promise.all(files.map(async (f) => {
            const link = await dbx.filesGetTemporaryLink({ path: f.path_lower });
            return {
                name: f.name,
                url: link.result.link
            };
        }));

        res.json(images);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch images from Dropbox' });
    }
});

// API: セレクト結果保存
app.post('/api/select', async (req, res) => {
    const { userName, selectedImages } = req.body;
    if (!userName || !selectedImages) return res.status(400).json({ error: 'Required' });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `${userName}_${timestamp}.json`;
    const data = { userName, selectionDate: new Date().toLocaleString('ja-JP'), images: selectedImages };
    try {
        await dbx.filesUpload({
            path: `${PATHS.SELECTIONS}/${fileName}`,
            contents: JSON.stringify(data, null, 2),
            mode: { '.tag': 'overwrite' }
        });
        res.json({ message: 'Saved' });
    } catch (err) {
        res.status(500).json({ error: 'Failed' });
    }
});

cron.schedule('0 0 * * *', async () => { /* クリーンアップ処理 */ });

app.listen(PORT, () => console.log(`Run on ${PORT}`));




