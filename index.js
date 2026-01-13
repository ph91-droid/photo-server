const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Dropbox } = require('dropbox');
const cron = require('node-cron');
const { Jimp } = require('jimp');

const app = express();
const PORT = process.env.PORT || 5000;

// Dropboxトークン (RenderのEnvironment Variablesから取得)
const DBX_ACCESS_TOKEN = process.env.DBX_ACCESS_TOKEN;
if (!DBX_ACCESS_TOKEN) {
    console.error('Error: DBX_ACCESS_TOKEN is not defined in environment variables.');
    process.exit(1);
}
const dbx = new Dropbox({ accessToken: DBX_ACCESS_TOKEN });

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

// 画像最適化 (Source -> Web)
async function optimizeImages() {
    try {
        const list = await dbx.filesListFolder({ path: PATHS.SOURCE });
        const sourceFiles = list.result.entries.filter(e => e['.tag'] === 'file');

        for (const file of sourceFiles) {
            const webPath = `${PATHS.WEB}/${file.name}`;

            // すでに存在するかチェック
            try {
                await dbx.filesGetMetadata({ path: webPath });
                continue; // 存在すればスキップ
            } catch (e) {
                // なければ作成
                console.log(`Optimizing: ${file.name}`);
                const download = await dbx.filesDownload({ path: file.path_lower });
                const buffer = download.result.fileBinary;

                const image = await Jimp.read(buffer);
                image.resize({ w: 1000 }).quality(80); // 幅1000pxにリサイズ
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

// クリーンアップタスク (毎日深夜0時にチェック)
cron.schedule('0 0 * * *', async () => {
    console.log('Running cleanup check...');
    const now = new Date();
    const limitDays = 30;

    async function processCleanup(folderPath, targetPath, isDelete = false) {
        const list = await dbx.filesListFolder({ path: folderPath });
        for (const item of list.result.entries) {
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
    }

    // SourceをArchiveへ移動
    await processCleanup(PATHS.SOURCE, PATHS.ARCHIVE);
    // Finalを削除
    await processCleanup(PATHS.FINAL, null, true);
    // Webも不要になるので削除
    await processCleanup(PATHS.WEB, null, true);
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
