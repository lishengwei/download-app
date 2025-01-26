const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { analyzeCSVFile, processCSVFile, cancelCurrentDownload, findCSVFiles } = require('./download');

let mainWindow;
// 初始化下载状态
global.isDownloadCancelled = false;
let isDownloading = false;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
    createWindow();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

// 分析文件
ipcMain.handle('analyze-files', async (event, { csvPath }) => {
    try {
        // 重置下载状态
        isDownloading = false;
        global.isDownloadCancelled = false;

        // 检查文件是否存在
        if (!fs.existsSync(csvPath)) {
            throw new Error('文件不存在');
        }

        // 检查是否为目录
        const stat = fs.statSync(csvPath);
        console.log('文件类型:', stat.isDirectory() ? '目录' : '文件 ' + csvPath);
        if (stat.isDirectory()) {
            // 如果是目录，查找所有CSV文件
            const csvFiles = await findCSVFiles(csvPath);
            if (csvFiles.length === 0) {
                throw new Error('所选目录中没有找到CSV文件');
            }

            // 分析第一个CSV文件
            const tasks = await analyzeCSVFile(csvFiles[0].path);
            return { success: true, tasks, allFiles: csvFiles };
        } else {
            // 如果是单个文件，直接分析
            const tasks = await analyzeCSVFile(csvPath);
            return { success: true, tasks, allFiles: [{ path: csvPath, name: path.basename(csvPath), size: stat.size }] };
        }
    } catch (error) {
        console.error('分析文件失败:', error);
        return { success: false, error: error.message };
    }
});

// 开始下载
ipcMain.handle('start-download', async (event, { tasks }) => {
    try {
        if (isDownloading) {
            return { success: false, error: '已有下载任务正在进行' };
        }

        if (!Array.isArray(tasks) || tasks.length === 0) {
            return { success: false, error: '没有可下载的任务' };
        }

        // 重置下载状态
        isDownloading = true;
        global.isDownloadCancelled = false;
        console.log(`开始下载 ${tasks.length} 个文件`);

        // 创建必要的目录
        const directories = new Set(tasks.map(task => path.dirname(task.targetPath)));
        for (const dir of directories) {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        }

        for (let i = 0; i < tasks.length && !global.isDownloadCancelled; i++) {
            const task = tasks[i];
            console.log(`处理第 ${i + 1}/${tasks.length} 个文件:`, task.fileName);

            // 发送开始下载状态
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('download-progress', {
                    taskIndex: i,
                    progress: 0,
                    status: '开始下载'
                });
            }

            try {
                await processCSVFile(task, (progress) => {
                    // 发送下载进度
                    if (!global.isDownloadCancelled && mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('download-progress', {
                            taskIndex: i,
                            progress: progress,
                            status: progress === 100 ? '完成' : '下载中'
                        });
                    }
                });

                if (global.isDownloadCancelled) {
                    throw new Error('下载已取消');
                }
            } catch (error) {
                console.error(`文件 ${task.fileName} 下载失败:`, error);
                // 发送错误状态
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('download-progress', {
                        taskIndex: i,
                        progress: 0,
                        status: `失败: ${error.message}`
                    });
                }
                if (error.message === '下载已取消') {
                    throw error;
                }
            }
        }

        const wasDownloadCancelled = global.isDownloadCancelled;
        isDownloading = false;
        global.isDownloadCancelled = false;

        if (wasDownloadCancelled) {
            // 发送取消事件
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('download-cancelled');
            }
            return { success: false, error: '下载已取消' };
        }

        return { success: true };
    } catch (error) {
        console.error('下载过程出错:', error);
        isDownloading = false;
        global.isDownloadCancelled = false;
        // 发送取消事件
        if (error.message === '下载已取消' && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('download-cancelled');
        }
        return { success: false, error: error.message };
    }
});

// 取消下载
ipcMain.handle('cancel-download', async () => {
    try {
        if (isDownloading) {
            global.isDownloadCancelled = true;
            
            // 调用下载模块的取消函数
            await cancelCurrentDownload();
            
            // 通知前端下载已取消
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('download-cancelled');
            }

            isDownloading = false;
        }
        return { success: true };
    } catch (error) {
        console.error('取消下载失败:', error);
        return { success: false, error: error.message };
    }
});
