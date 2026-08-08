import express from 'express';
import proxy from 'express-http-proxy';
import { URL } from 'url';
import path from 'path';
import { minify_sync as minify } from 'terser';
import CleanCSS from 'clean-css';
import { config } from '../config.js';
import { seoStore } from './seo.js';

const PAGE_URL = config.pageUrl;
const GA_MEASUREMENT_ID =
  config.analytics.googleAnalytics && config.analytics.googleAnalyticsId
    ? config.analytics.googleAnalyticsId
    : '';

const GOOGLE_ANALYTICS_SOURCES =
  'https://www.googletagmanager.com https://www.google-analytics.com';
const VERCEL_ANALYTICS_SOURCES = 'https://va.vercel-scripts.com';
const CUSTOM_STYLE = `
  .notion-topbar > div > div:nth-last-child(1), .notion-topbar > div > div:nth-last-child(2) {
    display:none !important;
  }
  .notion-topbar-mobile > div:nth-child(2) > div:nth-child(2) {
    display:none !important;
  }
`;
const LOCATION_HREF_PATTERN = /window\.location\.href(?=[^=]|={2,})/g;
const ASSET_REQUEST_PATTERN = /^\/_assets\/[^/]*\.js$/;
const STATIC_ASSET_PATTERN = /^\/_assets\//;
const PASSTHROUGH_REQUEST_PATTERN = /^\/(image[s]?|api)\//;
const PUBLIC_PAGE_DATA_ENDPOINT = '/200/www.notion.so/api/v3/';
const EXPERIMENT_ENDPOINT = '/200/exp.notion.so/v1/';

const { origin: pageDomain, pathname: pagePath } = new URL(PAGE_URL);
const [pageId] = path.basename(pagePath).match(/[^-]*$/) || [''];

