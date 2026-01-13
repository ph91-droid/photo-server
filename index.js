const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Dropbox } = require('dropbox');
const cron = require('node-cron');
const Jimp = require('jimp');

const app = express();
const PORT = process.env.PORT || 5000;

// Dropbox設定
const dbx = new Dropbox({
    refreshToken: process.env.DBX_REFRESH_TOKEN,
    clientId: process.env.DBX_CLIENT_ID,
    clientSecret: process.env.DBX_CLIENT_SECRET
});

app.use(cors());
app.use(express.json());

// フォルダパス設定
const PATHS = {
    SOURCE: '/PhotoSelection/Source',
    WEB: '/PhotoSelection/Web',
    ARCHIVE: '/PhotoSelection/Archive',
    FINAL: '/PhotoSelection/Final',
    SELECTIONS: '/PhotoSelection/Selections'
};

let statusLogs = [];
function addLog(msg) {
    const log = `[${new Date().toISOString()}] ${msg}`;
    console.log(log);
    statusLogs.push(log);
    if (statusLogs.length > 50) statusLogs.shift();
}

// 画像の最適化（リサイズ処理）
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
            } catch (e) {
                addLog(`Optimizing: ${file.name}`);
                try {
                    const download = await dbx.filesDownload({ path: file.path_lower });
                    const buffer = download.result.fileBinary;
                    const image = await Jimp.read(buffer);
                    
                    // Jimp v0.xの記法
                    image.resize(1000, Jimp.AUTO).quality(80);
                    
                    const optimizedBuffer = await image.getBufferAsync('image/jpeg');
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

// 初期化
async function initFolders() {
    for (const p of Object.values(PATHS)) {
        try {
            await dbx.filesGetMetadata({ path: p });
        } catch (e) {
            try {
                await dbx.filesCreateFolderV2({ path: p });
                addLog(`Created folder: ${p}`);
            } catch (err) {}
        }
    }
    optimizeImages();
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
        res.status(500).json({ error: 'Failed' });
    }
});

app.post('/api/select', async (req, res) => {
    const { userName, selectedImages } = req.body;
    if (!userName || !selectedImages) return res.status(400).send('Missing params');

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `${userName}_${timestamp}.json`;
    const filePath = `${PATHS.SELECTIONS}/${fileName}`;
    const data = { userName, selectionDate: new Date().toLocaleString('ja-JP'), count: selectedImages.length, images: selectedImages };

    try {
        await dbx.filesUpload({ path: filePath, contents: JSON.stringify(data, null, 2), mode: { '.tag': 'overwrite' } });
        res.json({ message: 'Success', fileName });
    } catch (err) {
        res.status(500).send('Save Error');
    }
});

// クリーンアップ
cron.schedule('0 0 * * *', async () => {
    const now = new Date();
    const limitDays = 30;
    async function processCleanup(folderPath, targetPath, isDelete = false) {
        try {
            const list = await dbx.filesListFolder({ path: folderPath });
            for (const item of list.result.entries) {
                if (item['.tag'] !== 'file') continue;
                const created = new Date(item.server_modified || now);
                if ((now - created) / (1000 * 60 * 60 * 24) > limitDays) {
                    if (isDelete) await dbx.filesDeleteV2({ path: item.path_lower });
                    else await dbx.filesMoveV2({ from_path: item.path_lower, to_path: `${targetPath}/${item.name}` });
                }
            }
        } catch (err) {}
    }
    await processCleanup(PATHS.SOURCE, PATHS.ARCHIVE);
    await processCleanup(PATHS.FINAL, null, true);
    await processCleanup(PATHS.WEB, null, true);
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
