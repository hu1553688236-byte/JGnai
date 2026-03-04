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

const V4_MODELS = [
    'nai-diffusion-4-5-curated', 'nai-diffusion-4-5-full',
    'nai-diffusion-4-curated-preview', 'nai-diffusion-4-full'
];

const defaultSettings = {
    enabled: true,
    baseUrl: '',
    token: '',
    verified: false,
    model: 'nai-diffusion-4-5-curated',
    width: 832,
    height: 1216,
    sampler: 'k_euler_ancestral',
    steps: 28,
    cfg: 3,
    startMarker: 'image###',
    endMarker: '###',
    globalPositive: 'masterpiece, best quality, ',
    globalNegative: 'blurry, lowres, bad anatomy, worst quality, bad quality, jpeg artifacts',
};

let isProcessingMessage = false;

function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildPattern() {
    const s = getSettings();
    const start = s.startMarker || defaultSettings.startMarker;
    const end = s.endMarker || defaultSettings.endMarker;
    return new RegExp(escapeRegExp(start) + '(.*?)' + escapeRegExp(end), 'gs');
}

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (extension_settings[MODULE_NAME][key] === undefined) {
            extension_settings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return extension_settings[MODULE_NAME];
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function composeFinalPrompt(prompt) {
    const s = getSettings();
    const gp = (s.globalPositive || '').trim();
    const p = (prompt || '').trim();
    if (gp && p) return gp.endsWith(',') ? `${gp} ${p}` : `${gp}, ${p}`;
    return gp || p;
}

function isV4Model(model) {
    return V4_MODELS.includes(model);
}

function buildRequestBody(prompt) {
    const s = getSettings();
    const finalPrompt = composeFinalPrompt(prompt);
    const neg = s.globalNegative || '';
    const seed = Math.floor(Math.random() * 4294967295);

    return {
        input: finalPrompt,
        model: s.model,
        action: "generate",
        parameters: {
            width: s.width,
            height: s.height,
            scale: s.cfg,
            sampler: s.sampler,
            steps: s.steps,
            seed: seed,
            n_samples: 1,
            ucPreset: 0,
            qualityToggle: true,
            sm: false,
            sm_dyn: false,
            cfg_rescale: 0,
            noise_schedule: "native",
            negative_prompt: neg
        }
    };
}

// ========== API ==========

async function apiRequest(endpoint, options = {}) {
    const s = getSettings();
    if (!s.baseUrl) throw new Error('请先配置服务器地址');

    const url = `${s.baseUrl}${endpoint}`;
    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${s.token}`,
        ...options.headers
    };

    const res = await fetch(url, { ...options, headers });

    if (!res.ok) {
        if (res.status === 401) throw new Error('Token 无效');
        if (res.status === 429) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || '请求太频繁');
        }
        if (res.status === 503) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || '服务器忙');
        }
        throw new Error(`HTTP ${res.status}`);
    }

    return res;
}

async function testConnection() {
    const res = await apiRequest('/health');
    return res.json();
}

async function getStats() {
    const res = await apiRequest('/stats');
    return res.json();
}

async function generateImage(prompt) {
    const body = buildRequestBody(prompt);
    const res = await apiRequest('/ai/generate-image', {
        method: 'POST',
        body: JSON.stringify(body)
    });

    const blob = await res.blob();
    if (blob.size < 1000) {
        throw new Error('返回数据异常');
    }
    return URL.createObjectURL(new Blob([blob], { type: 'image/png' }));
}

// ========== UI Components ==========

function createGenComponent(prompt, messageId) {
    const displayPrompt = prompt.length > 60 ? prompt.slice(0, 60) + '...' : prompt;
    const uniqueId = `nai-${messageId}-${Date.now()}`;

    return `
        <div class="nai-gen-box" data-prompt="${escapeHtml(prompt)}" data-id="${uniqueId}">
            <div class="nai-prompt-display" title="${escapeHtml(prompt)}">
                <span class="nai-prompt-icon">🎨</span>
                <span>${escapeHtml(displayPrompt)}</span>
            </div>
            <button class="nai-gen-btn menu_button">✨ 生成图片</button>
            <div class="nai-result"></div>
        </div>
    `;
}

async function handleGenClick(event) {
    const btn = event.target;
    if (btn.disabled) return;

    const box = btn.closest('.nai-gen-box');
    if (!box) return;

    const prompt = box.dataset.prompt;
    const resultDiv = box.querySelector('.nai-result');

    btn.disabled = true;
    btn.textContent = '⏳ 生成中...';
    resultDiv.innerHTML = '<div class="nai-loading">✨ 正在生成中...</div>';

    try {
        const imgUrl = await generateImage(prompt);

        resultDiv.innerHTML = `
            <img src="${imgUrl}" class="nai-result-img" onclick="window.open(this.src,'_blank')" />
            <div class="nai-image-actions">
                <a href="${imgUrl}" download="nai_${Date.now()}.png" class="nai-action-btn">💾 下载</a>
            </div>
        `;

        btn.textContent = '🔄 重新生成';

        if (typeof toastr !== 'undefined') {
            toastr.success('图片生成成功！');
        }

    } catch (err) {
        resultDiv.innerHTML = `<div class="nai-error">❌ ${escapeHtml(err.message)}</div>`;
        btn.textContent = '✨ 重试';

        if (typeof toastr !== 'undefined') {
            toastr.error(err.message);
        }
    }

    btn.disabled = false;
}

// ========== Message Processing ==========

async function processMessage(messageId) {
    const s = getSettings();
    if (!s.enabled || !s.token || !s.verified) return;

    const mes = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!mes) return;

    const mesText = mes.querySelector('.mes_text');
    if (!mesText) return;

    // 如果已经处理过（包含生成组件），跳过
    if (mesText.querySelector('.nai-gen-box')) return;

    const pattern = buildPattern();
    const html = mesText.innerHTML;

    if (!pattern.test(html)) return;
    pattern.lastIndex = 0;

    // 等 500ms 确认内容稳定（流式传输中可能还在变）
    await new Promise(r => setTimeout(r, 500));
    if (mesText.innerHTML !== html) return;

    isProcessingMessage = true;
    try {
        const newHtml = html.replace(pattern, (match, promptRaw) => {
            const prompt = promptRaw.trim();
            if (!prompt) return match;
            return createGenComponent(prompt, messageId);
        });

        mesText.innerHTML = newHtml;

        mesText.querySelectorAll('.nai-gen-btn').forEach(btn => {
            btn.addEventListener('click', handleGenClick);
        });

        console.log(`[NAI-ImageGen] 已处理消息 #${messageId}`);
    } finally {
        isProcessingMessage = false;
    }
}

