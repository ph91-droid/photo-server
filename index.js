const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Dropbox } = require('dropbox');
const cron = require('node-cron');

const Jimp = require('jimp');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 5000;

// Dropbox設定 (Refresh Tokenを使用して永続化)
const dbx = new Dropbox({
    refreshToken: process.env.DBX_REFRESH_TOKEN || '-mndMbc7yYMAAAAAAAAAAVBVQnxO9OEvwTxgwc2hAUwMHdk7oNSBQB1uUI2fNDpT',
    clientId: process.env.DBX_CLIENT_ID || 'f59tf1b3v8ln9i6',
    clientSecret: process.env.DBX_CLIENT_SECRET || 'ad9t4cgqr4qqt8l'
});

app.use(cors());
app.use(express.json());

// フォルダパス設定
const PATHS = {
    SOURCE: '/PhotoSelection/Source',  // あなたが写真を入れる元データ
    WEB: '/PhotoSelection/Web',        // システムが生成する軽量版
    ARCHIVE: '/PhotoSelection/Archive', // 期間終了後に移動
    FINAL: '/PhotoSelection/Final',     // 最終納品用
    FINAL_WEB: '/PhotoSelection/Final_Web', // 最終納品用の軽量版
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


// Final画像の最適化（スマホ閲覧・ダウンロード用）
async function optimizeFinalImages() {
    try {
        addLog('Starting Final optimization...');
        // Finalフォルダ確認
        try {
            await dbx.filesGetMetadata({ path: PATHS.FINAL });
        } catch (e) {
            addLog('Final folder not found, skipping optimization.');
            return;
        }

        // Final_Webフォルダ確認・作成
        try {
            await dbx.filesGetMetadata({ path: PATHS.FINAL_WEB });
        } catch (e) {
            await dbx.filesCreateFolderV2({ path: PATHS.FINAL_WEB });
        }

        const list = await dbx.filesListFolder({ path: PATHS.FINAL });
        const finalFiles = list.result.entries.filter(e => e['.tag'] === 'file');
        addLog(`Found ${finalFiles.length} images in Final.`);

        for (const file of finalFiles) {
            const webPath = `${PATHS.FINAL_WEB}/${file.name}`;
            try {
                await dbx.filesGetMetadata({ path: webPath });
                // 存在すればスキップ
            } catch (e) {
                // なければ作成
                addLog(`Optimizing Final: ${file.name}`);
                try {
                    const download = await dbx.filesDownload({ path: file.path_lower });
                    const buffer = download.result.fileBinary;
                    const image = await Jimp.read(buffer);

                    // スマホ向けに少し大きめでリサイズ (長辺1920px)
                    image.resize(1920, Jimp.AUTO).quality(85);

                    const optimizedBuffer = await image.getBufferAsync('image/jpeg');
                    await dbx.filesUpload({
                        path: webPath,
                        contents: optimizedBuffer,
                        mode: { '.tag': 'overwrite' }
                    });
                    addLog(`Success Final: ${file.name}`);
                } catch (innerErr) {
                    addLog(`Failed Final ${file.name}: ${innerErr.message}`);
                }
            }
        }
        addLog('Final optimization cycle finished.');
    } catch (error) {
        addLog(`Final Optimization Error: ${error.message}`);
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
    optimizeFinalImages(); // Final用も実行
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
                        url: link.result.link,
                        date: f.server_modified // 日付ソート用に追加
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

// API: Final画像一覧取得
app.get('/api/final', async (req, res) => {
    try {
        // リクエスト時に最適化チェックを非同期で走らせる（待たない）
        optimizeFinalImages();

        addLog('Fetching Final image links...');

        // Final（元画像）とFinal_Web（軽量画像）の両方を取得
        const [finalList, webList] = await Promise.all([
            dbx.filesListFolder({ path: PATHS.FINAL }).catch(() => ({ result: { entries: [] } })),
            dbx.filesListFolder({ path: PATHS.FINAL_WEB }).catch(() => ({ result: { entries: [] } }))
        ]);

        const finalFiles = finalList.result.entries.filter(e => e['.tag'] === 'file');

        // 軽量版のマップ作成
        const webMap = new Map();
        webList.result.entries.forEach(f => {
            if (f['.tag'] === 'file') webMap.set(f.name, f);
        });

        // リンク取得（バッチ処理）
        const batchSize = 10;
        const images = [];

        for (let i = 0; i < finalFiles.length; i += batchSize) {
            const batch = finalFiles.slice(i, i + batchSize);
            const batchResults = await Promise.all(batch.map(async (f) => {
                try {
                    // Original link
                    const originalLink = await dbx.filesGetTemporaryLink({ path: f.path_lower });

                    // Mobile link (あれば軽量版、なければ元画像)
                    let mobileUrl = originalLink.result.link;
                    if (webMap.has(f.name)) {
                        const webFile = webMap.get(f.name);
                        const webLink = await dbx.filesGetTemporaryLink({ path: webFile.path_lower });
                        mobileUrl = webLink.result.link;
                    }

                    return {
                        name: f.name,
                        original_url: originalLink.result.link,
                        mobile_url: mobileUrl,
                        date: f.server_modified
                    };
                } catch (e) {
                    addLog(`Error fetching link for ${f.name}: ${e.message}`);
                    return null;
                }
            }));
            images.push(...batchResults.filter(img => img !== null));
        }

        res.json(images);
    } catch (err) {
        addLog(`API Final Error: ${err.message}`);
        res.status(500).json({ error: 'Failed' });
    }
});



// API: 一括ダウンロード (ZIP) - PC用
app.get('/api/final/zip', async (req, res) => {
    try {
        const type = req.query.type || 'original';
        const targetDir = type === 'mobile' ? PATHS.FINAL_WEB : PATHS.FINAL;

        // フォルダ存在確認
        try {
            await dbx.filesGetMetadata({ path: targetDir });
        } catch (e) {
            return res.status(404).send('Target folder not found');
        }

        addLog(`Starting ZIP download for ${type}...`);

        // レスポンスヘッダー設定
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="photos_${type}.zip"`);

        // tarコマンドでZIP作成してストリーム出力
        // Dropbox内のファイルを直接ローカルのtarに渡すのは難しい（マウントされていないため）。
        // Dropbox APIには「フォルダをZIPでダウンロード」する機能があるため、そちらを使用するのが確実。

        // Dropbox API: /files/download_zip
        const download = await dbx.filesDownloadZip({ path: targetDir });

        // binaryデータを返す
        res.send(download.result.fileBinary);
        addLog(`ZIP download finished for ${type}`);

    } catch (err) {
        addLog(`ZIP API Error: ${err.message}`);
        // ヘッダー送信後かもしれないので、ログ出力に留めるか、可能ならエラーを返す
        if (!res.headersSent) res.status(500).send('ZIP generation failed');
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
    await processCleanup(PATHS.FINAL_WEB, null, true);
    await processCleanup(PATHS.WEB, null, true);
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
