/**
 * Engine de Redirecionamento Instantâneo para GitHub Pages
 * Antigravity Redirect Engine - Suporte a Prefixo (/go/slug ou /l/slug)
 */
(function () {
  'use strict';

  // Recursos reservados do sistema que não devem ser tratados como slugs
  const RESERVED_PATHS = [
    '',
    '/',
    'index.html',
    'admin.html',
    '_painel_a7x9k2.html',
    '404.html',
    'styles.css',
    'script.js',
    'redirect.js',
    'admin.js',
    'links.json',
    'manifest.json',
    'logo.png',
    'verificado.png',
    'cname',
    'favicon.ico'
  ];

  // Prefixos de rota suportados (ex: /go/pague-menos ou /l/pague-menos)
  const SUPPORTED_PREFIXES = ['go', 'l', 'r', 'link', 'brinde'];

  /**
   * Extrai o slug da URL atual (suporta /go/slug, /l/slug, query params e hash)
   */
  function extractSlugInfo() {
    const url = new URL(window.location.href);
    
    // 1. Tentar parâmetro da Query String (?go=slug, ?l=slug ou ?slug=slug)
    const paramSlug = url.searchParams.get('go') || url.searchParams.get('l') || url.searchParams.get('slug');
    if (paramSlug) {
      return sanitizeSlug(paramSlug);
    }

    // 2. Tentar Hash (#go/slug ou #pague-menos)
    if (url.hash && url.hash.length > 1) {
      let hashContent = url.hash.substring(1);
      if (!hashContent.includes('=')) {
        if (hashContent.includes('/')) {
          const hashParts = hashContent.split('/').filter(Boolean);
          if (hashParts.length >= 2 && SUPPORTED_PREFIXES.includes(hashParts[0].toLowerCase())) {
            return sanitizeSlug(hashParts[1]);
          }
        }
        return sanitizeSlug(hashContent);
      }
    }

    // 3. Extrair do Pathname (/go/pague-menos ou /l/pague-menos ou /pague-menos)
    const pathname = url.pathname;
    const parts = pathname.split('/').filter(Boolean);
    
    if (parts.length >= 2) {
      const firstPart = parts[0].toLowerCase();
      // Se tiver um prefixo como /go/pague-menos ou /l/pague-menos
      if (SUPPORTED_PREFIXES.includes(firstPart)) {
        return sanitizeSlug(parts[1]);
      }
    }

    if (parts.length > 0) {
      const lastPart = parts[parts.length - 1];
      // Se não for rota reservada
      if (!RESERVED_PATHS.includes(lastPart.toLowerCase())) {
        return sanitizeSlug(lastPart);
      }
    }

    return null;
  }

  function sanitizeSlug(slug) {
    if (!slug) return null;
    try {
      slug = decodeURIComponent(slug);
    } catch (e) {}
    slug = slug.trim().toLowerCase();
    
    // Remover extensão .html caso presente
    if (slug.endsWith('.html') && !RESERVED_PATHS.includes(slug)) {
      slug = slug.replace(/\.html$/, '');
    }
    return slug;
  }

  function isReserved(slug) {
    if (!slug) return true;
    return RESERVED_PATHS.includes(slug.toLowerCase());
  }

  /**
   * Registra clique no armazenamento local
   */
  function registerClick(slug) {
    try {
      const clickStats = JSON.parse(localStorage.getItem('redirect_click_stats') || '{}');
      clickStats[slug] = (clickStats[slug] || 0) + 1;
      localStorage.setItem('redirect_click_stats', JSON.stringify(clickStats));

      const adminLinks = JSON.parse(localStorage.getItem('redirect_links_db') || '{}');
      if (adminLinks[slug]) {
        adminLinks[slug].clicks = (adminLinks[slug].clicks || 0) + 1;
        localStorage.setItem('redirect_links_db', JSON.stringify(adminLinks));
      }
    } catch (err) {
      console.warn('Erro ao salvar estatística de clique:', err);
    }
  }

  /**
   * Executa o redirecionamento imediato
   */
  function executeRedirect(targetUrl, slug) {
    if (!targetUrl) return;
    registerClick(slug);

    // Google Analytics 4 se ativo
    const gaId = localStorage.getItem('redirect_ga4_id');
    if (gaId && window.gtag) {
      try {
        window.gtag('event', 'redirect', {
          'event_category': 'outbound',
          'event_label': slug,
          'transport_type': 'beacon'
        });
      } catch (e) {}
    }

    // Redirecionamento instantâneo sem histórico
    window.location.replace(targetUrl);
  }

  // Processar slug
  const slug = extractSlugInfo();

  if (!slug || isReserved(slug)) {
    return;
  }

  // 1. Tentar cache LocalStorage (resposta em 0ms)
  let cachedDb = null;
  try {
    const rawCache = localStorage.getItem('redirect_links_db') || localStorage.getItem('redirect_links_cache');
    if (rawCache) {
      cachedDb = JSON.parse(rawCache);
    }
  } catch (e) {}

  if (cachedDb && cachedDb[slug] && cachedDb[slug].url) {
    executeRedirect(cachedDb[slug].url, slug);
    return;
  }

  // 2. Buscar em links.json
  fetch('links.json?t=' + Date.now(), { cache: 'no-cache' })
    .then(response => {
      if (!response.ok) throw new Error('links.json não encontrado');
      return response.json();
    })
    .then(data => {
      if (data && typeof data === 'object') {
        try {
          localStorage.setItem('redirect_links_cache', JSON.stringify(data));
        } catch (e) {}

        if (data[slug] && data[slug].url) {
          executeRedirect(data[slug].url, slug);
        } else {
          window.REDIRECT_NOT_FOUND = true;
          window.REDIRECT_SLUG = slug;
          if (typeof window.onRedirectNotFound === 'function') {
            window.onRedirectNotFound(slug);
          }
        }
      }
    })
    .catch(err => {
      console.error('Erro ao buscar link:', err);
      window.REDIRECT_NOT_FOUND = true;
      window.REDIRECT_SLUG = slug;
    });

})();
