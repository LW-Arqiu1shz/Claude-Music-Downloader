// 小克音乐下载器 —— EchoMusic 插件
//
// 防封设计要点：
// 1. 只调用 EchoMusic 播放时本来就会调用的接口（privilege/lite、song/url/auth/merge、
//    云盘 user/cloud/url），参数与播放器一致；登录态由宿主注入，插件拿不到 token。
// 2. 下载正在播放的歌曲时，直接复用播放器已经拿到的地址，不额外发任何酷狗接口请求。
// 3. 全局单线程排队，每次接口请求之间随机间隔 3~5 秒，模拟正常切歌节奏。
// 4. 每首歌最多 2 次取地址请求；遇到安全验证交给宿主弹窗，不自动反复重试。
// 5. 每日下载数量上限（默认 150 首），没有「一键下载整个歌单」这类批量功能。
// 6. 音频文件从 CDN 下载时不携带账号 Cookie，和播放器缓冲音频是同一种请求。
//
// 7. 和「小克音量均衡器」联动：两个插件都启用时，可以下载音量均衡过的版本（FLAC）。
//    均衡器负责解码、处理和编码；下载器负责文件读写。宿主单次写文件最多 8 MiB，
//    大文件分块写入后用 bin/open-folder.exe（cmd 副本）的 `copy /b` 合并。
//
// 「打开文件夹」：EchoMusic 没有给插件开放打开任意目录的接口，插件只能启动自身目录内的
// 程序，所以 bin/open-folder.exe 是系统 cmd.exe 的一份副本，执行 `start "" <目录>`。
// （不能直接用 explorer.exe 副本：宿主以隐藏窗口启动，资源管理器窗口也会是隐藏的。）
// 首次使用时宿主会弹窗确认。

const QUALITY_ORDER = ['128', '320', 'flac', 'high'];
const QUALITY_LABELS = {
  follow: '跟随播放器默认音质',
  128: '标准 128k',
  320: '高品 320k',
  flac: '无损 FLAC',
  high: 'Hi-Res',
};
const DEFAULT_SETTINGS = {
  quality: 'follow',
  nameTemplate: 'title-artist',
  dailyLimit: 150,
  variant: 'original', // original | leveled | both（需要小克音量均衡器）
};
const VARIANT_LABELS = {
  original: '原版',
  leveled: '音量均衡版（FLAC）',
  both: '原版 + 音量均衡版',
};
const LEVELED_SUFFIX = '（音量均衡）';
const MIN_GAP_MS = 3000;
const JITTER_MS = 2000;
const QUEUE_LIMIT = 20;
const PAGE_ID = 'queue';
const OPENER = 'bin/open-folder.exe';

class CanceledError extends Error {
  constructor() {
    super('已取消');
    this.canceled = true;
  }
}

