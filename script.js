'use strict';

const BLOG_URL = 'https://euquerobrindesgratis.blogspot.com/';
const FEED_URL = BLOG_URL + 'feeds/posts/default?alt=json-in-script&max-results=3';
const AUTO_UPDATE_INTERVAL = 30000;

let lastPosts = [];
let scriptTag = null;

function loadPosts() {
  const timestamp = Date.now();
  const url = FEED_URL + '&callback=showPosts&t=' + timestamp;
  
  if (scriptTag) {
    scriptTag.remove();
  }
  
  scriptTag = document.createElement('script');
  scriptTag.async = true;
  scriptTag.src = url;
  scriptTag.onerror = () => {
    document.getElementById('posts-container').innerHTML = '<p class="error">Erro ao carregar posts. Tente novamente mais tarde.</p>';
  };
  document.body.appendChild(scriptTag);
}

function showPosts(data) {
  const container = document.getElementById('posts-container');
  
  if (!data?.feed?.entry?.length) {
    container.innerHTML = '<p class="error">Nenhum post disponível.</p>';
    return;
  }
  
  const posts = data.feed.entry.map(entry => {
    const title = entry.title.$t;
    const image = entry.media$thumbnail?.url.replace('/s72-c/', '/s400/') || '';
    return {
      title: title,
      image: image,
      url: BLOG_URL
    };
  });
  
  const postsJson = JSON.stringify(posts);
  const lastPostsJson = JSON.stringify(lastPosts);
  
  if (postsJson === lastPostsJson) {
    return;
  }
  
  lastPosts = posts;
  
  const html = posts.map(post => 
    `<a href="${post.url}" target="_blank" class="post-card"><img src="${post.image}" alt="${post.title}" class="post-image" loading="lazy" decoding="async" width="150" height="150"><h3 class="post-title">${post.title}</h3></a>`
  ).join('');
  
  container.innerHTML = `<div class="posts-grid">${html}</div>`;
}

document.addEventListener('DOMContentLoaded', () => {
  loadPosts();
  setInterval(loadPosts, AUTO_UPDATE_INTERVAL);
});