async function processAllMessages() {
    const s = getSettings();
    if (!s.enabled || !s.token || !s.verified) return;

    const messages = document.querySelectorAll('#chat .mes');
    for (const mes of messages) {
        const mesid = mes.getAttribute('mesid');
        if (mesid !== null) {
            await processMessage(parseInt(mesid, 10));
        }
    }
}

// ========== Settings ==========

function loadSettingsUI() {
    const s = getSettings();
    $("#nai_enabled").prop("checked", s.enabled);
    $("#nai_base_url").val(s.baseUrl);
    $("#nai_token").val(s.token);
    $("#nai_model").val(s.model);
    $("#nai_width").val(s.width);
    $("#nai_height").val(s.height);
    $("#nai_sampler").val(s.sampler);
    $("#nai_steps").val(s.steps);
    $("#nai_steps_val").text(s.steps);
    $("#nai_cfg").val(s.cfg);
    $("#nai_cfg_val").text(parseFloat(s.cfg).toFixed(1));
    $("#nai_start_marker").val(s.startMarker);
    $("#nai_end_marker").val(s.endMarker);
    $("#nai_global_positive").val(s.globalPositive);
    $("#nai_global_negative").val(s.globalNegative);
    updateLoginStatus();
}

function updateLoginStatus() {
    const s = getSettings();
    const el = $("#nai_login_status");
    if (s.verified) {
        el.html('<span style="color:#4ade80">✅ 已连接</span>');
    } else if (s.token) {
        el.html('<span style="color:#f59e0b">⏳ 待验证</span>');
    } else {
        el.html('<span style="color:#9ca3af">❌ 未连接</span>');
    }
}

