const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Dropbox } = require('dropbox');
const cron = require('node-cron');
const { Jimp } = require('jimp');

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
    FINAL: '/PhotoSelection/Final',     // 納品用フォルダ
    SELECTIONS: '/PhotoSelection/Selections' // 結果保存
};

// 画像最適化 (Source -> Web)
async function optimizeImages() {
    try {
        const list = await dbx.filesListFolder({ path: PATHS.SOURCE });
        const sourceFiles = list.result.entries.filter(e => e['.tag'] === 'file');

        for (const file of sourceFiles) {
            const webPath = `${PATHS.WEB}/${file.name}`;
            try {
                await dbx.filesGetMetadata({ path: webPath });
                continue;
            } catch (e) {
                console.log(`Optimizing: ${file.name}`);
                const download = await dbx.filesDownload({ path: file.path_lower });
                const buffer = download.result.fileBinary;
                const image = await Jimp.read(buffer);
                image.resize({ w: 1000 }).quality(80);
                const optimizedBuffer = await image.getBuffer('image/jpeg');
                await dbx.filesUpload({
                    path: webPath,
                    contents: optimizedBuffer,
                    mode: { '.tag': 'overwrite' }
                });
            }
        }
    } catch (error) {
        console.error('Optimization error:', error);
    }
}

async function initFolders() {
    for (const p of Object.values(PATHS)) {
        try {
            await dbx.filesGetMetadata({ path: p });
        } catch (e) {
            await dbx.filesCreateFolderV2({ path: p });
        }
    }
    optimizeImages();
}
initFolders();

app.get('/api/images', async (req, res) => {
    try {
        const list = await dbx.filesListFolder({ path: PATHS.WEB });
        const files = list.result.entries.filter(e => e['.tag'] === 'file');
        const images = await Promise.all(files.map(async (f) => {
            const link = await dbx.filesGetTemporaryLink({ path: f.path_lower });
            return { name: f.name, url: link.result.link };
        }));
        res.json(images);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch images from Dropbox' });
    }
});

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

cron.schedule('0 0 * * *', async () => {
    console.log('Cleanup...');
    // (クリーンアップ処理はそのまま維持)
});

app.listen(PORT, () => console.log(`Run on ${PORT}`));
