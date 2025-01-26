const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { parse } = require('csv-parse');
const Progress = require('progress');

// 存储当前下载的取消函数
let currentCancelTokenSource = null;

// 分析CSV文件，返回下载任务列表
async function analyzeCSVFile(csvPath) {
    return new Promise((resolve, reject) => {
        // 首先检查文件扩展名
        if (!csvPath.toLowerCase().endsWith('.csv')) {
            reject(new Error('请选择CSV文件'));
            return;
        }

        const tasks = [];
        let lineNumber = 0;
        let firstChunk = true;

        // 获取CSV文件所在目录作为下载目录
        const downloadDir = path.dirname(csvPath);

        fs.createReadStream(csvPath)
            .pipe(parse({
                delimiter: ',',
                columns: true,
                skip_empty_lines: true
            }))
            .on('data', (record) => {
                lineNumber++;

                // 检查必需字段
                if (!record['章节'] || !record['文章标题']) {
                    console.warn(`第 ${lineNumber} 行缺少必需字段，已跳过`);
                    return;
                }

                // 构建基础文件名（章节-文章标题）
                const baseFileName = sanitizeFileName(`${record['章节']}-${record['文章标题']}`);
                
                // 处理音频下载
                if (record['音频地址'] && isValidUrl(record['音频地址'])) {
                    const audioExt = getExtensionFromURL(record['音频地址']) || '.mp3';
                    tasks.push({
                        url: record['音频地址'],
                        fileName: `${baseFileName}${audioExt}`,
                        targetPath: path.join(downloadDir, `${baseFileName}${audioExt}`),
                        type: 'audio'
                    });
                }

                // 处理视频下载
                if (record['视频地址'] && isValidUrl(record['视频地址'])) {
                    const videoExt = getExtensionFromURL(record['视频地址']) || '.mp4';
                    tasks.push({
                        url: record['视频地址'],
                        fileName: `${baseFileName}${videoExt}`,
                        targetPath: path.join(downloadDir, `${baseFileName}${videoExt}`),
                        type: 'video'
                    });
                }

                // 处理字幕下载
                if (record['字幕地址'] && isValidUrl(record['字幕地址'])) {
                    const subtitleExt = getExtensionFromURL(record['字幕地址']) || '.srt';
                    tasks.push({
                        url: record['字幕地址'],
                        fileName: `${baseFileName}${subtitleExt}`,
                        targetPath: path.join(downloadDir, `${baseFileName}${subtitleExt}`),
                        type: 'subtitle'
                    });
                }
            })
            .on('end', () => {
                if (tasks.length === 0) {
                    reject(new Error('CSV文件中没有找到有效的下载任务'));
                } else {
                    resolve(tasks);
                }
            })
            .on('error', (error) => {
                reject(new Error(`解析CSV文件失败: ${error.message}`));
            });
    });
}

// 验证URL是否有效
function isValidUrl(string) {
    try {
        new URL(string);
        return true;
    } catch (_) {
        return false;
    }
}

// 清理文件名
function sanitizeFileName(fileName) {
    if (!fileName) return '';
    
    // 移除不安全的字符
    let cleaned = fileName
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '') // 移除Windows不允许的字符
        .replace(/^\.+/, '') // 移除开头的点
        .trim();
    
    // 如果清理后为空，返回空字符串
    if (!cleaned) return '';
    
    // 限制长度
    if (cleaned.length > 255) {
        cleaned = cleaned.substring(0, 255);
    }
    
    return cleaned;
}