function onSettingChange() {
    const s = getSettings();
    s.enabled = $("#nai_enabled").prop("checked");
    s.baseUrl = $("#nai_base_url").val().trim().replace(/\/+$/, '');
    s.model = $("#nai_model").val();
    s.width = parseInt($("#nai_width").val()) || 832;
    s.height = parseInt($("#nai_height").val()) || 1216;
    s.sampler = $("#nai_sampler").val();
    s.steps = parseInt($("#nai_steps").val()) || 28;
    s.cfg = parseFloat($("#nai_cfg").val()) || 3;
    s.startMarker = $("#nai_start_marker").val() || defaultSettings.startMarker;
    s.endMarker = $("#nai_end_marker").val() || defaultSettings.endMarker;
    s.globalPositive = $("#nai_global_positive").val();
    s.globalNegative = $("#nai_global_negative").val();
    saveSettingsDebounced();
}

// ========== Init ==========

jQuery(async () => {
    console.log('[NAI-ImageGen] 加载中...');
    console.log('[NAI-ImageGen] 扩展路径:', extensionFolderPath);

    try {
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        $("#extensions_settings").append(settingsHtml);
        console.log('[NAI-ImageGen] 设置面板加载成功');
    } catch (err) {
        console.error('[NAI-ImageGen] 加载设置面板失败:', err);
        console.error('[NAI-ImageGen] 尝试路径:', `${extensionFolderPath}/settings.html`);
        return;
    }

    // 绑定事件
    $("#nai_enabled, #nai_model, #nai_sampler").on("change", onSettingChange);
    $("#nai_base_url, #nai_start_marker, #nai_end_marker").on("input", onSettingChange);
    $("#nai_global_positive, #nai_global_negative").on("input", onSettingChange);
    $("#nai_width, #nai_height").on("input", onSettingChange);

    $("#nai_steps").on("input", function () {
        $("#nai_steps_val").text(this.value);
        onSettingChange();
    });

    $("#nai_cfg").on("input", function () {
        $("#nai_cfg_val").text(parseFloat(this.value).toFixed(1));
        onSettingChange();
    });

    $("#nai_size_preset").on("change", function () {
        const v = this.value;
        if (v === 'custom') return;
        const [w, h] = v.split(',');
        $("#nai_width").val(w);
        $("#nai_height").val(h);
        onSettingChange();
    });

    $("#nai_token").on("input", function () {
        const s = getSettings();
        s.token = this.value.trim();
        s.verified = false;
        saveSettingsDebounced();
        updateLoginStatus();
    });

    $("#nai_toggle_key").on("click", function () {
        const input = $("#nai_token");
        input.attr("type", input.attr("type") === "password" ? "text" : "password");
    });

    $("#nai_verify_btn").on("click", async function () {
        const s = getSettings();
        s.baseUrl = $("#nai_base_url").val().trim().replace(/\/+$/, '');
        s.token = $("#nai_token").val().trim();

        if (!s.baseUrl || !s.token) {
            if (typeof toastr !== 'undefined') toastr.warning('请填写服务器地址和 Token');
            return;
        }

        saveSettingsDebounced();

        const btn = $(this);
        btn.prop("disabled", true).val("测试中...");

        try {
            const health = await testConnection();

            s.verified = true;
            saveSettingsDebounced();
            updateLoginStatus();

            if (typeof toastr !== 'undefined') {
                toastr.success(`连接成功！模型: ${health.models || '?'}个`);
            }

            // 获取配额
            try {
                const stats = await getStats();
                $("#nai_quota_info").text(
                    `今日已用: ${stats.today_used} | 剩余: ${stats.today_remaining} | 限制: ${stats.rate_limit}`
                );
            } catch (e) {
                console.warn('[NAI-ImageGen] 获取配额失败:', e);
            }

            setTimeout(processAllMessages, 200);

        } catch (err) {
            s.verified = false;
            saveSettingsDebounced();
            updateLoginStatus();
            if (typeof toastr !== 'undefined') toastr.error('连接失败: ' + err.message);
        }

        btn.prop("disabled", false).val("测试连接");
    });

    // 事件委托：生成按钮（兼容动态创建的按钮）
    $(document).on("click", ".nai-gen-btn", function (e) {
        handleGenClick(e);
    });

    // 事件委托：图片点击打开
    $(document).on("click", ".nai-result-img", function () {
        window.open(this.src, '_blank');
    });

    loadSettingsUI();

    // 自动验证
    const s = getSettings();
    if (s.baseUrl && s.token) {
        console.log('[NAI-ImageGen] 自动验证连接...');
        try {
            const health = await testConnection();
            s.verified = true;
            saveSettingsDebounced();
            updateLoginStatus();
            console.log('[NAI-ImageGen] 自动连接成功');

            try {
                const stats = await getStats();
                $("#nai_quota_info").text(
                    `今日已用: ${stats.today_used} | 剩余: ${stats.today_remaining} | 限制: ${stats.rate_limit}`
                );
            } catch (e) {
                // 忽略
            }
        } catch (e) {
            console.warn('[NAI-ImageGen] 自动验证失败:', e.message);
            s.verified = false;
            saveSettingsDebounced();
            updateLoginStatus();
        }
    }

    // 监听 SillyTavern 事件
    try {
        const { eventSource, event_types } = SillyTavern.getContext();

        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (id) => {
            setTimeout(() => processMessage(id).catch(err => {
                console.error('[NAI-ImageGen] processMessage error:', err);
            }), 300);
        });

        eventSource.on(event_types.USER_MESSAGE_RENDERED, (id) => {
            setTimeout(() => processMessage(id).catch(err => {
                console.error('[NAI-ImageGen] processMessage error:', err);
            }), 300);
        });

        eventSource.on(event_types.MESSAGE_EDITED, (id) => {
            setTimeout(() => processMessage(id).catch(err => {
                console.error('[NAI-ImageGen] processMessage error:', err);
            }), 100);
        });

        eventSource.on(event_types.CHAT_CHANGED, () => {
            setTimeout(processAllMessages, 200);
        });

        eventSource.on(event_types.MESSAGE_SWIPED, () => {
            setTimeout(processAllMessages, 100);
        });

        console.log('[NAI-ImageGen] 事件监听器已绑定');
    } catch (err) {
        console.warn('[NAI-ImageGen] 无法绑定事件:', err);
    }

    // 轮询兜底：每 3 秒扫描一次未处理的标记
    setInterval(() => {
        const s = getSettings();
        if (!s.enabled || !s.token || !s.verified) return;

        const pattern = buildPattern();
        document.querySelectorAll('#chat .mes .mes_text').forEach(mesText => {
            // 跳过已处理的
            if (mesText.querySelector('.nai-gen-box')) return;

            if (pattern.test(mesText.innerHTML)) {
                pattern.lastIndex = 0;
                const mes = mesText.closest('.mes');
                if (mes) {
                    const id = parseInt(mes.getAttribute('mesid'), 10);
                    if (!isNaN(id)) {
                        processMessage(id).catch(err => {
                            console.error('[NAI-ImageGen] 轮询 processMessage error:', err);
                        });
                    }
                }
            }
            pattern.lastIndex = 0;
        });
    }, 3000);

    setTimeout(processAllMessages, 500);

    console.log('[NAI-ImageGen] 加载完成');
});
