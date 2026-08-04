/**
 * Cloudflare Worker API Proxy para GitHub Pages
 * Antigravity Zero-Client-Token Proxy Engine
 * 
 * Permite que o painel em admin.meudominio.com.br salve links no GitHub
 * sem que o Token do GitHub (PAT) JAMAIS toque no navegador do cliente!
 */

export default {
  async fetch(request, env, ctx) {
    // 1. Configuração de CORS (Permitir apenas seu subdomínio admin)
    const allowedOrigin = env.ADMIN_ORIGIN || 'https://admin.meudominio.com.br';
    
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': allowedOrigin,
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    const url = new URL(request.url);

    // 2. Rota de teste de saúde
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', proxy: 'Cloudflare Worker' }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': allowedOrigin }
      });
    }

    // 3. Rota de commit de links (/api/update-links)
    if (url.pathname === '/api/update-links' && request.method === 'POST') {
      try {
        // Validação da chave de autenticação do admin
        const authHeader = request.headers.get('Authorization') || '';
        const expectedSecret = env.ADMIN_SECRET_KEY || 'CAFEQuente@@##77';
        
        if (!authHeader.includes(expectedSecret)) {
          return new Response(JSON.stringify({ error: 'Acesso não autorizado ao Worker' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': allowedOrigin }
          });
        }

        const body = await request.json();
        const { linksData, commitMessage, repoOwner, repoName, branch } = body;

        const githubToken = env.GITHUB_TOKEN; // Armazenado com segurança nas variáveis secretas do Worker
        const owner = repoOwner || env.GITHUB_OWNER || 'lourenco';
        const repo = repoName || env.GITHUB_REPO || 'bio-bg-2';
        const targetBranch = branch || env.GITHUB_BRANCH || 'main';

        if (!githubToken) {
          return new Response(JSON.stringify({ error: 'GITHUB_TOKEN não configurado no Worker' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': allowedOrigin }
          });
        }

        // Buscar SHA atual do links.json
        const ghApiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/links.json?ref=${targetBranch}`;
        let sha = '';

        const getRes = await fetch(ghApiUrl, {
          headers: {
            'User-Agent': 'CloudflareWorker-Proxy',
            'Authorization': `token ${githubToken}`,
            'Accept': 'application/vnd.github.v3+json'
          }
        });

        if (getRes.ok) {
          const fileInfo = await getRes.json();
          sha = fileInfo.sha;
        }

        // Codificar JSON em Base64
        const jsonString = JSON.stringify(linksData, null, 2);
        const base64Content = btoa(unescape(encodeURIComponent(jsonString)));

        // Enviar commit para o GitHub
        const putBody = {
          message: commitMessage || 'Atualizar links via Admin Proxy Worker',
          content: base64Content,
          branch: targetBranch
        };
        if (sha) putBody.sha = sha;

        const putRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/links.json`, {
          method: 'PUT',
          headers: {
            'User-Agent': 'CloudflareWorker-Proxy',
            'Authorization': `token ${githubToken}`,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(putBody)
        });

        if (putRes.ok) {
          return new Response(JSON.stringify({ success: true, message: 'Commit realizado com sucesso no GitHub' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': allowedOrigin }
          });
        } else {
          const errData = await putRes.json();
          return new Response(JSON.stringify({ error: errData.message }), {
            status: putRes.status,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': allowedOrigin }
          });
        }

      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': allowedOrigin }
        });
      }
    }

    return new Response('Not Found', { status: 404 });
  }
};
