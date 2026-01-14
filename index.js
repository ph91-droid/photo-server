const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Dropbox } = require('dropbox');
const cron = require('node-cron');
const Jimp = require('jimp');

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

// キャッシュ用 (一時リンクを保存)
let urlCache = {
    data: null,
    expires: 0
};
const CACHE_DURATION = 3 * 60 * 60 * 1000; // 3時間

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
                // 存在すればスキップ
            } catch (e) {
                // なければ作成
                addLog(`Optimizing: ${file.name}`);
                try {
                    const download = await dbx.filesDownload({ path: file.path_lower });
                    const buffer = download.result.fileBinary;
                    const image = await Jimp.read(buffer);

                    // インストール済みのJimp v0.x系の書き方に合わせる
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

// フォルダの自動作成と初期化
async function initFolders() {
    for (const p of Object.values(PATHS)) {
        try {
            await dbx.filesGetMetadata({ path: p });
        } catch (e) {
            try {
                await dbx.filesCreateFolderV2({ path: p });
                addLog(`Created folder: ${p}`);
            } catch (err) {
                // 親フォルダがない場合などのエラーは無視（再試行される）
            }
        }
    }
    optimizeImages(); // 初回実行
}
initFolders();

// API: デバッグ情報の取得
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
        const now = Date.now();
        // キャッシュチェック
        if (urlCache.data && urlCache.expires > now) {
            addLog('Returning images from cache');
            return res.json(urlCache.data);
        }

        addLog('Fetching fresh image links from Dropbox...');
        const list = await dbx.filesListFolder({ path: PATHS.WEB });
        const files = list.result.entries.filter(e => e['.tag'] === 'file');

        // バッチ処理でリンクを取得 (10枚ずつ)
        const batchSize = 10;
        const images = [];

        for (let i = 0; i < files.length; i += batchSize) {
            const batch = files.slice(i, i + batchSize);
            const batchResults = await Promise.all(batch.map(async (f) => {
                try {
                    const link = await dbx.filesGetTemporaryLink({ path: f.path_lower });
                    return {
                        name: f.name,
                        url: link.result.link
                    };
                } catch (e) {
                    addLog(`Error fetching link for ${f.name}: ${e.message}`);
                    return null;
                }
            }));
            images.push(...batchResults.filter(img => img !== null));
            addLog(`Fetched batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(files.length / batchSize)}`);
        }

        // キャッシュ更新
        urlCache = {
            data: images,
            expires: now + CACHE_DURATION
        };

        res.json(images);
    } catch (err) {
        addLog(`API Images Error: ${err.message}`);
        res.status(500).json({ error: 'Failed' }); // フロントエンドの想定に合わせる
    }
});

// API: セレクト結果保存
app.post('/api/select', async (req, res) => {
    const { userName, selectedImages } = req.body;

    if (!userName || !selectedImages) {
        return res.status(400).json({ error: 'User name and selections are required' });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `${userName}_${timestamp}.json`;
    const filePath = `${PATHS.SELECTIONS}/${fileName}`;

    const data = {
        userName,
        selectionDate: new Date().toLocaleString('ja-JP'),
        count: selectedImages.length,
        images: selectedImages
    };

    try {
        await dbx.filesUpload({
            path: filePath,
            contents: JSON.stringify(data, null, 2),
            mode: { '.tag': 'overwrite' }
        });
        res.json({ message: 'Saved to Dropbox', fileName });
    } catch (err) {
        res.status(500).json({ error: 'Failed to save to Dropbox' });
    }
});

// クリーンアップタスク (毎日深夜0時に自動実行)
cron.schedule('0 0 * * *', async () => {
    console.log('Running cleanup check...');
    const now = new Date();
    const limitDays = 30;

    async function processCleanup(folderPath, targetPath, isDelete = false) {
        try {
            const list = await dbx.filesListFolder({ path: folderPath });
            for (const item of list.result.entries) {
                if (item['.tag'] !== 'file') continue;
                const created = new Date(item.server_modified || now);
                const diffDays = (now - created) / (1000 * 60 * 60 * 24);

                if (diffDays > limitDays) {
                    if (isDelete) {
                        await dbx.filesDeleteV2({ path: item.path_lower });
                        console.log(`Deleted expired file: ${item.name}`);
                    } else {
                        await dbx.filesMoveV2({
                            from_path: item.path_lower,
                            to_path: `${targetPath}/${item.name}`
                        });
                        console.log(`Archived expired file: ${item.name}`);
                    }
                }
            }
        } catch (err) {
            console.error(`Cleanup error in ${folderPath}:`, err.message);
        }
    }

    await processCleanup(PATHS.SOURCE, PATHS.ARCHIVE);
    await processCleanup(PATHS.FINAL, null, true);
    await processCleanup(PATHS.WEB, null, true);
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
