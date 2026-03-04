import { extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const MODULE_NAME = 'nai_image_gen';

// 自动检测路径
const extensionFolderPath = (() => {
    const url = new URL(import.meta.url);
    const parts = url.pathname.split('/');
    parts.pop();
    return parts.join('/');
})();

// 画风预设 (Prompt前缀)
const STYLES = {
    'style_1': { name: '精致立绘', prefix: '{{{Character Study}}}, 4::masterpiece, best quality,::, 2::official art, year2024,::, 1.95::Artist:nobusawa_osamu::, 1.05::Artist:bilibili_xiaolu::, 1.75::Artist:houkisei::, sharp focus, detailed background', preview: 'https://files.catbox.moe/vfw8i2.png' },
    'style_2': { name: '3D写实', prefix: 'best quality, masterpiece, realistic, 2.00::3D::, 1.20::Artist:jagercoke::, 1.40::Artist:yinse_qi_ji::, 1.50::Artist:nixeu::, photorealistic, 8k, subsurface scattering, skin texture, pores', preview: 'https://files.catbox.moe/ye39wv.png' },
    'style_3': { name: 'Q版可爱', prefix: '2.12::chibi::, 1.78::Artist:xinzoruo(chibi)::, kawaii, small body proportions, round face, soft lighting, pastel colors, simple background', preview: 'https://files.catbox.moe/hrsl8m.png' },
    'style_4': { name: '水墨武侠', prefix: 'masterpiece, 2.0::ink_wash_painting::, 1.5::greyscale::, 1.75::Artist:xuedaixun(ink_wash_painting)::, inkblot, ink, wuxia atmosphere, dynamic pose', preview: 'https://files.catbox.moe/rno2b6.png' }
};

const defaultSettings = {
    enabled: true,
    baseUrl: '',
    token: '',
    verified: false,
    model: 'nai-diffusion-4-5-curated',
    selected_style: 'style_1',
    auto_gen: false,
};

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    return extension_settings[MODULE_NAME];
}

// ========== NAI API ==========

