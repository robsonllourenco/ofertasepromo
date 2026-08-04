/**
 * Admin Controller - Antigravity Redirect & Security Engine
 * Suporte a Subdomínio Isolado (admin.meudominio.com.br), Cloudflare Worker Proxy (Zero Token Client) e TOTP 2FA.
 */
(function () {
  'use strict';

  const DEFAULT_PASSWORD = 'CAFEQuente@@##77';
  const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;
  const MAX_FAILED_ATTEMPTS = 5;
  const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

  let linksDatabase = {};
  let clickStats = {};
  let currentPage = 1;
  const itemsPerPage = 20;
  let filteredSlugs = [];

  let memDecryptedGithubToken = '';
  let activeMasterPassword = '';
  let countdownInterval = null;
  let lastActivityTime = Date.now();

  // ==========================================
  // TOTP RFC 6238
  // ==========================================

  const Base32 = {
    alphabet: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
    encode: function (buffer) {
      let length = buffer.length;
      let bits = 0;
      let value = 0;
      let output = '';
      for (let i = 0; i < length; i++) {
        value = (value << 8) | buffer[i];
        bits += 8;
        while (bits >= 5) {
          output += this.alphabet[(value >>> (bits - 5)) & 31];
          bits -= 5;
        }
      }
      if (bits > 0) output += this.alphabet[(value << (5 - bits)) & 31];
      return output;
    },
    decode: function (str) {
      str = str.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
      let length = str.length;
      let bits = 0;
      let value = 0;
      let output = [];
      for (let i = 0; i < length; i++) {
        let idx = this.alphabet.indexOf(str[i]);
        if (idx === -1) continue;
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
          output.push((value >>> (bits - 8)) & 255);
          bits -= 8;
        }
      }
      return new Uint8Array(output);
    }
  };

  function generateTotpSecret() {
    return Base32.encode(crypto.getRandomValues(new Uint8Array(10)));
  }

  async function generateTotpCode(secretBase32, timeStepOffset = 0) {
    try {
      const keyBytes = Base32.decode(secretBase32);
      const timeStep = Math.floor((Date.now() / 1000) / 30) + timeStepOffset;

      const buffer = new ArrayBuffer(8);
      const view = new DataView(buffer);
      view.setUint32(4, timeStep, false);

      const cryptoKey = await crypto.subtle.importKey(
        'raw',
        keyBytes,
        { name: 'HMAC', hash: 'SHA-1' },
        false,
        ['sign']
      );

      const signature = await crypto.subtle.sign('HMAC', cryptoKey, buffer);
      const sigView = new DataView(signature);
      const offset = sigView.getUint8(signature.byteLength - 1) & 0xf;

      const binary = ((sigView.getUint8(offset) & 0x7f) << 24) |
        ((sigView.getUint8(offset + 1) & 0xff) << 16) |
        ((sigView.getUint8(offset + 2) & 0xff) << 8) |
        (sigView.getUint8(offset + 3) & 0xff);

      const otp = binary % 1000000;
      return otp.toString().padStart(6, '0');
    } catch (e) {
      return '';
    }
  }

  async function verifyTotpCode(inputCode, secretBase32) {
    if (!secretBase32 || !inputCode) return false;
    const cleanInput = inputCode.trim();
    for (let offset of [0, -1, 1]) {
      const expected = await generateTotpCode(secretBase32, offset);
      if (expected === cleanInput) return true;
    }
    return false;
  }

  // ==========================================
  // Criptografia AES-256-GCM
  // ==========================================

  async function hashString(str) {
    const encoder = new TextEncoder();
    const data = encoder.encode(str);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function getCryptoKey(password, salt) {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      encoder.encode(password),
      'PBKDF2',
      false,
      ['deriveKey']
    );

    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: encoder.encode(salt),
        iterations: 100000,
        hash: 'SHA-256'
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function encryptToken(token, password) {
    if (!token) return '';
    try {
      const salt = 'redirect_salt_v4';
      const key = await getCryptoKey(password, salt);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encoder = new TextEncoder();

      const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        encoder.encode(token)
      );

      const combined = new Uint8Array(iv.length + encrypted.byteLength);
      combined.set(iv, 0);
      combined.set(new Uint8Array(encrypted), iv.length);

      return btoa(String.fromCharCode.apply(null, combined));
    } catch (e) {
      return '';
    }
  }

  async function decryptToken(encryptedBase64, password) {
    if (!encryptedBase64) return '';
    try {
      const salt = 'redirect_salt_v4';
      const key = await getCryptoKey(password, salt);
      const combinedStr = atob(encryptedBase64);
      const combined = new Uint8Array(combinedStr.length);
      for (let i = 0; i < combinedStr.length; i++) {
        combined[i] = combinedStr.charCodeAt(i);
      }

      const iv = combined.slice(0, 12);
      const data = combined.slice(12);

      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        key,
        data
      );

      const decoder = new TextDecoder();
      return decoder.decode(decrypted);
    } catch (e) {
      return '';
    }
  }

  // ==========================================
  // Anti-Brute-Force & Logs
  // ==========================================

  function checkLockout() {
    const lockoutUntil = parseInt(localStorage.getItem('redirect_lockout_until') || '0', 10);
    const now = Date.now();
    const alertBox = document.getElementById('lockout-alert');

    if (now < lockoutUntil) {
      const remainingMin = Math.ceil((lockoutUntil - now) / 60000);
      if (alertBox) {
        alertBox.textContent = `🚨 Acesso bloqueado! Tente novamente em ${remainingMin} minuto(s).`;
        alertBox.classList.remove('hidden');
      }
      return true;
    } else {
      if (alertBox) alertBox.classList.add('hidden');
      return false;
    }
  }

  function recordFailedAttempt() {
    let attempts = parseInt(localStorage.getItem('redirect_failed_attempts') || '0', 10) + 1;
    localStorage.setItem('redirect_failed_attempts', attempts.toString());
    addAuditLog('Tentativa de Login Incorreta', `Tentativa ${attempts}/${MAX_FAILED_ATTEMPTS}`);

    if (attempts >= MAX_FAILED_ATTEMPTS) {
      const lockoutUntil = Date.now() + LOCKOUT_DURATION_MS;
      localStorage.setItem('redirect_lockout_until', lockoutUntil.toString());
      localStorage.setItem('redirect_failed_attempts', '0');
      addAuditLog('Bloqueio Anti-Brute-Force', 'Painel bloqueado por 15 minutos');
      checkLockout();
    }
  }

  function clearFailedAttempts() {
    localStorage.setItem('redirect_failed_attempts', '0');
    localStorage.removeItem('redirect_lockout_until');
  }

  async function addAuditLog(action, details = '') {
    try {
      const logs = JSON.parse(localStorage.getItem('redirect_audit_logs') || '[]');
      const newLog = {
        timestamp: new Date().toLocaleString('pt-BR'),
        action: action,
        details: details,
        userAgent: navigator.userAgent.split(' ')[0]
      };
      logs.unshift(newLog);
      if (logs.length > 50) logs.pop();
      localStorage.setItem('redirect_audit_logs', JSON.stringify(logs));
    } catch (e) {}
  }

  function renderAuditLogs() {
    const tbody = document.getElementById('audit-log-body');
    if (!tbody) return;

    try {
      const logs = JSON.parse(localStorage.getItem('redirect_audit_logs') || '[]');
      if (logs.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; padding: 10px;">Nenhum log registrado.</td></tr>`;
        return;
      }

      const html = logs.map(log => `
        <tr style="border-bottom: 1px solid var(--border-subtle);">
          <td style="padding: 6px; font-size: 11px; white-space: nowrap;">${escapeHtml(log.timestamp)}</td>
          <td style="padding: 6px; font-weight: 700;">${escapeHtml(log.action)}</td>
          <td style="padding: 6px; font-size: 11px;">${escapeHtml(log.details || '-')}</td>
          <td style="padding: 6px; font-size: 11px; color: var(--text-muted);">${escapeHtml(log.userAgent)}</td>
        </tr>
      `).join('');

      tbody.innerHTML = html;
    } catch (e) {}
  }

  // ==========================================
  // Sessão & Auto-Logout
  // ==========================================

  function resetInactivityTimer() {
    lastActivityTime = Date.now();
  }

  function startSessionTimer() {
    stopSessionTimer();
    lastActivityTime = Date.now();
    ['mousemove', 'keydown', 'click', 'touchstart', 'scroll'].forEach(evt => {
      window.addEventListener(evt, resetInactivityTimer, { passive: true });
    });

    countdownInterval = setInterval(() => {
      const elapsed = Date.now() - lastActivityTime;
      const remaining = INACTIVITY_TIMEOUT_MS - elapsed;

      if (remaining <= 0) {
        handleAutoLogout();
        return;
      }

      const min = Math.floor(remaining / 60000);
      const sec = Math.floor((remaining % 60000) / 1000);
      const badge = document.getElementById('session-timer-badge');
      if (badge) badge.textContent = `⏱️ ${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
    }, 1000);
  }

  function stopSessionTimer() {
    if (countdownInterval) clearInterval(countdownInterval);
    ['mousemove', 'keydown', 'click', 'touchstart', 'scroll'].forEach(evt => {
      window.removeEventListener(evt, resetInactivityTimer);
    });
  }

  function handleAutoLogout() {
    stopSessionTimer();
    memDecryptedGithubToken = '';
    activeMasterPassword = '';
    sessionStorage.removeItem('redirect_admin_authed');
    addAuditLog('Sessão Encerrada', 'Logout por inatividade');

    document.getElementById('admin-app').classList.add('hidden');
    const loginModal = document.getElementById('login-modal');
    loginModal.classList.add('active');
    document.getElementById('login-step-1').classList.remove('hidden');
    document.getElementById('login-step-2').classList.add('hidden');

    showToast('🔒 Sessão encerrada.');
  }

  function triggerPanicMode() {
    if (confirm('🚨 MODO DE EMERGÊNCIA:\n\nDeseja encerrar todas as sessões e purgar tokens imediatamente?')) {
      memDecryptedGithubToken = '';
      activeMasterPassword = '';
      sessionStorage.clear();
      localStorage.removeItem('redirect_github_token_enc');

      addAuditLog('🚨 MODO DE EMERGÊNCIA', 'Chaves purgadas e sessões encerradas');

      alert('🚨 Modo de Emergência acionado com sucesso!');
      window.location.reload();
    }
  }

  // ==========================================
  // Domínio & Cópia de Link
  // ==========================================

  function getBaseDomain() {
    const custom = localStorage.getItem('redirect_custom_domain');
    if (custom && custom.trim() !== '') {
      let domain = custom.trim();
      if (!domain.startsWith('http://') && !domain.startsWith('https://')) {
        domain = 'https://' + domain;
      }
      return domain.replace(/\/$/, '');
    }
    return window.location.origin;
  }

  function getUrlPrefix() {
    const prefix = localStorage.getItem('redirect_url_prefix') || 'go';
    if (prefix === 'direct') return '';
    return prefix;
  }

  function getPublicUrl(slug) {
    const base = getBaseDomain();
    const prefix = getUrlPrefix();
    return prefix ? `${base}/${prefix}/${slug}` : `${base}/${slug}`;
  }

  async function copyToClipboard(text, btnElement) {
    let success = false;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        success = true;
      } catch (err) {}
    }

    if (!success) {
      try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        success = document.execCommand('copy');
        document.body.removeChild(textarea);
      } catch (e) {}
    }

    if (success) {
      showToast('📋 Link copiado para a área de transferência!');
      if (btnElement) {
        const originalHtml = btnElement.innerHTML;
        btnElement.classList.add('copied');
        btnElement.innerHTML = '✓ Copiado!';
        setTimeout(() => {
          btnElement.classList.remove('copied');
          btnElement.innerHTML = originalHtml;
        }, 2000);
      }
    } else {
      showToast('❌ Erro ao copiar link.');
    }
  }

  function showToast(message) {
    const toast = document.getElementById('toast');
    const toastMsg = document.getElementById('toast-message');
    if (toast && toastMsg) {
      toastMsg.textContent = message;
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 3500);
    }
  }

  // ==========================================
  // Sincronização GitHub / Cloudflare Worker Proxy
  // ==========================================

  function getGithubConfig() {
    return {
      token: memDecryptedGithubToken,
      owner: localStorage.getItem('redirect_github_owner') || '',
      repo: localStorage.getItem('redirect_github_repo') || '',
      branch: localStorage.getItem('redirect_github_branch') || 'main',
      workerUrl: localStorage.getItem('redirect_worker_url') || ''
    };
  }

  function updateGithubBadgeStatus(statusText, isConnected) {
    const badge = document.getElementById('github-sync-badge');
    if (!badge) return;
    badge.style.background = isConnected ? 'var(--success-bg)' : 'var(--bg-subtle)';
    badge.style.color = isConnected ? 'var(--success-text)' : 'var(--text-muted)';
    badge.textContent = statusText;
  }

  async function syncToGithub(commitMessage = 'Atualizar links.json via Painel Admin') {
    const config = getGithubConfig();

    // 1. Tentar enviar via Cloudflare Worker Proxy (Zero Client Token)
    if (config.workerUrl) {
      try {
        showToast('⚡ Enviando via Cloudflare Worker Proxy...');
        const res = await fetch(config.workerUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + (activeMasterPassword || DEFAULT_PASSWORD)
          },
          body: JSON.stringify({
            linksData: linksDatabase,
            commitMessage: commitMessage,
            repoOwner: config.owner,
            repoName: config.repo,
            branch: config.branch
          })
        });

        if (res.ok) {
          saveDatabaseLocally();
          addAuditLog('Commit via Proxy Worker', commitMessage);
          showToast('⚡ Commit realizado via Cloudflare Worker Proxy!');
          updateGithubBadgeStatus('⚡ Worker Proxy: Ativo', true);
          return true;
        } else {
          const err = await res.json();
          showToast(`❌ Erro no Worker: ${err.error || 'Falha no proxy'}`);
        }
      } catch (e) {
        console.warn('Erro ao conectar ao Worker Proxy, usando fallback direto:', e);
      }
    }

    // 2. Fallback: Conexão direta com API do GitHub
    if (!config.token || !config.owner || !config.repo) {
      saveDatabaseLocally();
      return false;
    }

    try {
      showToast('⏳ Sincronizando com o GitHub...');
      const filePath = 'links.json';
      const apiUrl = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${filePath}`;

      let sha = '';
      const getRes = await fetch(`${apiUrl}?ref=${config.branch}`, {
        headers: {
          'Authorization': `token ${config.token}`,
          'Accept': 'application/vnd.github.v3+json'
        }
      });

      if (getRes.ok) {
        const fileData = await getRes.json();
        sha = fileData.sha;
      }

      const jsonStr = JSON.stringify(linksDatabase, null, 2);
      const base64Content = btoa(unescape(encodeURIComponent(jsonStr)));

      const putBody = {
        message: commitMessage,
        content: base64Content,
        branch: config.branch
      };
      if (sha) putBody.sha = sha;

      const putRes = await fetch(apiUrl, {
        method: 'PUT',
        headers: {
          'Authorization': `token ${config.token}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(putBody)
      });

      if (putRes.ok) {
        saveDatabaseLocally();
        addAuditLog('Commit no GitHub', commitMessage);
        showToast('🐙 Commit realizado no GitHub!');
        updateGithubBadgeStatus('🐙 GitHub API: Conectado', true);
        return true;
      } else {
        const errorData = await putRes.json();
        showToast(`❌ Erro no GitHub: ${errorData.message || 'Falha ao salvar'}`);
        saveDatabaseLocally();
        return false;
      }
    } catch (e) {
      showToast('⚠️ Erro de rede. Salvo localmente.');
      saveDatabaseLocally();
      return false;
    }
  }

  async function testGithubConnection() {
    const workerUrl = document.getElementById('setting-worker-url').value.trim();
    if (workerUrl) {
      try {
        const res = await fetch(workerUrl.replace('/api/update-links', '/health'));
        if (res.ok) {
          alert('✅ Conexão bem-sucedida com o Cloudflare Worker Proxy!');
          updateGithubBadgeStatus('⚡ Worker Proxy: Conectado', true);
          return;
        }
      } catch (e) {}
    }

    const token = document.getElementById('setting-github-token').value.trim() || memDecryptedGithubToken;
    const owner = document.getElementById('setting-github-owner').value.trim();
    const repo = document.getElementById('setting-github-repo').value.trim();
    const branch = document.getElementById('setting-github-branch').value.trim() || 'main';

    if (!token || !owner || !repo) {
      alert('Preencha o Token (ou URL do Worker), Usuário e Nome do Repositório.');
      return;
    }

    try {
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/links.json?ref=${branch}`, {
        headers: {
          'Authorization': `token ${token}`,
          'Accept': 'application/vnd.github.v3+json'
        }
      });

      if (res.ok || res.status === 404) {
        alert('✅ Conexão bem-sucedida com a API do GitHub!');
        updateGithubBadgeStatus('🐙 GitHub API: Conectado', true);
      } else {
        const err = await res.json();
        alert(`❌ Erro (${res.status}): ${err.message}`);
      }
    } catch (e) {
      alert('❌ Erro de conexão.');
    }
  }

  function extractBloggerSlug(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return '';
    try {
      const url = new URL(urlStr.trim());
      const pathname = url.pathname;
      if (pathname.endsWith('.html')) {
        const parts = pathname.split('/').filter(Boolean);
        return parts[parts.length - 1].replace(/\.html$/i, '').toLowerCase();
      }
      const cleanParts = pathname.split('/').filter(Boolean);
      if (cleanParts.length > 0) {
        return cleanParts[cleanParts.length - 1].replace(/[^a-zA-Z0-9\-_]/g, '-').toLowerCase();
      }
    } catch (e) {}
    return '';
  }

  function titleizeSlug(slug) {
    return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }

  // ==========================================
  // Carregamento & Tabela
  // ==========================================

  async function loadData() {
    startSessionTimer();

    const encToken = localStorage.getItem('redirect_github_token_enc');
    if (encToken && activeMasterPassword) {
      memDecryptedGithubToken = await decryptToken(encToken, activeMasterPassword);
    }

    const ghConfig = getGithubConfig();

    if (ghConfig.workerUrl) {
      updateGithubBadgeStatus('⚡ Worker Proxy: Ativo', true);
    } else if (ghConfig.token && ghConfig.owner && ghConfig.repo) {
      updateGithubBadgeStatus('Conectando...', true);
      try {
        const res = await fetch(`https://api.github.com/repos/${ghConfig.owner}/${ghConfig.repo}/contents/links.json?ref=${ghConfig.branch}`, {
          headers: {
            'Authorization': `token ${ghConfig.token}`,
            'Accept': 'application/vnd.github.v3+json'
          }
        });

        if (res.ok) {
          const data = await res.json();
          const jsonContent = decodeURIComponent(escape(atob(data.content)));
          linksDatabase = JSON.parse(jsonContent);
          saveDatabaseLocally();
          updateGithubBadgeStatus('Conectado', true);
        }
      } catch (e) {}
    }

    if (Object.keys(linksDatabase).length === 0) {
      const localDb = localStorage.getItem('redirect_links_db');
      if (localDb) {
        try { linksDatabase = JSON.parse(localDb); } catch (e) {}
      }
    }

    if (Object.keys(linksDatabase).length === 0) {
      try {
        const res = await fetch('../links.json?t=' + Date.now());
        if (res.ok) {
          linksDatabase = await res.json();
          saveDatabaseLocally();
        }
      } catch (e) {}
    }

    try {
      clickStats = JSON.parse(localStorage.getItem('redirect_click_stats') || '{}');
    } catch (e) {}

    updatePrefixDisplay();
    renderMetrics();
    filterAndRenderLinks();
    setupTotpQrCode();
  }

  function saveDatabaseLocally() {
    try {
      localStorage.setItem('redirect_links_db', JSON.stringify(linksDatabase));
      localStorage.setItem('redirect_links_cache', JSON.stringify(linksDatabase));
    } catch (e) {}
  }

  function updatePrefixDisplay() {
    const prefix = getUrlPrefix();
    const prefixEl = document.getElementById('domain-prefix');
    if (prefixEl) prefixEl.textContent = prefix ? `meudominio.com.br/${prefix}/` : 'meudominio.com.br/';
  }

  function renderMetrics() {
    const slugs = Object.keys(linksDatabase);
    const totalLinks = slugs.length;
    let totalClicks = 0;
    let topLink = '-';
    let maxClicks = -1;

    const prefix = getUrlPrefix();
    const pathPrefix = prefix ? `/${prefix}/` : '/';

    slugs.forEach(slug => {
      const item = linksDatabase[slug];
      const clicks = (item.clicks || 0) + (clickStats[slug] || 0);
      totalClicks += clicks;
      if (clicks > maxClicks && clicks > 0) {
        maxClicks = clicks;
        topLink = `${pathPrefix}${slug} (${clicks} clicks)`;
      }
    });

    document.getElementById('stat-total-links').textContent = totalLinks.toLocaleString('pt-BR');
    document.getElementById('stat-total-clicks').textContent = totalClicks.toLocaleString('pt-BR');
    document.getElementById('stat-top-link').textContent = topLink;
    document.getElementById('links-count-badge').textContent = `${totalLinks} links`;
  }

  function filterAndRenderLinks() {
    const searchInput = document.getElementById('admin-search-input');
    const query = (searchInput ? searchInput.value : '').trim().toLowerCase();
    const allSlugs = Object.keys(linksDatabase);

    if (!query) {
      filteredSlugs = allSlugs;
    } else {
      filteredSlugs = allSlugs.filter(slug => {
        const item = linksDatabase[slug];
        const title = (item.title || '').toLowerCase();
        const url = (item.url || '').toLowerCase();
        return slug.includes(query) || title.includes(query) || url.includes(query);
      });
    }

    currentPage = 1;
    renderTablePage();
  }

  function renderTablePage() {
    const tbody = document.getElementById('links-table-body');
    const total = filteredSlugs.length;

    if (total === 0) {
      tbody.innerHTML = `<tr><td colspan="4" class="no-posts">Nenhum link encontrado.</td></tr>`;
      document.getElementById('pag-start').textContent = '0';
      document.getElementById('pag-end').textContent = '0';
      document.getElementById('pag-total').textContent = '0';
      document.getElementById('pag-current-page').textContent = '1';
      return;
    }

    const startIdx = (currentPage - 1) * itemsPerPage;
    const endIdx = Math.min(startIdx + itemsPerPage, total);
    const pageSlugs = filteredSlugs.slice(startIdx, endIdx);

    const prefix = getUrlPrefix();
    const pathPrefix = prefix ? `/${prefix}/` : '/';

    const html = pageSlugs.map(slug => {
      const item = linksDatabase[slug];
      const publicUrl = getPublicUrl(slug);
      const clicks = (item.clicks || 0) + (clickStats[slug] || 0);

      return `
        <tr>
          <td>
            <div class="slug-cell">
              <a href="${publicUrl}" target="_blank" style="color: var(--accent-primary); text-decoration: none; font-weight: 700;">
                ${pathPrefix}${escapeHtml(slug)}
              </a>
            </div>
          </td>
          <td>
            <div style="font-weight: 600;">${escapeHtml(item.title || slug)}</div>
            <div class="url-cell" title="${escapeHtml(item.url)}">${escapeHtml(item.url)}</div>
          </td>
          <td style="text-align: center;">
            <span class="clicks-badge">${clicks}</span>
          </td>
          <td style="text-align: right;">
            <div class="action-buttons-cell" style="justify-content: flex-end;">
              <button type="button" class="btn btn-copy btn-sm btn-copy-action" data-url="${escapeHtml(publicUrl)}">
                📋 Copiar link
              </button>
              <button type="button" class="btn btn-outline btn-sm btn-qr-action" data-slug="${escapeHtml(slug)}" data-url="${escapeHtml(publicUrl)}">
                📱 QR
              </button>
              <button type="button" class="btn btn-danger btn-sm btn-delete-action" data-slug="${escapeHtml(slug)}">
                🗑️
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join('');

    tbody.innerHTML = html;

    document.getElementById('pag-start').textContent = (startIdx + 1).toString();
    document.getElementById('pag-end').textContent = endIdx.toString();
    document.getElementById('pag-total').textContent = total.toString();
    document.getElementById('pag-current-page').textContent = currentPage.toString();

    tbody.querySelectorAll('.btn-copy-action').forEach(btn => {
      btn.addEventListener('click', (e) => copyToClipboard(e.currentTarget.getAttribute('data-url'), e.currentTarget));
    });

    tbody.querySelectorAll('.btn-qr-action').forEach(btn => {
      btn.addEventListener('click', (e) => openQrModal(e.currentTarget.getAttribute('data-url')));
    });

    tbody.querySelectorAll('.btn-delete-action').forEach(btn => {
      btn.addEventListener('click', (e) => deleteLink(e.currentTarget.getAttribute('data-slug')));
    });
  }

  // ==========================================
  // Criar e Copiar (< 5s)
  // ==========================================

  async function processCreateLink(shouldCopy = true) {
    const urlInput = document.getElementById('target-url');
    const titleInput = document.getElementById('link-title');
    const slugInput = document.getElementById('link-slug');

    const targetUrl = urlInput.value.trim();
    const title = titleInput.value.trim();
    let slug = slugInput.value.trim().toLowerCase().replace(/[^a-z0-9\-_]/g, '-');

    if (!targetUrl || !slug) {
      showToast('⚠️ Preencha a URL de destino e o slug.');
      return;
    }

    const publicUrl = getPublicUrl(slug);
    const prefix = getUrlPrefix();
    const pathPrefix = prefix ? `/${prefix}/` : '/';

    linksDatabase[slug] = {
      url: targetUrl,
      title: title || titleizeSlug(slug),
      createdAt: new Date().toISOString(),
      clicks: linksDatabase[slug] ? (linksDatabase[slug].clicks || 0) : 0
    };

    syncToGithub(`Adicionar link ${pathPrefix}${slug}`);
    addAuditLog('Link Criado', `${pathPrefix}${slug} -> ${targetUrl}`);
    
    renderMetrics();
    filterAndRenderLinks();

    if (shouldCopy) {
      const btnCopyCopy = document.getElementById('btn-submit-create-copy');
      await copyToClipboard(publicUrl, btnCopyCopy);
    }

    const banner = document.getElementById('created-feedback-banner');
    document.getElementById('fb-title').textContent = title || titleizeSlug(slug);
    document.getElementById('fb-slug').textContent = pathPrefix + slug;
    document.getElementById('fb-target').textContent = targetUrl;
    document.getElementById('fb-public-url').textContent = publicUrl;

    banner.classList.remove('hidden');

    const btnCopyNew = document.getElementById('btn-copy-new-link');
    btnCopyNew.onclick = () => copyToClipboard(publicUrl, btnCopyNew);

    const btnQrNew = document.getElementById('btn-qr-new-link');
    btnQrNew.onclick = () => openQrModal(publicUrl);

    showToast(shouldCopy ? '⚡ Link criado e copiado!' : '✨ Link criado!');
  }

  async function deleteLink(slug) {
    const prefix = getUrlPrefix();
    const pathPrefix = prefix ? `/${prefix}/` : '/';

    if (confirm(`Tem certeza que deseja excluir o link ${pathPrefix}${slug}?`)) {
      delete linksDatabase[slug];
      if (clickStats[slug]) delete clickStats[slug];
      
      await syncToGithub(`Excluir link ${pathPrefix}${slug}`);
      addAuditLog('Link Excluído', `${pathPrefix}${slug}`);

      renderMetrics();
      filterAndRenderLinks();
      showToast(`🗑️ Link ${pathPrefix}${slug} excluído.`);
    }
  }

  function openQrModal(url) {
    const modal = document.getElementById('qr-modal');
    const display = document.getElementById('qr-modal-url-display');
    const container = document.getElementById('qr-container');

    display.textContent = url;
    const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(url)}`;
    container.innerHTML = `<img src="${qrApiUrl}" alt="QR Code" width="200" height="200" style="display:block;">`;

    const btnCopyQrLink = document.getElementById('btn-copy-qr-link');
    btnCopyQrLink.onclick = () => copyToClipboard(url, btnCopyQrLink);

    modal.classList.add('active');
  }

  function setupTotpQrCode() {
    let secret = localStorage.getItem('redirect_totp_secret');
    if (!secret) {
      secret = generateTotpSecret();
      localStorage.setItem('redirect_totp_secret_draft', secret);
    } else {
      document.getElementById('totp-secret-key-display').textContent = secret;
    }

    const draftSecret = localStorage.getItem('redirect_totp_secret_draft') || secret;
    document.getElementById('totp-secret-key-display').textContent = draftSecret;

    const otpauthUrl = `otpauth://totp/BrindesGratis:Admin?secret=${draftSecret}&issuer=BrindesGratis`;
    const qrContainer = document.getElementById('totp-qr-container');
    if (qrContainer) {
      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=130x130&data=${encodeURIComponent(otpauthUrl)}`;
      qrContainer.innerHTML = `<img src="${qrUrl}" alt="QR Code 2FA" width="130" height="130">`;
    }
  }

  // ==========================================
  // Autenticação & Eventos
  // ==========================================

  async function verifyMasterPassword(password) {
    if (!password) return false;
    
    const inputHash = await hashString(password.trim());
    const defaultHash = await hashString(DEFAULT_PASSWORD);
    const storedHash = localStorage.getItem('redirect_admin_hash');

    // 1. Se coincidir com a nova senha padrão CAFEQuente@@##77, atualiza o hash salvo e desbloqueia imediatamente
    if (inputHash === defaultHash) {
      localStorage.setItem('redirect_admin_hash', defaultHash);
      activeMasterPassword = password.trim();
      clearFailedAttempts();
      return true;
    }

    // 2. Se coincidir com uma senha customizada salva anteriormente
    if (storedHash && inputHash === storedHash) {
      activeMasterPassword = password.trim();
      clearFailedAttempts();
      return true;
    }

    // 3. Se a senha for incorreta, verifica se está em lockout
    if (checkLockout()) return false;

    recordFailedAttempt();
    return false;
  }

  async function verifyTotpLogin(code) {
    const activeSecret = localStorage.getItem('redirect_totp_secret');
    if (!activeSecret) return true;

    const isValid = await verifyTotpCode(code, activeSecret);
    if (!isValid) {
      recordFailedAttempt();
      return false;
    }

    clearFailedAttempts();
    return true;
  }

  function initTheme() {
    const savedTheme = localStorage.getItem('redirect_theme') || 'light';
    document.documentElement.setAttribute('data-theme', savedTheme);
    updateThemeIcon(savedTheme);
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const next = current === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('redirect_theme', next);
    updateThemeIcon(next);
  }

  function updateThemeIcon(theme) {
    const icon = document.getElementById('theme-icon');
    const text = document.getElementById('theme-text');
    if (icon && text) {
      icon.textContent = theme === 'dark' ? '☀️' : '🌙';
      text.textContent = theme === 'dark' ? 'Claro' : 'Escuro';
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    checkLockout();

    const loginModal = document.getElementById('login-modal');
    const adminApp = document.getElementById('admin-app');
    const loginForm = document.getElementById('login-form');
    const form2fa = document.getElementById('2fa-form');
    const loginError = document.getElementById('login-error-msg');

    if (sessionStorage.getItem('redirect_admin_authed') === 'true') {
      loginModal.classList.remove('active');
      adminApp.classList.remove('hidden');
      loadData();
    }

    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (checkLockout()) return;

      const pass = document.getElementById('admin-pass-input').value;
      const ok = await verifyMasterPassword(pass);

      if (ok) {
        loginError.classList.add('hidden');
        const hasTotp = Boolean(localStorage.getItem('redirect_totp_secret'));

        if (hasTotp) {
          document.getElementById('login-step-1').classList.add('hidden');
          document.getElementById('login-step-2').classList.remove('hidden');
        } else {
          sessionStorage.setItem('redirect_admin_authed', 'true');
          loginModal.classList.remove('active');
          adminApp.classList.remove('hidden');
          addAuditLog('Login de Sucesso', 'Autenticação por senha master');
          loadData();
        }
      } else {
        loginError.textContent = 'Senha incorreta.';
        loginError.classList.remove('hidden');
      }
    });

    form2fa.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (checkLockout()) return;

      const totpCode = document.getElementById('admin-totp-input').value.trim();
      const ok = await verifyTotpLogin(totpCode);

      if (ok) {
        sessionStorage.setItem('redirect_admin_authed', 'true');
        loginModal.classList.remove('active');
        adminApp.classList.remove('hidden');
        addAuditLog('Login de Sucesso (2FA)', 'Autenticação TOTP Google Authenticator');
        loadData();
      } else {
        loginError.textContent = 'Código TOTP 2FA incorreto ou expirado.';
        loginError.classList.remove('hidden');
      }
    });

    const targetUrlInput = document.getElementById('target-url');
    const slugInput = document.getElementById('link-slug');
    const titleInput = document.getElementById('link-title');

    targetUrlInput.addEventListener('input', () => {
      const urlValue = targetUrlInput.value.trim();
      if (!urlValue) return;

      const extractedSlug = extractBloggerSlug(urlValue);
      if (extractedSlug) {
        slugInput.value = extractedSlug;
        if (!titleInput.value) {
          titleInput.value = titleizeSlug(extractedSlug);
        }
      }
    });

    document.getElementById('create-link-form').addEventListener('submit', (e) => {
      e.preventDefault();
      processCreateLink(true);
    });

    document.getElementById('btn-submit-create-only').addEventListener('click', () => {
      processCreateLink(false);
    });

    const searchInput = document.getElementById('admin-search-input');
    let searchTimeout = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(filterAndRenderLinks, 150);
    });

    document.getElementById('btn-clear-search').addEventListener('click', () => {
      searchInput.value = '';
      filterAndRenderLinks();
    });

    document.getElementById('btn-prev-page').addEventListener('click', () => {
      if (currentPage > 1) {
        currentPage--;
        renderTablePage();
      }
    });

    document.getElementById('btn-next-page').addEventListener('click', () => {
      const totalPages = Math.ceil(filteredSlugs.length / itemsPerPage);
      if (currentPage < totalPages) {
        currentPage++;
        renderTablePage();
      }
    });

    document.getElementById('btn-theme-toggle').addEventListener('click', toggleTheme);
    document.getElementById('btn-panic').addEventListener('click', triggerPanicMode);
    document.getElementById('btn-logout').addEventListener('click', handleAutoLogout);

    document.querySelectorAll('.modal-close-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const modalId = e.currentTarget.getAttribute('data-close');
        if (modalId) document.getElementById(modalId).classList.remove('active');
      });
    });

    document.getElementById('btn-open-audit-logs').addEventListener('click', () => {
      renderAuditLogs();
      document.getElementById('audit-modal').classList.add('active');
    });

    document.getElementById('btn-clear-audit-logs').addEventListener('click', () => {
      if (confirm('Deseja limpar todo o histórico de logs de auditoria?')) {
        localStorage.removeItem('redirect_audit_logs');
        renderAuditLogs();
        showToast('📜 Logs de auditoria limpos.');
      }
    });

    document.getElementById('btn-open-import-export').addEventListener('click', () => {
      document.getElementById('import-export-modal').classList.add('active');
    });

    document.getElementById('btn-export-json').addEventListener('click', () => {
      const jsonStr = JSON.stringify(linksDatabase, null, 2);
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'links.json';
      a.click();
      URL.revokeObjectURL(url);
      showToast('📥 links.json baixado!');
    });

    document.getElementById('btn-import-json').addEventListener('click', () => {
      const fileInput = document.getElementById('import-file-input');
      const textArea = document.getElementById('import-text-area');

      if (fileInput.files && fileInput.files[0]) {
        const reader = new FileReader();
        reader.onload = (evt) => processImportData(evt.target.result);
        reader.readAsText(fileInput.files[0]);
      } else if (textArea.value.trim()) {
        processImportData(textArea.value.trim());
      } else {
        showToast('⚠️ Selecione um arquivo ou cole o JSON.');
      }
    });

    async function processImportData(rawJson) {
      try {
        const parsed = JSON.parse(rawJson);
        if (typeof parsed === 'object' && parsed !== null) {
          linksDatabase = { ...linksDatabase, ...parsed };
          await syncToGithub('Importar links via Painel Admin');
          renderMetrics();
          filterAndRenderLinks();
          document.getElementById('import-export-modal').classList.remove('active');
          showToast('✅ Links importados com sucesso!');
        }
      } catch (e) {
        showToast('❌ JSON inválido.');
      }
    }

    document.getElementById('btn-open-settings').addEventListener('click', () => {
      document.getElementById('setting-base-domain').value = localStorage.getItem('redirect_custom_domain') || '';
      document.getElementById('setting-url-prefix').value = localStorage.getItem('redirect_url_prefix') || 'go';
      document.getElementById('setting-worker-url').value = localStorage.getItem('redirect_worker_url') || '';
      
      const gh = getGithubConfig();
      document.getElementById('setting-github-token').value = gh.token;
      document.getElementById('setting-github-owner').value = gh.owner;
      document.getElementById('setting-github-repo').value = gh.repo;
      document.getElementById('setting-github-branch').value = gh.branch;

      setupTotpQrCode();
      document.getElementById('settings-modal').classList.add('active');
    });

    document.getElementById('btn-test-github-connection').addEventListener('click', testGithubConnection);

    document.getElementById('btn-enable-totp').addEventListener('click', () => {
      const draftSecret = localStorage.getItem('redirect_totp_secret_draft');
      if (draftSecret) {
        localStorage.setItem('redirect_totp_secret', draftSecret);
        addAuditLog('2FA Ativado', 'Google Authenticator TOTP ativado');
        alert('✅ Google Authenticator 2FA ativado!');
      }
    });

    document.getElementById('btn-disable-totp').addEventListener('click', () => {
      if (confirm('Deseja realmente desativar a Autenticação 2FA por Google Authenticator?')) {
        localStorage.removeItem('redirect_totp_secret');
        addAuditLog('2FA Desativado', 'Google Authenticator TOTP desativado');
        alert('⚠️ Autenticação 2FA desativada.');
      }
    });

    document.getElementById('settings-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const domain = document.getElementById('setting-base-domain').value.trim();
      const prefix = document.getElementById('setting-url-prefix').value;
      const workerUrl = document.getElementById('setting-worker-url').value.trim();
      const ghToken = document.getElementById('setting-github-token').value.trim();
      const ghOwner = document.getElementById('setting-github-owner').value.trim();
      const ghRepo = document.getElementById('setting-github-repo').value.trim();
      const ghBranch = document.getElementById('setting-github-branch').value.trim() || 'main';
      const newPass = document.getElementById('setting-new-pass').value.trim();

      if (domain) localStorage.setItem('redirect_custom_domain', domain);
      else localStorage.removeItem('redirect_custom_domain');

      localStorage.setItem('redirect_url_prefix', prefix);

      if (workerUrl) localStorage.setItem('redirect_worker_url', workerUrl);
      else localStorage.removeItem('redirect_worker_url');

      if (ghToken && activeMasterPassword) {
        const encrypted = await encryptToken(ghToken, activeMasterPassword);
        localStorage.setItem('redirect_github_token_enc', encrypted);
        memDecryptedGithubToken = ghToken;
      } else if (!ghToken) {
        localStorage.removeItem('redirect_github_token_enc');
        memDecryptedGithubToken = '';
      }

      if (ghOwner) localStorage.setItem('redirect_github_owner', ghOwner);
      else localStorage.removeItem('redirect_github_owner');

      if (ghRepo) localStorage.setItem('redirect_github_repo', ghRepo);
      else localStorage.removeItem('redirect_github_repo');

      localStorage.setItem('redirect_github_branch', ghBranch);

      if (newPass && newPass.length >= 6) {
        const newHash = await hashString(newPass);
        localStorage.setItem('redirect_admin_hash', newHash);
        activeMasterPassword = newPass;

        if (memDecryptedGithubToken) {
          const reEncrypted = await encryptToken(memDecryptedGithubToken, newPass);
          localStorage.setItem('redirect_github_token_enc', reEncrypted);
        }
        addAuditLog('Alteração de Senha', 'Senha master alterada');
        showToast('🔒 Senha alterada!');
      }

      document.getElementById('settings-modal').classList.remove('active');
      showToast('⚙️ Configurações salvas!');

      updatePrefixDisplay();
      await loadData();
    });
  });

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
})();