// 下载单个文件并显示进度
async function downloadFile(url, targetPath, onProgress) {
    let writer = null;
    let downloadStream = null;
    
    try {
        // 创建新的取消令牌
        currentCancelTokenSource = axios.CancelToken.source();

        // 确保目标目录存在
        const targetDir = path.dirname(targetPath);
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }

        // 先获取文件大小
        const headResponse = await axios.head(url, {
            cancelToken: currentCancelTokenSource.token
        }).catch(() => ({ headers: {} }));
        
        if (global.isDownloadCancelled) {
            throw new Error('下载已取消');
        }

        let totalBytes = parseInt(headResponse.headers['content-length'], 10) || 0;

        const response = await axios({
            url,
            method: 'GET',
            responseType: 'stream',
            cancelToken: currentCancelTokenSource.token
        });

        if (global.isDownloadCancelled) {
            throw new Error('下载已取消');
        }

        // 如果 head 请求没有获取到大小，从 GET 请求获取
        if (!totalBytes) {
            totalBytes = parseInt(response.headers['content-length'], 10) || 0;
        }

        downloadStream = response.data;

        // 写入文件
        return new Promise((resolve, reject) => {
            let downloadedBytes = 0;
            let hasError = false;

            writer = fs.createWriteStream(targetPath);
            
            writer.on('error', (error) => {
                hasError = true;
                console.error('写入错误:', error);
                if (downloadStream) {
                    downloadStream.destroy();
                }
                reject(error);
            });

            writer.on('finish', () => {
                if (hasError || global.isDownloadCancelled) {
                    fs.unlink(targetPath, () => {
                        reject(new Error('下载已取消'));
                    });
                } else {
                    onProgress(100); // 确保显示 100% 完成
                    resolve();
                }
            });

            // 使用 data 事件来跟踪下载进度
            downloadStream.on('data', (chunk) => {
                if (global.isDownloadCancelled) {
                    hasError = true;
                    downloadStream.destroy();
                    return;
                }

                downloadedBytes += chunk.length;
                if (totalBytes) {
                    const progress = Math.min(Math.round((downloadedBytes / totalBytes) * 100), 100);
                    onProgress(progress);
                } else {
                    // 如果无法获取文件大小，使用简单的进度显示
                    onProgress(Math.min(Math.round((downloadedBytes / 1048576) * 10), 99)); // 每 1MB 显示 10% 进度，最多显示 99%
                }
            });

            downloadStream.on('end', () => {
                if (!hasError && !global.isDownloadCancelled) {
                    writer.end();
                }
            });

            downloadStream.on('error', (error) => {
                hasError = true;
                console.error('下载流错误:', error);
                if (writer) {
                    writer.destroy();
                }
                reject(error);
            });

            downloadStream.pipe(writer, { end: false });
        });
    } catch (error) {
        if (axios.isCancel(error)) {
            throw new Error('下载已取消');
        }

        console.error('下载出错:', error.message);
        if (downloadStream) {
            downloadStream.destroy();
        }
        if (writer) {
            writer.destroy();
        }
        if (fs.existsSync(targetPath)) {
            try {
                fs.unlinkSync(targetPath);
            } catch (unlinkError) {
                console.error('删除文件失败:', unlinkError);
            }
        }
        throw error;
    } finally {
        currentCancelTokenSource = null;
    }
}

// 处理单个任务
async function processTask(task, onProgress) {
    try {
        if (global.isDownloadCancelled) {
            throw new Error('下载已取消');
        }

        const targetPath = task.targetPath;
        console.log('处理文件:', task.fileName);
        console.log('下载自:', task.url);
        console.log('保存到:', targetPath);
        
        // 确保目标目录存在
        const targetDir = path.dirname(targetPath);
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }

        await downloadFile(task.url, targetPath, onProgress);
        return true;
    } catch (error) {
        console.error(`处理任务失败: ${error.message}`);
        throw error;
    }
}

// 处理CSV文件
async function processCSVFile(task, onProgress = () => {}) {
    try {
        await processTask(task, onProgress);
        return true;
    } catch (error) {
        console.error(`处理任务失败: ${error.message}`);
        throw error;
    }
}

// 取消当前下载
async function cancelCurrentDownload() {
    if (currentCancelTokenSource) {
        currentCancelTokenSource.cancel('下载已取消');
        currentCancelTokenSource = null;
    }
}

// 工具函数：从URL中获取文件扩展名
function getExtensionFromURL(url) {
    try {
        const pathname = new URL(url).pathname;
        const ext = path.extname(pathname);
        return ext || null;
    } catch (error) {
        return null;
    }
}

// 遍历目录查找CSV文件
function findCSVFiles(directoryPath) {
    return new Promise((resolve, reject) => {
        try {
            const results = [];
            
            // 递归遍历目录的函数
            function walkDir(currentPath) {
                const files = fs.readdirSync(currentPath);
                
                files.forEach(file => {
                    const filePath = path.join(currentPath, file);
                    const stat = fs.statSync(filePath);
                    
                    if (stat.isDirectory()) {
                        // 如果是目录，递归遍历
                        walkDir(filePath);
                    } else if (stat.isFile() && path.extname(file).toLowerCase() === '.csv') {
                        // 如果是CSV文件，添加到结果列表
                        results.push({
                            path: filePath,
                            name: file,
                            size: stat.size
                        });
                    }
                });
            }
            
            // 开始遍历
            walkDir(directoryPath);
            resolve(results);
        } catch (error) {
            reject(new Error(`遍历目录时出错: ${error.message}`));
        }
    });
}

module.exports = {
    analyzeCSVFile,
    processCSVFile,
    processTask,
    cancelCurrentDownload,
    findCSVFiles,
    sanitizeFileName,
    getExtensionFromURL
};
