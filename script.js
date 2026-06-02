'use strict';

const BLOG_URL='https://euquerobrindesgratis.blogspot.com/',FEED_URL=BLOG_URL+'feeds/posts/default?alt=json-in-script&max-results=3&callback=showPosts',CACHE_KEY='blogPosts',CACHE_TIME=43200000;


function loadPosts(){const e=localStorage.getItem(CACHE_KEY),t=localStorage.getItem(CACHE_KEY+'_time');if(e&&t&&Date.now()-parseInt(t)<CACHE_TIME)return void showPosts(JSON.parse(e));const a=document.createElement('script');a.async=!0,a.src=FEED_URL,a.onerror=()=>{document.getElementById('posts-container').innerHTML='<p class="error">Erro ao carregar posts. Tente novamente mais tarde.</p>'},document.body.appendChild(a)}

function showPosts(e){const t=document.getElementById('posts-container');if(!e?.feed?.entry?.length)return void(t.innerHTML='<p class="error">Nenhum post disponível.</p>');const a=e.feed.entry.map(e=>{const t=e.title.$t,a=e.media$thumbnail?.url.replace('/s72-c/','/s400/')||'';return`<a href="${BLOG_URL}" target="_blank" class="post-card"><img src="${a}" alt="${t}" class="post-image" loading="lazy" decoding="async" width="150" height="150"><h3 class="post-title">${t}</h3></a>`}).join('');t.innerHTML=`<div class="posts-grid">${a}</div>`,localStorage.setItem(CACHE_KEY,JSON.stringify(e)),localStorage.setItem(CACHE_KEY+'_time',Date.now().toString())}


document.addEventListener('DOMContentLoaded',()=>{loadPosts()});