// Map start page path to "/". Replacing URL for example:
// - https://my.notion.site/0123456789abcdef0123456789abcdef -> https://mydomain.com/
// - /My-Page-0123456789abcdef0123456789abcdef -> /
// - /my/My-Page-0123456789abcdef0123456789abcdef -> /
declare global {
  interface Window {
    ncd: {
      _pageId: string;
      _pageDomain: string;
      _myUrl: (url: string) => string;
      _yourUrl: (url: string) => string;
      href: () => string;
    };
  }
}
const locationProxy = (
  pageDomain: string,
  pageId: string,
  pageSlugMap: Record<string, string>,
) => {
  window.ncd = {
    _pageId: pageId,
    _pageDomain: pageDomain,
    _myUrl: function (url: string) {
      return url
        .replace(location.origin, this._pageDomain)
        .replace(/\/(?=\?|$)/, `/${this._pageId}`);
    },
    _yourUrl: function (url: string) {
      if (typeof url !== 'string') return url;
      const rewritten = url
        .replace(this._pageDomain, location.origin)
        .replace(
          new RegExp(`(^|[^/])\\/[^/].*${this._pageId}(?=\\?|$)`),
          '$1/',
        );
      const id = rewritten
        .replace(/-/g, '')
        .match(/[0-9a-f]{32}(?=[/?#]|$)/i)?.[0]
        ?.toLowerCase();
      const slug = id ? pageSlugMap[id] : undefined;
      if (!slug) return rewritten;
      const parsed = new URL(rewritten, location.origin);
      return `/${encodeURIComponent(slug)}${parsed.search}${parsed.hash}`;
    },
    href: function () {
      return this._myUrl(location.href);
    },
  };

  const proxyHistoryMethod = (method: typeof window.history.pushState) =>
    new Proxy(method, {
      apply: function (target, that, [data, unused, url]) {
        return Reflect.apply(target, that, [
          data,
          unused,
          window.ncd._yourUrl(url),
        ]);
      },
    });
  window.history.pushState = proxyHistoryMethod(window.history.pushState);
  window.history.replaceState = proxyHistoryMethod(window.history.replaceState);
};

function minifyExpression(expression: string) {
  return minify(expression).code;
}

function getLocationProxyScript() {
  return minifyExpression(
    `(${locationProxy.toString()})(${JSON.stringify(pageDomain)}, ${JSON.stringify(pageId)}, ${JSON.stringify(seoStore.getPageSlugMap())})`,
  );
}

const ga = GA_MEASUREMENT_ID
  ? `<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());

  gtag('config', '${GA_MEASUREMENT_ID}');
</script>`
  : '';

const vercelAnalytics = config.analytics.vercelAnalytics
  ? `<!-- Vercel Analytics -->
<script>window.va=window.va||function(){(window.vaq=window.vaq||[]).push(arguments);};</script>
<script defer src="/_vercel/insights/script.js"></script>`
  : '';

const vercelSpeedInsights = config.analytics.vercelSpeedInsights
  ? `<!-- Vercel Speed Insights -->
<script defer src="/_vercel/speed-insights/script.js"></script>`
  : '';

// 所有注入到 </body> 之前的分析脚本
const analyticsMarkup = `${ga}${vercelAnalytics}${vercelSpeedInsights}`;

/** HTML 属性值转义,防止破坏标签结构 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 站点验证 meta 标签(全站统一) */
function getVerificationMarkup(): string {
  const tags: string[] = [];
  if (config.verification.google && config.verification.googleCode) {
    tags.push(
      `<meta name="google-site-verification" content="${escapeHtml(
        config.verification.googleCode,
      )}">`,
    );
  }
  if (config.verification.bing && config.verification.bingCode) {
    tags.push(
      `<meta name="msvalidate.01" content="${escapeHtml(
        config.verification.bingCode,
      )}">`,
    );
  }
  return tags.join('');
}

/** 根据请求路径取出用于查询 SEO 的第一段 key */
function getSeoKey(requestUrl: string): string {
  const [, firstSegment = ''] = requestUrl.split('?')[0].split('/');
  return decodeURIComponent(firstSegment);
}

/**
 * 生成当前请求对应的 SEO <title> 与 meta 标签。
 * - 优先使用数据库条目的 Description / 标题
 * - 根页面回退到设置文件中的默认值
 */
function getSeoMarkup(
  requestUrl: string,
  host?: string,
): {
  title: string;
  description: string;
  markup: string;
} {
  const key = getSeoKey(requestUrl);
  const meta = key ? seoStore.getMeta(key) : undefined;

  const title = meta?.title || config.seo.defaultTitle;
  const description = meta?.description || config.seo.defaultDescription;

  const tags: string[] = [];

  // 有 Slug 时只收录 Slug；没有 Slug 时收录 Notion 原始字符路径。
  const canonicalSlug = key ? seoStore.canonicalSlug(key) : undefined;
  const canonicalPath = canonicalSlug ?? (meta ? key : undefined);
  if (canonicalPath && host) {
    const canonicalUrl = `https://${host}/${encodeURIComponent(canonicalPath)}`;
    tags.push(`<link rel="canonical" href="${escapeHtml(canonicalUrl)}">`);
    tags.push(`<meta property="og:url" content="${escapeHtml(canonicalUrl)}">`);
  }
  if (description) {
    tags.push(`<meta name="description" content="${escapeHtml(description)}">`);
    tags.push(
      `<meta property="og:description" content="${escapeHtml(description)}">`,
    );
    tags.push(
      `<meta name="twitter:description" content="${escapeHtml(description)}">`,
    );
  }
  if (title) {
    tags.push(`<meta property="og:title" content="${escapeHtml(title)}">`);
    tags.push(`<meta name="twitter:title" content="${escapeHtml(title)}">`);
  }
  if (config.seo.siteName) {
    tags.push(
      `<meta property="og:site_name" content="${escapeHtml(
        config.seo.siteName,
      )}">`,
    );
  }
  tags.push('<meta property="og:type" content="website">');
  tags.push('<meta name="twitter:card" content="summary_large_image">');

  return { title, description, markup: tags.join('') };
}

/**
 * 浏览器端挂载 Utterances 评论框(评论内容存储在 GitHub Issues 中)。
 * - 首页不挂载评论。
 * - Notion 是 SPA,依赖轮询 location.pathname 检测软导航并重新挂载。
 * - 挂载点优先选 .notion-page-content 之后,找不到则退避重试,
 *   多次重试后兜底追加到 body 末尾。
 * - 主题跟随 Notion 自身的暗色模式 class,否则回退到系统色彩方案。
 */
const commentsMount = (repo: string) => {
  const CONTAINER_ID = 'ncd-comments';
  let lastPathname = '';
  let mountAttempts = 0;

  const isDarkMode = () =>
    document.documentElement.classList.contains('dark-mode') ||
    document.body.classList.contains('dark') ||
    window.matchMedia('(prefers-color-scheme: dark)').matches;

  const removeExisting = () => {
    document.getElementById(CONTAINER_ID)?.remove();
  };

  const mount = () => {
    if (location.pathname === '/') {
      removeExisting();
      return;
    }

    const anchor = document.querySelector('.notion-page-content');
    if (!anchor && mountAttempts < 20) {
      mountAttempts += 1;
      setTimeout(mount, 300);
      return;
    }

    removeExisting();
    mountAttempts = 0;

    const container = document.createElement('div');
    container.id = CONTAINER_ID;
    container.style.maxWidth = '900px';
    container.style.margin = '40px auto';
    container.style.padding = '0 96px';

    const script = document.createElement('script');
    script.src = 'https://utteranc.es/client.js';
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.setAttribute('repo', repo);
    script.setAttribute('issue-term', 'pathname');
    script.setAttribute('theme', isDarkMode() ? 'github-dark' : 'github-light');
    container.appendChild(script);

    if (anchor?.parentElement) {
      anchor.parentElement.insertBefore(container, anchor.nextSibling);
    } else {
      document.body.appendChild(container);
    }
  };

  const checkNavigation = () => {
    if (location.pathname !== lastPathname) {
      lastPathname = location.pathname;
      mountAttempts = 0;
      mount();
    }
  };

  window
    .matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', () => mount());
  setInterval(checkNavigation, 500);
  checkNavigation();
};

function getCommentsScript() {
  const js = minifyExpression(
    `(${commentsMount.toString()})(${JSON.stringify(config.comments.repo)})`,
  );
  return `<script>${js}</script>`;
}

const customScript = () => {
  const replacedUrl = (url: string) => {
    const [, domain] = /^https?:\/\/([^\\/]*)/.exec(url) || ['', ''];
    if (
      (domain.endsWith('notion.so') &&
        !domain.endsWith('msgstore.www.notion.so')) ||
      domain.endsWith('splunkcloud.com') ||
      domain.endsWith('statsigapi.net')
    ) {
      console.info('[NCD]', 'Suppress request:', url);
      return url.replace(/^.*:(.*)\/\//, '/200/$1');
    }
    return url;
  };

  window.fetch = new Proxy(window.fetch, {
    apply: function (target, that, [url, ...rest]) {
      url = replacedUrl(url);
      return Reflect.apply(target, that, [url, ...rest]);
    },
  });

  window.XMLHttpRequest = new Proxy(XMLHttpRequest, {
    construct: function (target, args) {
      // @ts-expect-error A spread argument must either have a tuple type or be passed to a rest parameter.
      const xhr = new target(...args);
      xhr.open = new Proxy(xhr.open, {
        apply: function (target, that, [method, url, ...rest]) {
          url = replacedUrl(url);
          return Reflect.apply(target, that, [method, url, ...rest]);
        },
      });
      return xhr;
    },
  });
};

function getCustomScript() {
  const js = minifyExpression(`(${customScript.toString()})()`);
  return `<script>${js}</script>`;
}

function getCustomStyle() {
  const css = new CleanCSS().minify(CUSTOM_STYLE).styles;
  return `<style>${css}</style>`;
}

function getInjectedHeadMarkup() {
  return `<script>${getLocationProxyScript()}</script>${getCustomScript()}${getCustomStyle()}`;
}

function getProxyPath(url: string) {
  // 自定义 slug ��由:把 /my-slug 映射到对应 Notion 页面 ID
  const [, firstSegment = ''] = url.split('?')[0].split('/');
  if (firstSegment) {
    const targetPageId = seoStore.resolvePageId(
      decodeURIComponent(firstSegment),
    );
    if (targetPageId) {
      return `/${targetPageId}`;
    }
  }
  return url.replace(/\/(\?|$)/, `/${pageId}$1`);
}

function rewriteCookieDomains(cookies: string[], hostname: string) {
  return cookies.map((cookie) =>
    cookie.replace(
      /((?:^|; )Domain=)(?:[^.]+\.)?notion\.site(;|$)/gi,
      `$1${hostname}$2`,
    ),
  );
}

function addAnalyticsSourcesToCsp(csp: string) {
  return csp.replace(
    /(?=(script-src|connect-src) )[^;]*/g,
    `$& ${GOOGLE_ANALYTICS_SOURCES} ${VERCEL_ANALYTICS_SOURCES}`,
  );
}

function isPseudoSuccessEndpoint(url: string) {
  return /^\/200\/?/.test(url);
}

function handlePseudoSuccessEndpoint(url: string, res: express.Response) {
  if (url.startsWith(PUBLIC_PAGE_DATA_ENDPOINT)) {
    res.send('success');
  } else if (url.startsWith(EXPERIMENT_ENDPOINT)) {
    res.json({ success: true });
  } else {
    res.end();
  }
}

function rewriteRuntimeAsset(data: string) {
  return data.replace(LOCATION_HREF_PATTERN, 'window.ncd.href()');
}

function rewriteHtml(data: string, requestUrl: string, host?: string) {
  const {
    title,
    description,
    markup: seoMarkup,
  } = getSeoMarkup(requestUrl, host);
  let result = data;

  // 替换原有 <title>(有自定义标题时)
  if (title) {
    result = /<title>[\s\S]*?<\/title>/i.test(result)
      ? result.replace(
          /<title>[\s\S]*?<\/title>/i,
          `<title>${escapeHtml(title)}</title>`,
        )
      : result.replace('</head>', `<title>${escapeHtml(title)}</title></head>`);
  }

  // 移除 Notion 原有 SEO 标签，确保搜索引擎只读取本站生成的 canonical。
  result = result
    .replace(/<link[^>]*rel=["']canonical["'][^>]*>/gi, '')
    .replace(
      /<meta[^>]*(?:property|name)=["']og:(?:url|title|description)["'][^>]*>/gi,
      '',
    )
    .replace(
      /<meta[^>]*name=["']twitter:(?:title|description)["'][^>]*>/gi,
      '',
    );
  if (description) {
    result = result.replace(/<meta[^>]*name=["']description["'][^>]*>/gi, '');
  }

  const headInjection = `${getVerificationMarkup()}${seoMarkup}${getInjectedHeadMarkup()}`;

  // 评论仅在非首页内容页(文章 + 子页面)注入,getSeoKey 为空字符串代表首页。
  const commentsInjection =
    config.comments.enabled && getSeoKey(requestUrl) ? getCommentsScript() : '';

  return result
    .replace('</head>', `${headInjection}</head>`)
    .replace('</body>', `${analyticsMarkup}${commentsInjection}</body>`);
}

function rewriteSharedResponseContent(data: string) {
  return data
    .replace(
      /https:\/\/((aif\.notion\.so|widget\.intercom\.io)\/?[^"`]*)/g,
      `/200/$1`,
    )
    .replace(/\w+\.init\({dsn:/, 'return;$&');
}

function decorateHtmlOrAssetResponse(
  data: string,
  requestUrl: string,
  host?: string,
) {
  const rewritten = ASSET_REQUEST_PATTERN.test(requestUrl)
    ? rewriteRuntimeAsset(data)
    : rewriteHtml(data, requestUrl, host);

  return rewriteSharedResponseContent(rewritten);
}

// Filenames under /_assets/ are content-hashed, so responses are immutable.
interface CacheEntry {
  data: Buffer | string;
  contentType: string;
}
const assetCache = new Map<string, CacheEntry>();

const app = express();

// 启动 SEO / Slug 内存缓存,并按 config.refreshIntervalMs 定时刷新
seoStore.start();

app.get('/robots.txt', (req, res) => {
  res
    .status(200)
    .type('text/plain')
    .send(
      `User-agent: *\nAllow: /\nSitemap: https://${req.headers.host}/sitemap.xml\n`,
    );
});

app.get('/sitemap.xml', async (req, res) => {
  try {
    await seoStore.ensureFresh();
  } catch (error) {
    console.error('[NCD][SEO] 网站地图刷新失败', (error as Error).message);
  }

  const origin = `https://${req.headers.host}`;
  const paths = ['', ...seoStore.getSitemapPaths()];
  const urls = [...new Set(paths)].map((pagePath) => {
    const location = pagePath
      ? `${origin}/${encodeURIComponent(pagePath)}`
      : `${origin}/`;
    return `<url><loc>${escapeHtml(location)}</loc></url>`;
  });

  res
    .status(200)
    .type('application/xml')
    .set('Cache-Control', 'public, max-age=0, s-maxage=3600')
    .send(
      `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}</urlset>`,
    );
});

// 将带前缀 / 原始 ID 的页面 URL 301 重定向到简洁 slug。
// 仅处理浏览器 / 爬虫的顶层文档导航(Accept: text/html),
// 不影响 Notion 前端的资源与 API 请求。
app.use(async (req, res, next) => {
  const accept = String(req.headers['accept'] ?? '');
  if (req.method !== 'GET' || !accept.includes('text/html')) return next();

  try {
    await seoStore.ensureFresh();
  } catch (error) {
    console.error('[NCD][SEO] 请求前刷新失败', (error as Error).message);
    // Notion 页面仍应可用；刷新失败时继续代理原始字符 URL。
  }

  const path = req.url.split('?')[0];
  const [, firstSegment = ''] = path.split('/');
  // 根页面、带扩展名的资源、特殊端点不重定向
  if (!firstSegment || firstSegment.includes('.')) return next();
  if (/^(200|_assets|_next|image|images|api)$/i.test(firstSegment)) {
    return next();
  }

  const decoded = decodeURIComponent(firstSegment);
  const slug = seoStore.canonicalSlug(decoded);
  if (slug && slug !== decoded) {
    const query = req.url.slice(path.length); // 保留 query string
    res.redirect(301, `/${encodeURIComponent(slug)}${query}`);
    return;
  }
  next();
});

app.use((req, res, next) => {
  const cached = assetCache.get(req.url);
  if (cached) {
    res.setHeader('content-type', cached.contentType);
    res.setHeader('cache-control', 'public, max-age=31536000, immutable');
    res.send(cached.data);
    return;
  }
  next();
});

app.use(
  proxy(pageDomain, {
    proxyReqOptDecorator: (proxyReqOpts) => {
      if (proxyReqOpts.headers) {
        delete proxyReqOpts.headers['accept-encoding'];
        // 不把 Googlebot/Bingbot UA 转发给 Notion 上游，避免 Cloudflare
        // 返回 403 挑战页；访客侧仍收到完整 SEO HTML。
        proxyReqOpts.headers['user-agent'] =
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
      }
      return proxyReqOpts;
    },
    filter: (req, res) => {
      if (isPseudoSuccessEndpoint(req.url)) {
        handlePseudoSuccessEndpoint(req.url, res);
        return false;
      }
      return true;
    },
    proxyReqPathResolver: (req) => {
      return getProxyPath(req.url);
    },
    userResHeaderDecorator: (headers, userReq) => {
      const cookies = headers['set-cookie'];
      if (cookies) {
        headers['set-cookie'] = rewriteCookieDomains(cookies, userReq.hostname);
      }

      const csp = headers['content-security-policy'] as string;
      if (csp) {
        headers['content-security-policy'] = addAnalyticsSourcesToCsp(csp);
      }

      if (STATIC_ASSET_PATTERN.test(userReq.url)) {
        headers['cache-control'] = 'public, max-age=31536000, immutable';
      }

      return headers;
    },
    userResDecorator: (proxyRes, proxyResData, userReq) => {
      const contentType = proxyRes.headers['content-type'] ?? '';
      if (
        PASSTHROUGH_REQUEST_PATTERN.test(userReq.url) ||
        (!contentType.startsWith('text/') &&
          !contentType.includes('javascript'))
      ) {
        if (
          STATIC_ASSET_PATTERN.test(userReq.url) &&
          proxyRes.statusCode === 200
        ) {
          assetCache.set(userReq.url, { data: proxyResData, contentType });
        }
        return proxyResData;
      }

      const data = proxyResData.toString();
      const result = decorateHtmlOrAssetResponse(
        data,
        userReq.url,
        userReq.headers.host,
      );

      if (
        STATIC_ASSET_PATTERN.test(userReq.url) &&
        proxyRes.statusCode === 200
      ) {
        assetCache.set(userReq.url, { data: result, contentType });
      }

      return result;
    },
  }),
);

if (!process.env.VERCEL_REGION && !process.env.NOW_REGION) {
  const port = process.env.PORT || 3000;
  app.listen(port, () =>
    console.log(`Server running at http://localhost:${port}`),
  );
}

export default app;