export function activate(ctx) {
  const { defineComponent, h, ref, reactive, onMounted } = ctx.vue;

  const state = reactive({
    queue: [], // 排队中的歌曲
    current: null, // { song, phase, progress, canceled }
    running: false,
    history: [], // 最近完成的记录
    dirLabel: '',
  });
  let currentTask = null;
  let lastApiAt = 0;
  let disposed = false;
  ctx.dispose(() => {
    disposed = true;
    state.queue.splice(0);
    if (currentTask) currentTask.cancel().catch(() => {});
  });

  // ---------- 工具 ----------
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const pace = async () => {
    const gap = MIN_GAP_MS + Math.floor(Math.random() * JITTER_MS);
    const wait = lastApiAt + gap - Date.now();
    if (wait > 0) await sleep(wait);
    lastApiAt = Date.now();
  };

  const loadSettings = async () => ({
    ...DEFAULT_SETTINGS,
    ...((await ctx.storage.get('settings')) || {}),
  });

  const today = () => new Date().toLocaleDateString('zh-CN');

  const getStats = async () => {
    const stats = (await ctx.storage.get('stats')) || {};
    return stats.date === today() ? stats : { date: today(), count: 0 };
  };

  const bumpStats = async () => {
    const stats = await getStats();
    stats.count += 1;
    await ctx.storage.set('stats', stats);
  };

  const saveHistory = () => ctx.storage.set('history', state.history.map((item) => ({ ...item })));

  const addHistory = async (record) => {
    state.history.unshift(record);
    await saveHistory();
  };

  // 清空全部下载记录（只清记录，不删文件）
  const clearHistory = async () => {
    if (!state.history.length) return;
    const ok = window.confirm(`确定要清除全部 ${state.history.length} 条下载记录吗？\n（只清除记录，已下载的文件不会被删除）`);
    if (!ok) return;
    state.history.splice(0, state.history.length);
    await saveHistory();
    ctx.toast.success('下载记录已清除');
  };

  const removeHistory = async (id) => {
    const index = state.history.findIndex((item) => item.id === id);
    if (index >= 0) state.history.splice(index, 1);
    await saveHistory();
  };

  const sanitize = (name) =>
    String(name || '')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/, '')
      .slice(0, 150) || '未命名歌曲';

  const extFromUrl = (url, fallback) => {
    try {
      const match = new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i);
      if (match) return match[1].toLowerCase();
    } catch {}
    return fallback;
  };

  const formatBytes = (bytes) => {
    if (!bytes) return '';
    return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
  };

  const formatTime = (ts) => {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const songArtist = (song) =>
    song.artist || (song.singers || song.artists || []).map((a) => a.name).join('、') || '未知歌手';
  // song.title 是酷狗原始名，常常是「歌手 - 歌名」；song.name 是宿主处理过的纯歌名。
  // 和宿主 getSongDisplayTitle 一样：优先 name，否则从 title 里剥掉「歌手 - 」前缀。
  const songTitle = (song) => {
    const names = [
      String(song.artist || '').trim(),
      ...(song.singers || song.artists || []).map((a) => String(a?.name || '').trim()),
    ].filter(Boolean);
    const stripPrefix = (text) => {
      for (const name of names) {
        const prefix = `${name} - `;
        if (text.startsWith(prefix)) return text.slice(prefix.length).trim();
      }
      return text;
    };
    const name = String(song.name || '').trim();
    if (name) return stripPrefix(name);
    return stripPrefix(String(song.title || '').trim()) || '未知歌曲';
  };
  const songKey = (song) => String(song.hash || song.id || '');

  const buildBaseName = (song, template) =>
    sanitize(
      template === 'artist-title'
        ? `${songArtist(song)} - ${songTitle(song)}`
        : template === 'title'
          ? songTitle(song)
          : `${songTitle(song)} - ${songArtist(song)}`,
    );

  const collectUrls = (payload) => {
    const urls = [];
    const add = (value) => {
      if (typeof value === 'string') {
        const url = value.trim();
        if (url && !urls.includes(url)) urls.push(url);
      } else if (Array.isArray(value)) value.forEach(add);
    };
    const walk = (node, depth) => {
      if (!node || depth > 3) return;
      if (typeof node === 'string' || Array.isArray(node)) return add(node);
      if (typeof node !== 'object') return;
      add(node.url);
      add(node.play_url);
      add(node.playUrl);
      add(node.backupUrl);
      add(node.backup_url);
      add(node.backupUrls);
      if (!urls.length) {
        walk(node.data, depth + 1);
        walk(node.info, depth + 1);
      }
    };
    walk(payload, 0);
    return urls.filter((u) => /^https?:\/\//i.test(u));
  };

  const matchQuality = (item, quality) => {
    const q = String(item.quality ?? '').trim().toLowerCase();
    const level = item.level;
    if (quality === '128') return q === '128' || level === 1 || level === 2;
    if (quality === '320') return q === '320' || q === 'hq' || level === 4;
    if (quality === 'flac') return q === 'flac' || q === 'sq' || level === 5;
    if (quality === 'high') return ['high', 'hires', 'hi-res', 'res'].includes(q) || level === 6;
    return false;
  };

  const resolveTargetQuality = (setting) => {
    if (setting !== 'follow') return setting;
    const q = String(ctx.settings?.defaultAudioQuality ?? '320');
    if (QUALITY_ORDER.includes(q)) return q;
    return q.startsWith('viper') ? 'high' : '320';
  };

  const getVerificationId = (body) => {
    const resp = body?.response ?? body;
    return resp?.ssaCode || resp?.eventId || resp?.data?.ssaCode || '';
  };

  const checkCanceled = () => {
    if (disposed || state.current?.canceled) throw new CanceledError();
  };

  // 调用酷狗接口：限速 + 遇到安全验证交给宿主处理，验证通过后只重试一次。
  const callKugou = async (fn) => {
    await pace();
    checkCanceled();
    let body;
    try {
      body = await fn();
    } catch (error) {
      body = { __error: error, response: error?.response };
    }
    const eventId = getVerificationId(body);
    if (eventId) {
      ctx.toast.warning('酷狗要求安全验证，请在弹窗中完成');
      const verified = await ctx.kugouVerification.request(eventId);
      if (!verified.ok) {
        throw new Error(verified.canceled ? '已取消安全验证，下载暂停' : verified.error || '安全验证失败');
      }
      await pace();
      checkCanceled();
      body = await fn();
    }
    if (body?.__error) throw body.__error;
    return body;
  };

  // ---------- 取地址 ----------
  const getRelateGoods = async (song) => {
    if (Array.isArray(song.relateGoods) && song.relateGoods.length) return song.relateGoods;
    const res = await callKugou(() => ctx.kugou.music.getSongPrivilegeLite(song.hash, song.albumId));
    const source = res && typeof res === 'object' && 'data' in res ? res.data : res;
    const first = Array.isArray(source) ? source[0] : null;
    const goods = first?.relate_goods ?? first?.relateGoods ?? [];
    return Array.isArray(goods) ? goods.filter((g) => g && typeof g === 'object') : [];
  };

  const isCloudSong = (song) => song.source === 'cloud' && (song.cloudAudioSource?.hash || song.cloudFileId);

  const reuseCurrentPlayback = (song, targetQuality, followPlayer) => {
    const store = ctx.stores.player;
    if (!store || String(store.currentTrackId ?? '') !== String(song.id ?? '')) return null;
    const url = store.currentAudioUrl;
    if (!url || !/^https?:\/\//i.test(url)) return null;
    const playingQuality = store.currentResolvedAudioQuality;
    if (store.currentResolvedAudioEffect && store.currentResolvedAudioEffect !== 'none') return null;
    if (!followPlayer && playingQuality && playingQuality !== targetQuality) return null;
    const candidates = Array.isArray(store.currentAudioCandidateUrls) ? store.currentAudioCandidateUrls : [];
    return {
      urls: [url, ...candidates.filter((u) => u !== url && /^https?:\/\//i.test(u))],
      quality: playingQuality || targetQuality,
      reused: true,
    };
  };

  const resolveSongUrls = async (song, settings) => {
    const targetQuality = resolveTargetQuality(settings.quality);

    const reused = reuseCurrentPlayback(song, targetQuality, settings.quality === 'follow');
    if (reused) return reused;

    if (isCloudSong(song)) {
      const src = song.cloudAudioSource || {};
      const res = await callKugou(() =>
        ctx.kugou.music.getCloudSongUrl(src.hash || song.hash, {
          cloudFileId: src.cloudFileId ?? song.cloudFileId,
          albumAudioId: src.albumAudioId ?? song.albumAudioId,
          audioId: src.audioId,
          name: src.name || songTitle(song),
        }),
      );
      const urls = collectUrls(res);
      if (urls.length) return { urls, quality: src.quality || '云盘' };
      throw new Error('无法获取云盘歌曲地址');
    }

    if (!song.hash) throw new Error('这首歌没有曲库信息，无法下载');

    const goods = await getRelateGoods(song);
    const options = { albumId: song.albumId, albumAudioId: song.albumAudioId };
    const order = QUALITY_ORDER.slice(0, QUALITY_ORDER.indexOf(targetQuality) + 1).reverse();
    const tried = [];
    let attempts = 0;
    let lastRes = null;

    for (const quality of order) {
      const matched = goods.find((g) => g.hash && matchQuality(g, quality));
      if (!matched) continue;
      if (attempts >= 2) break; // 每首最多 2 次取地址请求
      attempts += 1;
      tried.push(quality);
      const res = await callKugou(() => ctx.kugou.music.getSongUrl(matched.hash, quality, undefined, options));
      lastRes = res;
      const urls = collectUrls(res);
      if (urls.length) return { urls, quality, ext: res?.extName || res?.data?.extName };
    }

    if (attempts < 2) {
      const res = await callKugou(() => ctx.kugou.music.getSongUrl(song.hash, '', undefined, options));
      lastRes = res;
      const urls = collectUrls(res);
      if (urls.length) return { urls, quality: tried.length ? '兼容' : targetQuality };
    }

    const msg = lastRes?.msg || lastRes?.error || lastRes?.data?.msg;
    throw new Error(msg ? `无法获取下载地址：${msg}` : '无法获取下载地址（可能需要 VIP 或该歌曲无版权）');
  };

  // ---------- 保存目录 ----------
  const getSavedDirectory = async () => {
    const savedId = await ctx.storage.get('directoryId');
    if (!savedId) return null;
    try {
      const grants = await ctx.fs.listDirectoryGrants();
      const found = (grants || []).find((g) => g.id === savedId);
      if (found?.available && found.access === 'read-write') return found;
    } catch {}
    return null;
  };

  const pickDirectory = async () => {
    const selection = await ctx.fs.requestDirectory({
      access: 'read-write',
      purpose: '选择下载歌曲的保存文件夹',
      persist: true,
    });
    if (!selection.ok) throw new Error(selection.error?.message || '无法授权文件夹');
    if (selection.canceled) return null;
    const dir = selection.directory;
    await ctx.storage.set('directoryId', dir.id);
    state.dirLabel = dir.displayPath || dir.name;
    await ctx.storage.set('directoryLabel', state.dirLabel);
    return dir;
  };

  const ensureDirectory = async () => (await getSavedDirectory()) || (await pickDirectory());

  const openFolder = async () => {
    try {
      const dir = await getSavedDirectory();
      if (!dir) {
        ctx.toast.info('还没有选择保存文件夹，下载第一首歌时会询问');
        return;
      }
      if (!dir.displayPath) throw new Error('无法读取文件夹路径');
      // cmd 会解释这些字符，含有时不启动，改为提示路径
      if (/[&|<>^%"]/.test(dir.displayPath)) {
        throw new Error(`路径含特殊字符，请手动打开：${dir.displayPath}`);
      }
      // 宿主以隐藏窗口方式启动插件程序；用 start 走系统「打开」动作，资源管理器窗口才会正常显示
      const result = await ctx.process.launch({
        executable: OPENER,
        args: ['/d', '/c', 'start', '', dir.displayPath],
      });
      if (result && result.ok === false) throw new Error(result.error || '无法打开文件夹');
    } catch (error) {
      ctx.toast.danger(`打开文件夹失败：${error?.message || error}`);
    }
  };

  const changeFolder = async () => {
    try {
      const dir = await pickDirectory();
      if (dir) ctx.toast.success(`保存位置已改为：${state.dirLabel}`);
    } catch (error) {
      ctx.toast.danger(error?.message || String(error));
    }
  };

  const fileExists = async (directoryId, relativePath) => {
    try {
      await ctx.fs.stat({ kind: 'directory-file', directoryId, relativePath });
      return true;
    } catch {
      return false;
    }
  };

  // ---------- 小克音量均衡器联动 ----------
  const getLeveler = () => {
    const api = globalThis.__ClaudeVolumeLeveler;
    return api && api.apiVersion === 1 && typeof api.processToFlac === 'function' ? api : null;
  };

  const fileRef = (directoryId, relativePath) => ({ kind: 'directory-file', directoryId, relativePath });

  const removeQuietly = async (directoryId, relativePath) => {
    try {
      await ctx.fs.deleteFile(fileRef(directoryId, relativePath));
    } catch {}
  };

  // 读整个文件：媒体租约地址支持 fetch，没有 readFileBytes 的 4 MiB 限制
  const readWholeFile = async (ref) => {
    const lease = await ctx.fs.openMedia(ref);
    try {
      const response = await fetch(lease.url);
      if (!response.ok) throw new Error(`读取文件失败（${response.status}）`);
      return await response.arrayBuffer();
    } finally {
      try {
        lease.release();
      } catch {}
    }
  };

  // 封面：尽力而为，失败就不嵌封面。走宿主下载（不带 Cookie），和界面加载封面是同一种请求。
  const fetchCover = async (song, directoryId, tempBase) => {
    const raw = song.coverUrl || song.cover || '';
    if (!/^https?:\/\//i.test(raw)) return null;
    const url = raw.replace('{size}', '480');
    const rel = `${tempBase}.cover`;
    try {
      const task = await ctx.net.download({
        url,
        target: { directoryId, relativePath: rel },
        name: '封面',
        conflict: 'replace',
        maxBytes: 4 * 1024 * 1024,
        connectTimeoutMs: 10000,
        idleTimeoutMs: 10000,
      });
      const result = await task.wait();
      const bytes = new Uint8Array(await readWholeFile(result.file));
      const mime =
        bytes[0] === 0xff && bytes[1] === 0xd8
          ? 'image/jpeg'
          : bytes[0] === 0x89 && bytes[1] === 0x50
            ? 'image/png'
            : null;
      return mime ? { mime, data: bytes } : null;
    } catch {
      return null;
    } finally {
      await removeQuietly(directoryId, rel);
    }
  };

  const waitForFile = async (ref, timeoutMs) => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      checkCanceled();
      if (await ctx.fs.stat(ref).then(() => true, () => false)) return true;
      await sleep(300);
    }
    return false;
  };

  // 宿主单次写文件最多 8 MiB：小文件直接写，大文件分块写好后用 cmd 的 copy /b 合并，再流式复制成正式文件名
  const writeChunks = async (directory, relativePath, chunks, tempBase) => {
    if (chunks.length === 1) {
      const res = await ctx.fs.writeFile(fileRef(directory.id, relativePath), chunks[0]);
      if (res && res.ok === false) throw new Error(res.error?.message || '写入文件失败');
      return relativePath;
    }
    const dirPath = directory.displayPath;
    if (!dirPath || /[%"]/.test(dirPath)) {
      throw new Error('保存文件夹路径里有 % 或引号，无法合并大文件，请换一个文件夹');
    }
    const parts = chunks.map((_, i) => `${tempBase}-${i}.part`);
    const merged = `${tempBase}.flac`;
    const marker = `${tempBase}.done`;
    const abs = (name) => `${dirPath.replace(/[\\/]+$/, '')}\\${name}`;
    try {
      for (let i = 0; i < chunks.length; i++) {
        checkCanceled();
        const res = await ctx.fs.writeFile(fileRef(directory.id, parts[i]), chunks[i], { overwrite: true });
        if (res && res.ok === false) throw new Error(res.error?.message || '写入临时文件失败');
      }
      const args = ['/d', '/c', 'copy', '/b', '/y'];
      parts.forEach((p, i) => {
        if (i) args.push('+');
        args.push(abs(p));
      });
      args.push(abs(merged), '>', 'nul', '&&', 'type', 'nul', '>', abs(marker));
      const launched = await ctx.process.launch({ executable: OPENER, args });
      if (launched && launched.ok === false) {
        throw new Error(launched.canceled ? '没有允许合并文件，已取消' : launched.error || '无法合并文件');
      }
      if (!(await waitForFile(fileRef(directory.id, marker), 120000))) throw new Error('合并文件超时');
      const stat = await ctx.fs.stat(fileRef(directory.id, merged));
      const expected = chunks.reduce((a, c) => a + c.length, 0);
      if (Number(stat?.size) !== expected) throw new Error('合并后的文件大小不对');
      currentTask = await ctx.fs.copyFile(
        fileRef(directory.id, merged),
        { directoryId: directory.id, relativePath },
        { conflict: 'rename' },
      );
      const done = await currentTask.wait();
      return done?.file?.relativePath || relativePath;
    } finally {
      currentTask = null;
      for (const p of [...parts, merged, marker]) await removeQuietly(directory.id, p);
    }
  };

  const makeLeveled = async (job, directory, sourceRef, outName, tempBase) => {
    const api = getLeveler();
    if (!api) throw new Error('小克音量均衡器没有启用');
    const { song } = job;
    job.phase = '均衡处理中';
    job.progress = '';
    const bytes = await readWholeFile(sourceRef);
    checkCanceled();
    const picture = await fetchCover(song, directory.id, tempBase);
    checkCanceled();
    const abort = new AbortController();
    const watchCancel = setInterval(() => {
      if (job.canceled || disposed) abort.abort();
    }, 200);
    let result;
    try {
      result = await api.processToFlac(bytes, {
        tags: {
          TITLE: songTitle(song),
          ARTIST: songArtist(song),
          ALBUM: song.albumName || song.album || '',
          COMMENT: '小克音量均衡器处理',
        },
        picture,
        signal: abort.signal,
        onProgress: (p, phase) => {
          job.phase = phase === '完成' ? '保存中' : `均衡处理 · ${phase}`;
          job.progress = `${Math.round(p * 100)}%`;
        },
      });
    } catch (error) {
      if (error?.canceled) throw new CanceledError();
      throw error;
    } finally {
      clearInterval(watchCancel);
    }
    checkCanceled();
    job.phase = '保存中';
    job.progress = '';
    const fileName = await writeChunks(directory, `${outName}.flac`, result.chunks, tempBase);
    return { fileName, bytes: result.bytes };
  };

  // ---------- 单首下载 ----------
  const downloadOne = async (job) => {
    const { song } = job;
    const settings = await loadSettings();
    const stats = await getStats();
    const limit = Math.max(1, Number(settings.dailyLimit) || DEFAULT_SETTINGS.dailyLimit);
    if (stats.count >= limit) {
      throw new Error(`今天已下载 ${stats.count} 首，达到每日上限 ${limit}（可在插件设置里调整）`);
    }

    let variant = VARIANT_LABELS[settings.variant] ? settings.variant : 'original';
    if (variant !== 'original' && !getLeveler()) {
      ctx.toast.warning('没有检测到启用中的小克音量均衡器，这次先下载原版');
      variant = 'original';
    }

    const directory = await ensureDirectory();
    if (!directory) throw new Error('未选择保存文件夹');

    const baseName = buildBaseName(song, settings.nameTemplate);
    const leveledName = variant === 'both' ? `${baseName}${LEVELED_SUFFIX}` : baseName;
    const tempBase = `.xkdl-${job.id}`;

    // 已经下载过的就跳过；「两个都要」时如果原版已经有了，直接拿它来做均衡版
    let existingOriginal = null;
    for (const ext of ['flac', 'mp3', 'm4a', 'ogg']) {
      if (await fileExists(directory.id, `${baseName}.${ext}`)) {
        existingOriginal = `${baseName}.${ext}`;
        break;
      }
    }
    if (variant === 'original' && existingOriginal) {
      ctx.toast.info(`「${baseName}」已经下载过了`);
      return;
    }
    if (variant === 'leveled' && existingOriginal) {
      ctx.toast.info(`「${baseName}」已经有了（同名文件：${existingOriginal}）`);
      return;
    }
    if (variant === 'both' && (await fileExists(directory.id, `${leveledName}.flac`))) {
      ctx.toast.info(`「${leveledName}」已经下载过了`);
      return;
    }

    const finish = async ({ fileName, bytes, quality }) => {
      await bumpStats();
      await addHistory({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        title: songTitle(song),
        artist: songArtist(song),
        quality,
        fileName,
        bytes: bytes || 0,
        finishedAt: Date.now(),
      });
    };

    if (variant === 'both' && existingOriginal) {
      const made = await makeLeveled(job, directory, fileRef(directory.id, existingOriginal), leveledName, tempBase);
      await finish({ ...made, quality: '音量均衡 FLAC' });
      ctx.toast.success(`均衡版完成：${leveledName}`);
      return;
    }

    job.phase = '获取地址中';
    const resolved = await resolveSongUrls(song, settings);
    checkCanceled();

    let lastError = null;
    for (const url of resolved.urls.slice(0, 3)) {
      checkCanceled();
      const fallbackExt = resolved.quality === 'flac' || resolved.quality === 'high' ? 'flac' : 'mp3';
      const ext = sanitize(resolved.ext || extFromUrl(url, fallbackExt)).toLowerCase();
      // 只要均衡版时，原版先下到临时文件，处理完删除
      const downloadPath = variant === 'leveled' ? `${tempBase}.src.${ext}` : `${baseName}.${ext}`;
      job.phase = '下载中';
      job.progress = '';
      let unsubscribe = () => {};
      let result;
      try {
        currentTask = await ctx.net.download({
          url,
          target: { directoryId: directory.id, relativePath: downloadPath },
          name: baseName,
          sourceKey: songKey(song),
          conflict: variant === 'leveled' ? 'replace' : 'rename',
        });
        if (job.canceled) {
          await currentTask.cancel().catch(() => {});
          throw new CanceledError();
        }
        unsubscribe = currentTask.subscribe((snap) => {
          job.progress = snap.totalBytes
            ? `${Math.floor((snap.receivedBytes / snap.totalBytes) * 100)}%`
            : formatBytes(snap.receivedBytes);
        });
        result = await currentTask.wait();
      } catch (error) {
        if (job.canceled) throw new CanceledError();
        lastError = error;
        continue;
      } finally {
        unsubscribe();
        currentTask = null;
      }

      const qualityLabel = QUALITY_LABELS[resolved.quality] || resolved.quality;
      const savedName = result?.file?.relativePath || downloadPath;
      if (variant === 'original') {
        await finish({ fileName: savedName, bytes: result?.bytes, quality: qualityLabel });
        ctx.toast.success(`下载完成：${baseName}`);
        return;
      }

      // 均衡处理（原版已经下好了，这里失败不会再去请求酷狗）
      try {
        const made = await makeLeveled(job, directory, result.file || fileRef(directory.id, savedName), leveledName, tempBase);
        if (variant === 'both') {
          await finish({ fileName: savedName, bytes: result?.bytes, quality: qualityLabel });
        }
        await finish({ ...made, quality: `${qualityLabel} · 音量均衡 FLAC` });
        ctx.toast.success(variant === 'both' ? `下载完成：${baseName}（原版 + 均衡版）` : `下载完成：${baseName}（音量均衡版）`);
      } catch (error) {
        if (error?.canceled || job.canceled) {
          if (variant === 'leveled') await removeQuietly(directory.id, savedName);
          throw new CanceledError();
        }
        const msg = error?.message || String(error);
        if (variant === 'leveled') {
          // 均衡失败：把下好的原版留下来，免得白下
          try {
            const copy = await ctx.fs.copyFile(
              fileRef(directory.id, savedName),
              { directoryId: directory.id, relativePath: `${baseName}.${ext}` },
              { conflict: 'rename' },
            );
            const kept = await copy.wait();
            await finish({ fileName: kept?.file?.relativePath || `${baseName}.${ext}`, bytes: result?.bytes, quality: qualityLabel });
            ctx.toast.warning(`均衡处理失败（${msg}），已保存原版：${baseName}`);
          } catch {
            throw new Error(`均衡处理失败：${msg}`);
          }
        } else {
          await finish({ fileName: savedName, bytes: result?.bytes, quality: qualityLabel });
          ctx.toast.warning(`原版已保存，但均衡处理失败：${msg}`);
        }
      } finally {
        if (variant === 'leveled') await removeQuietly(directory.id, savedName);
      }
      return;
    }
    throw lastError || new Error('下载失败');
  };

  // ---------- 队列 ----------
  const runQueue = async () => {
    if (state.running) return;
    state.running = true;
    try {
      while (state.queue.length && !disposed) {
        const job = state.queue.shift();
        state.current = job;
        try {
          await downloadOne(job);
        } catch (error) {
          if (error?.canceled) {
            ctx.toast.info(`已取消「${songTitle(job.song)}」`);
          } else {
            const msg = error?.message || String(error);
            ctx.toast.danger(`下载失败「${songTitle(job.song)}」：${msg}`);
            // 安全验证失败 / 达到上限 / 没选文件夹时清空队列，避免继续请求
            if (/验证|上限|未选择/.test(msg)) state.queue.splice(0);
          }
        }
      }
    } finally {
      state.running = false;
      state.current = null;
    }
  };

  const enqueue = (song) => {
    if (!song) return;
    const key = songKey(song);
    const dup =
      (state.current && songKey(state.current.song) === key) || state.queue.some((job) => songKey(job.song) === key);
    if (dup) {
      ctx.toast.info('这首歌已经在下载队列里了');
      return;
    }
    if (state.queue.length >= QUEUE_LIMIT) {
      ctx.toast.warning(`队列已满（最多 ${QUEUE_LIMIT} 首），请稍后再添加`);
      return;
    }
    state.queue.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      song: { ...song },
      phase: '排队中',
      progress: '',
      canceled: false,
    });
    ctx.toast.info(
      state.running ? `已加入下载队列（前面还有 ${state.queue.length} 首）` : `开始下载「${songTitle(song)}」`,
    );
    runQueue();
  };

  const cancelJob = async (jobId) => {
    const index = state.queue.findIndex((job) => job.id === jobId);
    if (index >= 0) {
      state.queue.splice(index, 1);
      return;
    }
    if (state.current?.id === jobId) {
      state.current.canceled = true;
      state.current.phase = '正在取消';
      if (currentTask) await currentTask.cancel().catch(() => {});
    }
  };

  const canDownload = (song) =>
    Boolean(song && (song.hash || isCloudSong(song))) && !['webdav', 'local'].includes(song?.source);

  const currentSong = () => ctx.player.currentTrack?.value ?? ctx.player.currentTrack;

  // ---------- 初始化 ----------
  (async () => {
    const saved = await ctx.storage.get('history');
    if (Array.isArray(saved)) state.history.splice(0, state.history.length, ...saved);
    state.dirLabel = (await ctx.storage.get('directoryLabel')) || '';
  })();

  // ---------- 下载队列页面 ----------
  const btnStyle =
    'padding:5px 12px;border-radius:8px;border:1px solid var(--color-border, #8884);background:transparent;color:inherit;cursor:pointer;font-size:13px;white-space:nowrap;';
  const smallBtn =
    'padding:2px 10px;border-radius:6px;border:1px solid var(--color-border, #8884);background:transparent;color:inherit;cursor:pointer;font-size:12px;white-space:nowrap;';
  const cardStyle =
    'border:1px solid var(--color-border, #8883);border-radius:12px;padding:14px;min-width:0;display:flex;flex-direction:column;gap:8px;';
  const itemStyle =
    'display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;background:var(--color-fill, rgba(128,128,128,.08));';
  const ellipsis = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
  const empty = (text) => h('div', { style: 'opacity:.55;font-size:13px;padding:16px 4px;' }, text);

  const songLine = (title, sub) =>
    h('div', { style: 'flex:1;min-width:0;' }, [
      h('div', { style: `font-size:14px;${ellipsis}` }, title),
      h('div', { style: `font-size:12px;opacity:.6;${ellipsis}` }, sub),
    ]);

  const QueuePage = defineComponent({
    setup() {
      return () => {
        const active = [...(state.current ? [state.current] : []), ...state.queue];
        return h('div', { style: 'padding:24px;display:flex;flex-direction:column;gap:18px;' }, [
          h('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;' }, [
            h('div', { style: 'min-width:0;' }, [
              h('h2', { style: 'margin:0;font-size:22px;' }, '下载队列'),
              h(
                'div',
                { style: `font-size:12px;opacity:.6;margin-top:4px;${ellipsis}` },
                `保存位置：${state.dirLabel || '未选择（下载第一首歌时会询问）'}`,
              ),
            ]),
            h('div', { style: 'display:flex;gap:8px;' }, [
              h('button', { style: btnStyle, onClick: openFolder }, '打开保存文件夹'),
              h('button', { style: btnStyle, onClick: changeFolder }, '更改保存位置'),
            ]),
          ]),
          h(
            'div',
            { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px;align-items:start;' },
            [
              h('section', { style: cardStyle }, [
                h('div', { style: 'font-weight:600;' }, `下载中 (${active.length})`),
                active.length
                  ? active.map((job) =>
                      h('div', { key: job.id, style: itemStyle }, [
                        songLine(songTitle(job.song), songArtist(job.song)),
                        h(
                          'span',
                          { style: 'font-size:12px;opacity:.75;white-space:nowrap;' },
                          job.progress ? `${job.phase} ${job.progress}` : job.phase,
                        ),
                        h(
                          'button',
                          { style: smallBtn, disabled: job.canceled, onClick: () => cancelJob(job.id) },
                          '取消',
                        ),
                      ]),
                    )
                  : empty('没有正在下载的歌曲。右键歌曲选「下载歌曲」，或点播放栏的下载按钮。'),
              ]),
              h('section', { style: cardStyle }, [
                h('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:8px;' }, [
                  h('div', { style: 'font-weight:600;' }, `已完成 (${state.history.length})`),
                  h(
                    'button',
                    {
                      style: smallBtn,
                      disabled: !state.history.length,
                      title: '清除全部下载记录，不会删除文件',
                      onClick: clearHistory,
                    },
                    '清除下载记录',
                  ),
                ]),
                state.history.length
                  ? state.history.map((item) =>
                      h('div', { key: item.id, style: itemStyle }, [
                        songLine(
                          item.title,
                          [item.artist, item.quality, formatBytes(item.bytes), formatTime(item.finishedAt)]
                            .filter(Boolean)
                            .join(' · '),
                        ),
                        h(
                          'button',
                          { style: smallBtn, title: '只删除这条记录，不会删除文件', onClick: () => removeHistory(item.id) },
                          '删除记录',
                        ),
                      ]),
                    )
                  : empty('还没有下载完成的歌曲'),
              ]),
            ],
          ),
        ]);
      };
    },
  });

  ctx.ui.addPage({
    id: PAGE_ID,
    title: '下载队列',
    icon: 'tabler:download',
    component: QueuePage,
  });

  ctx.ui.titlebar.register({
    id: 'download-queue',
    title: '下载队列',
    icon: 'tabler:download',
    tooltip: '小克音乐下载器 · 下载队列',
    defaultPlacement: 'toolbar',
    order: 300,
    onClick: () => ctx.router.push(`/main/plugin/${encodeURIComponent(ctx.manifest.id)}/${PAGE_ID}`),
  });

  // ---------- 下载入口 ----------
  ctx.ui.addSongContextMenuItem({
    id: 'download-song',
    label: '下载歌曲',
    order: 50,
    visible: (song) => canDownload(song),
    onSelect: (song) => enqueue(song),
  });

  ctx.ui.playerbar.register({
    id: 'download-current',
    title: '下载当前歌曲',
    icon: 'tabler:download',
    tooltip: '下载当前播放的歌曲',
    defaultPlacement: 'right',
    order: 900,
    badge: () => {
      const n = state.queue.length + (state.current ? 1 : 0);
      return n ? String(n) : null;
    },
    badgeTitle: '下载队列数量',
    disabled: () => !canDownload(currentSong()),
    onClick: () => enqueue(currentSong()),
  });

  // ---------- 设置面板 ----------
  const SettingsPanel = defineComponent({
    setup() {
      const form = reactive({ ...DEFAULT_SETTINGS });
      const todayCount = ref(0);

      onMounted(async () => {
        Object.assign(form, await loadSettings());
        todayCount.value = (await getStats()).count;
      });

      // 实时保存：每次改动直接写入，没有保存按钮
      const clampLimit = (value) => Math.min(500, Math.max(1, Math.floor(Number(value) || 150)));
      const persist = async () => {
        try {
          await ctx.storage.set('settings', { ...form, dailyLimit: clampLimit(form.dailyLimit) });
        } catch (error) {
          ctx.toast.danger(`设置保存失败：${error?.message || error}`);
        }
      };

      const row = 'display:flex;align-items:center;justify-content:space-between;gap:12px;';
      const input =
        'padding:4px 8px;border-radius:6px;border:1px solid var(--color-border, #8884);background:transparent;color:inherit;';

      const select = (key, options) =>
        h(
          'select',
          {
            style: input,
            value: form[key],
            onChange: (e) => {
              form[key] = e.target.value;
              persist();
            },
          },
          options.map(([value, label]) => h('option', { value, selected: form[key] === value }, label)),
        );

      return () =>
        h('div', { style: 'display:grid;gap:14px;font-size:13px;' }, [
          h('div', { style: row }, [
            h('span', '保存位置'),
            h('div', { style: 'display:flex;gap:8px;align-items:center;min-width:0;' }, [
              h(
                'span',
                { style: `opacity:.7;max-width:240px;${ellipsis}` },
                state.dirLabel || '未选择（首次下载时会询问）',
              ),
              h('button', { style: smallBtn, onClick: changeFolder }, '选择…'),
              h('button', { style: smallBtn, onClick: openFolder }, '打开'),
            ]),
          ]),
          h('div', { style: row }, [h('span', '下载音质'), select('quality', Object.entries(QUALITY_LABELS))]),
          getLeveler()
            ? h('div', { style: 'display:grid;gap:4px;' }, [
                h('div', { style: row }, [h('span', '下载版本'), select('variant', Object.entries(VARIANT_LABELS))]),
                h(
                  'div',
                  { style: 'font-size:12px;opacity:.6;line-height:1.6;' },
                  `已检测到小克音量均衡器：均衡版按它当前的设置处理（${(() => {
                    const s = getLeveler().getSettings?.() || {};
                    return s.minLufs != null ? `${s.minLufs} ~ ${s.maxLufs} LUFS` : '默认设置';
                  })()}），保存为无损 FLAC，文件会比 MP3 大。「两个都要」时均衡版文件名带「${LEVELED_SUFFIX}」。`,
                ),
              ])
            : h('div', { style: row }, [
                h('span', '下载版本'),
                h('span', { style: 'opacity:.6;font-size:12px;' }, '原版（安装并启用「小克音量均衡器」后可选均衡版）'),
              ]),
          h('div', { style: row }, [
            h('span', '文件命名'),
            select('nameTemplate', [
              ['title-artist', '歌名 - 歌手'],
              ['artist-title', '歌手 - 歌名'],
              ['title', '仅歌名'],
            ]),
          ]),
          h('div', { style: row }, [
            h('span', `每日上限（今天已下载 ${todayCount.value} 首）`),
            h('input', {
              style: input + 'width:80px;',
              type: 'number',
              min: 1,
              max: 500,
              value: form.dailyLimit,
              onInput: (e) => {
                form.dailyLimit = e.target.value;
                if (e.target.value !== '') persist();
              },
              // 离开输入框时把超范围/空的值纠正回来并显示出来
              onChange: (e) => {
                form.dailyLimit = clampLimit(e.target.value);
                e.target.value = form.dailyLimit;
                persist();
              },
            }),
          ]),
          h(
            'p',
            { style: 'margin:0;opacity:.65;line-height:1.6;' },
            '音质不可用时会自动降一级。每首歌之间会自动间隔几秒，下载正在播放的歌曲时直接复用播放地址，不会额外请求酷狗接口。均衡处理在本机完成，不会多请求酷狗；第一次保存较大的均衡版时，EchoMusic 会再确认一次是否允许运行 open-folder.exe（用来合并文件）。',
          ),
        ]);
    },
  });

  ctx.ui.settings.define({
    title: '小克音乐下载器设置',
    component: SettingsPanel,
  });
}
