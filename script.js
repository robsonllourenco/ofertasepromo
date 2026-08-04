'use strict';

const BLOG_URL = 'https://euquerobrindesgratis.blogspot.com/';
const FEED_URL = BLOG_URL + 'feeds/posts/default?alt=json-in-script&max-results=4';
const AUTO_UPDATE_INTERVAL = 30000;

let lastPosts = [];
let scriptTag = null;
let allLinksData = null;

const FALLBACK_POSTS = [
  {
    title: 'K-Beauty Glow Week reúne marcas de skincare coreano em evento gratuito em São Paulo',
    image: 'https://blogger.googleusercontent.com/img/b/R29vZ2xl/AVvXsEj3b5IACW3bAkMxQMFD0G3Qe4uhYcatnGmoseP4UJs3k0BTiKNjeajjL8x5Gbxc8GpVQCFlmcIwE8L8WhXYFAzsLgBZAn32VaILFc3E0DBIK-gaJc19F5QcfKOkAGf8HRt2NQMiVr_25qP6N-bc9DGG2_2eUaxZzvYZ2IUSTX6fDrMgj6WAHAgJbzKXLA8/s400/k-beauty-marcas-skincare-gratis.webp',
    url: BLOG_URL
  },
  {
    title: 'DaBelle abre seleção para mulheres apaixonadas por beleza testarem kit Óleo Mágico',
    image: 'https://blogger.googleusercontent.com/img/b/R29vZ2xl/AVvXsEhBVOmEFg0g2BnivBiepyb_1luLdkqwWI-UXoYdz6w-IDggK5Hhlv4sFIFc4nOPKuzWTjIMQuQJAd-OdWErJkpkpg3Bi3XClurA9NN58RPYMLxLbPLfKPi7vKIL1a3QIhmv3smOjHTX539SH5to2P9gF7FUltqsoQFgrrfB74JDBU7hCa5epuZVfSgCW2o/s400/dabelle-selecao-influenciadoras-oleo-magico-kit.webp',
    url: BLOG_URL
  },
  {
    title: 'Ticky estreia parceria com a Vichy e lança pirulito Morango Cream Zero Açúcar',
    image: 'https://blogger.googleusercontent.com/img/b/R29vZ2xl/AVvXsEgMaenC4-C0uLqpMCTIBf2_3dqs7jae3S8fEUYFjBV3u0rYytRrrZJmi9ck0YYv7o0UPyNTV3FlkKYsNcjHT_DjGNEbhmKjfI7T9W31Xs0n3LfLgEHp6DatjCTH1VAibHE6pfENCO_hA_YjZ-IGkl0nGiZLD7HfoXYxbBHmrC0nxdZzrfks6axwhyphenhyphenuSLhY/s400/ticky-pirulito-morango-cream-vichy.webp',
    url: BLOG_URL
  },
  {
    title: 'Confira todas as novidades e brindes grátis disponíveis no nosso site',
    image: 'logo.png',
    url: BLOG_URL
  }
];

function renderPosts(posts) {
  const container = document.getElementById('posts-container');
  if (!container || !posts?.length) return;

  const postsJson = JSON.stringify(posts);
  const lastPostsJson = JSON.stringify(lastPosts);

  if (postsJson === lastPostsJson) return;
  lastPosts = posts;

  const html = posts.map(post => 
    `<a href="${post.url}" target="_blank" class="post-card"><img src="${post.image}" alt="${post.title}" class="post-image" loading="lazy" decoding="async" width="150" height="150"><h3 class="post-title">${post.title}</h3></a>`
  ).join('');

  container.innerHTML = `<div class="posts-grid">${html}</div>`;
}

function loadPosts() {
  const jsonpUrl = FEED_URL + '&callback=showPosts&t=' + Date.now();
  if (scriptTag) scriptTag.remove();

  scriptTag = document.createElement('script');
  scriptTag.async = true;
  scriptTag.src = jsonpUrl;
  scriptTag.onerror = () => {
    renderPosts(FALLBACK_POSTS);
  };
  document.body.appendChild(scriptTag);
}

function showPosts(data) {
  if (!data?.feed?.entry?.length) {
    renderPosts(FALLBACK_POSTS);
    return;
  }

  const posts = data.feed.entry.map(entry => ({
    title: entry.title.$t,
    image: entry.media$thumbnail?.url.replace('/s72-c/', '/s400/') || 'logo.png',
    url: BLOG_URL
  }));

  renderPosts(posts);
}

window.showPosts = showPosts;

// Alternador de Tema Claro / Escuro
function initTheme() {
  const savedTheme = localStorage.getItem('redirect_theme') || 'light';
  document.documentElement.setAttribute('data-theme', savedTheme);
  const icon = document.getElementById('theme-icon');
  if (icon) icon.textContent = savedTheme === 'dark' ? '☀️' : '🌙';
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  const next = current === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('redirect_theme', next);
  const icon = document.getElementById('theme-icon');
  if (icon) icon.textContent = next === 'dark' ? '☀️' : '🌙';
}

// Pesquisa de links na Bio
function initBioSearch() {
  const searchInput = document.getElementById('bio-search-input');
  const resultsContainer = document.getElementById('bio-search-results');
  if (!searchInput || !resultsContainer) return;

  fetch('links.json')
    .then(res => res.json())
    .then(data => {
      allLinksData = data;
    })
    .catch(e => console.warn('Não foi possível carregar links para pesquisa:', e));

  searchInput.addEventListener('input', () => {
    const query = searchInput.value.trim().toLowerCase();
    if (!query || !allLinksData) {
      resultsContainer.innerHTML = '';
      return;
    }

    const matches = Object.entries(allLinksData).filter(([slug, info]) => {
      const title = (info.title || '').toLowerCase();
      const url = (info.url || '').toLowerCase();
      return slug.includes(query) || title.includes(query) || url.includes(query);
    });

    if (matches.length === 0) {
      resultsContainer.innerHTML = '<p class="no-posts">Nenhum brinde ou link encontrado.</p>';
      return;
    }

    const html = matches.slice(0, 4).map(([slug, info]) => `
      <div class="search-result-item">
        <div class="result-info">
          <strong>${escapeHtml(info.title || slug)}</strong>
          <small>/${slug}</small>
        </div>
        <a href="${info.url}" target="_blank" class="btn btn-primary btn-sm">Acessar</a>
      </div>
    `).join('');

    resultsContainer.innerHTML = html;
  });
}

function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initBioSearch();

  const themeBtn = document.getElementById('btn-theme-toggle');
  if (themeBtn) themeBtn.addEventListener('click', toggleTheme);

  renderPosts(FALLBACK_POSTS);
  loadPosts();
  setInterval(loadPosts, AUTO_UPDATE_INTERVAL);

  // Bloquear clique direito e seleção
  document.addEventListener('contextmenu', e => e.preventDefault());
  document.addEventListener('selectstart', e => e.preventDefault());
  document.addEventListener('copy', e => e.preventDefault());
  document.addEventListener('dragstart', e => e.preventDefault());

  // Bloquear teclas de inspeção
  document.addEventListener('keydown', e => {
    if (
      e.key === 'F12' ||
      e.keyCode === 123 ||
      (e.ctrlKey && e.shiftKey && ['I', 'i', 'J', 'j', 'C', 'c'].includes(e.key)) ||
      (e.ctrlKey && ['U', 'u', 'S', 's', 'C', 'c', 'A', 'a'].includes(e.key))
    ) {
      e.preventDefault();
      return false;
    }
  });
});