async function apiRequest(endpoint, options = {}) {
    const s = getSettings();
    const url = `${s.baseUrl}${endpoint}`;
    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${s.token}`,
        ...options.headers
    };
    try {
        const res = await fetch(url, { ...options, headers });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res;
    } catch (err) {
        throw err;
    }
}

async function generateImage(prompt) {
    const s = getSettings();
    
    // 合并画风前缀
    const style = STYLES[s.selected_style];
    const finalPrompt = style ? `${style.prefix}, ${prompt}` : prompt;
    
    const body = {
        input: finalPrompt,
        model: s.model,
        action: "generate",
        parameters: {
            width: 832, height: 1216, scale: 3, sampler: "k_euler_ancestral", steps: 28,
            seed: Math.floor(Math.random() * 4294967295),
            n_samples: 1, ucPreset: 0, qualityToggle: true,
            negative_prompt: "blurry, lowres, bad anatomy, worst quality, bad quality"
        }
    };

    const res = await apiRequest('/ai/generate-image', {
        method: 'POST',
        body: JSON.stringify(body)
    });

    const blob = await res.blob();
    if (blob.size < 1000) throw new Error('生成失败');
    return URL.createObjectURL(new Blob([blob], { type: 'image/png' }));
}

// ========== GBA 面板逻辑 ==========

function createGBAPanel() {
    if (document.getElementById('nai_style_gen')) return;

    const s = getSettings();
    const currentStyle = STYLES[s.selected_style] || STYLES['style_1'];

    const html = `
    <div class="gba-shell">
        <div class="gba-texture"></div>
        <div class="gba-bright"></div>
        <div class="gba-logo" id="nsg_logo" title="切换画风">
            <span class="gba-logo-text" id="nsg_style_name">${currentStyle.name}</span>
        </div>
        <div class="gba-vline gba-vline-left"></div>
        <div class="gba-vline gba-vline-right"></div>
        <div class="gba-sticker">
            <div class="gba-sticker-inner">
                <div class="gba-preview-img" id="nsg_preview_img" style="background-image:url(${currentStyle.preview});"></div>
                <div class="gba-status" id="nsg_status">READY</div>
            </div>
        </div>
        <div class="gba-sidebar gba-sidebar-left">
            <span class="gba-sidebar-text">NOVEL AI</span>
        </div>
        <div class="gba-sidebar gba-sidebar-right">
            <span class="gba-sidebar-text">ZEABUR</span>
        </div>
        
        <!-- 底部控制栏 -->
        <div class="gba-arrow" id="nsg_toggle">▼</div>
        <button class="gba-close" id="nsg_close">×</button>
    </div>
    
    <div class="gba-panel" id="nsg_panel" style="display:none;">
        <div class="gba-row">
            <select id="nsg_style_select" class="gba-select">
                ${Object.keys(STYLES).map(k => `<option value="${k}" ${k === s.selected_style ? 'selected' : ''}>${STYLES[k].name}</option>`).join('')}
            </select>
        </div>
        <div class="gba-buttons">
            <button id="nsg_gen_btn" class="gba-btn gba-btn-gen">▶ DRAW</button>
            <button id="nsg_regen_btn" class="gba-btn gba-btn-regen">↻ REDO</button>
        </div>
        <div class="gba-auto-row">
            <label class="gba-auto-box">
                <input type="checkbox" id="nsg_auto_gen" ${s.auto_gen ? 'checked' : ''}>
                <span class="gba-auto-label">AUTO</span>
            </label>
            <span class="gba-auto-status" id="nsg_auto_status">STANDBY</span>
        </div>
    </div>`;

    const panel = document.createElement('div');
    panel.id = 'nai_style_gen';
    panel.innerHTML = html;
    document.body.appendChild(panel);

    bindGBAEvents();
}

function bindGBAEvents() {
    const s = getSettings();
    const panel = document.getElementById('nai_style_gen');
    const shell = panel.querySelector('.gba-shell');
    const toggle = document.getElementById('nsg_toggle');
    const expandPanel = document.getElementById('nsg_panel');

    // 拖拽逻辑
    let isDragging = false, offset = { x: 0, y: 0 };
    shell.addEventListener('mousedown', (e) => {
        if (e.target.closest('.gba-logo, .gba-arrow, .gba-close')) return;
        isDragging = true;
        offset.x = e.clientX - panel.offsetLeft;
        offset.y = e.clientY - panel.offsetTop;
    });
    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        panel.style.left = (e.clientX - offset.x) + 'px';
        panel.style.top = (e.clientY - offset.y) + 'px';
        panel.style.right = 'auto'; // 清除默认的 right: 20px
    });
    document.addEventListener('mouseup', () => isDragging = false);

    // 展开/收起
    toggle.onclick = () => {
        const isClosed = expandPanel.style.display === 'none';
        expandPanel.style.display = isClosed ? 'block' : 'none';
        shell.classList.toggle('panel-open', isClosed);
        toggle.innerText = isClosed ? '▲' : '▼';
    };

    // 关闭
    document.getElementById('nsg_close').onclick = () => panel.remove();

    // 切换画风
    const styleSelect = document.getElementById('nsg_style_select');
    styleSelect.onchange = (e) => {
        const key = e.target.value;
        s.selected_style = key;
        saveSettingsDebounced();
        
        document.getElementById('nsg_style_name').innerText = STYLES[key].name;
        document.getElementById('nsg_preview_img').style.backgroundImage = `url(${STYLES[key].preview})`;
        toastr.success(`画风已切换: ${STYLES[key].name}`);
    };

    // 点击 Logo 循环切换
    document.getElementById('nsg_logo').onclick = () => {
        const keys = Object.keys(STYLES);
        const idx = keys.indexOf(s.selected_style);
        const nextKey = keys[(idx + 1) % keys.length];
        styleSelect.value = nextKey;
        styleSelect.dispatchEvent(new Event('change'));
    };

    // 自动生图开关
    document.getElementById('nsg_auto_gen').onchange = (e) => {
        s.auto_gen = e.target.checked;
        saveSettingsDebounced();
        document.getElementById('nsg_auto_status').innerText = s.auto_gen ? 'READY' : 'OFF';
        toastr.info(`自动生图: ${s.auto_gen ? '开启' : '关闭'}`);
    };

    // ▶ DRAW 按钮逻辑
    document.getElementById('nsg_gen_btn').onclick = async () => {
        if (!s.baseUrl || !s.token) return toastr.warning('请先在插件设置里配置连接！');
        
        // 获取最新一条消息内容
        const lastMsg = document.querySelector('#chat .mes:last-child .mes_text');
        if (!lastMsg) return toastr.warning('没有找到消息');
        
        const content = lastMsg.innerText;
        updateStatus('WORKING');
        
        try {
            const imgUrl = await generateImage(content.slice(0, 500));
            // 插入图片到消息
            const { chat, updateMessageBlock } = await import('/script.js');
            const msgs = document.querySelectorAll('#chat .mes');
            const msgIndex = msgs.length - 1;
            
            chat[msgIndex].mes += `\n\n<img src="${imgUrl}" style="max-width:100%;border-radius:8px;">`;
            updateMessageBlock(msgIndex, chat[msgIndex]);
            
            updateStatus('DONE');
            toastr.success('生成成功！');
        } catch (err) {
            updateStatus('FAIL');
            toastr.error(err.message);
        }
    };
}

function updateStatus(text) {
    const el = document.getElementById('nsg_auto_status');
    const mainEl = document.getElementById('nsg_status');
    if (el) el.innerText = text;
    if (mainEl) mainEl.innerText = text;
}

// ========== 自动监听逻辑 ==========

let lastProcessedId = null;

async function checkAutoGenerate() {
    const s = getSettings();
    if (!s.auto_gen || !s.enabled) return;

    const msgs = document.querySelectorAll('#chat .mes');
    if (msgs.length === 0) return;

    const lastMsg = msgs[msgs.length - 1];
    const id = lastMsg.getAttribute('mesid');

    // 如果是新消息，且不是系统提示
    if (id !== lastProcessedId && !lastMsg.classList.contains('sys_mes')) {
        lastProcessedId = id;
        
        // 简单的防抖，等待消息生成完毕
        setTimeout(async () => {
            const content = lastMsg.querySelector('.mes_text').innerText;
            if (content.length < 10) return; // 太短不生成

            updateStatus('AUTO...');
            try {
                const imgUrl = await generateImage(content.slice(0, 500));
                
                const { chat, updateMessageBlock } = await import('/script.js');
                const msgIndex = parseInt(id);
                
                if (chat[msgIndex]) {
                    chat[msgIndex].mes += `\n\n<img src="${imgUrl}" style="max-width:100%;border-radius:8px;">`;
                    updateMessageBlock(msgIndex, chat[msgIndex]);
                    updateStatus('DONE');
                }
            } catch (err) {
                updateStatus('ERR');
            }
        }, 2000);
    }
}

// ========== 初始化 ==========

jQuery(async () => {
    try {
        // 加载标准设置面板 (settings.html)
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        $("#extensions_settings").append(settingsHtml);
        
        // 绑定标准设置事件
        $("#nai_verify_btn").on("click", async () => {
            // ... 原有的验证逻辑 ...
            const s = getSettings();
            s.baseUrl = $("#nai_base_url").val().trim();
            s.token = $("#nai_token").val().trim();
            saveSettingsDebounced();
            try {
                await apiRequest('/health');
                s.verified = true;
                toastr.success('连接成功');
            } catch (e) { toastr.error('连接失败'); }
        });
        
        // 加载 GBA 悬浮窗
        createGBAPanel();
        
        // 启动自动监听循环
        setInterval(checkAutoGenerate, 1000);
        
        console.log('[NAI-ImageGen] GBA版加载完成');
        
    } catch (err) {
        console.error(err);
    }
});
